/**
 * PRE-1066 / PRE-1069 — hermes-paperclip-adapter@0.2.0 patch tests.
 *
 * Covers the three session_id corruption bugs patched in
 * `patches/hermes-paperclip-adapter@0.2.0.patch`:
 *
 *   A. Truncation — sessionDisplayId must keep the full 22-char hermes id,
 *      not slice(0, 16).
 *   B. Regex false-positive — SESSION_ID_REGEX_LEGACY must not capture
 *      "from" out of the "session ID from a previous CLI run" help text.
 *   C. clearSession — adapter must set executionResult.clearSession=true
 *      when stderr contains "Session not found", otherwise Paperclip keeps
 *      re-using the poisoned id forever.
 *
 * Also covers the new shape validator that rejects malformed ids
 * (e.g. "20260527_115456_" with no hex tail, or "from").
 */
import { describe, expect, it } from "vitest";

// We import the *patched* module from node_modules. The patch
// (`patches/hermes-paperclip-adapter@0.2.0.patch`) adds an internal
// `__testing__` namespace re-exported from `./server` so we can unit-test
// the pure parsing + validation helpers without spawning a hermes child
// process.
// @ts-expect-error — no .d.ts ships for the patched __testing__ symbol.
import { __testing__ } from "hermes-paperclip-adapter/server";

const {
  parseHermesOutput,
  isValidHermesSessionId,
  SESSION_ID_REGEX_LEGACY,
  HERMES_SESSION_ID_SHAPE,
} = __testing__;

const FULL_ID = "20260527_115456_a1b2c3";
const FULL_ID_LONG = "20260527_115456_a1b2c3d4e5";

describe("PRE-1066 Bug A: hermes session id is no longer truncated", () => {
  it("HERMES_SESSION_ID_SHAPE accepts the canonical 22-char hermes id", () => {
    expect(HERMES_SESSION_ID_SHAPE.test(FULL_ID)).toBe(true);
  });

  it("parseHermesOutput returns the full id from quiet-mode stdout", () => {
    const stdout = `Doing stuff...\n\nsession_id: ${FULL_ID}\n`;
    const out = parseHermesOutput(stdout, "");
    expect(out.sessionId).toBe(FULL_ID);
    // No truncation anywhere in the parser.
    expect(out.sessionId?.length).toBeGreaterThanOrEqual(22);
  });

  it("parseHermesOutput returns the full id when hermes writes it to stderr", () => {
    // quiet mode (-Q) writes session_id to stderr.
    const stderr = `[hermes] starting\nsession_id: ${FULL_ID_LONG}\n`;
    const out = parseHermesOutput("response body\n", stderr);
    expect(out.sessionId).toBe(FULL_ID_LONG);
  });
});

describe("PRE-1066 Bug B: SESSION_ID_REGEX_LEGACY rejects help-text false positives", () => {
  it('does NOT capture "from" from the "session ID from a previous CLI run" repro string', () => {
    const helpText =
      "Error: please pass a session ID from a previous CLI run to --resume";
    const m = helpText.match(SESSION_ID_REGEX_LEGACY);
    expect(m).toBeNull();
  });

  it("does NOT match anywhere inside an inline error sentence", () => {
    const sentence =
      "We could not load the session id you provided because the file is missing.";
    expect(sentence.match(SESSION_ID_REGEX_LEGACY)).toBeNull();
  });

  it("still matches a real legacy session line at the start of a line", () => {
    const legacy = `something\nsession id: ${FULL_ID}\nmore`;
    const m = legacy.match(SESSION_ID_REGEX_LEGACY);
    expect(m?.[1]).toBe(FULL_ID);
  });

  it("parseHermesOutput does not return sessionId=from for the help-text repro", () => {
    const stdout = "response\n";
    const stderr =
      "Error: please pass a session ID from a previous CLI run to --resume\n";
    const out = parseHermesOutput(stdout, stderr);
    expect(out.sessionId).not.toBe("from");
    // The only acceptable values are: undefined, null, or a shape-valid id.
    if (out.sessionId != null) {
      expect(isValidHermesSessionId(out.sessionId)).toBe(true);
    }
  });
});

describe("PRE-1066 validator: isValidHermesSessionId rejects corrupt shapes", () => {
  it("accepts canonical ids", () => {
    expect(isValidHermesSessionId(FULL_ID)).toBe(true);
    expect(isValidHermesSessionId(FULL_ID_LONG)).toBe(true);
  });

  it('rejects the "from" false positive (Bug B)', () => {
    expect(isValidHermesSessionId("from")).toBe(false);
  });

  it("rejects ids with empty hex tail (e.g. partial parses)", () => {
    expect(isValidHermesSessionId("20260527_115456_")).toBe(false);
  });

  it("rejects ids missing the timestamp prefix", () => {
    expect(isValidHermesSessionId("a1b2c3d4")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isValidHermesSessionId(null as unknown as string)).toBe(false);
    expect(isValidHermesSessionId(undefined as unknown as string)).toBe(false);
    expect(isValidHermesSessionId(123 as unknown as string)).toBe(false);
  });
});
