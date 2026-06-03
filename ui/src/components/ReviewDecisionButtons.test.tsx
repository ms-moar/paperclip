// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  ReviewDecisionButtons,
  isReviewDecisionAvailable,
  type ReviewDecisionViewer,
} from "./ReviewDecisionButtons";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

type IssueShape = Pick<Issue, "status" | "executionState">;

function makeIssue(overrides: Partial<IssueShape> = {}): IssueShape {
  return {
    status: "in_review",
    executionState: {
      status: "pending",
      currentParticipant: { type: "user", agentId: null, userId: "user-1" },
      lastDecisionId: null,
    } as IssueShape["executionState"],
    ...overrides,
  } as IssueShape;
}

describe("isReviewDecisionAvailable", () => {
  it("returns true when issue in_review and participant matches viewer user", () => {
    expect(
      isReviewDecisionAvailable(makeIssue(), { agentId: null, userId: "user-1" }),
    ).toBe(true);
  });

  it("returns false when status is not in_review", () => {
    expect(
      isReviewDecisionAvailable(makeIssue({ status: "in_progress" }), { agentId: null, userId: "user-1" }),
    ).toBe(false);
  });

  it("returns false when executionState pending but participant is different user", () => {
    expect(
      isReviewDecisionAvailable(makeIssue(), { agentId: null, userId: "user-other" }),
    ).toBe(false);
  });

  it("returns true for matching agent viewer", () => {
    const issue = makeIssue({
      executionState: {
        status: "pending",
        currentParticipant: { type: "agent", agentId: "agent-9", userId: null },
        lastDecisionId: null,
      } as IssueShape["executionState"],
    });
    expect(isReviewDecisionAvailable(issue, { agentId: "agent-9", userId: null })).toBe(true);
    expect(isReviewDecisionAvailable(issue, { agentId: "agent-x", userId: null })).toBe(false);
  });

  it("returns false when executionState missing", () => {
    expect(
      isReviewDecisionAvailable(makeIssue({ executionState: null as unknown as IssueShape["executionState"] }), {
        agentId: null,
        userId: "user-1",
      }),
    ).toBe(false);
  });
});

describe("ReviewDecisionButtons", () => {
  let container: HTMLDivElement;
  const viewer: ReviewDecisionViewer = { agentId: null, userId: "user-1" };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders nothing when not available", () => {
    const root = createRoot(container);
    act(() => {
      root.render(
        <ReviewDecisionButtons
          issue={makeIssue({ status: "todo" })}
          viewer={viewer}
          onSubmit={() => {}}
        />,
      );
    });
    expect(container.querySelector('[data-testid="review-decision-buttons"]')).toBeNull();
    act(() => root.unmount());
  });

  it("submits Approve with status=done", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ReviewDecisionButtons issue={makeIssue()} viewer={viewer} onSubmit={onSubmit} />,
      );
    });
    const approveBtn = container.querySelector<HTMLButtonElement>('[data-testid="review-decision-approve"]');
    expect(approveBtn).not.toBeNull();
    act(() => approveBtn!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="review-decision-comment"]');
    expect(textarea).not.toBeNull();
    act(() => {
      setTextareaValue(textarea!, "Looks good");
    });
    const submitBtn = container.querySelector<HTMLButtonElement>('[data-testid="review-decision-submit"]');
    await act(async () => {
      submitBtn!.click();
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledWith({ status: "done", comment: "Looks good" });
    act(() => root.unmount());
  });

  it("submits Request changes with status=in_progress", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const root = createRoot(container);
    act(() => {
      root.render(
        <ReviewDecisionButtons issue={makeIssue()} viewer={viewer} onSubmit={onSubmit} />,
      );
    });
    const rcBtn = container.querySelector<HTMLButtonElement>('[data-testid="review-decision-request-changes"]');
    act(() => rcBtn!.click());
    const textarea = container.querySelector<HTMLTextAreaElement>('[data-testid="review-decision-comment"]');
    act(() => {
      setTextareaValue(textarea!, "Please fix X");
    });
    const submitBtn = container.querySelector<HTMLButtonElement>('[data-testid="review-decision-submit"]');
    await act(async () => {
      submitBtn!.click();
      await Promise.resolve();
    });
    expect(onSubmit).toHaveBeenCalledWith({ status: "in_progress", comment: "Please fix X" });
    act(() => root.unmount());
  });

  it("disables submit when comment is empty", () => {
    const onSubmit = vi.fn();
    const root = createRoot(container);
    act(() => {
      root.render(
        <ReviewDecisionButtons issue={makeIssue()} viewer={viewer} onSubmit={onSubmit} />,
      );
    });
    const approveBtn = container.querySelector<HTMLButtonElement>('[data-testid="review-decision-approve"]');
    act(() => approveBtn!.click());
    const submitBtn = container.querySelector<HTMLButtonElement>('[data-testid="review-decision-submit"]');
    expect(submitBtn?.hasAttribute("disabled")).toBe(true);
    act(() => root.unmount());
  });
});
