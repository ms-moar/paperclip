import { describe, expect, it } from "vitest";
import {
  liveEventsListenerCount,
  publishLiveEvent,
  subscribeCompanyLiveEvents,
} from "./live-events.js";

describe("live-events subscriber lifecycle", () => {
  it("adds a listener on subscribe and removes it on unsubscribe", () => {
    const companyId = `co-${Math.random().toString(36).slice(2)}`;
    expect(liveEventsListenerCount(companyId)).toBe(0);

    const unsubscribe = subscribeCompanyLiveEvents(companyId, () => {});
    expect(liveEventsListenerCount(companyId)).toBe(1);

    unsubscribe();
    expect(liveEventsListenerCount(companyId)).toBe(0);
  });

  it("only delivers events to subscribers of the matching company", () => {
    const companyA = `coA-${Math.random().toString(36).slice(2)}`;
    const companyB = `coB-${Math.random().toString(36).slice(2)}`;
    const receivedA: unknown[] = [];
    const receivedB: unknown[] = [];

    const offA = subscribeCompanyLiveEvents(companyA, (e) => receivedA.push(e));
    const offB = subscribeCompanyLiveEvents(companyB, (e) => receivedB.push(e));

    publishLiveEvent({ companyId: companyA, type: "issue.updated" as never });

    expect(receivedA).toHaveLength(1);
    expect(receivedB).toHaveLength(0);

    offA();
    offB();
  });

  it("does not leak listeners across many subscribe/unsubscribe cycles", () => {
    // Regression guard for the live-events-ws connection leak: every subscribe
    // must be matched by its unsubscribe so the listener count returns to
    // baseline. A monotonically climbing count is the leak signature.
    const companyId = `co-${Math.random().toString(36).slice(2)}`;
    const baseline = liveEventsListenerCount(companyId);

    for (let i = 0; i < 50; i++) {
      const off = subscribeCompanyLiveEvents(companyId, () => {});
      off();
    }

    expect(liveEventsListenerCount(companyId)).toBe(baseline);
  });
});
