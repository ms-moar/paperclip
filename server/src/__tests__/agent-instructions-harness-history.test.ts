import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentInstructionsService } from "../services/agent-instructions.js";
import type { HarnessHistoryWriteCtx } from "../services/agent-instructions.js";

// ---------- helpers ----------

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function installFakeWrapper(dir: string): Promise<{ wrapperPath: string; logPath: string }> {
  const wrapperPath = path.join(dir, "paperclip-harness-history");
  const logPath = path.join(dir, "calls.log");
  const script = [
    "#!/usr/bin/env bash",
    "set -u",
    `printf '%s\\n' "ARGS: $*" >> ${JSON.stringify(logPath)}`,
    "if [ ! -t 0 ]; then",
    `  printf 'STDIN-START\\n' >> ${JSON.stringify(logPath)}`,
    `  cat >> ${JSON.stringify(logPath)}`,
    `  printf '\\nSTDIN-END\\n' >> ${JSON.stringify(logPath)}`,
    "fi",
    `printf '%s\\n' "committed fake-sha-1234"`,
    "exit 0",
  ].join("\n");
  await fs.writeFile(wrapperPath, script, { mode: 0o755 });
  return { wrapperPath, logPath };
}

async function installFailingWrapper(
  dir: string,
  reason: "secret-hit" | "path-guard" = "secret-hit",
): Promise<{ wrapperPath: string }> {
  const wrapperPath = path.join(dir, "paperclip-harness-history");
  const script = [
    "#!/usr/bin/env bash",
    "set -u",
    "if [ \"$1\" = \"--version\" ]; then",
    "  echo 'paperclip-harness-history failing-wrapper'",
    "  exit 0",
    "fi",
    "cat >/dev/null",
    `printf '%s\\n' ${JSON.stringify(reason + " detected during commit-on-write")} 1>&2`,
    "exit 1",
  ].join("\n");
  await fs.writeFile(wrapperPath, script, { mode: 0o755 });
  return { wrapperPath };
}

function makeAgent(adapterConfig: Record<string, unknown>, managedRootPath: string) {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent 1",
    adapterConfig: {
      instructionsBundleMode: "managed",
      instructionsRootPath: managedRootPath,
      instructionsEntryFile: "AGENTS.md",
      instructionsFilePath: path.join(managedRootPath, "AGENTS.md"),
      ...adapterConfig,
    },
  };
}

const testCtx: HarnessHistoryWriteCtx = {
  actor: { type: "agent", id: "agent-1", display: "Agent 1" },
  runId: "run-step2",
  issueId: "issue-step2",
  issueIdentifier: "MAD-256",
  trigger: "PUT /api/agents/:id/instructions-bundle/file",
};

// ---------- suite ----------

