import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIssueExecutionPolicy } from "./issue-execution-policy.ts";

const mockIssueUpdate = vi.fn();
const mockCreateChild = vi.fn();

vi.mock("./issues.js", () => ({
  issueService: () => ({
    update: mockIssueUpdate,
    createChild: mockCreateChild,
  }),
}));

type Row = Record<string, unknown>;

function createSelectChain(rows: Row[]) {
  return {
    from() {
      return {
        where() {
          return {
            then(cb: (rows: Row[]) => unknown) {
              return Promise.resolve(cb(rows));
            },
          };
        },
      };
    },
  };
}

function createFakeDb(args: {
  interactionRow: Row;
  issueRow: Row;
}) {
  let interactionRow = { ...args.interactionRow };
  const decisionInserts: Row[] = [];
  const issueTouches: Row[] = [];
  let selectCallCount = 0;

  const db: any = {
    select: vi.fn(() => {
      selectCallCount += 1;
      // First select = interaction lookup (getPendingInteractionForResolution + setIdempotency check),
      // any subsequent select returns issue row.
      if (selectCallCount === 1) return createSelectChain([interactionRow]);
      return createSelectChain([args.issueRow]);
    }),
    update: vi.fn(() => ({
      set(values: Row) {
        return {
          where() {
            if ("status" in values || "result" in values || "resolvedAt" in values) {
              interactionRow = { ...interactionRow, ...values };
              return {
                returning: async () => [interactionRow],
              };
            }
            if ("updatedAt" in values) {
              issueTouches.push(values);
              return Promise.resolve(undefined);
            }
            throw new Error("Unexpected update target");
          },
        };
      },
    })),
    insert: vi.fn(() => ({
      values: async (row: Row) => {
        decisionInserts.push(row);
      },
    })),
    transaction: async (cb: (tx: typeof db) => Promise<unknown>) => cb(db),
  };

  return {
    db,
    decisionInserts,
    issueTouches,
    getInteractionRow: () => interactionRow,
  };
}

// Stable UUID-shaped ids for fixtures.
const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "22222222-2222-4222-8222-222222222222";
const INTERACTION_ID = "33333333-3333-4333-8333-333333333333";
const CTO_USER_ID = "44444444-4444-4444-4444-444444444444";
const REVIEWER_AGENT_ID = "55555555-5555-4555-8555-555555555555";
const CODER_AGENT_ID = "66666666-6666-4666-8666-666666666666";
const NON_PARTICIPANT_USER_ID = "77777777-7777-4777-8777-777777777777";

function makeConfirmationInteractionRow(): Row {
  return {
    id: INTERACTION_ID,
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    kind: "request_confirmation",
    status: "pending",
    continuationPolicy: "wake_assignee",
    sourceCommentId: null,
    sourceRunId: null,
    title: "Confirm",
    summary: null,
    idempotencyKey: null,
    createdByAgentId: CODER_AGENT_ID,
    createdByUserId: null,
    resolvedByAgentId: null,
    resolvedByUserId: null,
    payload: {
      version: 1,
      prompt: "Approve plan v2?",
    },
    result: null,
    resolvedAt: null,
    createdAt: new Date("2026-05-01T10:00:00.000Z"),
    updatedAt: new Date("2026-05-01T10:00:00.000Z"),
  };
}

function makeApprovalOnlyPolicy(userId: string) {
  return normalizeIssueExecutionPolicy({
    stages: [
      { type: "approval", participants: [{ type: "user", userId }] },
    ],
  })!;
}

function makeTwoStagePolicy() {
  return normalizeIssueExecutionPolicy({
    stages: [
      { type: "review", participants: [{ type: "agent", agentId: REVIEWER_AGENT_ID }] },
      { type: "approval", participants: [{ type: "user", userId: CTO_USER_ID }] },
    ],
  })!;
}

