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
} from "../helpers/embedded-postgres.js";
import { runningProcesses } from "../../adapters/index.ts";
import { heartbeatService } from "../../services/heartbeat.ts";

const mockAdapterExecute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  errorMessage: null,
  summary: "MAD-203 replay wake executed.",
  provider: "test",
  model: "test-model",
})));

vi.mock("../../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../../adapters/index.ts")>("../../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping MAD-203 replay integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`);
}

type Db = ReturnType<typeof createDb>;

type Seed = {
  companyId: string;
  issueId: string;
  assigneeAgentId: string;
  reviewerAgentId: string;
  otherReviewerAgentId: string;
  stageId: string;
  lastDecisionId: string;
};

async function waitForRun(db: Db, runId: string) {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (row?.status === "succeeded" || row?.status === "failed" || row?.status === "cancelled") return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
}

async function waitForIdle(db: Db) {
  let idlePolls = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns);
    const active = rows.some((row) => row.status === "queued" || row.status === "running");
    if (!active) {
      idlePolls += 1;
      if (idlePolls >= 3) return;
    } else {
      idlePolls = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function cleanup(db: Db) {
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
}

function pendingExecutionState(seed: Seed, reviewerAgentId = seed.reviewerAgentId, lastDecisionId = seed.lastDecisionId) {
  return {
    status: "pending",
    currentStageId: seed.stageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: reviewerAgentId, userId: null },
    returnAssignee: { type: "agent", agentId: seed.assigneeAgentId, userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId,
    lastDecisionOutcome: null,
  };
}

function changesRequestedState(seed: Seed, lastDecisionId = seed.lastDecisionId) {
  return {
    status: "changes_requested",
    currentStageId: seed.stageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: seed.reviewerAgentId, userId: null },
    returnAssignee: { type: "agent", agentId: seed.assigneeAgentId, userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId,
    lastDecisionOutcome: "changes_requested",
  };
}

async function seedMad203Snapshot(db: Db): Promise<Seed> {
  const companyId = randomUUID();
  const issueId = randomUUID();
  const assigneeAgentId = randomUUID();
  const reviewerAgentId = randomUUID();
  const otherReviewerAgentId = randomUUID();
  const stageId = randomUUID();
  const lastDecisionId = "20300000-1113-4000-8113-000000000203";
  const seed = { companyId, issueId, assigneeAgentId, reviewerAgentId, otherReviewerAgentId, stageId, lastDecisionId };

  await db.insert(companies).values({
    id: companyId,
    name: "MAD replay",
    issuePrefix: `M${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(agents).values([
    { id: assigneeAgentId, companyId, name: "Mid Engineer A", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} },
    { id: reviewerAgentId, companyId, name: "QA", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} },
    { id: otherReviewerAgentId, companyId, name: "QA2", role: "qa", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } }, permissions: {} },
  ]);
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "MAD-203 replay fixture at 11:13 UTC",
    status: "in_review",
    priority: "high",
    assigneeAgentId: reviewerAgentId,
    executionState: pendingExecutionState(seed),
    createdAt: new Date("2026-06-03T11:13:00.000Z"),
    updatedAt: new Date("2026-06-03T11:13:00.000Z"),
  });
  return seed;
}

function reviewWake(seed: Seed, recipientAgentId = seed.reviewerAgentId, lastDecisionId = seed.lastDecisionId) {
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
      snapshotAt: "2026-06-03T11:13:00.000Z",
      executionStage,
    },
    requestedByActorType: "system" as const,
    requestedByActorId: "mad-203-replay",
  };
}

describeEmbeddedPostgres("MAD-203 replay integration", () => {
  let db!: Db;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mad-203-replay-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await waitForIdle(db);
    mockAdapterExecute.mockClear();
    runningProcesses.clear();
    await cleanup(db);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("suppresses and folds stale 11:13 UTC reviewer wakes after request_changes returned work to the executor", async () => {
    const seed = await seedMad203Snapshot(db);
    await db.update(issues).set({
      status: "in_progress",
      assigneeAgentId: seed.assigneeAgentId,
      executionState: changesRequestedState(seed),
      updatedAt: new Date("2026-06-03T11:14:00.000Z"),
    }).where(eq(issues.id, seed.issueId));

    await heartbeat.wakeup(seed.reviewerAgentId, { ...reviewWake(seed), idempotencyKey: "mad-203-stale-1" });
    await heartbeat.wakeup(seed.reviewerAgentId, { ...reviewWake(seed), idempotencyKey: "mad-203-stale-2" });

    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
    const [wake] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.reason, "wake.stale_suppressed"));
    expect(wake).toMatchObject({ status: "skipped", coalescedCount: 1 });
    expect(wake.idempotencyKey).toBe(`execution-stage-wake:${seed.issueId}:${seed.reviewerAgentId}:${seed.lastDecisionId}`);
    const activity = await db.select({ action: activityLog.action }).from(activityLog);
    expect(activity.map((row) => row.action).sort()).toEqual(["wake.folded", "wake.stale_suppressed"]);
  });

  it("handles the assignee race between wake emission and delivery by suppressing the stale reviewer run", async () => {
    const seed = await seedMad203Snapshot(db);
    await db.update(issues).set({
      assigneeAgentId: seed.otherReviewerAgentId,
      executionState: pendingExecutionState(seed, seed.otherReviewerAgentId),
      updatedAt: new Date("2026-06-03T11:13:30.000Z"),
    }).where(eq(issues.id, seed.issueId));

    const run = await heartbeat.wakeup(seed.reviewerAgentId, reviewWake(seed));

    expect(run).toBeNull();
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    const [suppressed] = await db.select().from(activityLog).where(eq(activityLog.action, "wake.stale_suppressed"));
    expect(suppressed?.details).toMatchObject({
      issueId: seed.issueId,
      recipientAgentId: seed.reviewerAgentId,
      expectedAgentId: seed.otherReviewerAgentId,
      wakeReason: "execution_review_requested",
    });
  });

  it("suppresses old decision-pointer wakes while allowing the current reviewer decision pointer", async () => {
    const seed = await seedMad203Snapshot(db);
    const advancedDecisionId = "20300000-1114-4000-8114-000000000203";
    await db.update(issues).set({ executionState: pendingExecutionState(seed, seed.reviewerAgentId, advancedDecisionId) }).where(eq(issues.id, seed.issueId));

    const staleRun = await heartbeat.wakeup(seed.reviewerAgentId, reviewWake(seed, seed.reviewerAgentId, seed.lastDecisionId));
    const currentRun = await heartbeat.wakeup(seed.reviewerAgentId, reviewWake(seed, seed.reviewerAgentId, advancedDecisionId));

    expect(staleRun).toBeNull();
    expect(currentRun).not.toBeNull();
    const runRow = await waitForRun(db, currentRun!.id);
    expect(runRow?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    const actions = await db.select({ action: activityLog.action }).from(activityLog);
    expect(actions.map((row) => row.action)).toEqual(expect.arrayContaining(["wake.dispatched", "wake.stale_suppressed"]));
  });
});
