import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach } from "vitest";

const originalNordRelayHome = process.env.NORDRELAY_HOME;
let testHome: string | undefined;

beforeEach(() => {
  testHome = mkdtempSync(path.join(tmpdir(), "nordrelay-test-home-"));
  process.env.NORDRELAY_HOME = testHome;
});

afterEach(() => {
  const home = testHome;
  testHome = undefined;
  if (originalNordRelayHome === undefined) {
    delete process.env.NORDRELAY_HOME;
  } else {
    process.env.NORDRELAY_HOME = originalNordRelayHome;
  }
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
});
