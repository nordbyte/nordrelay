import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("nordrelay CLI script", () => {
  it("does not mix readline echo with raw password masking", () => {
    const source = readFileSync("plugins/nordrelay/scripts/nordrelay.mjs", "utf8");
    const askSecret = source.match(/async function askSecret[\s\S]*?\n}\n\nasync function askChoice/)?.[0] ?? "";

    expect(askSecret).toContain('output.write("*")');
    expect(askSecret).toContain("input.pause();");
    expect(askSecret).not.toContain("rl.pause()");
    expect(askSecret).not.toContain("rl.resume()");
  });
});
