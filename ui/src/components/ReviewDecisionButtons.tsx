import { useState } from "react";
import { Check, X } from "lucide-react";
import type { Issue } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";

export interface ReviewDecisionViewer {
  agentId: string | null;
  userId: string | null;
}

export interface ReviewDecisionButtonsProps {
  issue: Pick<Issue, "status" | "executionState">;
  viewer: ReviewDecisionViewer;
  onSubmit: (decision: { status: "done" | "in_progress"; comment: string }) => Promise<void> | void;
  submitting?: boolean;
}

export function isReviewDecisionAvailable(
  issue: Pick<Issue, "status" | "executionState">,
  viewer: ReviewDecisionViewer,
): boolean {
  if (issue.status !== "in_review") return false;
  const state = issue.executionState;
  if (!state || state.status !== "pending") return false;
  const participant = state.currentParticipant;
  if (!participant) return false;
  if (participant.type === "agent") return !!viewer.agentId && participant.agentId === viewer.agentId;
  return !!viewer.userId && participant.userId === viewer.userId;
}

export function ReviewDecisionButtons({ issue, viewer, onSubmit, submitting }: ReviewDecisionButtonsProps) {
  const [open, setOpen] = useState<null | "approve" | "request_changes">(null);
  const [comment, setComment] = useState("");
  const [submittingLocal, setSubmittingLocal] = useState(false);

  if (!isReviewDecisionAvailable(issue, viewer)) return null;
  const busy = submitting || submittingLocal;

  const handleSubmit = async (decision: "approve" | "request_changes") => {
    const trimmed = comment.trim();
    if (!trimmed) return;
    setSubmittingLocal(true);
    try {
      await onSubmit({
        status: decision === "approve" ? "done" : "in_progress",
        comment: trimmed,
      });
      setComment("");
      setOpen(null);
    } finally {
      setSubmittingLocal(false);
    }
  };

  return (
    <div
      data-testid="review-decision-buttons"
      className="mb-3 rounded-md border border-blue-300/70 bg-blue-50/80 px-3 py-2.5 text-sm text-blue-950 shadow-sm dark:border-blue-500/40 dark:bg-blue-500/10 dark:text-blue-100"
    >
      <p className="font-medium leading-5">Ты ревьюер на этом stage</p>
      <p className="mt-1 text-xs leading-5 text-blue-900/80 dark:text-blue-100/80">
        Подтверди или верни на доработку. Checkout не требуется — сервер примет решение по reviewer evidence path.
      </p>
      {open ? (
        <div className="mt-2 space-y-2">
          <textarea
            data-testid="review-decision-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            disabled={busy}
            placeholder={open === "approve" ? "Что подтверждаешь" : "Что просишь изменить"}
            className="w-full rounded-md border border-blue-300/70 bg-background/80 px-2 py-1.5 text-sm text-foreground outline-none focus:border-blue-500 dark:border-blue-500/40 dark:bg-background/40"
          />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-7"
              disabled={busy || !comment.trim()}
              onClick={() => handleSubmit(open)}
              data-testid="review-decision-submit"
            >
              {busy ? "Отправляем…" : open === "approve" ? "Approve" : "Request changes"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={busy}
              onClick={() => {
                setOpen(null);
                setComment("");
              }}
              data-testid="review-decision-cancel"
            >
              Отмена
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="h-7 gap-1.5"
            onClick={() => setOpen("approve")}
            data-testid="review-decision-approve"
          >
            <Check className="h-3.5 w-3.5" />
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5"
            onClick={() => setOpen("request_changes")}
            data-testid="review-decision-request-changes"
          >
            <X className="h-3.5 w-3.5" />
            Request changes
          </Button>
        </div>
      )}
    </div>
  );
}
