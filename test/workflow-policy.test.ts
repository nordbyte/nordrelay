import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("workflow policy", () => {
  it("guards package publishing with a release version check", () => {
    const workflow = readFileSync(".github/workflows/publish.yml", "utf8");

    expect(workflow).toContain("scripts/verify-release-version.mjs");
    expect(workflow).toContain("github.event.release.tag_name");
    expect(workflow).toContain("NORDRELAY_RELEASE_VERSION");
  });

  it("uses immutable or verified security scanner references", () => {
    const workflow = readFileSync(".github/workflows/security.yml", "utf8");

    expect(workflow).not.toContain("trufflesecurity/trufflehog@main");
    expect(workflow).toMatch(/trufflesecurity\/trufflehog@v\d+\.\d+\.\d+/);
    expect(workflow).toContain("sha256sum -c -");
  });
});
