import { describe, expect, it } from "vitest";

import { parseLastEventId, sseFrame } from "../src/web/sse.js";

describe("SSE helpers", () => {
  it("uses a browser-friendly query fallback for Last-Event-ID", () => {
    expect(parseLastEventId(undefined, "42")).toBe("42");
    expect(parseLastEventId("", "42")).toBe("42");
    expect(parseLastEventId(" 17 ", "42")).toBe("17");
    expect(parseLastEventId([" 23 "], "42")).toBe("23");
    expect(parseLastEventId(undefined, "")).toBeNull();
  });

  it("emits event ids before event data for replayable streams", () => {
    expect(sseFrame("queue_status_changed", { ok: true }, "99")).toMatch(/^id: 99\nevent: queue_status_changed\ndata: \{"ok":true\}\n\n$/);
  });
});
