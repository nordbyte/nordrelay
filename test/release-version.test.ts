import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;

describe("release version guard", () => {
  it("accepts a release tag that matches package.json", () => {
    expect(() => runGuard({
      GITHUB_EVENT_NAME: "release",
      GITHUB_RELEASE_TAG: `v${packageVersion}`,
    })).not.toThrow();
  });

  it("rejects a release tag that does not match package.json", () => {
    expect(() => runGuard({
      GITHUB_EVENT_NAME: "release",
      GITHUB_RELEASE_TAG: "v0.0.0",
    })).toThrow(/does not match package\.json/);
  });

  it("requires workflow dispatch version to match package.json", () => {
    expect(() => runGuard({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      NORDRELAY_RELEASE_VERSION: packageVersion,
    })).not.toThrow();

    expect(() => runGuard({
      GITHUB_EVENT_NAME: "workflow_dispatch",
      NORDRELAY_RELEASE_VERSION: "0.0.0",
    })).toThrow(/does not match package\.json/);
  });
});

function runGuard(env: Record<string, string>): void {
  execFileSync(process.execPath, ["scripts/verify-release-version.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "",
      GITHUB_RELEASE_TAG: "",
      GITHUB_REF_NAME: "",
      GITHUB_REF_TYPE: "",
      INPUT_VERSION: "",
      NORDRELAY_RELEASE_TAG: "",
      NORDRELAY_RELEASE_VERSION: "",
      ...env,
    },
    stdio: "pipe",
  });
}
