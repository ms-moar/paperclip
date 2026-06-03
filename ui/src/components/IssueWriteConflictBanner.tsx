import { useEffect } from "react";
import { AlertTriangle, RefreshCw, Clock, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { IssueWriteConflict } from "../lib/issueWriteConflict";

const AUTO_CLEAR_MS = 5000;

interface IssueWriteConflictBannerProps {
  conflict: IssueWriteConflict;
  newAssigneeLabel?: string | null;
  onRefresh?: () => void;
  onDismiss?: () => void;
  refreshing?: boolean;
}

export function IssueWriteConflictBanner({
  conflict,
  newAssigneeLabel,
  onRefresh,
  onDismiss,
  refreshing,
}: IssueWriteConflictBannerProps) {
  useEffect(() => {
    if (conflict.errorCode !== "wake_context_stale" || !onDismiss) return;
    const timer = window.setTimeout(onDismiss, AUTO_CLEAR_MS);
    return () => window.clearTimeout(timer);
  }, [conflict.errorCode, onDismiss]);

  if (conflict.errorCode === "checkout_held_by_other_run") {
    return (
      <BannerShell
        testId="issue-write-conflict-checkout-held"
        tone="amber"
        icon={<Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />}
        title="Кто-то другой держит checkout"
        body={
          <p className="leading-5">
            Активный run другого агента удерживает checkout. Подожди завершения или повтори с backoff.
            {conflict.currentCheckoutRunId ? (
              <>
                {" "}Run:{" "}
                <code className="rounded bg-amber-100 px-1 py-0.5 text-[12px] dark:bg-amber-400/15">
                  {conflict.currentCheckoutRunId.slice(0, 8)}
                </code>
              </>
            ) : null}
          </p>
        }
        actions={
          onDismiss ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={onDismiss}
              data-testid="issue-write-conflict-dismiss"
            >
              Закрыть
            </Button>
          ) : null
        }
      />
    );
  }

  if (conflict.errorCode === "assignee_mismatch") {
    const label = newAssigneeLabel ?? conflict.currentAssigneeAgentId ?? "новый ассайни";
    return (
      <BannerShell
        testId="issue-write-conflict-assignee-mismatch"
        tone="amber"
        icon={<AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />}
        title="Контекст устарел"
        body={
          <p className="leading-5">
            Issue передан другому ассайни (<span className="font-medium">{label}</span>). Обнови страницу, чтобы продолжить.
          </p>
        }
        actions={
          onRefresh ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1.5"
              onClick={onRefresh}
              disabled={refreshing}
              data-testid="issue-write-conflict-refresh"
            >
              <RefreshCw className={refreshing ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              {refreshing ? "Обновляем…" : "Refresh"}
            </Button>
          ) : null
        }
      />
    );
  }

  return (
    <BannerShell
      testId="issue-write-conflict-wake-stale"
      tone="slate"
      icon={<Clock className="mt-0.5 h-4 w-4 shrink-0 text-slate-600 dark:text-slate-300" />}
      title="Wake устарел"
      body={
        <p className="leading-5">
          Wake-context устарел (decision pointer продвинулся). Сервер уже свернул дубли — баннер закроется автоматически.
        </p>
      }
      actions={null}
    />
  );
}

function BannerShell({
  testId,
  tone,
  icon,
  title,
  body,
  actions,
}: {
  testId: string;
  tone: "amber" | "slate";
  icon: React.ReactNode;
  title: string;
  body: React.ReactNode;
  actions: React.ReactNode;
}) {
  const toneClass = tone === "amber"
    ? "border-amber-300/70 bg-amber-50/90 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
    : "border-slate-300/70 bg-slate-50/90 text-slate-900 dark:border-slate-500/40 dark:bg-slate-500/10 dark:text-slate-100";
  return (
    <div
      data-testid={testId}
      role="alert"
      className={`mb-3 rounded-md border px-3 py-2.5 text-sm shadow-sm ${toneClass}`}
    >
      <div className="flex items-start gap-2">
        {icon}
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="font-medium leading-5">{title}</p>
          {body}
          {actions ? <div className="pt-0.5">{actions}</div> : null}
        </div>
      </div>
    </div>
  );
}
