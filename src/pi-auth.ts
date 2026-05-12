import type { AuthStatus } from "./codex-auth.js";

const PROVIDER_ENV_KEYS: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
  "aws-bedrock": ["AWS_BEARER_TOKEN_BEDROCK", "AWS_PROFILE", "AWS_ACCESS_KEY_ID"],
  azure: ["AZURE_OPENAI_API_KEY"],
  "azure-openai": ["AZURE_OPENAI_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  cloudflare: ["CLOUDFLARE_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  fireworks: ["FIREWORKS_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  google: ["GEMINI_API_KEY"],
  groq: ["GROQ_API_KEY"],
  kimi: ["KIMI_API_KEY"],
  minimax: ["MINIMAX_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  moonshot: ["MOONSHOT_API_KEY"],
  opencode: ["OPENCODE_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  "openai-codex": ["OPENAI_API_KEY"],
  xai: ["XAI_API_KEY"],
  xiaomi: ["XIAOMI_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY", "XIAOMI_TOKEN_PLAN_AMS_API_KEY", "XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  zai: ["ZAI_API_KEY"],
};

export function checkPiAuthStatus(model: string | undefined, env: NodeJS.ProcessEnv = process.env): AuthStatus {
  const provider = providerFromModel(model);
  const keys = PROVIDER_ENV_KEYS[provider];
  if (!keys) {
    return {
      authenticated: true,
      method: "cli",
      detail: `Pi provider "${provider}" is not verifiable by NordRelay. Run "pi" on the host if auth fails.`,
    };
  }

  const configured = keys.filter((key) => Boolean(env[key]?.trim()));
  if (configured.length > 0) {
    return {
      authenticated: true,
      method: "api-key",
      detail: `Pi provider "${provider}" has ${configured.join(" or ")} configured.`,
    };
  }

  return {
    authenticated: false,
    method: "none",
    detail: `Pi provider "${provider}" needs one of: ${keys.join(", ")}.`,
  };
}

function providerFromModel(model: string | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed) {
    return "google";
  }
  const separator = trimmed.indexOf("/");
  if (separator === -1) {
    return "google";
  }
  return trimmed.slice(0, separator).toLowerCase();
}
