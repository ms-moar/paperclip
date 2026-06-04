import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHarnessHistoryService } from "../services/harness-history.js";
import { HttpError } from "../errors.js";

interface WrapperFixture {
  wrapperPath: string;
  logPath: string;
  cleanupDir: string;
}

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function installFakeWrapper(options: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}): Promise<WrapperFixture> {
  const dir = await makeTempDir("paperclip-harness-history-wrapper-");
  const wrapperPath = path.join(dir, "paperclip-harness-history");
  const logPath = path.join(dir, "calls.log");
  const exitCode = options.exitCode ?? 0;
  const stdoutLine = (options.stdout ?? "fake-sha-abcdef1234567890").replace(/\r?\n$/, "");
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

describe("harness-history service", () => {
  const originalWrapperEnv = process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER;
  const originalDisabledEnv = process.env.PAPERCLIP_HARNESS_HISTORY_DISABLED;
  const cleanupDirs = new Set<string>();

  beforeEach(() => {
    delete process.env.PAPERCLIP_HARNESS_HISTORY_DISABLED;
    delete process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER;
  });

  afterEach(async () => {
    if (originalWrapperEnv === undefined) delete process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER;
    else process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = originalWrapperEnv;
    if (originalDisabledEnv === undefined) delete process.env.PAPERCLIP_HARNESS_HISTORY_DISABLED;
    else process.env.PAPERCLIP_HARNESS_HISTORY_DISABLED = originalDisabledEnv;

    await Promise.all(
      [...cleanupDirs].map(async (dir) => {
        await fs.rm(dir, { recursive: true, force: true });
        cleanupDirs.delete(dir);
      }),
    );
  });

  it("treats PAPERCLIP_HARNESS_HISTORY_DISABLED=1 as silent passthrough", async () => {
    process.env.PAPERCLIP_HARNESS_HISTORY_DISABLED = "1";
    const svc = createHarnessHistoryService();

    expect(svc.isEnabled()).toBe(false);
    await expect(svc.probeWrapper()).resolves.toBeUndefined();

    const result = await svc.commitOnWrite({
      reason: "agent.instructions_file_updated",
      paths: ["/tmp/fake.md"],
      actor: { type: "agent", id: "agent-1" },
    });
    expect(result).toEqual({ committed: false, sha: null, reason: "disabled" });
  });

  it("U1: commits allowed paths and returns the wrapper-reported sha", async () => {
    const fixture = await installFakeWrapper({ stdout: "committed deadbeefcafebabe1234567890\n" });
    cleanupDirs.add(fixture.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fixture.wrapperPath;
    const svc = createHarnessHistoryService();

    const result = await svc.commitOnWrite({
      reason: "agent.instructions_file_updated",
      paths: ["/tmp/companies/c1/agents/a1/instructions/AGENTS.md"],
      actor: { type: "agent", id: "agent-1", display: "Agent 1" },
      runId: "run-1",
      issueId: "issue-1",
      issueIdentifier: "MAD-256",
      trigger: "PUT /api/agents/:id/instructions-bundle/file",
    });

    expect(result.committed).toBe(true);
    expect(result.sha).toBe("deadbeefcafebabe1234567890");
    const log = await fs.readFile(fixture.logPath, "utf8");
    expect(log).toContain("ARGS: commit-on-write --actor-id agent-1 --actor-type agent");
    expect(log).toContain("Actor-Type: agent");
    expect(log).toContain("Actor-Id: agent-1");
    expect(log).toContain("Run-Id: run-1");
    expect(log).toContain("Issue-Identifier: MAD-256");
    expect(log).toContain("Files: 1");
    expect(log).toContain("Path: /tmp/companies/c1/agents/a1/instructions/AGENTS.md");
  });

  it("U2: forbidden path → 422 harness-history-path-guard", async () => {
    const fixture = await installFakeWrapper({
      exitCode: 12,
      stderr: "path-guard: path lands outside allowlist\n",
    });
    cleanupDirs.add(fixture.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fixture.wrapperPath;
    const svc = createHarnessHistoryService();

    await expect(
      svc.commitOnWrite({
        reason: "agent.instructions_file_updated",
        paths: ["/tmp/outside.md"],
        actor: { type: "agent", id: "agent-1" },
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "harness-history-path-guard",
    });
  });

  it("U3: secret pattern hit → 422 harness-history-secret-hit", async () => {
    const fixture = await installFakeWrapper({
      exitCode: 13,
      stderr: "secret-hit: pcp_board_… matched in companies/c1/shared/notes.md\n",
    });
    cleanupDirs.add(fixture.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fixture.wrapperPath;
    const svc = createHarnessHistoryService();

    await expect(
      svc.commitOnWrite({
        reason: "shared.notes_edited",
        paths: ["companies/c1/shared/notes.md"],
        actor: { type: "oob-watcher", id: "system" },
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: "harness-history-secret-hit",
    });
  });

  it("U4: lock contention → 503 harness-history-busy", async () => {
    const fixture = await installFakeWrapper({
      exitCode: 14,
      stderr: "lock: flock timed out after 10s\n",
    });
    cleanupDirs.add(fixture.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fixture.wrapperPath;
    const svc = createHarnessHistoryService();

    await expect(
      svc.commitOnWrite({
        reason: "agent.instructions_file_updated",
        paths: ["companies/c1/agents/a1/instructions/AGENTS.md"],
        actor: { type: "agent", id: "agent-1" },
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "harness-history-busy",
    });
  });

  it("U5: generic git failure → 503 harness-history-write-failed", async () => {
    const fixture = await installFakeWrapper({
      exitCode: 1,
      stderr: "fatal: unable to commit\n",
    });
    cleanupDirs.add(fixture.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fixture.wrapperPath;
    const svc = createHarnessHistoryService();

    await expect(
      svc.commitOnWrite({
        reason: "agent.instructions_file_updated",
        paths: ["companies/c1/agents/a1/instructions/AGENTS.md"],
        actor: { type: "agent", id: "agent-1" },
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: "harness-history-write-failed",
    });
  });

  it("captureSnapshot + restoreSnapshot round-trip restores prior bytes and recreates absence", async () => {
    const dir = await makeTempDir("paperclip-harness-history-snap-");
    cleanupDirs.add(dir);
    const existing = path.join(dir, "kept.md");
    const newborn = path.join(dir, "new.md");
    await fs.writeFile(existing, "original-content", "utf8");

    const svc = createHarnessHistoryService();
    const snapshot = await svc.captureSnapshot([existing, newborn]);
    expect(snapshot.entries.get(existing)?.toString()).toBe("original-content");
    expect(snapshot.entries.get(newborn)).toBeNull();

    await fs.writeFile(existing, "overwrite-after-snapshot", "utf8");
    await fs.writeFile(newborn, "created-after-snapshot", "utf8");

    await svc.restoreSnapshot(snapshot);
    expect(await fs.readFile(existing, "utf8")).toBe("original-content");
    await expect(fs.access(newborn)).rejects.toThrow();
  });

  it("U7: trailer payload encodes actor / run / issue / import metadata for parsing back", async () => {
    const fixture = await installFakeWrapper({});
    cleanupDirs.add(fixture.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fixture.wrapperPath;
    const svc = createHarnessHistoryService();

    await svc.commitOnWrite({
      reason: "company.import_bundle_materialise",
      paths: [
        "companies/c1/agents/a1/instructions/AGENTS.md",
        "companies/c1/agents/a1/instructions/HEARTBEAT.md",
      ],
      actor: { type: "company-import", id: "board-user-1", display: "Mike" },
      runId: "run-42",
      issueId: "issue-42",
      issueIdentifier: "MAD-256",
      trigger: "POST /api/companies/import",
      importId: "import-uuid-1",
      agentSlug: "senior-engineer",
    });

    const log = await fs.readFile(fixture.logPath, "utf8");
    expect(log).toContain("Actor-Type: company-import");
    expect(log).toContain("Actor-Id: board-user-1");
    expect(log).toContain("Actor-Display: Mike");
    expect(log).toContain("Run-Id: run-42");
    expect(log).toContain("Issue-Id: issue-42");
    expect(log).toContain("Issue-Identifier: MAD-256");
    expect(log).toContain("Trigger: POST /api/companies/import");
    expect(log).toContain("Files: 2");
    expect(log).toContain("Path: companies/c1/agents/a1/instructions/AGENTS.md");
    expect(log).toContain("Path: companies/c1/agents/a1/instructions/HEARTBEAT.md");
    expect(log).toContain("Import-Id: import-uuid-1");
    expect(log).toContain("Agent-Slug: senior-engineer");
  });

  it("probeWrapper rejects when wrapper does not exist and disabled flag is unset", async () => {
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = "/nonexistent/paperclip-harness-history-fixture";
    const svc = createHarnessHistoryService();
    await expect(svc.probeWrapper()).rejects.toThrow(/wrapper not found/);
  });

  it("probeWrapper rejects when wrapper --version returns non-zero", async () => {
    const fixture = await installFakeWrapper({ exitCode: 99, stderr: "bad version probe\n" });
    cleanupDirs.add(fixture.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fixture.wrapperPath;
    const svc = createHarnessHistoryService();
    await expect(svc.probeWrapper()).rejects.toThrow(/exit 99/);
  });

  it("commitOnWrite throws structured 503 when the wrapper disappeared after boot probe", async () => {
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = "/nonexistent/paperclip-harness-history-runtime";
    const svc = createHarnessHistoryService();
    await expect(
      svc.commitOnWrite({
        reason: "agent.instructions_file_updated",
        paths: ["companies/c1/agents/a1/instructions/AGENTS.md"],
        actor: { type: "agent", id: "agent-1" },
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });

  it("revertAgentBundle invokes checkout-allowlist-path followed by commit-on-write", async () => {
    const fixture = await installFakeWrapper({});
    cleanupDirs.add(fixture.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fixture.wrapperPath;
    const svc = createHarnessHistoryService();

    const result = await svc.revertAgentBundle({
      importId: "import-7",
      companyId: "c1",
      agentId: "a1",
      revertedAgentSlug: "senior-engineer",
      boardUserId: "board-user-1",
      runId: "run-7",
      issueId: "issue-7",
      issueIdentifier: "MAD-256",
    });

    expect(result.committed).toBe(true);
    const log = await fs.readFile(fixture.logPath, "utf8");
    expect(log).toContain(
      "ARGS: checkout-allowlist-path import-import-7-pre -- companies/c1/agents/a1/instructions/",
    );
    expect(log).toContain("ARGS: commit-on-write --actor-id board-user-1 --actor-type company-import-revert");
    expect(log).toContain("Import-Id: import-7");
    expect(log).toContain("Reverted-Agent-Slug: senior-engineer");
  });

  it("createPreImportTag invokes wrapper tag-create with import-<id>-pre", async () => {
    const fixture = await installFakeWrapper({});
    cleanupDirs.add(fixture.cleanupDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = fixture.wrapperPath;
    const svc = createHarnessHistoryService();

    await svc.createPreImportTag("import-9");

    const log = await fs.readFile(fixture.logPath, "utf8");
    expect(log).toContain("ARGS: tag-create import-import-9-pre");
  });
});
