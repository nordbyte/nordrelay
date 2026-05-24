import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { stateBackendDirectory, stateBackendPath } from "../src/state/state-backend.js";

const originalNordRelayHome = process.env.NORDRELAY_HOME;

afterEach(() => {
  if (originalNordRelayHome === undefined) {
    delete process.env.NORDRELAY_HOME;
  } else {
    process.env.NORDRELAY_HOME = originalNordRelayHome;
  }
});

describe("state backend paths", () => {
  it("keeps regular workspace state scoped below the workspace", () => {
    const workspace = path.join(tmpdir(), "nordrelay-workspace");

    expect(stateBackendDirectory(workspace)).toBe(path.join(workspace, ".nordrelay"));
    expect(stateBackendPath(workspace, "json", "session-names.json")).toBe(
      path.join(workspace, ".nordrelay", "session-names.json"),
    );
  });

  it("falls back to NordRelay home instead of writing below the filesystem root", () => {
    const home = mkdtempSync(path.join(tmpdir(), "nordrelay-home-"));
    try {
      process.env.NORDRELAY_HOME = home;
      const rootWorkspace = path.parse(process.cwd()).root;

      expect(stateBackendDirectory(rootWorkspace)).toBe(home);
      expect(stateBackendPath(rootWorkspace, "json", "session-names.json")).toBe(
        path.join(home, "session-names.json"),
      );
      expect(stateBackendPath(rootWorkspace, "sqlite")).toBe(path.join(home, "state.sqlite"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to NordRelay home for an empty workspace", () => {
    const home = mkdtempSync(path.join(tmpdir(), "nordrelay-empty-home-"));
    try {
      process.env.NORDRELAY_HOME = home;

      expect(stateBackendPath("", "json", "state.json")).toBe(path.join(home, "state.json"));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
