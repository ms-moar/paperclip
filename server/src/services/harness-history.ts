// Synchronous commit-on-write for harness-managed docs.
// Implements MAD-255 plan §3.1 (Layer A) and §4 (metadata trailer).
// Wrapper script `/usr/local/sbin/paperclip-harness-history` is shipped by MAD-257.
// While the wrapper is absent or `PAPERCLIP_HARNESS_HISTORY_DISABLED=1` the service
// degrades to silent passthrough so dev/test/pre-rollout servers stay bootable.
// Once the wrapper exists and the disabled flag is unset, the boot probe enforces
// fail-closed semantics described in plan §5.

import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { HttpError } from "../errors.js";

const DEFAULT_WRAPPER_PATH = "/usr/local/sbin/paperclip-harness-history";

function isTrueish(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveWrapperPath(): string {
  return process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER?.trim() || DEFAULT_WRAPPER_PATH;
}

function isDisabled(): boolean {
  return isTrueish(process.env.PAPERCLIP_HARNESS_HISTORY_DISABLED);
}

export type HarnessHistoryActorType =
  | "agent"
  | "board-user"
  | "oob-watcher"
  | "plugin-install"
  | "hire-hook"
  | "company-import"
  | "company-import-safe"
  | "company-import-revert"
  | "company-import-operator-revert";

export interface HarnessHistoryActor {
  type: HarnessHistoryActorType;
  id: string;
  display?: string;
}

export interface HarnessHistoryContext {
  reason: string;
  paths: string[];
  actor: HarnessHistoryActor;
  runId?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
  trigger?: string;
  importId?: string | null;
  agentSlug?: string | null;
  revertedAgentSlug?: string | null;
  category?: "feat" | "fix" | "chore" | "oob" | "init" | "delete" | "rename" | "revert";
  scope?: string;
  summary?: string;
}

export interface HarnessHistoryCommitResult {
  committed: boolean;
  sha: string | null;
  reason?: string;
}

export interface HarnessHistorySnapshot {
  /** Map absolutePath → previous file bytes, or null when the path didn't exist before. */
  entries: Map<string, Buffer | null>;
}

export interface RevertAgentBundleInput {
  importId: string;
  companyId: string;
  agentId: string;
  revertedAgentSlug: string;
  boardUserId: string;
  runId?: string | null;
  issueId?: string | null;
  issueIdentifier?: string | null;
}

export interface HarnessHistoryService {
  isEnabled(): boolean;
  probeWrapper(): Promise<void>;
  captureSnapshot(absolutePaths: string[]): Promise<HarnessHistorySnapshot>;
  restoreSnapshot(snapshot: HarnessHistorySnapshot): Promise<void>;
  commitOnWrite(ctx: HarnessHistoryContext): Promise<HarnessHistoryCommitResult>;
  createPreImportTag(importId: string): Promise<void>;
  revertAgentBundle(input: RevertAgentBundleInput): Promise<HarnessHistoryCommitResult>;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function formatTrailers(ctx: HarnessHistoryContext): string {
  const lines: string[] = [];
  lines.push(`Actor-Type: ${ctx.actor.type}`);
  lines.push(`Actor-Id: ${ctx.actor.id || "system"}`);
  if (ctx.actor.display) lines.push(`Actor-Display: ${ctx.actor.display}`);
  lines.push(`Run-Id: ${ctx.runId ?? "none"}`);
  lines.push(`Issue-Id: ${ctx.issueId ?? "none"}`);
  lines.push(`Issue-Identifier: ${ctx.issueIdentifier ?? "none"}`);
  lines.push(`Trigger: ${ctx.trigger ?? ctx.reason}`);
  lines.push(`Files: ${ctx.paths.length}`);
  lines.push(`Import-Id: ${ctx.importId ?? "none"}`);
  lines.push(`Agent-Slug: ${ctx.agentSlug ?? "none"}`);
  lines.push(`Reverted-Agent-Slug: ${ctx.revertedAgentSlug ?? "none"}`);
  return lines.join("\n");
}

function defaultSummary(ctx: HarnessHistoryContext): string {
  const category = ctx.category ?? inferCategory(ctx);
  const scope = ctx.scope ?? "harness";
  const summary = (ctx.summary ?? ctx.reason).replace(/\s+/g, " ").trim().slice(0, 72);
  return `${category}(${scope}): ${summary}`;
}

function inferCategory(ctx: HarnessHistoryContext): NonNullable<HarnessHistoryContext["category"]> {
  if (ctx.actor.type === "oob-watcher") return "oob";
  if (ctx.actor.type === "company-import-revert") return "revert";
  if (ctx.actor.type === "company-import-operator-revert") return "revert";
  if (ctx.reason.includes("init") || ctx.reason.includes("materialise")) return "init";
  if (ctx.reason.includes("delete")) return "delete";
  if (ctx.reason.includes("rename")) return "rename";
  return "feat";
}

async function spawnWrapper(
  wrapper: string,
  args: string[],
  options: { input?: string; timeoutMs?: number } = {},
): Promise<SpawnResult> {
  return await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(wrapper, args, {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`harness-history wrapper timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    if (options.input) {
      child.stdin?.write(options.input);
    }
    child.stdin?.end();
  });
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function createHarnessHistoryService(): HarnessHistoryService {
  async function probeWrapper(): Promise<void> {
    if (isDisabled()) return;
    const wrapper = resolveWrapperPath();
    if (!(await pathExists(wrapper))) {
      throw new Error(
        `harness-history wrapper not found at ${wrapper}. Install via MAD-257 or set PAPERCLIP_HARNESS_HISTORY_DISABLED=1 for non-prod boot.`,
      );
    }
    const result = await spawnWrapper(wrapper, ["--version"], { timeoutMs: 5_000 });
    if (result.exitCode !== 0) {
      throw new Error(
        `harness-history wrapper --version returned exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  async function captureSnapshot(absolutePaths: string[]): Promise<HarnessHistorySnapshot> {
    const entries = new Map<string, Buffer | null>();
    for (const absolutePath of absolutePaths) {
      try {
        const buf = await fs.readFile(absolutePath);
        entries.set(absolutePath, buf);
      } catch (err) {
        const errno = (err as NodeJS.ErrnoException).code;
        if (errno === "ENOENT") {
          entries.set(absolutePath, null);
        } else {
          throw err;
        }
      }
    }
    return { entries };
  }

  async function restoreSnapshot(snapshot: HarnessHistorySnapshot): Promise<void> {
    for (const [absolutePath, previous] of snapshot.entries) {
      if (previous === null) {
        await fs.rm(absolutePath, { force: true });
      } else {
        await fs.writeFile(absolutePath, previous);
      }
    }
  }

  async function commitOnWrite(ctx: HarnessHistoryContext): Promise<HarnessHistoryCommitResult> {
    if (isDisabled()) {
      return { committed: false, sha: null, reason: "disabled" };
    }
    const wrapper = resolveWrapperPath();
    if (!(await pathExists(wrapper))) {
      // Boot probe runs once at startup; this branch defends against runtime removal.
      throw new HttpError(503, "harness-history-write-failed", {
        reason: "wrapper-missing",
        wrapper,
      });
    }
    const message = `${defaultSummary(ctx)}\n\n${formatTrailers(ctx)}\n`;
    const result = await spawnWrapper(
      wrapper,
      ["commit-on-write", "--actor-id", ctx.actor.id || "system", "--actor-type", ctx.actor.type],
      { input: message, timeoutMs: 15_000 },
    );
    if (result.exitCode === 0) {
      const sha = result.stdout.trim().split(/\s+/).pop() || null;
      return { committed: true, sha };
    }
    const stderr = result.stderr.trim();
    if (/path-guard/i.test(stderr)) {
      throw new HttpError(422, "harness-history-path-guard", { stderr });
    }
    if (/secret-hit/i.test(stderr)) {
      throw new HttpError(422, "harness-history-secret-hit", { stderr });
    }
    if (/size-cap|too large/i.test(stderr)) {
      throw new HttpError(422, "harness-history-size-cap", { stderr });
    }
    if (/lock|busy|flock/i.test(stderr)) {
      throw new HttpError(503, "harness-history-busy", { stderr });
    }
    throw new HttpError(503, "harness-history-write-failed", {
      exitCode: result.exitCode,
      stderr,
    });
  }

  async function createPreImportTag(importId: string): Promise<void> {
    if (isDisabled()) return;
    const wrapper = resolveWrapperPath();
    if (!(await pathExists(wrapper))) {
      throw new HttpError(503, "harness-history-write-failed", {
        reason: "wrapper-missing",
        wrapper,
      });
    }
    const result = await spawnWrapper(wrapper, ["tag-create", `import-${importId}-pre`], {
      timeoutMs: 5_000,
    });
    if (result.exitCode !== 0) {
      throw new HttpError(503, "harness-history-write-failed", {
        reason: "tag-create-failed",
        importId,
        stderr: result.stderr.trim(),
      });
    }
  }

  async function revertAgentBundle(
    input: RevertAgentBundleInput,
  ): Promise<HarnessHistoryCommitResult> {
    if (isDisabled()) return { committed: false, sha: null, reason: "disabled" };
    const wrapper = resolveWrapperPath();
    if (!(await pathExists(wrapper))) {
      throw new HttpError(503, "harness-history-write-failed", {
        reason: "wrapper-missing",
        wrapper,
      });
    }
    const tag = `import-${input.importId}-pre`;
    const allowlistPath = `companies/${input.companyId}/agents/${input.agentId}/instructions/`;
    const checkoutResult = await spawnWrapper(
      wrapper,
      ["checkout-allowlist-path", tag, "--", allowlistPath],
      { timeoutMs: 15_000 },
    );
    if (checkoutResult.exitCode !== 0) {
      throw new HttpError(503, "harness-history-write-failed", {
        reason: "revert-checkout-failed",
        stderr: checkoutResult.stderr.trim(),
      });
    }
    return await commitOnWrite({
      reason: "company.import_bundle_revert",
      paths: [allowlistPath],
      actor: {
        type: "company-import-revert",
        id: input.boardUserId,
        display: "company-import-revert",
      },
      runId: input.runId ?? null,
      issueId: input.issueId ?? null,
      issueIdentifier: input.issueIdentifier ?? null,
      trigger: "company-import-revert",
      importId: input.importId,
      agentSlug: null,
      revertedAgentSlug: input.revertedAgentSlug,
      category: "revert",
      scope: "company-import",
      summary: `revert agent ${input.revertedAgentSlug} (${input.importId})`,
    });
  }

  return {
    isEnabled: () => !isDisabled(),
    probeWrapper,
    captureSnapshot,
    restoreSnapshot,
    commitOnWrite,
    createPreImportTag,
    revertAgentBundle,
  };
}

export const harnessHistoryService = createHarnessHistoryService();
