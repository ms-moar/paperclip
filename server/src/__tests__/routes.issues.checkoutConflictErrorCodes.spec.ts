import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../errors.js";

const issueId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const ownerAgentId = "33333333-3333-4333-8333-333333333333";
const peerAgentId = "44444444-4444-4444-8444-444444444444";
const ownerRunId = "55555555-5555-4555-8555-555555555555";
const peerRunId = "66666666-6666-4666-8666-666666666666";

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

function registerRouteMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({ trackAgentTaskCompleted: vi.fn(), trackErrorHandlerCrash: vi.fn() }));
  vi.doMock("../telemetry.js", () => ({ getTelemetryClient: vi.fn(() => ({ track: vi.fn() })) }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => mockAgentService,
    companyService: () => mockCompanyService,
    documentService: () => mockDocumentService,
    documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
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

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: issueId,
    companyId,
    status: "in_progress",
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
    title: "MAD-203 replay",
    executionPolicy: null,
    executionState: null,
    hiddenAt: null,
    ...overrides,
  };
}

function createRunContextDb() {
  return {
    transaction: async (callback: (tx: { insert: () => { values: () => Promise<void> } }) => Promise<unknown>) => callback({ insert: () => ({ values: async () => undefined }) }),
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ then: async (resolve: (rows: unknown[]) => unknown) => resolve([]) })) })) })),
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ errorHandler }, { issueRoutes }] = await Promise.all([
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", issueRoutes(createRunContextDb() as any, mockStorageService as any));
  app.use(errorHandler);
  return app;
}

function peerActor() {
  return { type: "agent", agentId: peerAgentId, companyId, source: "agent_key", runId: peerRunId };
}

function ownerActor() {
  return { type: "agent", agentId: ownerAgentId, companyId, source: "agent_key", runId: ownerRunId };
}

describe("issues route checkout conflict error codes", () => {
  beforeEach(() => {
    vi.resetModules();
    registerRouteMocks();
    vi.clearAllMocks();
    mockAccessService.decide.mockResolvedValue({ allowed: false, reason: "no override" });
    mockAgentService.resolveByReference.mockResolvedValue({ ambiguous: false, agent: null });
    mockCompanyService.getById.mockResolvedValue({ id: companyId, issuePrefix: "MAD" });
    mockIssueService.getByIdentifier.mockResolvedValue(null);
    mockIssueService.findMentionedAgents.mockResolvedValue([]);
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getCurrentScheduledRetry.mockResolvedValue(null);
    mockIssueService.update.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({ ...makeIssue(), ...patch }));
  });

  it("returns assignee_mismatch when a stale reviewer mutates an in_progress issue owned by another assignee", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue());

    const res = await request(await createApp(peerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "stale reviewer write" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Issue is checked out by another agent",
      errorCode: "assignee_mismatch",
      currentAssigneeAgentId: ownerAgentId,
      currentCheckoutRunId: null,
      executionState: { status: null, currentParticipant: null, lastDecisionId: null },
    });
    expect(mockIssueService.assertCheckoutOwner).not.toHaveBeenCalled();
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("returns checkout_held_by_other_run when a same-assignee write has a foreign checkout lock", async () => {
    const foreignRunId = "88888888-8888-4888-8888-888888888888";
    mockIssueService.getById.mockResolvedValue(makeIssue({ checkoutRunId: foreignRunId, executionRunId: foreignRunId }));
    mockIssueService.assertCheckoutOwner.mockRejectedValue(new HttpError(409, "Issue checkout conflict"));

    const res = await request(await createApp(ownerActor()))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "owner write with stale run" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Issue is checked out by another agent",
      errorCode: "checkout_held_by_other_run",
      currentAssigneeAgentId: ownerAgentId,
      currentCheckoutRunId: foreignRunId,
    });
    expect(mockIssueService.update).not.toHaveBeenCalled();
  });

  it("preserves active subtree pause hold conflicts during checkout", async () => {
    mockIssueService.getById.mockResolvedValue(makeIssue({ status: "blocked" }));
    mockIssueService.checkout.mockRejectedValue(
      new HttpError(409, "Issue checkout blocked by active subtree pause hold", {
        issueId,
        holdId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        rootIssueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        mode: "subtree",
      }),
    );

    const res = await request(await createApp(ownerActor()))
      .post(`/api/issues/${issueId}/checkout`)
      .send({ agentId: ownerAgentId, expectedStatuses: ["blocked", "in_review"] });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      error: "Issue checkout blocked by active subtree pause hold",
      errorCode: "active_subtree_pause_hold",
      currentAssigneeAgentId: ownerAgentId,
      currentCheckoutRunId: null,
      details: {
        issueId,
        status: "blocked",
        assigneeAgentId: ownerAgentId,
        checkoutRunId: null,
        actorAgentId: ownerAgentId,
        actorRunId: ownerRunId,
        conflictDetails: {
          issueId,
          holdId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          rootIssueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          mode: "subtree",
        },
      },
    });
  });
});
