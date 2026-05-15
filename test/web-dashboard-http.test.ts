import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { isRequestBodyTooLargeError, readJsonBody } from "../src/web-dashboard-http.js";

describe("web dashboard HTTP helpers", () => {
  it("limits JSON request bodies and reports 413-compatible errors", async () => {
    const req = Readable.from([Buffer.from("{\"value\":\"too large\"}")]);

    await expect(readJsonBody(req as never, 8)).rejects.toSatisfy(isRequestBodyTooLargeError);
  });

  it("parses JSON bodies within the configured limit", async () => {
    const req = Readable.from([Buffer.from("{\"value\":42}")]);

    await expect(readJsonBody(req as never, 1024)).resolves.toEqual({ value: 42 });
  });
});
