import { describe, expect, it } from "vitest";

import { relayRuntimePrepareEvent, relayRuntimeReplayEvents } from "../src/runtime/relay-runtime-events.js";
import type { RelayEvent } from "../src/runtime/relay-runtime-types.js";

describe("relay runtime events", () => {
  it("assigns monotonic ids and replays events after the last seen id", () => {
    const runtime = { eventSeq: 0, eventHistory: [] as RelayEvent[] };

    const first = relayRuntimePrepareEvent(runtime, statusEvent("first"));
    const second = relayRuntimePrepareEvent(runtime, statusEvent("second"));

    expect(first).toMatchObject({ seq: 1, eventId: "1" });
    expect(second).toMatchObject({ seq: 2, eventId: "2" });
    expect(relayRuntimeReplayEvents(runtime, "1").map((event) => event.eventId)).toEqual(["2"]);
  });

  it("does not duplicate already prepared events in history", () => {
    const runtime = { eventSeq: 10, eventHistory: [] as RelayEvent[] };
    const prepared = statusEvent("prepared", { seq: 9, eventId: "9" });

    expect(relayRuntimePrepareEvent(runtime, prepared)).toBe(prepared);
    expect(runtime.eventHistory).toEqual([]);
    expect(runtime.eventSeq).toBe(10);
  });
});

function statusEvent(message: string, meta: Partial<RelayEvent> = {}): RelayEvent {
  return {
    type: "status",
    level: "info",
    message,
    at: "2026-06-09T00:00:00.000Z",
    ...meta,
  } as RelayEvent;
}
