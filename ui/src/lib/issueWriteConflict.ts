import type {
  IssueExecutionStateStatus,
  IssueExecutionStagePrincipal,
  IssueWriteConflictErrorCode,
  IssueWriteConflictResponse,
} from "@paperclipai/shared";
import { ApiError } from "../api/client";

export type IssueWriteConflict = {
  errorCode: IssueWriteConflictErrorCode;
  message: string;
  currentAssigneeAgentId: string | null;
  currentCheckoutRunId: string | null;
  executionState: {
    status: IssueExecutionStateStatus | null;
    currentParticipant: IssueExecutionStagePrincipal | null;
    lastDecisionId: string | null;
  };
};

const KNOWN_ERROR_CODES: ReadonlySet<IssueWriteConflictErrorCode> = new Set([
  "checkout_held_by_other_run",
  "assignee_mismatch",
  "wake_context_stale",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readParticipant(value: unknown): IssueExecutionStagePrincipal | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  if (type !== "agent" && type !== "user") return null;
  return {
    type,
    agentId: typeof value.agentId === "string" ? value.agentId : null,
    userId: typeof value.userId === "string" ? value.userId : null,
  } as IssueExecutionStagePrincipal;
}

export function parseIssueWriteConflict(body: unknown): IssueWriteConflict | null {
  if (!isRecord(body)) return null;
  const code = body.errorCode;
  if (typeof code !== "string" || !KNOWN_ERROR_CODES.has(code as IssueWriteConflictErrorCode)) return null;
  const exec = isRecord(body.executionState) ? body.executionState : {};
  return {
    errorCode: code as IssueWriteConflictErrorCode,
    message: readString(body.error) ?? "Issue write conflict",
    currentAssigneeAgentId: readString(body.currentAssigneeAgentId),
    currentCheckoutRunId: readString(body.currentCheckoutRunId),
    executionState: {
      status: (typeof exec.status === "string" ? exec.status : null) as IssueExecutionStateStatus | null,
      currentParticipant: readParticipant(exec.currentParticipant),
      lastDecisionId: readString(exec.lastDecisionId),
    },
  };
}

export function getIssueWriteConflictFromError(error: unknown): IssueWriteConflict | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 409) return null;
  return parseIssueWriteConflict(error.body);
}

export function isAutoClearingConflict(conflict: IssueWriteConflict): boolean {
  return conflict.errorCode === "wake_context_stale";
}

export function isExpectedResponse(value: unknown): value is IssueWriteConflictResponse {
  return parseIssueWriteConflict(value) !== null;
}
