import { describe, expect, it } from "vitest";

import { ROUTING_ASK_REGEX, detectRoutingAsk } from "../routing-ask-patterns.js";

describe("routing-ask-patterns", () => {
  describe("positive fixtures", () => {
    const positives: Array<[string, string]> = [
      ["explicit routing-ask token", "routing-ask: needs CEO to PATCH assigneeAgentId"],
      ["routing ask with space", "Filing a routing ask — please re-route"],
      ["routing_ask underscore", "routing_ask: cross-provider needed per PRE-725"],
      ["route to CEO", "Cannot reassign, please route to CEO"],
      ["route to CTO", "route to CTO for architectural review"],
      ["route to board", "route to board for budget approval"],
      ["patch assigneeAgentId verbatim", "CEO PATCH assigneeAgentId required for reviewer swap"],
      ["please reassign", "Please reassign to Codex Verifier per PRE-725"],
      ["re-assign to", "re-assign to GLM QA, Codex unavailable"],
      ["reassign to (no hyphen)", "reassign to Senior Dev for follow-up"],
      ["Ukrainian не має tasks:assign", "Інженер не має tasks:assign — потрібен CEO для роутингу"],
      ["Ukrainian не мае tasks:assign", "не мае tasks:assign permission"],
      ["English cannot assign task", "I cannot assign task to peer reviewer — escalating"],
      ["Russian нет прав на assign", "У меня нет прав на assign — нужен CEO"],
      ["escalate to CEO", "escalate to CEO — blocked on cross-provider gap"],
      ["escalating to mike", "escalating to Mike for board override"],
      ["escalate to board", "escalate to board — budget approval needed"],
      ["hand-off to CTO", "hand-off to CTO for review"],
      ["hand off to ceo", "hand off to ceo, this is process work"],
    ];

    for (const [name, body] of positives) {
      it(`flags "${name}"`, () => {
        expect(detectRoutingAsk(body)).toBe(true);
        expect(ROUTING_ASK_REGEX.test(body)).toBe(true);
      });
    }
  });

  describe("negative fixtures", () => {
    const negatives: Array<[string, string]> = [
      ["empty string", ""],
      ["whitespace", "   \n\t  "],
      ["regular code review", "Please review the diff and confirm the AC mapping"],
      ["generic ask the user", "ask the user to confirm before we proceed"],
      ["unrelated 'route' usage", "the http route returns 404 in staging"],
      ["unrelated 'assign' usage", "we should assign these timeouts a value"],
      ["plain status update", "moved to in_progress, smoke tests running"],
      ["mentions CEO without routing intent", "CEO already approved this last week"],
      ["unrelated escalation noun", "this is an escalation in the dispute log"],
      ["routing token in URL noise", "https://example.com/api/v2/routing"],
    ];

    for (const [name, body] of negatives) {
      it(`does not flag "${name}"`, () => {
        expect(detectRoutingAsk(body)).toBe(false);
        expect(ROUTING_ASK_REGEX.test(body)).toBe(false);
      });
    }
  });

  describe("null / undefined / non-string input", () => {
    it("returns false for null", () => {
      expect(detectRoutingAsk(null)).toBe(false);
    });
    it("returns false for undefined", () => {
      expect(detectRoutingAsk(undefined)).toBe(false);
    });
    it("returns false for non-string coerced input", () => {
      expect(detectRoutingAsk(123 as unknown as string)).toBe(false);
    });
  });

  describe("case insensitivity", () => {
    it("matches uppercase 'ROUTING-ASK'", () => {
      expect(detectRoutingAsk("ROUTING-ASK: PLEASE CONFIRM")).toBe(true);
    });
    it("matches mixed-case 'Route To Ceo'", () => {
      expect(detectRoutingAsk("Route To Ceo for review")).toBe(true);
    });
  });
});
