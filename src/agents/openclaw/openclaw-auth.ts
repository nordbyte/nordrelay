import type { AuthStatus } from "../codex/codex-auth.js";
import { OpenClawGatewayClient } from "./openclaw-gateway.js";

export async function checkOpenClawAuthStatus(options: {
  gatewayUrl: string;
  token?: string;
  password?: string;
}): Promise<AuthStatus> {
  const client = new OpenClawGatewayClient({
    url: options.gatewayUrl,
    token: options.token,
    password: options.password,
    timeoutMs: 5_000,
  });
  try {
    await client.health();
    return {
      authenticated: true,
      method: options.token || options.password ? "api-key" : "cli",
      detail: `OpenClaw Gateway reachable at ${options.gatewayUrl}`,
    };
  } catch (error) {
    return {
      authenticated: false,
      method: options.token || options.password ? "api-key" : "cli",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    client.close();
  }
}