describe("agent-instructions service — harness-history write hooks (W1-W5)", () => {
  const savedEnvs: Record<string, string | undefined> = {};
  const cleanupDirs = new Set<string>();

  beforeEach(() => {
    for (const key of ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_HARNESS_HISTORY_WRAPPER", "PAPERCLIP_HARNESS_HISTORY_DISABLED"]) {
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

  async function setup() {
    const paperclipHome = await makeTempDir("paperclip-ai-hh-home-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test";

    const wrapperDir = await makeTempDir("paperclip-ai-hh-wrapper-");
    cleanupDirs.add(wrapperDir);
    const { wrapperPath, logPath } = await installFakeWrapper(wrapperDir);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = wrapperPath;

    const managedRoot = path.join(paperclipHome, "instances", "test", "companies", "company-1", "agents", "agent-1", "instructions");
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Agent\n", "utf8");

    return { logPath, managedRoot };
  }

  // W1 — writeFile with ctx
  it("W1: writeFile with ctx commits with reason agent.instructions_file_updated", async () => {
    const { logPath, managedRoot } = await setup();
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await svc.writeFile(agent, "NOTES.md", "# Notes\n", undefined, testCtx);

    const log = await fs.readFile(logPath, "utf8");
    expect(log).toContain("ARGS: commit-on-write --actor-id agent-1 --actor-type agent");
    expect(log).toContain("agent.instructions_file_updated");
    expect(log).toContain("Actor-Type: agent");
    expect(log).toContain("Issue-Identifier: MAD-256");
    // ctx.paths must be embedded as `Path:` trailer lines so forensics has the
    // concrete file path that triggered the write, not just `Files: N`.
    expect(log).toMatch(/Path: \S*NOTES\.md/);
  });

  // W1 — writeFile without ctx must NOT call wrapper
  it("W1: writeFile without ctx does not commit", async () => {
    const { logPath, managedRoot } = await setup();
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await svc.writeFile(agent, "NOTES2.md", "# No ctx\n");

    const exists = await fs.access(logPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  // W2 — deleteFile with ctx
  it("W2: deleteFile with ctx commits with reason agent.instructions_file_deleted", async () => {
    const { logPath, managedRoot } = await setup();
    await fs.writeFile(path.join(managedRoot, "DELETE_ME.md"), "bye\n", "utf8");
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await svc.deleteFile(agent, "DELETE_ME.md", testCtx);

    const log = await fs.readFile(logPath, "utf8");
    expect(log).toContain("ARGS: commit-on-write --actor-id agent-1 --actor-type agent");
    expect(log).toContain("agent.instructions_file_deleted");
    expect(log).toContain("Actor-Id: agent-1");
  });

  // W2 — deleteFile without ctx must NOT call wrapper
  it("W2: deleteFile without ctx does not commit", async () => {
    const { logPath, managedRoot } = await setup();
    await fs.writeFile(path.join(managedRoot, "DELETE_ME2.md"), "bye\n", "utf8");
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await svc.deleteFile(agent, "DELETE_ME2.md");

    const exists = await fs.access(logPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  // W3 — updateBundle with ctx
  it("W3: updateBundle with ctx commits with reason agent.instructions_bundle_updated", async () => {
    const { logPath, managedRoot } = await setup();
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await svc.updateBundle(agent, { mode: "managed" }, testCtx);

    const log = await fs.readFile(logPath, "utf8");
    expect(log).toContain("ARGS: commit-on-write --actor-id agent-1 --actor-type agent");
    expect(log).toContain("agent.instructions_bundle_updated");
  });

  // W3 — updateBundle without ctx must NOT call wrapper
  it("W3: updateBundle without ctx does not commit", async () => {
    const { logPath, managedRoot } = await setup();
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await svc.updateBundle(agent, { mode: "managed" });

    const exists = await fs.access(logPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  // W5 — materializeManagedBundle with ctx
  it("W5: materializeManagedBundle with ctx commits with reason agent.instructions_bundle_materialise", async () => {
    const { logPath, managedRoot } = await setup();
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await svc.materializeManagedBundle(
      agent,
      { "AGENTS.md": "# Materialized\n", "GUIDE.md": "## Guide\n" },
      { replaceExisting: true },
      testCtx,
    );

    const log = await fs.readFile(logPath, "utf8");
    expect(log).toContain("ARGS: commit-on-write --actor-id agent-1 --actor-type agent");
    expect(log).toContain("agent.instructions_bundle_materialise");
    expect(log).toContain("Files: 2");
  });

  // W5 — materializeManagedBundle without ctx must NOT call wrapper
  it("W5: materializeManagedBundle without ctx does not commit", async () => {
    const { logPath, managedRoot } = await setup();
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await svc.materializeManagedBundle(agent, { "AGENTS.md": "# Mat\n" });

    const exists = await fs.access(logPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  // disabled passthrough — even with ctx, no commit when disabled
  it("PAPERCLIP_HARNESS_HISTORY_DISABLED=1 silences commits even when ctx is provided", async () => {
    const { logPath, managedRoot } = await setup();
    process.env.PAPERCLIP_HARNESS_HISTORY_DISABLED = "1";
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await svc.writeFile(agent, "NOTES3.md", "# Disabled\n", undefined, testCtx);

    const exists = await fs.access(logPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  // ---------- transactional rollback (fail-closed) ----------

  async function setupWithFailingWrapper(reason: "secret-hit" | "path-guard" = "secret-hit"): Promise<{ managedRoot: string }> {
    const paperclipHome = await makeTempDir("paperclip-ai-hh-home-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test";

    const wrapperDir = await makeTempDir("paperclip-ai-hh-wrapper-");
    cleanupDirs.add(wrapperDir);
    const { wrapperPath } = await installFailingWrapper(wrapperDir, reason);
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = wrapperPath;

    const managedRoot = path.join(paperclipHome, "instances", "test", "companies", "company-1", "agents", "agent-1", "instructions");
    await fs.mkdir(managedRoot, { recursive: true });
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Agent\n", "utf8");

    return { managedRoot };
  }

  it("W1 rollback: writeFile commit failure (secret-hit) leaves no new file and preserves old content", async () => {
    const { managedRoot } = await setupWithFailingWrapper("secret-hit");
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    const newFile = path.join(managedRoot, "NEW.md");
    const oldFile = path.join(managedRoot, "AGENTS.md");
    const oldContent = await fs.readFile(oldFile, "utf8");

    await expect(
      svc.writeFile(agent, "NEW.md", "SECRET=sk-leak-must-not-persist\n", undefined, testCtx),
    ).rejects.toThrow();
    const newExists = await fs.access(newFile).then(() => true).catch(() => false);
    expect(newExists).toBe(false);
    expect(await fs.readFile(oldFile, "utf8")).toBe(oldContent);
  });

  it("W1 rollback: writeFile commit failure on existing file restores previous bytes", async () => {
    const { managedRoot } = await setupWithFailingWrapper("path-guard");
    await fs.writeFile(path.join(managedRoot, "NOTES.md"), "before\n", "utf8");
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await expect(
      svc.writeFile(agent, "NOTES.md", "after-that-must-rollback\n", undefined, testCtx),
    ).rejects.toThrow();
    expect(await fs.readFile(path.join(managedRoot, "NOTES.md"), "utf8")).toBe("before\n");
  });

  it("W2 rollback: deleteFile commit failure restores the deleted file", async () => {
    const { managedRoot } = await setupWithFailingWrapper("path-guard");
    await fs.writeFile(path.join(managedRoot, "KEEP.md"), "must-survive\n", "utf8");
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await expect(svc.deleteFile(agent, "KEEP.md", testCtx)).rejects.toThrow();
    expect(await fs.readFile(path.join(managedRoot, "KEEP.md"), "utf8")).toBe("must-survive\n");
  });

  it("W3 rollback: updateBundle commit failure restores the previous tree", async () => {
    const { managedRoot } = await setupWithFailingWrapper("secret-hit");
    // remove AGENTS.md so updateBundle triggers the bundle write path
    await fs.rm(path.join(managedRoot, "AGENTS.md"), { force: true });
    await fs.writeFile(path.join(managedRoot, "EXISTING.md"), "keep-me\n", "utf8");
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await expect(svc.updateBundle(agent, { mode: "managed" }, testCtx)).rejects.toThrow();
    // EXISTING.md kept
    expect(await fs.readFile(path.join(managedRoot, "EXISTING.md"), "utf8")).toBe("keep-me\n");
    // AGENTS.md was missing before — must remain absent after rollback
    const agentsExists = await fs.access(path.join(managedRoot, "AGENTS.md")).then(() => true).catch(() => false);
    expect(agentsExists).toBe(false);
  });

  it("W5 rollback: materializeManagedBundle commit failure restores the previous tree (replaceExisting)", async () => {
    const { managedRoot } = await setupWithFailingWrapper("secret-hit");
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), "# Original Agent\n", "utf8");
    await fs.writeFile(path.join(managedRoot, "OLD.md"), "# Old\n", "utf8");
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await expect(
      svc.materializeManagedBundle(
        agent,
        { "AGENTS.md": "# Materialized\n", "GUIDE.md": "## Guide\n" },
        { replaceExisting: true },
        testCtx,
      ),
    ).rejects.toThrow();

    expect(await fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8")).toBe("# Original Agent\n");
    expect(await fs.readFile(path.join(managedRoot, "OLD.md"), "utf8")).toBe("# Old\n");
    const guideExists = await fs.access(path.join(managedRoot, "GUIDE.md")).then(() => true).catch(() => false);
    expect(guideExists).toBe(false);
  });

  // W4 rollback — legacy-only agent must not leak auto-materialised AGENTS.md when
  // commit-on-write later rejects the target file write.
  it("W4 rollback: writeFile on legacy-only agent leaves no auto-materialised AGENTS.md and no NEW.md", async () => {
    const paperclipHome = await makeTempDir("paperclip-ai-hh-home-");
    cleanupDirs.add(paperclipHome);
    process.env.PAPERCLIP_HOME = paperclipHome;
    process.env.PAPERCLIP_INSTANCE_ID = "test";

    const wrapperDir = await makeTempDir("paperclip-ai-hh-wrapper-");
    cleanupDirs.add(wrapperDir);
    const { wrapperPath } = await installFailingWrapper(wrapperDir, "secret-hit");
    process.env.PAPERCLIP_HARNESS_HISTORY_WRAPPER = wrapperPath;

    // Legacy-only agent: no managed bundle on disk, no instructionsRootPath,
    // only promptTemplate which ensureWritableBundle would materialise into AGENTS.md.
    const expectedRoot = path.join(
      paperclipHome,
      "instances",
      "test",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    const rootExistedBefore = await fs.access(expectedRoot).then(() => true).catch(() => false);
    expect(rootExistedBefore).toBe(false);

    const agent = {
      id: "agent-1",
      companyId: "company-1",
      name: "Agent 1",
      adapterConfig: {
        promptTemplate: "LEGACY_SECRET=sk-legacy-should-not-materialize\n",
      },
    };
    const svc = agentInstructionsService();

    await expect(
      svc.writeFile(agent, "NEW.md", "SECRET=sk-leak-must-not-persist\n", undefined, testCtx),
    ).rejects.toThrow();

    const newExists = await fs.access(path.join(expectedRoot, "NEW.md")).then(() => true).catch(() => false);
    const agentsExists = await fs
      .access(path.join(expectedRoot, "AGENTS.md"))
      .then(() => true)
      .catch(() => false);
    expect(newExists).toBe(false);
    expect(agentsExists).toBe(false);
  });

  it("W5 rollback: materializeManagedBundle commit failure into empty root removes any newly-written files", async () => {
    const { managedRoot } = await setupWithFailingWrapper("secret-hit");
    // Wipe the root so previous tree is empty (no AGENTS.md to restore)
    await fs.rm(managedRoot, { recursive: true, force: true });
    await fs.mkdir(managedRoot, { recursive: true });
    const agent = makeAgent({}, managedRoot);
    const svc = agentInstructionsService();

    await expect(
      svc.materializeManagedBundle(
        agent,
        { "AGENTS.md": "# Materialized\n", "NESTED/INNER.md": "# nested\n" },
        undefined,
        testCtx,
      ),
    ).rejects.toThrow();

    const agentsExists = await fs.access(path.join(managedRoot, "AGENTS.md")).then(() => true).catch(() => false);
    const innerExists = await fs.access(path.join(managedRoot, "NESTED", "INNER.md")).then(() => true).catch(() => false);
    expect(agentsExists).toBe(false);
    expect(innerExists).toBe(false);
  });
});
