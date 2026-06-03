// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueWriteConflictBanner } from "./IssueWriteConflictBanner";
import type { IssueWriteConflict } from "../lib/issueWriteConflict";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeConflict(errorCode: IssueWriteConflict["errorCode"], overrides: Partial<IssueWriteConflict> = {}): IssueWriteConflict {
  return {
    errorCode,
    message: "conflict",
    currentAssigneeAgentId: null,
    currentCheckoutRunId: null,
    executionState: { status: null, currentParticipant: null, lastDecisionId: null },
    ...overrides,
  };
}

describe("IssueWriteConflictBanner", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  it("renders checkout_held_by_other_run banner with run id prefix", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <IssueWriteConflictBanner
          conflict={makeConflict("checkout_held_by_other_run", {
            currentCheckoutRunId: "abcdef12-1111-2222-3333-444455556666",
          })}
          onDismiss={() => {}}
        />,
      );
    });
    const banner = container.querySelector('[data-testid="issue-write-conflict-checkout-held"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("checkout");
    expect(banner?.textContent).toContain("abcdef12");
    act(() => root.unmount());
  });

  it("renders assignee_mismatch banner with Refresh button + label", () => {
    const onRefresh = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(
        <IssueWriteConflictBanner
          conflict={makeConflict("assignee_mismatch", { currentAssigneeAgentId: "agent-2" })}
          newAssigneeLabel="Bob"
          onRefresh={onRefresh}
        />,
      );
    });
    const banner = container.querySelector('[data-testid="issue-write-conflict-assignee-mismatch"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Bob");
    const refreshBtn = container.querySelector<HTMLButtonElement>('[data-testid="issue-write-conflict-refresh"]');
    expect(refreshBtn).not.toBeNull();
    act(() => refreshBtn!.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it("renders wake_context_stale banner and auto-dismisses after timeout", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(
        <IssueWriteConflictBanner
          conflict={makeConflict("wake_context_stale")}
          onDismiss={onDismiss}
        />,
      );
    });
    const banner = container.querySelector('[data-testid="issue-write-conflict-wake-stale"]');
    expect(banner).not.toBeNull();
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });
});
