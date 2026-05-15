import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("nordrelay CLI script", () => {
  it("does not mix readline echo with raw password masking", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");
    const askSecret = source.match(/async function askSecret[\s\S]*?\r?\n}\r?\n\r?\nasync function askChoice/)?.[0] ?? "";

    expect(askSecret).toContain('output.write("*")');
    expect(askSecret).toContain("input.pause();");
    expect(askSecret).not.toContain("rl.pause()");
    expect(askSecret).not.toContain("rl.resume()");
  });

  it("exposes a first-class update command", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain("async function commandUpdate");
    expect(source).toContain('options.command === "update"');
    expect(source).toContain("nordrelay [init|user|peer|doctor|web|start|stop|restart|status|update|foreground|version]");
    expect(source).toContain("@nordbyte/nordrelay@latest");
  });

  it("supports source builds before launches and restart", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain('arg === "--build"');
    expect(source).toContain("async function buildRuntime()");
    expect(source).toContain("warnIfRuntimeBuildIsStale()");
    expect(source).toContain("runtimeForwardFlags(options.rawFlags)");
    expect(source).toContain("nordrelay restart --build");
    expect(source).toContain('console.log("  --build');
  });

  it("handles --help before the foreground default", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");

    expect(source).toContain('copy[0] === "--help" || copy[0] === "-h"');
    expect(source).toContain("function printHelp()");
    expect(source).toContain('if (options.command === "help")');
  });
});
