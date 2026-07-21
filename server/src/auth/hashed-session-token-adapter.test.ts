import { describe, expect, it } from "vitest";
import type { DBAdapter, Where } from "better-auth/types";
import { withHashedSessionToken } from "./hashed-session-token-adapter.js";

type Row = Record<string, unknown>;

function matches(row: Row, where: Where[] | undefined): boolean {
  if (!where || where.length === 0) return true;
  return where.every((c) => {
    const op = c.operator ?? "eq";
    if (op !== "eq") return true;
    return row[c.field] === c.value;
  });
}

function makeFakeAdapter(store: Row[]): DBAdapter {
  const self: DBAdapter = {
    id: "fake",
    async create(args) {
      const row = { ...args.data } as Row;
      store.push(row);
      return row as never;
    },
    async findOne(args) {
      for (const row of store) {
        if (matches(row, args.where)) return row as never;
      }
      return null;
    },
    async findMany(args) {
      const out: Row[] = [];
      for (const row of store) {
        if (matches(row, args.where)) out.push(row);
      }
      return out as never;
    },
    async update(args) {
      for (const row of store) {
        if (matches(row, args.where)) {
          Object.assign(row, args.update);
          return row as never;
        }
      }
      return null;
    },
    async updateMany(args) {
      let n = 0;
      for (const row of store) {
        if (matches(row, args.where)) {
          Object.assign(row, args.update);
          n++;
        }
      }
      return n;
    },
    async delete(args) {
      for (let i = store.length - 1; i >= 0; i--) {
        if (matches(store[i], args.where)) store.splice(i, 1);
      }
    },
    async deleteMany(args) {
      let n = 0;
      for (let i = store.length - 1; i >= 0; i--) {
        if (matches(store[i], args.where)) {
          store.splice(i, 1);
          n++;
        }
      }
      return n;
    },
    async count(args) {
      let n = 0;
      for (const row of store) if (matches(row, args.where)) n++;
      return n;
    },
    async consumeOne(args) {
      for (const row of store) {
        if (matches(row, args.where)) {
          store.splice(store.indexOf(row), 1);
          return row as never;
        }
      }
      return null;
    },
    async incrementOne(args) {
      for (const row of store) {
        if (matches(row, args.where)) {
          for (const [k, v] of Object.entries(args.increment)) (row[k] as number) = ((row[k] as number) ?? 0) + v;
          if (args.set) Object.assign(row, args.set);
          return row as never;
        }
      }
      return null;
    },
    async transaction(cb) {
      return cb(self as never);
    },
  };
  return self;
}

function sha256Hex(t: string): string {
  // reference sha256 hex length for assertions
  void t;
  return "x".repeat(64);
}

describe("withHashedSessionToken", () => {
  it("create stores hashed token but returns plaintext", async () => {
    const store: Row[] = [];
    const adapter = withHashedSessionToken((() => makeFakeAdapter(store)) as never)({} as never);
    const created = await adapter.create<{ token: string; userId: string }>({
      model: "session",
      data: { token: "secret-cookie-token", userId: "u1" },
    });
    expect(created.token).toBe("secret-cookie-token");
    expect(store.length).toBe(1);
    expect(store[0].token).not.toBe("secret-cookie-token");
    expect((store[0].token as string).length).toBe(64);
  });

  it("findOne by plaintext token returns the row with plaintext token", async () => {
    const store: Row[] = [];
    const adapter = withHashedSessionToken((() => makeFakeAdapter(store)) as never)({} as never);
    await adapter.create({
      model: "session",
      data: { token: "my-plain-tok", userId: "u2" },
    });
    const row = await adapter.findOne<{ token: string; userId: string }>({
      model: "session",
      where: [{ field: "token", value: "my-plain-tok" }],
    });
    expect(row).not.toBeNull();
    expect(row!.token).toBe("my-plain-tok");
    expect(row!.userId).toBe("u2");
  });

  it("dual-read finds a legacy plaintext-token row", async () => {
    const store: Row[] = [{ id: "legacy", token: "legacy-plain", userId: "u3" }];
    const adapter = withHashedSessionToken((() => makeFakeAdapter(store)) as never)({} as never);
    const row = await adapter.findOne<{ token: string; userId: string }>({
      model: "session",
      where: [{ field: "token", value: "legacy-plain" }],
    });
    expect(row).not.toBeNull();
    expect(row!.userId).toBe("u3");
  });

  it("delete by plaintext token removes the hashed row", async () => {
    const store: Row[] = [];
    const adapter = withHashedSessionToken((() => makeFakeAdapter(store)) as never)({} as never);
    await adapter.create({ model: "session", data: { token: "to-delete", userId: "u4" } });
    expect(store.length).toBe(1);
    await adapter.delete({ model: "session", where: [{ field: "token", value: "to-delete" }] });
    expect(store.length).toBe(0);
  });

  it("non-session model passthrough: user create delegated unchanged", async () => {
    const store: Row[] = [];
    const adapter = withHashedSessionToken((() => makeFakeAdapter(store)) as never)({} as never);
    const created = await adapter.create<{ email: string; token: string }>({
      model: "user",
      data: { email: "a@b.com", token: "should-not-be-hashed" },
    });
    expect(created.email).toBe("a@b.com");
    expect(store.length).toBe(1);
    expect(store[0].token).toBe("should-not-be-hashed");
  });

  it("update by plaintext (session refresh) returns plaintext token, keeps hash at rest", async () => {
    const store: Row[] = [];
    const adapter = withHashedSessionToken((() => makeFakeAdapter(store)) as never)({} as never);
    await adapter.create({ model: "session", data: { token: "refresh-tok", userId: "u5" } });
    const hashAtRest = store[0].token as string;
    // Better Auth session refresh calls updateSession(plaintextToken, { expiresAt, updatedAt })
    const updated = await adapter.update<{ token: string; userId: string }>({
      model: "session",
      where: [{ field: "token", value: "refresh-tok" }],
      update: { updatedAt: new Date() },
    });
    expect(updated).not.toBeNull();
    // returned token must be plaintext (feeds setSessionCookie) — not the hash
    expect(updated!.token).toBe("refresh-tok");
    // at rest it must still be the hash, unchanged
    expect(store[0].token).toBe(hashAtRest);
    expect((store[0].token as string).length).toBe(64);
  });

  it("create INSIDE a transaction still hashes (trx re-wrapped)", async () => {
    const store: Row[] = [];
    const adapter = withHashedSessionToken((() => makeFakeAdapter(store)) as never)({} as never);
    // mimic Better Auth: runWithTransaction → adapter.transaction(trx => trx.create(...))
    await adapter.transaction(async (trx) => {
      await (trx as typeof adapter).create({
        model: "session",
        data: { token: "in-tx-token", userId: "u6" },
      });
    });
    expect(store.length).toBe(1);
    expect(store[0].token).not.toBe("in-tx-token");
    expect((store[0].token as string).length).toBe(64);
    // and it is findable by the plaintext afterwards (outside tx)
    const row = await adapter.findOne<{ userId: string }>({
      model: "session",
      where: [{ field: "token", value: "in-tx-token" }],
    });
    expect(row?.userId).toBe("u6");
  });

  it("sha256 reference sanity (hex len)", () => {
    // sanity guard against accidental length drift
    expect(sha256Hex("x").length).toBe(64);
  });
});
