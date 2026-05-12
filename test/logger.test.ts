import { describe, expect, it, vi } from "vitest";

import { installConsoleLogger } from "../src/logger.js";

describe("logger", () => {
  it("can emit console output as JSON records", () => {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const output: string[] = [];
    console.log = vi.fn((line: string) => {
      output.push(line);
    }) as unknown as typeof console.log;

    try {
      installConsoleLogger("json");
      console.warn("hello", { id: 1 });
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }

    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toEqual(expect.objectContaining({
      level: "warn",
      event: "console",
      message: 'hello {"id":1}',
    }));
  });
});
