import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { actorMiddleware, clearActorCache } from "../middleware/auth.js";

function createSelectChain(rows: unknown[]) {
  return {
    from() {
      return {
        where() {
          return Promise.resolve(rows);
        },
      };
    },
  };
}

// db.select is invoked twice per session resolution (instance role + memberships).
function createDb() {
  return { select: vi.fn(() => createSelectChain([])) } as any;
}

function buildApp(db: any, resolveSession: any) {
  const app = express();
  app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession }));
  app.get("/actor", (req, res) => res.json(req.actor));
  return app;
}

const session = {
  session: { id: "session-1", userId: "user-1" },
  user: { id: "user-1", name: "User One", email: "user@example.com" },
};

describe("actorMiddleware session actor cache", () => {
  beforeEach(() => clearActorCache());

  it("resolves once for repeated requests carrying the same session cookie", async () => {
    const db = createDb();
    const resolveSession = vi.fn(async () => session);
    const app = buildApp(db, resolveSession);

    const r1 = await request(app).get("/actor").set("cookie", "pc.session=abc");
    const r2 = await request(app).get("/actor").set("cookie", "pc.session=abc");

    expect(r1.body).toMatchObject({ type: "board", userId: "user-1", source: "session" });
    expect(r2.body).toMatchObject({ type: "board", userId: "user-1", source: "session" });
    // Second request is a cache hit: no extra session resolution or DB lookups.
    expect(resolveSession).toHaveBeenCalledTimes(1);
    expect(db.select).toHaveBeenCalledTimes(2);
  });

  it("re-applies the per-request runId on a cache hit (never caches runId)", async () => {
    const db = createDb();
    const resolveSession = vi.fn(async () => session);
    const app = buildApp(db, resolveSession);

    const r1 = await request(app)
      .get("/actor")
      .set("cookie", "pc.session=abc")
      .set("x-paperclip-run-id", "run-A");
    const r2 = await request(app)
      .get("/actor")
      .set("cookie", "pc.session=abc")
      .set("x-paperclip-run-id", "run-B");

    expect(r1.body.runId).toBe("run-A");
    expect(r2.body.runId).toBe("run-B");
    expect(resolveSession).toHaveBeenCalledTimes(1); // still a cache hit
  });

  it("misses the cache for a different session cookie", async () => {
    const db = createDb();
    const resolveSession = vi.fn(async () => session);
    const app = buildApp(db, resolveSession);

    await request(app).get("/actor").set("cookie", "pc.session=abc");
    await request(app).get("/actor").set("cookie", "pc.session=different");

    expect(resolveSession).toHaveBeenCalledTimes(2);
  });

  it("does not cache when there is no cookie", async () => {
    const db = createDb();
    const resolveSession = vi.fn(async () => session);
    const app = buildApp(db, resolveSession);

    await request(app).get("/actor");
    await request(app).get("/actor");

    expect(resolveSession).toHaveBeenCalledTimes(2);
  });
});
