import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const reviewerAgentId = "44444444-4444-4444-8444-444444444444";
const reviewerRunId = "66666666-6666-4666-8666-666666666666";
const stageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const lastDecisionId = "99999999-9999-4999-8999-999999999999";

const mockIssueService = vi.hoisted(() => ({
  addComment: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  checkout: vi.fn(),
  create: vi.fn(),
  createChild: vi.fn(),
  getAttachmentById: vi.fn(),
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
  getRelationSummaries: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  listAttachments: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  remove: vi.fn(),
  removeAttachment: vi.fn(),
  update: vi.fn(),
  findMentionedAgents: vi.fn(),
  getCurrentScheduledRetry: vi.fn(async () => null),
}));
const mockAccessService = vi.hoisted(() => ({ canUser: vi.fn(), decide: vi.fn(), hasPermission: vi.fn(async () => false) }));
const mockAgentService = vi.hoisted(() => ({ getById: vi.fn(), list: vi.fn(), resolveByReference: vi.fn() }));
const mockCompanyService = vi.hoisted(() => ({ getById: vi.fn() }));
const mockDocumentService = vi.hoisted(() => ({ upsertIssueDocument: vi.fn() }));
const mockWorkProductService = vi.hoisted(() => ({ createForIssue: vi.fn(), getById: vi.fn(), remove: vi.fn(), update: vi.fn() }));
const mockStorageService = vi.hoisted(() => ({ provider: "local_disk", putFile: vi.fn(), getObject: vi.fn(), headObject: vi.fn(), deleteObject: vi.fn() }));
const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));
const mockIssueThreadInteractionService = vi.hoisted(() => ({
  expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
  expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  listForIssue: vi.fn(async () => []),
}));
const mockIssueRecoveryActionService = vi.hoisted(() => ({
  getActiveForIssue: vi.fn(async () => null),
  listActiveForIssues: vi.fn(async () => new Map()),
  resolveActiveForIssue: vi.fn(async () => null),
}));
const mockTxInsertValues = vi.hoisted(() => vi.fn(async () => undefined));
const mockTxInsert = vi.hoisted(() => vi.fn(() => ({ values: mockTxInsertValues })));

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({ trackAgentTaskCompleted: vi.fn(), trackErrorHandlerCrash: vi.fn() }));
  vi.doMock("../telemetry.js", () => ({ getTelemetryClient: vi.fn(() => ({ track: vi.fn() })) }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => mockCompanyService,
    documentService: () => mockDocumentService,
    executionWorkspaceService: () => ({}),
    feedbackService: () => ({ listIssueVotesForUser: vi.fn(async () => []), saveIssueVote: vi.fn(async () => ({ vote: null, consentEnabledNow: false, sharingEnabled: false })) }),
    goalService: () => ({}),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({ get: vi.fn(async () => ({ id: "settings", general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" } })), listCompanyIds: vi.fn(async () => [companyId]) }),
    issueApprovalService: () => ({ listApprovalsForIssue: vi.fn(async () => []) }),
    issueReferenceService: () => ({ deleteDocumentSource: async () => undefined, diffIssueReferenceSummary: () => ({ addedReferencedIssues: [], removedReferencedIssues: [], currentReferencedIssues: [] }), emptySummary: () => ({ outbound: [], inbound: [] }), listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }), syncComment: async () => undefined, syncDocument: async () => undefined, syncIssue: async () => undefined }),
    issueRecoveryActionService: () => mockIssueRecoveryActionService,
    issueService: () => mockIssueService,
    issueThreadInteractionService: () => mockIssueThreadInteractionService,
    logActivity: vi.fn(async () => undefined),
    projectService: () => ({ getById: vi.fn(async () => null) }),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => mockWorkProductService,
  }));
}

function executionState(decisionId = lastDecisionId) {
  return {
    status: "pending",
    currentStageId: stageId,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: reviewerAgentId },
    returnAssignee: { type: "agent", agentId: ownerAgentId },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: decisionId,
    lastDecisionOutcome: null,
  };
}

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_review",
    priority: "high",
    checkoutRunId: null,
    executionRunId: null,
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: ownerAgentId,
    assigneeUserId: null,
    createdByUserId: "board-user",
    identifier: "MAD-203",
    title: "MAD-203 review",
    executionPolicy: {
      mode: "normal",
      commentRequired: true,
      stages: [{ id: stageId, type: "review", approvalsNeeded: 1, participants: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", type: "agent", agentId: reviewerAgentId }] }],
      monitor: null,
    },
    executionState: executionState(),
    hiddenAt: null,
    ...overrides,
  };
}

function createRunContextDb(contextSnapshot: Record<string, unknown>) {
  const tx = { insert: mockTxInsert };
  return {
    transaction: async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: async (resolve: (rows: unknown[]) => unknown) => resolve([{ id: reviewerRunId, companyId, agentId: reviewerAgentId, contextSnapshot }]),
        })),
      })),
    })),
  };
}

async function createApp(contextSnapshot: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = { type: "agent", agentId: reviewerAgentId, companyId, source: "agent_key", runId: reviewerRunId };
    next();
  });
  app.use("/api", issueRoutes(createRunContextDb(contextSnapshot) as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

describe("issues route reviewer evidence path", () => {
  beforeEach(() => {
    vi.resetModules();
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "no override" });
    mockAccessService.canUser.mockResolvedValue(true);
    mockAgentService.getById.mockResolvedValue({ id: reviewerAgentId, companyId, role: "qa", permissions: {} });
    mockAgentService.list.mockResolvedValue([]);
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "MAD" });
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.addComment.mockResolvedValue({ id: "77777777-7777-4777-8777-777777777777", issueId, companyId, body: "comment" });
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...makeIssue(), ...patch }));
  });

  it("lets the active reviewer leave durable evidence without owning the issue checkout", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());

    const res = await request(await createApp({ executionStage: { lastDecisionId } }))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Reviewer evidence" });

    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.addComment).toHaveBeenCalledWith(
      issueId,
      "Reviewer evidence",
      expect.objectContaining({ agentId: reviewerAgentId }),
      expect.objectContaining({ authorType: "agent" }),
    );
  });

  it("lets the active reviewer request changes through the decision patch path", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());

    const res = await request(await createApp({ executionStage: { lastDecisionId } }))
      .patch(`/api/issues/${issueId}`)
      .send({ status: "in_progress", comment: "Changes requested: replay fixture failed" });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).toHaveBeenCalledWith(
      issueId,
      expect.objectContaining({
        status: "in_progress",
        executionState: expect.objectContaining({
          status: "changes_requested",
          lastDecisionOutcome: "changes_requested",
        }),
      }),
      expect.anything(),
    );
  });

  it("returns wake_context_stale and preserves evidence when the reviewer wake decision pointer is outdated", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ executionState: executionState("bbbbbbbb-0000-4000-8000-000000000000") }));

    const res = await request(await createApp({ executionStage: { lastDecisionId } }))
      .post(`/api/issues/${issueId}/comments`)
      .send({ body: "Stale evidence" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Reviewer wake context is stale",
      errorCode: "wake_context_stale",
      executionState: { status: "pending", currentParticipant: { type: "agent", agentId: reviewerAgentId }, lastDecisionId: "bbbbbbbb-0000-4000-8000-000000000000" },
    });
    expect(mockIssueService.addComment).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });
});
