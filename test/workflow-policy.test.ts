import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("workflow policy", () => {
  it("guards package publishing with a release version check", () => {
    const workflow = readFileSync(".github/workflows/publish.yml", "utf8");

    expect(workflow).toContain("scripts/verify-release-version.mjs");
    expect(workflow).toContain("github.event.release.tag_name");
    expect(workflow).toContain("NORDRELAY_RELEASE_VERSION");
    expect(workflow).toContain("GITHUB_REF_NAME");
  });

  it("uses immutable or verified security scanner references", () => {
    const workflow = readFileSync(".github/workflows/security.yml", "utf8");

    expect(workflow).not.toContain("trufflesecurity/trufflehog@main");
    expect(workflow).toMatch(/trufflesecurity\/trufflehog@[a-f0-9]{40} # v\d+\.\d+\.\d+/);
    expect(workflow).toMatch(/actions\/checkout@[a-f0-9]{40} # v\d+/);
    expect(workflow).not.toContain("--only-verified");
    expect(workflow).toContain("GITLEAKS_LINUX_X64_SHA256");
    expect(workflow).toContain("sha256sum -c -");
  });

  it("pins GitHub Pages actions while keeping deploy permissions scoped", () => {
    const workflow = readFileSync(".github/workflows/pages.yml", "utf8");

    expect(workflow).toMatch(/actions\/checkout@[a-f0-9]{40} # v\d+/);
    expect(workflow).toMatch(/actions\/setup-node@[a-f0-9]{40} # v\d+/);
    expect(workflow).toMatch(/actions\/configure-pages@[a-f0-9]{40} # v\d+/);
    expect(workflow).toMatch(/actions\/upload-pages-artifact@[a-f0-9]{40} # v\d+/);
    expect(workflow).toMatch(/actions\/deploy-pages@[a-f0-9]{40} # v\d+/);
    expect(workflow).not.toMatch(/uses: actions\/[^@\s]+@v\d+/);
    expect(workflow).toContain("permissions:\n      pages: write\n      id-token: write");
  });
});
