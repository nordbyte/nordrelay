import { describe, expect, it } from "vitest";

import { renderMatrixSessionPageAction, type MatrixSessionListRecord } from "../src/channels/matrix/matrix-sessions.js";

describe("Matrix session picker", () => {
  const records: MatrixSessionListRecord[] = Array.from({ length: 13 }, (_, index) => ({
    id: `thread-${index + 1}`,
    title: `Session ${index + 1}`,
    cwd: `/workspace/project-${index + 1}`,
    firstUserMessage: `Prompt ${index + 1}`,
    model: "gpt-5.5",
    updatedAt: new Date(Date.now() - index * 60_000),
  }));

  it("renders Telegram-style paginated session choices with navigation actions", () => {
    const first = renderMatrixSessionPageAction("Recent threads", records, "pick123", {
      activeThreadId: "thread-1",
      pinnedThreadIds: ["thread-2"],
    });

    expect(first.text).toContain("Recent threads (1-6 of 13, page 1/3):");
    expect(first.text).toContain("active · project-1");
    expect(first.text).toContain("pinned · project-2");
    expect(first.buttons.flat()).toContainEqual({ label: expect.stringContaining("active"), action: "matrix_pick:pick123:0" });
    expect(first.buttons.flat()).toContainEqual({ label: "1/3", action: "matrix_sessions_page:pick123:refresh" });
    expect(first.buttons.flat()).toContainEqual({ label: "Next", action: "matrix_sessions_page:pick123:next" });
    expect(first.buttons.flat()).not.toContainEqual({ label: "Previous", action: "matrix_sessions_page:pick123:prev" });

    const second = renderMatrixSessionPageAction("Recent threads", records, "pick123", { page: 1 });
    expect(second.text).toContain("Recent threads (7-12 of 13, page 2/3):");
    expect(second.buttons.flat()).toContainEqual({ label: "Previous", action: "matrix_sessions_page:pick123:prev" });
    expect(second.buttons.flat()).toContainEqual({ label: "2/3", action: "matrix_sessions_page:pick123:refresh" });
    expect(second.buttons.flat()).toContainEqual({ label: "Next", action: "matrix_sessions_page:pick123:next" });
    expect(second.buttons.flat()).toContainEqual({ label: expect.stringContaining("Session 7"), action: "matrix_pick:pick123:6" });
  });
});
