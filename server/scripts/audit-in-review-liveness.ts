/**
 * MAD-203 PR-B pre-merge audit.
 *
 * Counts how many `issue.updated → status=in_review` transitions in the
 * last N days would have been blocked by the new universal liveness guard
 * (STRICT_REVIEW_GUARD=on). Approximates the historical liveness state by
 * consulting current issue/interaction/heartbeat rows.
 *
 * Usage:
 *   pnpm --filter @paperclipai/server exec tsx scripts/audit-in-review-liveness.ts [--days 30]
 */
import {
  activityLog,
  createDb,
  heartbeatRuns,
  issueThreadInteractions,
  issues as issueRows,
} from "../../packages/db/src/index.js";
import { and, eq, sql } from "drizzle-orm";
import { loadConfig } from "../src/config.js";
import { normalizeIssueExecutionPolicy } from "../src/services/issue-execution-policy.js";

const PENDING_INTERACTION_KINDS = new Set([
  "ask_user_questions",
  "request_confirmation",
  "suggest_tasks",
]);

function parseDays(): number {
  const idx = process.argv.indexOf("--days");
  if (idx < 0) return 30;
  const raw = process.argv[idx + 1];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function hasExecutionPolicyStageReviewer(policy: unknown): boolean {
  const normalized = normalizeIssueExecutionPolicy(policy ?? null);
  if (!normalized) return false;
  return normalized.stages.some(
    (stage) => Array.isArray(stage.participants) && stage.participants.length > 0,
  );
}

async function main() {
  const days = parseDays();
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);

  const transitions = await db
    .select({
      id: activityLog.id,
      entityId: activityLog.entityId,
      companyId: activityLog.companyId,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
      actorType: activityLog.actorType,
    })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.entityType, "issue"),
        eq(activityLog.action, "issue.updated"),
        sql`${activityLog.details} ->> 'status' = 'in_review'`,
        sql`(${activityLog.details} -> '_previous' ->> 'status') IS DISTINCT FROM 'in_review'`,
        sql`${activityLog.createdAt} > now() - (${days} || ' days')::interval`,
      ),
    );

  console.log(
    JSON.stringify({
      window_days: days,
      total_in_review_transitions: transitions.length,
    }),
  );

  let wouldBlock = 0;
  const blockedByActor: Record<string, number> = {};
  const blockedExamples: Array<{
    issueId: string;
    createdAt: Date;
    actorType: string | null;
    identifier: string | null;
  }> = [];

  for (const row of transitions) {
    const issueId = row.entityId;
    if (!issueId) continue;
    const transitionAt = row.createdAt;
    const details = (row.details ?? {}) as Record<string, unknown>;

    // (1) executionPolicy stage participants — read current row (best-effort).
    const issue = await db.query.issues
      ? await db.query.issues.findFirst({ where: eq(issueRows.id, issueId) })
      : (await db.select().from(issueRows).where(eq(issueRows.id, issueId)).limit(1))[0];
    let satisfied = false;

    if (issue && hasExecutionPolicyStageReviewer(issue.executionPolicy)) {
      satisfied = true;
    }

    // (2) monitor — embed in details (executionState.monitor) OR current monitorNextCheckAt set at/before transition.
    if (!satisfied) {
      const detailsExecutionState =
        (details.executionState as Record<string, unknown> | undefined) ?? null;
      const monitorFromDetails =
        detailsExecutionState && (detailsExecutionState as Record<string, unknown>).monitor;
      if (monitorFromDetails && typeof monitorFromDetails === "object") {
        satisfied = true;
      } else if (issue && issue.monitorNextCheckAt && issue.monitorNextCheckAt <= transitionAt) {
        satisfied = true;
      }
    }

    // (3) pending interaction at transition time.
    if (!satisfied) {
      const interactions = await db
        .select({
          id: issueThreadInteractions.id,
          kind: issueThreadInteractions.kind,
          status: issueThreadInteractions.status,
          createdAt: issueThreadInteractions.createdAt,
          resolvedAt: issueThreadInteractions.resolvedAt,
        })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.issueId, issueId));
      for (const interaction of interactions) {
        if (!PENDING_INTERACTION_KINDS.has(String(interaction.kind))) continue;
        if (interaction.createdAt > transitionAt) continue;
        if (interaction.resolvedAt && interaction.resolvedAt <= transitionAt) continue;
        satisfied = true;
        break;
      }
    }

    // (4) scheduledRetry — heartbeat run with status scheduled_retry whose nextAttempt is in the future relative to transition.
    if (!satisfied) {
      const retryRows = await db
        .select({
          scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
          status: heartbeatRuns.status,
        })
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.companyId, row.companyId),
            sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
          ),
        );
      for (const retry of retryRows) {
        if (retry.status !== "scheduled_retry") continue;
        if (retry.scheduledRetryAt && retry.scheduledRetryAt > transitionAt) {
          satisfied = true;
          break;
        }
      }
    }

    if (!satisfied) {
      wouldBlock += 1;
      const actor = row.actorType ?? "unknown";
      blockedByActor[actor] = (blockedByActor[actor] ?? 0) + 1;
      if (blockedExamples.length < 10) {
        blockedExamples.push({
          issueId,
          createdAt: transitionAt,
          actorType: row.actorType,
          identifier: issue?.identifier ?? null,
        });
      }
    }
  }

  console.log(
    JSON.stringify({
      would_be_blocked: wouldBlock,
      by_actor: blockedByActor,
      ratio: transitions.length === 0 ? 0 : Number((wouldBlock / transitions.length).toFixed(3)),
      examples: blockedExamples,
    }),
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("Audit failed:", err);
  process.exit(1);
});
