import { EventEmitter } from "node:events";
import type { LiveEvent, LiveEventType } from "@paperclipai/shared";

type LiveEventPayload = Record<string, unknown>;
type LiveEventListener = (event: LiveEvent) => void;

const emitter = new EventEmitter();
// Finite cap so a subscriber leak surfaces as a logged MaxListenersExceeded
// warning instead of growing silently. Set well above the realistic number of
// concurrent live-event subscribers (WS clients) for a single company, but far
// below the magnitude a real leak reaches. Previously this was 0 (unlimited),
// which let a leaked-listener bug accumulate invisibly.
const MAX_LIVE_EVENT_LISTENERS = 1000;
emitter.setMaxListeners(MAX_LIVE_EVENT_LISTENERS);

let nextEventId = 0;

function toLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}): LiveEvent {
  nextEventId += 1;
  return {
    id: nextEventId,
    companyId: input.companyId,
    type: input.type,
    createdAt: new Date().toISOString(),
    payload: input.payload ?? {},
  };
}

export function publishLiveEvent(input: {
  companyId: string;
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent(input);
  emitter.emit(input.companyId, event);
  return event;
}

export function publishGlobalLiveEvent(input: {
  type: LiveEventType;
  payload?: LiveEventPayload;
}) {
  const event = toLiveEvent({ companyId: "*", type: input.type, payload: input.payload });
  emitter.emit("*", event);
  return event;
}

export function subscribeCompanyLiveEvents(companyId: string, listener: LiveEventListener) {
  emitter.on(companyId, listener);
  return () => emitter.off(companyId, listener);
}

export function subscribeGlobalLiveEvents(listener: LiveEventListener) {
  emitter.on("*", listener);
  return () => emitter.off("*", listener);
}

/**
 * Number of live-event listeners currently registered. With `companyId` it
 * returns the count for that company's channel; without it, the total across
 * all channels. Intended for leak detection / observability and tests — a count
 * that climbs monotonically and never falls after clients disconnect indicates
 * a subscriber leak.
 */
export function liveEventsListenerCount(companyId?: string): number {
  if (companyId !== undefined) return emitter.listenerCount(companyId);
  return emitter.eventNames().reduce((sum, name) => sum + emitter.listenerCount(name), 0);
}