describe("acceptRequestConfirmation auto-finalize", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("flips to done atomically when the actor matches the final approval-stage participant", async () => {
    const policy = makeApprovalOnlyPolicy(CTO_USER_ID);
    const approvalStageId = policy.stages[0].id;
    const issueRow: Row = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: CTO_USER_ID,
      projectId: null,
      goalId: null,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: approvalStageId,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: CTO_USER_ID },
        returnAssignee: { type: "agent", agentId: CODER_AGENT_ID },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };

    const interactionRow = makeConfirmationInteractionRow();
    const state = createFakeDb({ interactionRow, issueRow });

    mockIssueUpdate.mockImplementation(async (id: string, patch: Row) => ({
      id,
      companyId: COMPANY_ID,
      status: typeof patch.status === "string" ? patch.status : "done",
      assigneeAgentId: patch.assigneeAgentId ?? null,
      assigneeUserId: patch.assigneeUserId ?? null,
    }));

    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const svc = issueThreadInteractionService(state.db as never);

    const result = await svc.acceptInteraction(
      { id: ISSUE_ID, companyId: COMPANY_ID, projectId: null, goalId: null },
      INTERACTION_ID,
      {},
      { userId: CTO_USER_ID },
    );

    expect(mockIssueUpdate).toHaveBeenCalledTimes(1);
    const [updatedId, patch] = mockIssueUpdate.mock.calls[0];
    expect(updatedId).toBe(ISSUE_ID);
    expect(patch.status).toBe("done");
    expect(patch.actorUserId).toBe(CTO_USER_ID);
    expect(result.continuationIssue).toEqual({
      id: ISSUE_ID,
      status: "done",
      assigneeAgentId: null,
      assigneeUserId: null,
    });
    expect(state.decisionInserts).toHaveLength(1);
    expect(state.decisionInserts[0]).toMatchObject({
      issueId: ISSUE_ID,
      stageId: approvalStageId,
      stageType: "approval",
      outcome: "approved",
      actorUserId: CTO_USER_ID,
      body: "Approve plan v2?",
    });
    expect(state.issueTouches).toHaveLength(0);
  });

  it("does not advance the stage when the accepting actor is not the current participant", async () => {
    const policy = makeApprovalOnlyPolicy(CTO_USER_ID);
    const approvalStageId = policy.stages[0].id;
    const issueRow: Row = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: CTO_USER_ID,
      projectId: null,
      goalId: null,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: approvalStageId,
        currentStageIndex: 0,
        currentStageType: "approval",
        currentParticipant: { type: "user", userId: CTO_USER_ID },
        returnAssignee: { type: "agent", agentId: CODER_AGENT_ID },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };

    const interactionRow = makeConfirmationInteractionRow();
    const state = createFakeDb({ interactionRow, issueRow });

    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const svc = issueThreadInteractionService(state.db as never);

    const result = await svc.acceptInteraction(
      { id: ISSUE_ID, companyId: COMPANY_ID, projectId: null, goalId: null },
      INTERACTION_ID,
      {},
      { userId: NON_PARTICIPANT_USER_ID },
    );

    expect(mockIssueUpdate).not.toHaveBeenCalled();
    expect(state.decisionInserts).toHaveLength(0);
    expect(result.continuationIssue).toBeNull();
    expect(result.interaction.status).toBe("accepted");
    // The fallback path touches the issue row (no return-to-creator preconditions hold).
    expect(state.issueTouches).toHaveLength(1);
  });

  it("advances to the next stage participant on intermediate review approval", async () => {
    const policy = makeTwoStagePolicy();
    const reviewStageId = policy.stages[0].id;
    const issueRow: Row = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "in_review",
      assigneeAgentId: REVIEWER_AGENT_ID,
      assigneeUserId: null,
      projectId: null,
      goalId: null,
      executionPolicy: policy,
      executionState: {
        status: "pending",
        currentStageId: reviewStageId,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: REVIEWER_AGENT_ID },
        returnAssignee: { type: "agent", agentId: CODER_AGENT_ID },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    };

    const interactionRow = makeConfirmationInteractionRow();
    const state = createFakeDb({ interactionRow, issueRow });

    mockIssueUpdate.mockImplementation(async (id: string, patch: Row) => ({
      id,
      companyId: COMPANY_ID,
      status: typeof patch.status === "string" ? patch.status : "in_review",
      assigneeAgentId: patch.assigneeAgentId ?? null,
      assigneeUserId: patch.assigneeUserId ?? null,
    }));

    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const svc = issueThreadInteractionService(state.db as never);

    const result = await svc.acceptInteraction(
      { id: ISSUE_ID, companyId: COMPANY_ID, projectId: null, goalId: null },
      INTERACTION_ID,
      {},
      { agentId: REVIEWER_AGENT_ID },
    );

    expect(mockIssueUpdate).toHaveBeenCalledTimes(1);
    const patch = mockIssueUpdate.mock.calls[0][1] as Row;
    expect(patch.status).toBe("in_review");
    expect(patch.assigneeUserId).toBe(CTO_USER_ID);
    expect(patch.assigneeAgentId).toBeNull();
    const nextState = patch.executionState as Row;
    expect(nextState.currentStageType).toBe("approval");
    expect(nextState.currentParticipant).toMatchObject({ type: "user", userId: CTO_USER_ID });
    expect(state.decisionInserts).toHaveLength(1);
    expect(state.decisionInserts[0]).toMatchObject({
      stageId: reviewStageId,
      stageType: "review",
      outcome: "approved",
      actorAgentId: REVIEWER_AGENT_ID,
    });
    expect(result.continuationIssue).toEqual({
      id: ISSUE_ID,
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: CTO_USER_ID,
    });
  });

  it("preserves the legacy behavior for confirmations on issues without an execution policy", async () => {
    const issueRow: Row = {
      id: ISSUE_ID,
      companyId: COMPANY_ID,
      status: "in_review",
      assigneeAgentId: null,
      assigneeUserId: CTO_USER_ID,
      projectId: null,
      goalId: null,
      executionPolicy: null,
      executionState: null,
    };

    const interactionRow = makeConfirmationInteractionRow();
    const state = createFakeDb({ interactionRow, issueRow });

    mockIssueUpdate.mockImplementation(async (id: string, patch: Row) => ({
      id,
      companyId: COMPANY_ID,
      status: typeof patch.status === "string" ? patch.status : "todo",
      assigneeAgentId: patch.assigneeAgentId ?? null,
      assigneeUserId: patch.assigneeUserId ?? null,
    }));

    const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
    const svc = issueThreadInteractionService(state.db as never);

    const result = await svc.acceptInteraction(
      { id: ISSUE_ID, companyId: COMPANY_ID, projectId: null, goalId: null },
      INTERACTION_ID,
      {},
      { userId: CTO_USER_ID },
    );

    // The return-to-creator legacy path fires: assigneeUserId set, creator agent took the issue,
    // and the issue moves to `todo` for the creator agent.
    expect(mockIssueUpdate).toHaveBeenCalledTimes(1);
    const patch = mockIssueUpdate.mock.calls[0][1] as Row;
    expect(patch.status).toBe("todo");
    expect(patch.assigneeAgentId).toBe(CODER_AGENT_ID);
    expect(patch.assigneeUserId).toBeNull();
    expect(state.decisionInserts).toHaveLength(0);
    expect(result.interaction.status).toBe("accepted");
  });
});
