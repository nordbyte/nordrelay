import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("project hardening", () => {
  it("excludes local secrets and runtime state from Docker build context", () => {
    const dockerignore = readFileSync(path.join(root, ".dockerignore"), "utf8");

    for (const pattern of [".git/", ".env", ".env.*", ".nordrelay/", "workspace/", "node_modules/", "dist/", "coverage/", "test-results/", "playwright-report/", "sbom.json", ".repovista/"]) {
      expect(dockerignore, pattern).toContain(pattern);
    }
  });

  it("does not copy the entire repository into Docker image layers", () => {
    const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");

    expect(dockerfile).not.toMatch(/^\s*COPY\s+\.\s+\.\s*$/m);
  });

  it("keeps docs tooling lockfile-bound and raises moderate dependency advisories", () => {
    const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const docsPackageLock = JSON.parse(readFileSync(path.join(root, "docs", "package-lock.json"), "utf8")) as {
      packages: Record<string, { devDependencies?: Record<string, string> }>;
    };

    expect(packageJson.scripts["docs:prepare"]).toBe("npm ci --prefix docs --ignore-scripts");
    expect(packageJson.scripts["docs:prepare"]).not.toMatch(/--no-package-lock|--no-save/);
    expect(packageJson.scripts["security:audit"]).toBe("npm audit --audit-level=moderate");
    expect(docsPackageLock.packages[""]?.devDependencies?.vitepress).toBe("1.6.4");
  });
});
