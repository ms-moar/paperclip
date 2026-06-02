import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const companyId = "22222222-2222-4222-8222-222222222222";
const otherCompanyId = "33333333-3333-4333-8333-333333333333";
const agentId = "11111111-1111-4111-8111-111111111111";

const mockCompanyService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));

const mockCostService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn(),
  issueTreeSummary: vi.fn(),
  byAgent: vi.fn(),
  byAgentModel: vi.fn(),
  byProvider: vi.fn(),
  byBiller: vi.fn(),
  windowSpend: vi.fn(),
  byProject: vi.fn(),
}));

const mockFinanceService = vi.hoisted(() => ({
  createEvent: vi.fn(),
  summary: vi.fn(),
  byBiller: vi.fn(),
  byKind: vi.fn(),
  list: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  overview: vi.fn(),
  upsertPolicy: vi.fn(),
  resolveIncident: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  getByIdentifier: vi.fn(),
  getById: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelBudgetScopeWork: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockFetchAllQuotaWindows = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  budgetService: () => mockBudgetService,
  companyService: () => mockCompanyService,
  costService: () => mockCostService,
  financeService: () => mockFinanceService,
  heartbeatService: () => mockHeartbeatService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
}));

vi.mock("../services/quota-windows.js", () => ({
  fetchAllQuotaWindows: mockFetchAllQuotaWindows,
}));

let routeModules:
  | Promise<[
    typeof import("../middleware/index.js"),
    typeof import("../routes/costs.js"),
  ]>
  | null = null;

async function loadRouteModules() {
  routeModules ??= Promise.all([
    import("../middleware/index.js"),
    import("../routes/costs.js"),
  ]);
  return routeModules;
}

async function createApp(actor: Express.Request["actor"]) {
  const [{ errorHandler }, { costRoutes }] = await loadRouteModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor;
    next();
  });
  app.use("/api", costRoutes({} as never));
  app.use(errorHandler);
  return app;
}

function agentActor(overrides: Partial<Express.Request["actor"]> = {}): Express.Request["actor"] {
  return {
    type: "agent",
    agentId,
    companyId,
    source: "agent_key",
    ...overrides,
  };
}

function boardActor(overrides: Partial<Express.Request["actor"]> = {}): Express.Request["actor"] {
  return {
    type: "board",
    userId: "user-1",
    companyIds: [companyId],
    source: "board_key",
    ...overrides,
  };
}

describe("cost routes quota-window authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCompanyService.getById.mockResolvedValue({ id: companyId, name: "Acme" });
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId,
      permissions: { canReadQuotaWindows: true },
    });
    mockFetchAllQuotaWindows.mockResolvedValue([
      { provider: "anthropic", ok: true, windows: [] },
    ]);
  });

  it("allows an agent with explicit quota-window read permission", async () => {
    const app = await createApp(agentActor());

    await request(app)
      .get(`/api/companies/${companyId}/costs/quota-windows`)
      .expect(200)
      .expect([{ provider: "anthropic", ok: true, windows: [] }]);

    expect(mockFetchAllQuotaWindows).toHaveBeenCalledTimes(1);
  });

  it("rejects same-company agents without the quota-window read permission", async () => {
    mockAgentService.getById.mockResolvedValue({
      id: agentId,
      companyId,
      permissions: { canReadQuotaWindows: false },
    });
    const app = await createApp(agentActor());

    await request(app)
      .get(`/api/companies/${companyId}/costs/quota-windows`)
      .expect(403);

    expect(mockFetchAllQuotaWindows).not.toHaveBeenCalled();
  });

  it("rejects cross-company agent quota-window reads before provider credentials are touched", async () => {
    const app = await createApp(agentActor({ companyId: otherCompanyId }));

    await request(app)
      .get(`/api/companies/${companyId}/costs/quota-windows`)
      .expect(403);

    expect(mockAgentService.getById).not.toHaveBeenCalled();
    expect(mockFetchAllQuotaWindows).not.toHaveBeenCalled();
  });

  it("keeps the existing board read path for company members", async () => {
    const app = await createApp(boardActor());

    await request(app)
      .get(`/api/companies/${companyId}/costs/quota-windows`)
      .expect(200);

    expect(mockFetchAllQuotaWindows).toHaveBeenCalledTimes(1);
  });

  it("rejects board users outside the company", async () => {
    const app = await createApp(boardActor({ companyIds: [otherCompanyId] }));

    await request(app)
      .get(`/api/companies/${companyId}/costs/quota-windows`)
      .expect(403);

    expect(mockFetchAllQuotaWindows).not.toHaveBeenCalled();
  });
});
