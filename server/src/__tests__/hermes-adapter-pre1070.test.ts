/**
 * PRE-1070 — hermes-paperclip-adapter@0.2.0 transient_upstream emission.
 *
 * Verifies the patched adapter emits the Paperclip transient-recovery
 * contract on non-success outcomes so that
 * `scheduleBoundedRetryForRun` fires automatically:
 *
 *   - top-level errorFamily   = "transient_upstream"
 *   - top-level errorCode     = "hermes_transient_upstream"
 *   - resultJson.errorFamily  = "transient_upstream"
 *
 * Plus the timeout-to-failed conversion: Paperclip's bounded-retry gate
 * (heartbeat.ts:8045) only fires on outcome=failed, not timed_out, so the
 * adapter clears `timedOut` and preserves the timeout context in
 * `errorMessage` to keep the retry path reachable.
 *
 * Approach: drive execute() with a real but controllable "hermes CLI" stub
 * (a bash script) via `adapterConfig.hermesCommand`. The stub writes
 * stdout/stderr/exit-code per the env vars we pass per case. This sidesteps
 * the vi.mock vs pnpm-nested-deps resolution gap (the hermes adapter is
 * published in .pnpm and imports `@paperclipai/adapter-utils/server-utils`
 * from its own subtree, which vi.mock on the workspace specifier does NOT
 * intercept).
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @ts-expect-error — no .d.ts for the patched module's `./server` entry.
import { execute } from "hermes-paperclip-adapter/server";

let stubDir: string;
let stubCli: string;

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "pre1070-stub-"));
  stubCli = join(stubDir, "fake-hermes.sh");
  writeFileSync(
    stubCli,
    `#!/bin/bash
# Fake hermes CLI for PRE-1070 unit test.
# Env vars:
#   PRE1070_STDOUT      stdout payload
#   PRE1070_STDERR      stderr payload
#   PRE1070_EXIT        exit code (default 0)
#   PRE1070_SLEEP       sleep N seconds AFTER writing output (forces timeout)
#   PRE1070_PRE_SLEEP   sleep N seconds BEFORE writing output (rare path)
if [ -n "$PRE1070_PRE_SLEEP" ]; then sleep "$PRE1070_PRE_SLEEP"; fi
if [ -n "$PRE1070_STDOUT" ]; then printf '%b' "$PRE1070_STDOUT"; fi
if [ -n "$PRE1070_STDERR" ]; then printf '%b' "$PRE1070_STDERR" 1>&2; fi
if [ -n "$PRE1070_SLEEP" ]; then sleep "$PRE1070_SLEEP"; fi
exit "\${PRE1070_EXIT:-0}"
`,
    "utf8",
  );
  chmodSync(stubCli, 0o755);
});

afterAll(() => {
  if (stubDir) rmSync(stubDir, { recursive: true, force: true });
});

type ScenarioEnv = {
  PRE1070_STDOUT?: string;
  PRE1070_STDERR?: string;
  PRE1070_EXIT?: string;
  PRE1070_SLEEP?: string;
};

function makeCtx(scenario: ScenarioEnv, timeoutSec = 30) {
  return {
    runId: "run-pre1070-test",
    agent: {
      id: "agent-test",
      companyId: "company-test",
      name: "Test Hermes",
      adapterConfig: {
        model: "glm-4.6",
        hermesCommand: stubCli,
        timeoutSec,
        graceSec: 1,
        persistSession: false,
        env: scenario,
        // disable session resume to keep the test deterministic
      },
    },
    config: {
      taskId: "PRE-9999",
      taskTitle: "Test task",
      taskBody: "Test body",
    },
    runtime: {},
    onLog: async () => undefined,
  };
}

describe("PRE-1070: hermes adapter emits transient_upstream on non-success", () => {
  it("emits errorFamily on non-zero exit (adapter_failed)", async () => {
    const ctx = makeCtx({
      PRE1070_STDOUT: "",
      PRE1070_STDERR: "Z.AI returned 503 service unavailable\\n",
      PRE1070_EXIT: "1",
    });
    const r = await execute(ctx);
    expect(r.errorFamily).toBe("transient_upstream");
    expect(r.errorCode).toBe("hermes_transient_upstream");
    expect(r.resultJson?.errorFamily).toBe("transient_upstream");
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(1);
  });

  it("converts adapter timeout to failed-with-errorFamily so bounded retry fires", async () => {
    // Sleep 4s with timeoutSec=2 → runChildProcess kills with SIGTERM, timedOut=true.
    const ctx = makeCtx(
      {
        PRE1070_STDOUT: "",
        PRE1070_STDERR: "",
        PRE1070_EXIT: "0",
        PRE1070_SLEEP: "4",
      },
      2,
    );
    const r = await execute(ctx);
    // Crucial: timedOut MUST be false so Paperclip outcome=failed, not timed_out.
    // See server/src/services/heartbeat.ts:8045 — bounded retry gate.
    expect(r.timedOut).toBe(false);
    expect(r.errorFamily).toBe("transient_upstream");
    expect(r.errorCode).toBe("hermes_transient_upstream");
    expect(r.resultJson?.errorFamily).toBe("transient_upstream");
    expect(r.errorMessage).toMatch(/Hermes timed out after \d+s/);
  }, 15000);

  it("emits errorFamily when stderr surfaces an error message but exitCode==0", async () => {
    const ctx = makeCtx({
      PRE1070_STDOUT: "",
      PRE1070_STDERR: "ERROR: rate limit exceeded\\n",
      PRE1070_EXIT: "0",
    });
    const r = await execute(ctx);
    expect(r.errorFamily).toBe("transient_upstream");
    expect(r.errorCode).toBe("hermes_transient_upstream");
  });

  it("does NOT emit errorFamily on clean success", async () => {
    const ctx = makeCtx({
      PRE1070_STDOUT:
        "ok response\\n\\nsession_id: 20260528_120000_abcdef\\n",
      PRE1070_STDERR: "",
      PRE1070_EXIT: "0",
    });
    const r = await execute(ctx);
    expect(r.errorFamily).toBeUndefined();
    expect(r.errorCode).toBeUndefined();
    expect(r.resultJson?.errorFamily).toBeUndefined();
    expect(r.timedOut).toBe(false);
  });

  it("preserves any existing errorMessage when wrapping a timeout", async () => {
    const ctx = makeCtx(
      {
        PRE1070_STDOUT: "",
        PRE1070_STDERR: "ERROR: upstream unreachable\\nFatal\\n",
        PRE1070_EXIT: "0",
        PRE1070_SLEEP: "4",
      },
      2,
    );
    const r = await execute(ctx);
    expect(r.timedOut).toBe(false);
    expect(r.errorMessage).toMatch(/Hermes timed out after 2s/);
    expect(r.errorMessage).toMatch(/upstream unreachable/);
  }, 15000);
});
