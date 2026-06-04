/**
 * Integration tests for harness-history import bundle flow (MAD-256 plan §6.2 I5–I9).
 *
 * These tests exercise the harness-history service API in the sequence that
 * company-portability.importBundle executes it, without requiring a real DB:
 *   1. createPreImportTag(importId)          — capture pre-import state (I5)
 *   2. materializeManagedBundle(..., ctx)     — commit per-agent (I6)
 *   3. on harness failure: revertAgentBundle  — restore + 503 abort (I7)
 *   4. disabled passthrough: none of the above calls reach the wrapper (I9)
 *
 * I1–I4 (single-file writeFile/deleteFile path-guard/secret-hit) are covered
 * by harness-history-service.test.ts and agent-instructions-harness-history.test.ts.
 * I8 (boot probe) is covered by the harness-history-service "probeWrapper" unit tests.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHarnessHistoryService } from "../services/harness-history.js";
import { HttpError } from "../errors.js";

// ---------- helpers ----------

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

interface WrapperFixture {
  wrapperPath: string;
  logPath: string;
  cleanupDir: string;
}

async function installFakeWrapper(options: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}): Promise<WrapperFixture> {
  const dir = await makeTempDir("paperclip-hh-import-");
  const wrapperPath = path.join(dir, "paperclip-harness-history");
  const logPath = path.join(dir, "calls.log");
  const exitCode = options.exitCode ?? 0;
  const stdoutLine = (options.stdout ?? "committed fake-sha-import").replace(/\r?\n$/, "");
  const stderrLine = (options.stderr ?? "").replace(/\r?\n$/, "");
  const script = [
    "#!/usr/bin/env bash",
    "set -u",
    `printf '%s\\n' "ARGS: $*" >> ${JSON.stringify(logPath)}`,
    "if [ ! -t 0 ]; then",
    `  printf 'STDIN-START\\n' >> ${JSON.stringify(logPath)}`,
    `  cat >> ${JSON.stringify(logPath)}`,
    `  printf '\\nSTDIN-END\\n' >> ${JSON.stringify(logPath)}`,
    "fi",
    `printf '%s\\n' ${JSON.stringify(stdoutLine)}`,
    stderrLine ? `printf '%s\\n' ${JSON.stringify(stderrLine)} 1>&2` : "true",
    `exit ${exitCode}`,
  ].join("\n");
  await fs.writeFile(wrapperPath, script, { mode: 0o755 });
  return { wrapperPath, logPath, cleanupDir: dir };
}

// ---------- suite ----------

describe("harness-history import bundle flow (I5–I9)", () => {
  const savedEnvs: Record<string, string | undefined> = {};
  const cleanupDirs = new Set<string>();

  beforeEach(() => {
    for (const key of ["PAPERCLIP_HARNESS_HISTORY_WRAPPER", "PAPERCLIP_HARNESS_HISTORY_DISABLED"]) {
      savedEnvs[key] = process.env[key];
    }
    delete process.env.PAPERCLIP_HARNESS_HISTORY_DISABLED;
    delete process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER;
  });

  afterEach(async () => {
    for (const [key, val] of Object.entries(savedEnvs)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  // I5 — createPreImportTag captures pre-import snapshot via wrapper tag-create
  it("I5: createPreImportTag issues tag-create import-<id>-pre before any per-agent commit", async () => {
    const fix = await installFakeWrapper({});
    cleanupDirs.add(fix.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fix.wrapperPath;
    const svc = createHarnessHistoryService();

    await svc.createPreImportTag("import-i5-uuid");

    const log = await fs.readFile(fix.logPath, "utf8");
    expect(log).toContain("ARGS: tag-create import-import-i5-uuid-pre");
  });

  // I6 — per-agent commit carries company-import actor, importId, agentSlug in trailer
  it("I6: commitOnWrite with company-import actor encodes importId and agentSlug in commit trailer", async () => {
    const fix = await installFakeWrapper({});
    cleanupDirs.add(fix.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fix.wrapperPath;
    const svc = createHarnessHistoryService();

    const result = await svc.commitOnWrite({
      reason: "agent.instructions_bundle_materialise",
      paths: ["companies/c1/agents/a1/instructions/AGENTS.md"],
      actor: { type: "company-import", id: "board-user-42", display: "Alice" },
      importId: "import-i6-uuid",
      agentSlug: "senior-engineer",
      trigger: "POST /api/companies/import",
    });

    expect(result.committed).toBe(true);
    const log = await fs.readFile(fix.logPath, "utf8");
    expect(log).toContain("Actor-Type: company-import");
    expect(log).toContain("Actor-Id: board-user-42");
    expect(log).toContain("Import-Id: import-i6-uuid");
    expect(log).toContain("Agent-Slug: senior-engineer");
    expect(log).toContain("Trigger: POST /api/companies/import");
  });

  // I7 — harness failure during import → revertAgentBundle restores pre-import state
  it("I7: revertAgentBundle restores pre-import state after harness commit failure", async () => {
    const fix = await installFakeWrapper({});
    cleanupDirs.add(fix.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fix.wrapperPath;
    const svc = createHarnessHistoryService();

    const importId = "import-i7-uuid";

    // Simulate the recovery sequence that importBundle executes on HttpError
    const revertResult = await svc.revertAgentBundle({
      importId,
      companyId: "c1",
      agentId: "a1",
      revertedAgentSlug: "senior-engineer",
      boardUserId: "board-user-42",
      runId: null,
      issueId: null,
      issueIdentifier: null,
    });

    expect(revertResult.committed).toBe(true);
    const log = await fs.readFile(fix.logPath, "utf8");
    expect(log).toContain("ARGS: checkout-allowlist-path import-import-i7-uuid-pre -- companies/c1/agents/a1/instructions/");
    expect(log).toContain("ARGS: commit-on-write --actor-id board-user-42 --actor-type company-import-revert");
    expect(log).toContain("Reverted-Agent-Slug: senior-engineer");
    expect(log).toContain("Import-Id: import-i7-uuid");
  });

  // I7b — wrapper path-guard 422 is an HttpError (triggers hard-abort in importBundle)
  it("I7b: path-guard failure from wrapper is an HttpError — importBundle can distinguish it", async () => {
    const fix = await installFakeWrapper({ exitCode: 12, stderr: "path-guard: outside allowlist\n" });
    cleanupDirs.add(fix.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fix.wrapperPath;
    const svc = createHarnessHistoryService();

    await expect(
      svc.commitOnWrite({
        reason: "agent.instructions_bundle_materialise",
        paths: ["outside/path.md"],
        actor: { type: "company-import", id: "board-user-1" },
        importId: "import-i7b-uuid",
        agentSlug: "agent-x",
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  // I8 — probeWrapper: non-fatal when wrapper absent (soft warn, does not throw at boot)
  it("I8: probeWrapper resolves silently when wrapper is absent and DISABLED=1", async () => {
    process.env.PAPERCLIP_HARNESS_HISTORY_DISABLED = "1";
    const svc = createHarnessHistoryService();
    await expect(svc.probeWrapper()).resolves.toBeUndefined();
  });

  it("I8b: probeWrapper throws with descriptive message when wrapper absent and not disabled", async () => {
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = "/nonexistent/probe-wrapper";
    const svc = createHarnessHistoryService();
    await expect(svc.probeWrapper()).rejects.toThrow(/wrapper not found/);
  });

  // I9 — DISABLED=1 silences createPreImportTag, commitOnWrite, revertAgentBundle
  it("I9: PAPERCLIP_HARNESS_HISTORY_DISABLED=1 silences all import-flow methods", async () => {
    const fix = await installFakeWrapper({});
    cleanupDirs.add(fix.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fix.wrapperPath;
    process.env.PAPERCLIP_HARNESS_HISTORY_DISABLED = "1";
    const svc = createHarnessHistoryService();

    await expect(svc.createPreImportTag("import-i9-uuid")).resolves.toBeUndefined();

    const commitResult = await svc.commitOnWrite({
      reason: "agent.instructions_bundle_materialise",
      paths: ["companies/c1/agents/a1/instructions/AGENTS.md"],
      actor: { type: "company-import", id: "board-user-1" },
      importId: "import-i9-uuid",
      agentSlug: "some-agent",
    });
    expect(commitResult).toEqual({ committed: false, sha: null, reason: "disabled" });

    const revertResult = await svc.revertAgentBundle({
      importId: "import-i9-uuid",
      companyId: "c1",
      agentId: "a1",
      revertedAgentSlug: "some-agent",
      boardUserId: "board-user-1",
    });
    expect(revertResult).toEqual({ committed: false, sha: null, reason: "disabled" });

    // Verify wrapper was never called
    const logExists = await fs.access(fix.logPath).then(() => true).catch(() => false);
    expect(logExists).toBe(false);
  });
});
