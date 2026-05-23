import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  executionWorkspaces,
  goals,
  heartbeatRuns,
  instanceSettings,
  issueComments,
  issueInboxArchives,
  issueRelations,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.ts";

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
    `Skipping embedded Postgres audit tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issueService.getInReviewParentChildAudit", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-audit-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
    await ensureIssueRelationsTable(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(issueInboxArchives);
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(goals);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(instanceSettings);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAndParent(status: string = "in_review") {
    const companyId = randomUUID();
    const parentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Audit Co",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values({
      id: parentId,
      companyId,
      title: "Parent in review",
      status,
      priority: "high",
    });
    return { companyId, parentId };
  }

  async function seedAgent(companyId: string, name = "Engineer") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("returns null when there are no blocked children", async () => {
    const { companyId, parentId } = await seedCompanyAndParent("in_review");
    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      parentId,
      title: "Child in progress",
      status: "in_progress",
      priority: "medium",
    });
    const result = await svc.getInReviewParentChildAudit(parentId, companyId);
    expect(result).toBeNull();
  });

  it("returns null when the parent is not in_review (status race)", async () => {
    const { companyId, parentId } = await seedCompanyAndParent("done");
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      parentId,
      title: "Blocked child",
      status: "blocked",
      priority: "medium",
    });
    const result = await svc.getInReviewParentChildAudit(parentId, companyId);
    expect(result).toBeNull();
  });

  it("returns null when companyId does not match the parent", async () => {
    const { companyId, parentId } = await seedCompanyAndParent("in_review");
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      parentId,
      title: "Blocked child",
      status: "blocked",
      priority: "medium",
    });
    const result = await svc.getInReviewParentChildAudit(parentId, randomUUID());
    expect(result).toBeNull();
  });

  it("returns 2 entries with one routing-ask flagged for two blocked children", async () => {
    const { companyId, parentId } = await seedCompanyAndParent("in_review");
    const agentId = await seedAgent(companyId, "Claude Senior Dev");

    const blockedRoutingChildId = randomUUID();
    const blockedQuietChildId = randomUUID();
    await db.insert(issues).values([
      {
        id: blockedRoutingChildId,
        companyId,
        parentId,
        title: "Programs billing review",
        status: "blocked",
        priority: "high",
        assigneeAgentId: agentId,
      },
      {
        id: blockedQuietChildId,
        companyId,
        parentId,
        title: "Quiet blocked child",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);

    await db.insert(issueComments).values([
      {
        companyId,
        issueId: blockedRoutingChildId,
        authorAgentId: agentId,
        authorType: "agent",
        body: "earlier comment that should not be picked up",
        createdAt: new Date("2026-05-22T08:00:00.000Z"),
      },
      {
        companyId,
        issueId: blockedRoutingChildId,
        authorAgentId: agentId,
        authorType: "agent",
        body: "CEO PATCH assigneeAgentId required for reviewer swap per PRE-725.",
        createdAt: new Date("2026-05-23T12:00:00.000Z"),
      },
      {
        companyId,
        issueId: blockedQuietChildId,
        authorAgentId: agentId,
        authorType: "agent",
        body: "Waiting on upstream confirmation, nothing actionable yet.",
        createdAt: new Date("2026-05-23T11:00:00.000Z"),
      },
    ]);

    const result = await svc.getInReviewParentChildAudit(parentId, companyId);
    expect(result).not.toBeNull();
    expect(result?.blockedChildren).toHaveLength(2);
    expect(result?.blockedChildrenTotal).toBe(2);
    expect(result?.blockedChildrenListTruncated).toBe(false);
    expect(typeof result?.scannedAt).toBe("string");

    const routingEntry = result?.blockedChildren.find(
      (entry) => entry.id === blockedRoutingChildId,
    );
    const quietEntry = result?.blockedChildren.find(
      (entry) => entry.id === blockedQuietChildId,
    );
    expect(routingEntry).toBeDefined();
    expect(routingEntry?.routingAskDetected).toBe(true);
    expect(routingEntry?.latestCommentPreview).toContain("PATCH assigneeAgentId");
    expect(routingEntry?.latestCommentAuthorType).toBe("agent");
    expect(routingEntry?.latestCommentAuthorId).toBe(agentId);
    expect(routingEntry?.assigneeAgentId).toBe(agentId);
    expect(typeof routingEntry?.ageHours).toBe("number");
    expect(routingEntry?.ageHours).toBeGreaterThanOrEqual(0);

    expect(quietEntry).toBeDefined();
    expect(quietEntry?.routingAskDetected).toBe(false);
    expect(quietEntry?.latestCommentPreview).toContain("upstream confirmation");
  });

  it("caps blocked children at MAX_BLOCKED_CHILD_AUDIT_ROWS=10 and flags truncation", async () => {
    const { companyId, parentId } = await seedCompanyAndParent("in_review");
    const agentId = await seedAgent(companyId, "Engineer Bot");

    const blockedIds: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const id = randomUUID();
      blockedIds.push(id);
      await db.insert(issues).values({
        id,
        companyId,
        parentId,
        title: `Blocked child ${i + 1}`,
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      });
    }

    const result = await svc.getInReviewParentChildAudit(parentId, companyId);
    expect(result).not.toBeNull();
    expect(result?.blockedChildren).toHaveLength(10);
    expect(result?.blockedChildrenTotal).toBe(15);
    expect(result?.blockedChildrenListTruncated).toBe(true);
  });

  it("truncates long comment previews to MAX_BLOCKED_COMMENT_PREVIEW_CHARS=200", async () => {
    const { companyId, parentId } = await seedCompanyAndParent("in_review");
    const agentId = await seedAgent(companyId, "Verbose Bot");
    const childId = randomUUID();
    await db.insert(issues).values({
      id: childId,
      companyId,
      parentId,
      title: "Long comment child",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    const longBody = "x".repeat(500);
    await db.insert(issueComments).values({
      companyId,
      issueId: childId,
      authorAgentId: agentId,
      authorType: "agent",
      body: longBody,
    });
    const result = await svc.getInReviewParentChildAudit(parentId, companyId);
    const entry = result?.blockedChildren[0];
    expect(entry?.latestCommentPreviewTruncated).toBe(true);
    expect(entry?.latestCommentPreview?.endsWith("…")).toBe(true);
    expect(entry?.latestCommentPreview?.length).toBeLessThanOrEqual(201);
  });
});
