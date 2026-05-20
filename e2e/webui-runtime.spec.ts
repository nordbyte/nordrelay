import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";

import { UserStore } from "../src/access/user-management.js";

test.describe("NordRelay WebUI runtime", () => {
  let runtime: RuntimeServer | undefined;

  test.beforeEach(async ({}, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "runtime smoke is covered once");
    runtime = await startRuntimeServer();
  });

  test.afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  test("serves the real dashboard with authenticated API access", async ({ page }) => {
    expect(runtime).toBeDefined();
    const server = runtime!;

    const anonymous = await page.request.get(`${server.baseUrl}/api/auth/me`);
    expect(anonymous.status()).toBe(401);

    const login = await page.request.post(`${server.baseUrl}/api/auth`, {
      data: { email: server.email, password: server.password },
    });
    expect(login.status()).toBe(200);

    await page.goto(server.baseUrl);
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.locator("#footerHealth")).toContainText(/Health:/);

    const health = await page.request.get(`${server.baseUrl}/healthz`);
    expect(health.status()).toBe(200);
    expect(await health.text()).toBe("ok\n");

    const bootstrap = await page.request.get(`${server.baseUrl}/api/bootstrap`);
    expect(bootstrap.status()).toBe(200);
    const bootstrapJson = await bootstrap.json() as {
      auth: { user: { email: string } };
      channels: Array<{ id: string }>;
      enabledAgents: string[];
    };
    expect(bootstrapJson.auth.user.email).toBe(server.email);
    expect(bootstrapJson.channels.map((channel) => channel.id)).toContain("telegram");
    expect(bootstrapJson.enabledAgents).toContain("codex");

    const active = await page.request.get(`${server.baseUrl}/api/active-sessions`);
    expect(active.status()).toBe(200);
    expect((await active.json()) as { sessions?: unknown[] }).toMatchObject({ sessions: [] });

    const firstEvent = await page.evaluate(() => new Promise<string>((resolve, reject) => {
      const source = new EventSource("/api/events");
      const timeout = window.setTimeout(() => {
        source.close();
        reject(new Error("Timed out waiting for SSE event."));
      }, 3_000);
      source.addEventListener("snapshot", () => {
        window.clearTimeout(timeout);
        source.close();
        resolve("snapshot");
      }, { once: true });
      source.onerror = () => {
        window.clearTimeout(timeout);
        source.close();
        reject(new Error("SSE connection failed."));
      };
    }));
    expect(firstEvent).toBe("snapshot");
  });
});

type RuntimeServer = {
  baseUrl: string;
  home: string;
  email: string;
  password: string;
  close: () => Promise<void>;
};

async function startRuntimeServer(): Promise<RuntimeServer> {
  const home = mkdtempSync(path.join(tmpdir(), "nordrelay-webui-runtime-"));
  const workspace = path.join(home, "workspace");
  const email = "runtime-admin@example.com";
  const password = "runtime-password-123";
  new UserStore(home).createAdmin({ email, displayName: "Runtime Admin", password });

  const port = await freePort();
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/web/web-dashboard.ts",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--home",
    home,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      NORDRELAY_HOME: home,
      WORKSPACE: workspace,
      TELEGRAM_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "test:token",
      DISCORD_ENABLED: "false",
      NORDRELAY_STATE_BACKEND: "json",
      NORDRELAY_CODEX_ENABLED: "true",
      NORDRELAY_PI_ENABLED: "false",
      NORDRELAY_HERMES_ENABLED: "false",
      NORDRELAY_OPENCLAW_ENABLED: "false",
      NORDRELAY_CLAUDE_CODE_ENABLED: "false",
      NORDRELAY_DEFAULT_AGENT: "codex",
      NORDRELAY_DASHBOARD_CACHE_TTL_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, child, () => output);
  } catch (error) {
    await stopChild(child);
    removeHome(home);
    throw error;
  }

  return {
    baseUrl,
    home,
    email,
    password,
    close: async () => {
      await stopChild(child);
      removeHome(home);
    },
  };
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForServer(baseUrl: string, child: ChildProcessWithoutNullStreams, output: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`WebUI runtime exited early with code ${child.exitCode}: ${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/auth/me`);
      if (response.status === 401 || response.status === 200) {
        return;
      }
    } catch {
      // Keep waiting until the listener is ready.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for WebUI runtime: ${output()}`);
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  const gracefulExit = waitForChildExit(child, 3_000);
  child.kill("SIGTERM");
  if (await gracefulExit) {
    return;
  }

  if (child.exitCode === null && child.pid && process.platform === "win32") {
    await taskkill(child.pid);
  } else if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
  await waitForChildExit(child, 3_000);
  child.stdout.destroy();
  child.stderr.destroy();
}

function waitForChildExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timeout.unref?.();
    const onExit = (): void => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

async function taskkill(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile("taskkill.exe", ["/pid", String(pid), "/t", "/f"], () => resolve());
  });
}

function removeHome(home: string): void {
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
