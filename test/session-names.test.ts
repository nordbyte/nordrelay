import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_SESSION_NAME_LENGTH, SessionNameStore, sanitizeSessionName } from "../src/state/session-names.js";

describe("session name store", () => {
  it("normalizes, limits, persists, and clears session names", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "nordrelay-session-names-"));
    try {
      const store = new SessionNameStore(workspace);
      const first = store.set("codex", "thread-1", "  Launch   Review  ");
      expect(first?.name).toBe("Launch Review");
      expect(store.get("codex", "thread-1")?.name).toBe("Launch Review");

      const longName = "x".repeat(MAX_SESSION_NAME_LENGTH + 20);
      const second = store.set("codex", "thread-1", longName);
      expect(second?.name).toHaveLength(MAX_SESSION_NAME_LENGTH);
      expect(sanitizeSessionName(longName)).toHaveLength(MAX_SESSION_NAME_LENGTH);

      store.set("codex", "thread-1", " ");
      expect(store.get("codex", "thread-1")).toBeNull();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
