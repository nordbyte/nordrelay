import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { HermesApiClient } from "../src/hermes-api.js";
import { checkHermesAuthStatus } from "../src/hermes-auth.js";

describe("hermes-api", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  it("starts a run and parses Hermes SSE events", async () => {
    const seenBodies: unknown[] = [];
    const baseUrl = await startServer((req, res) => {
      if (req.url === "/v1/runs" && req.method === "POST") {
        collectJson(req).then((body) => {
          seenBodies.push(body);
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ run_id: "run_1", status: "started" }));
        });
        return;
      }
      if (req.url === "/v1/runs/run_1/events" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ event: "message.delta", run_id: "run_1", delta: "Hello" })}\n\n`);
        res.write(`data: ${JSON.stringify({ event: "run.completed", run_id: "run_1", output: "Hello", usage: { input_tokens: 2, output_tokens: 1 } })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const client = new HermesApiClient({ baseUrl });
    const run = await client.startRun({ input: "hello", session_id: "session-1", model: "hermes-agent" });
    const events: string[] = [];
    await client.streamRunEvents(run.run_id, (event) => events.push(String(event.event)));

    expect(run.run_id).toBe("run_1");
    expect(seenBodies[0]).toMatchObject({ input: "hello", session_id: "session-1", model: "hermes-agent" });
    expect(events).toEqual(["message.delta", "run.completed"]);
  });

  it("checks Hermes API auth through capabilities", async () => {
    const baseUrl = await startServer((req, res) => {
      if (req.url === "/v1/capabilities" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ features: { run_events_sse: true } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await expect(checkHermesAuthStatus({ baseUrl })).resolves.toMatchObject({
      authenticated: true,
      method: "local-api",
    });
  });

  async function startServer(
    handler: Parameters<typeof createServer>[0],
  ): Promise<string> {
    server = createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Server did not bind to a TCP port");
    }
    return `http://127.0.0.1:${address.port}`;
  }
});

async function collectJson(req: Parameters<Parameters<typeof createServer>[0]>[0]): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}
