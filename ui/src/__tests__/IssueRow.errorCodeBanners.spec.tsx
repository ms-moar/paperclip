// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IssueWriteConflictBanner } from "../components/IssueWriteConflictBanner";
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

describe("IssueRow typed 409 banners", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  it("snapshots checkout_held_by_other_run banner copy with the conflicting run prefix", () => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <IssueWriteConflictBanner
          conflict={makeConflict("checkout_held_by_other_run", {
            currentCheckoutRunId: "abcdef12-1111-2222-3333-444455556666",
          })}
          onDismiss={() => {}}
        />,
      );
    });

    expect(container.querySelector('[data-testid="issue-write-conflict-checkout-held"]')?.textContent).toMatchInlineSnapshot(
      `"Кто-то другой держит checkoutАктивный run другого агента удерживает checkout. Подожди завершения или повтори с backoff. Run: abcdef12Закрыть"`,
    );
    flushSync(() => root.unmount());
  });

  it("snapshots assignee_mismatch banner copy and exposes refresh action", () => {
    const onRefresh = vi.fn();
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <IssueWriteConflictBanner
          conflict={makeConflict("assignee_mismatch", { currentAssigneeAgentId: "agent-2" })}
          newAssigneeLabel="Mid Engineer A"
          onRefresh={onRefresh}
        />,
      );
    });

    expect(container.querySelector('[data-testid="issue-write-conflict-assignee-mismatch"]')?.textContent).toMatchInlineSnapshot(
      `"Контекст устарелIssue передан другому ассайни (Mid Engineer A). Обнови страницу, чтобы продолжить.Refresh"`,
    );
    flushSync(() => container.querySelector<HTMLButtonElement>('[data-testid="issue-write-conflict-refresh"]')?.click());
    expect(onRefresh).toHaveBeenCalledTimes(1);
    flushSync(() => root.unmount());
  });

  it("snapshots wake_context_stale banner copy and auto-clears it", () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const root = createRoot(container);
    flushSync(() => {
      root.render(<IssueWriteConflictBanner conflict={makeConflict("wake_context_stale")} onDismiss={onDismiss} />);
    });

    expect(container.querySelector('[data-testid="issue-write-conflict-wake-stale"]')?.textContent).toMatchInlineSnapshot(
      `"Wake устарелWake-context устарел (decision pointer продвинулся). Сервер уже свернул дубли — баннер закроется автоматически."`,
    );
    flushSync(() => vi.advanceTimersByTime(5_000));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    flushSync(() => root.unmount());
  });
});
