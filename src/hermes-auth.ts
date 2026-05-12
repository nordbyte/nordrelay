import { HermesApiClient } from "./hermes-api.js";

export interface HermesAuthStatus {
  authenticated: boolean;
  method: string;
  detail: string;
}

export async function checkHermesAuthStatus(options: {
  baseUrl: string;
  apiKey?: string;
}): Promise<HermesAuthStatus> {
  const client = new HermesApiClient(options);
  try {
    await client.capabilities();
    return {
      authenticated: true,
      method: options.apiKey ? "api-key" : "local-api",
      detail: `Hermes API server reachable at ${options.baseUrl}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      authenticated: false,
      method: options.apiKey ? "api-key" : "local-api",
      detail: message,
    };
  }
}
