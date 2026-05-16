import type { AgentSessionInfo } from "../agents/shared/agent.js";
import { checkClaudeCodeAuthStatus, startClaudeCodeLogin, startClaudeCodeLogout } from "../agents/claude-code/claude-code-auth.js";
import { checkAuthStatus, startLogin as startCodexLogin, startLogout as startCodexLogout, type LoginResult } from "../agents/codex/codex-auth.js";
import type { ConnectorConfig } from "../core/config.js";
import { checkHermesAuthStatus, startHermesLogin, startHermesLogout } from "../agents/hermes/hermes-auth.js";
import { checkOpenClawAuthStatus } from "../agents/openclaw/openclaw-auth.js";
import { checkPiAuthStatus } from "../agents/pi/pi-auth.js";

export interface AgentAuthStatus {
  authenticated: boolean;
  detail: string;
  method?: string;
}

export class RelayAuthService {
  constructor(private readonly config: ConnectorConfig) {}

  async check(info: AgentSessionInfo): Promise<AgentAuthStatus> {
    if (info.agentId === "pi") {
      return checkPiAuthStatus(info.model);
    }
    if (info.agentId === "hermes") {
      return checkHermesAuthStatus({
        baseUrl: this.config.hermesApiBaseUrl,
        apiKey: this.config.hermesApiKey,
      });
    }
    if (info.agentId === "openclaw") {
      return checkOpenClawAuthStatus({
        gatewayUrl: this.config.openClawGatewayUrl,
        token: this.config.openClawGatewayToken,
        password: this.config.openClawGatewayPassword,
      });
    }
    if (info.agentId === "claude-code") {
      return checkClaudeCodeAuthStatus(this.config.claudeCodeCliPath);
    }
    return checkAuthStatus(this.config.codexApiKey);
  }

  async startLogin(info: AgentSessionInfo): Promise<LoginResult> {
    if (info.agentId === "hermes") {
      return startHermesLogin(this.config.hermesCliPath);
    }
    if (info.agentId === "claude-code") {
      return startClaudeCodeLogin(this.config.claudeCodeCliPath);
    }
    if (info.agentId === "codex") {
      return startCodexLogin();
    }
    return {
      success: false,
      message: `${info.agentLabel} login is not managed by NordRelay. Run the agent login flow on the host.`,
    };
  }

  async startLogout(info: AgentSessionInfo): Promise<LoginResult> {
    if (info.agentId === "hermes") {
      return startHermesLogout(this.config.hermesCliPath);
    }
    if (info.agentId === "claude-code") {
      return startClaudeCodeLogout(this.config.claudeCodeCliPath);
    }
    if (info.agentId === "codex") {
      return startCodexLogout();
    }
    return {
      success: false,
      message: `${info.agentLabel} logout is not managed by NordRelay. Run the agent logout flow on the host.`,
    };
  }
}
