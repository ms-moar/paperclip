import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  renderPaperclipWakePrompt,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { buildPaperclipWakePayload } from "../services/heartbeat.ts";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

async function ensureIssueRelationsTable(db: ReturnType<typeof createDb>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS "issue_relations" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "issue_id" uuid NOT NULL,
      "related_issue_id" uuid NOT NULL,
      "type" text NOT NULL,
      "created_by_agent_id" uuid,
      "created_by_user_id" text,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now()
    );
  `));
}

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake-payload audit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("buildPaperclipWakePayload — childAuditDigest", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-audit-");
    db = createDb(tempDb.connectionString);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("populates childAuditDigest for in_review parent with blocked children", async () => {
    const companyId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "WakeAudit",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Senior Dev",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent in review",
        status: "in_review",
        priority: "high",
      },
      {
        id: childId,
        companyId,
        parentId,
        title: "Blocked child needing routing",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
      },
    ]);
    await db.insert(issueComments).values({
      companyId,
      issueId: childId,
      authorAgentId: agentId,
      authorType: "agent",
      body: "CEO PATCH assigneeAgentId required for reviewer swap.",
    });

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId: parentId,
        wakeReason: "issue_assigned",
      },
      issueSummary: {
        id: parentId,
        identifier: "PRE-867",
        title: "Parent in review",
        status: "in_review",
        priority: "high",
        workMode: "standard",
      },
    });

    expect(payload).not.toBeNull();
    expect(payload?.childAuditDigest).not.toBeNull();
    expect(payload?.childAuditDigest?.blockedChildren).toHaveLength(1);
    const entry = payload?.childAuditDigest?.blockedChildren[0];
    expect(entry?.id).toBe(childId);
    expect(entry?.routingAskDetected).toBe(true);
    expect(entry?.assigneeAgentId).toBe(agentId);
    expect(entry?.latestCommentPreview).toContain("PATCH assigneeAgentId");

    const serialized = stringifyPaperclipWakePayload(payload);
    expect(serialized).not.toBeNull();
    const parsed = JSON.parse(serialized as string);
    expect(parsed.childAuditDigest.blockedChildren[0].routingAskDetected).toBe(true);

    const prompt = renderPaperclipWakePrompt(payload);
    expect(prompt).toContain("## Blocked children (in_review parent audit");
    expect(prompt).toContain("🚨 routing-ask detected");
    expect(prompt).toContain('Last comment (agent · ' + agentId + '):');
  });

  it("leaves childAuditDigest=null when parent is not in_review", async () => {
    const companyId = randomUUID();
    const parentId = randomUUID();
    const childId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "WakeAudit",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      {
        id: parentId,
        companyId,
        title: "Parent in progress",
        status: "in_progress",
        priority: "medium",
      },
      {
        id: childId,
        companyId,
        parentId,
        title: "Blocked child",
        status: "blocked",
        priority: "medium",
      },
    ]);

    const payload = await buildPaperclipWakePayload({
      db,
      companyId,
      contextSnapshot: {
        issueId: parentId,
        wakeReason: "issue_assigned",
      },
      issueSummary: {
        id: parentId,
        identifier: "PRE-902",
        title: "Parent in progress",
        status: "in_progress",
        priority: "medium",
        workMode: "standard",
      },
    });

    expect(payload).not.toBeNull();
    expect(payload?.childAuditDigest).toBeNull();
  });
});
