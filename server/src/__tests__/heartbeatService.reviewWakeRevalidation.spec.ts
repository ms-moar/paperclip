import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { runningProcesses } from "../adapters/index.ts";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Review wake revalidation test run.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat review wake revalidation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForCondition(fn: () => Promise<boolean>, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return fn();
}

async function cleanup(db: ReturnType<typeof createDb>) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await db.execute(sql.raw(`
        TRUNCATE TABLE
          "activity_log",
          "heartbeat_run_events",
          "heartbeat_runs",
          "agent_wakeup_requests",
          "issues",
          "agents",
          "companies"
        RESTART IDENTITY CASCADE
      `));
      return;
    } catch (error) {
      const retryable = error instanceof Error && (error.message.includes("deadlock detected") || error.message.includes("violates foreign key"));
      if (!retryable || attempt === 9) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

type Seeded = {
  companyId: string;
  assigneeAgentId: string;
  reviewerAgentId: string;
  otherReviewerAgentId: string;
  issueId: string;
  stageId: string;
};

describeEmbeddedPostgres("heartbeat review wake revalidation", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-review-wake-revalidation-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    let idlePolls = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const runs = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
      const hasActiveRun = runs.some((run) => run.status === "queued" || run.status === "running");
      if (!hasActiveRun) {
        idlePolls += 1;
        if (idlePolls >= 3) break;
      } else {
        idlePolls = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await cleanup(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedIssue(currentReviewerAgentId?: string): Promise<Seeded> {
    const companyId = randomUUID();
    const assigneeAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const otherReviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const stageId = randomUUID();
    const participantAgentId = currentReviewerAgentId ?? reviewerAgentId;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: assigneeAgentId,
        companyId,
        name: "Assignee",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: reviewerAgentId,
        companyId,
        name: "Reviewer",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
      {
        id: otherReviewerAgentId,
        companyId,
        name: "OtherReviewer",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Needs review",
      status: "in_review",
      priority: "high",
      assigneeAgentId: participantAgentId,
      executionState: {
        status: "pending",
        currentStageId: stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: participantAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: "11111111-1111-4111-8111-111111111111",
        lastDecisionOutcome: null,
      },
    });

    return { companyId, assigneeAgentId, reviewerAgentId, otherReviewerAgentId, issueId, stageId };
  }

  function executionWakeContext(seed: Seeded, recipientAgentId: string, lastDecisionId = "11111111-1111-4111-8111-111111111111") {
    const executionStage = {
      wakeRole: "reviewer",
      stageId: seed.stageId,
      stageType: "review",
      currentParticipant: { type: "agent", agentId: recipientAgentId, userId: null },
      returnAssignee: { type: "agent", agentId: seed.assigneeAgentId, userId: null },
      reviewRequest: null,
      lastDecisionId,
      lastDecisionOutcome: null,
      allowedActions: ["approve", "request_changes"],
    };
    return {
      source: "assignment" as const,
      triggerDetail: "system" as const,
      reason: "execution_review_requested",
      payload: { issueId: seed.issueId, mutation: "update", executionStage },
      contextSnapshot: {
        issueId: seed.issueId,
        taskId: seed.issueId,
        wakeReason: "execution_review_requested",
        source: "issue.execution_stage",
        executionStage,
      },
      requestedByActorType: "system" as const,
      requestedByActorId: "test",
    };
  }

  it("dispatches an execution review wake when recipient still matches current participant", async () => {
    const seed = await seedIssue();

    const run = await heartbeat.wakeup(seed.reviewerAgentId, executionWakeContext(seed, seed.reviewerAgentId));

    expect(run).not.toBeNull();
    await waitForCondition(async () => {
      const row = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)).then((rows) => rows[0] ?? null);
      return row?.status === "succeeded";
    });
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    const dispatched = await db.select().from(activityLog).where(eq(activityLog.action, "wake.dispatched"));
    expect(dispatched).toHaveLength(1);
  });

  it("suppresses a stale execution review wake before a heartbeat run is emitted", async () => {
    const seed = await seedIssue();
    await db.update(issues).set({
      assigneeAgentId: seed.otherReviewerAgentId,
      executionState: {
        status: "pending",
        currentStageId: seed.stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: seed.otherReviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: seed.assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: "11111111-1111-4111-8111-111111111111",
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, seed.issueId));

    const run = await heartbeat.wakeup(seed.reviewerAgentId, executionWakeContext(seed, seed.reviewerAgentId));

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const runs = await db.select().from(heartbeatRuns);
    expect(runs).toHaveLength(0);
    const [suppressed] = await db.select().from(activityLog).where(eq(activityLog.action, "wake.stale_suppressed"));
    expect(suppressed?.details).toMatchObject({
      issueId: seed.issueId,
      recipientAgentId: seed.reviewerAgentId,
      expectedAgentId: seed.otherReviewerAgentId,
      lastDecisionId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("suppresses an execution review wake when the decision context is no longer current", async () => {
    const seed = await seedIssue();
    await db.update(issues).set({
      executionState: {
        status: "pending",
        currentStageId: seed.stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: seed.reviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: seed.assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: "22222222-2222-4222-8222-222222222222",
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, seed.issueId));

    const run = await heartbeat.wakeup(seed.reviewerAgentId, executionWakeContext(seed, seed.reviewerAgentId));

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    const [suppressed] = await db.select().from(activityLog).where(eq(activityLog.action, "wake.stale_suppressed"));
    expect(suppressed?.details).toMatchObject({
      issueId: seed.issueId,
      recipientAgentId: seed.reviewerAgentId,
      expectedAgentId: seed.reviewerAgentId,
      lastDecisionId: "11111111-1111-4111-8111-111111111111",
      currentLastDecisionId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("folds repeated stale execution review wakes for the same issue recipient and decision", async () => {
    const seed = await seedIssue();
    await db.update(issues).set({
      assigneeAgentId: seed.otherReviewerAgentId,
      executionState: {
        status: "pending",
        currentStageId: seed.stageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: seed.otherReviewerAgentId, userId: null },
        returnAssignee: { type: "agent", agentId: seed.assigneeAgentId, userId: null },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: "11111111-1111-4111-8111-111111111111",
        lastDecisionOutcome: null,
      },
    }).where(eq(issues.id, seed.issueId));

    await heartbeat.wakeup(seed.reviewerAgentId, {
      ...executionWakeContext(seed, seed.reviewerAgentId),
      idempotencyKey: "caller-key-one",
    });
    await heartbeat.wakeup(seed.reviewerAgentId, {
      ...executionWakeContext(seed, seed.reviewerAgentId),
      idempotencyKey: "caller-key-two",
    });
    await heartbeat.wakeup(seed.reviewerAgentId, {
      ...executionWakeContext(seed, seed.reviewerAgentId),
      idempotencyKey: "caller-key-three",
    });

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      status: "skipped",
      reason: "wake.stale_suppressed",
      coalescedCount: 2,
      idempotencyKey: `execution-stage-wake:${seed.issueId}:${seed.reviewerAgentId}:11111111-1111-4111-8111-111111111111`,
    });
    const folded = await db.select().from(activityLog).where(eq(activityLog.action, "wake.folded"));
    expect(folded).toHaveLength(2);
  });
});
