import { describe, expect, it } from "vitest";
import {
  getIssueWriteConflictFromError,
  isAutoClearingConflict,
  isExpectedResponse,
  parseIssueWriteConflict,
} from "./issueWriteConflict";
import { ApiError } from "../api/client";

describe("parseIssueWriteConflict", () => {
  it("parses checkout_held_by_other_run with currentCheckoutRunId", () => {
    const body = {
      error: "Checkout held by another run",
      errorCode: "checkout_held_by_other_run",
      currentAssigneeAgentId: null,
      currentCheckoutRunId: "11111111-2222-3333-4444-555555555555",
      executionState: {
        status: "pending",
        currentParticipant: { type: "agent", agentId: "agent-1", userId: null },
        lastDecisionId: null,
      },
    };
    const conflict = parseIssueWriteConflict(body);
    expect(conflict).not.toBeNull();
    expect(conflict?.errorCode).toBe("checkout_held_by_other_run");
    expect(conflict?.currentCheckoutRunId).toBe("11111111-2222-3333-4444-555555555555");
    expect(conflict?.executionState.currentParticipant?.type).toBe("agent");
  });

  it("parses assignee_mismatch with currentAssigneeAgentId", () => {
    const body = {
      error: "Assignee changed",
      errorCode: "assignee_mismatch",
      currentAssigneeAgentId: "agent-new",
      currentCheckoutRunId: null,
      executionState: { status: "idle", currentParticipant: null, lastDecisionId: null },
    };
    const conflict = parseIssueWriteConflict(body);
    expect(conflict?.errorCode).toBe("assignee_mismatch");
    expect(conflict?.currentAssigneeAgentId).toBe("agent-new");
  });

  it("parses wake_context_stale", () => {
    const body = {
      error: "Wake stale",
      errorCode: "wake_context_stale",
      currentAssigneeAgentId: null,
      currentCheckoutRunId: null,
      executionState: { status: null, currentParticipant: null, lastDecisionId: "dec-1" },
    };
    const conflict = parseIssueWriteConflict(body);
    expect(conflict?.errorCode).toBe("wake_context_stale");
    expect(isAutoClearingConflict(conflict!)).toBe(true);
  });

  it("rejects unknown errorCode", () => {
    expect(parseIssueWriteConflict({ errorCode: "something_else" })).toBeNull();
  });

  it("rejects non-object body", () => {
    expect(parseIssueWriteConflict(null)).toBeNull();
    expect(parseIssueWriteConflict("string")).toBeNull();
    expect(parseIssueWriteConflict(42)).toBeNull();
  });

  it("isAutoClearingConflict returns true only for wake_context_stale", () => {
    const checkout = parseIssueWriteConflict({
      errorCode: "checkout_held_by_other_run",
      executionState: {},
    });
    expect(isAutoClearingConflict(checkout!)).toBe(false);
    const assignee = parseIssueWriteConflict({
      errorCode: "assignee_mismatch",
      executionState: {},
    });
    expect(isAutoClearingConflict(assignee!)).toBe(false);
  });

  it("isExpectedResponse acts as a type guard", () => {
    expect(isExpectedResponse({ errorCode: "checkout_held_by_other_run", executionState: {} })).toBe(true);
    expect(isExpectedResponse({ errorCode: "xx", executionState: {} })).toBe(false);
  });
});

describe("getIssueWriteConflictFromError", () => {
  it("returns parsed conflict from ApiError 409", () => {
    const err = new ApiError("conflict", 409, {
      error: "x",
      errorCode: "assignee_mismatch",
      executionState: {},
    });
    const conflict = getIssueWriteConflictFromError(err);
    expect(conflict?.errorCode).toBe("assignee_mismatch");
  });

  it("returns null for non-409 ApiError", () => {
    expect(
      getIssueWriteConflictFromError(
        new ApiError("server", 500, { errorCode: "assignee_mismatch", executionState: {} }),
      ),
    ).toBeNull();
  });

  it("returns null for non-ApiError", () => {
    expect(getIssueWriteConflictFromError(new Error("boom"))).toBeNull();
    expect(getIssueWriteConflictFromError(null)).toBeNull();
  });
});
