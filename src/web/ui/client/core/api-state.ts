class ApiStateError extends Error {
  apiStatus: WebuiApiStateStatus;
  apiTarget: string;
  apiMessage: string;
  apiHandled: boolean;
  apiRetryAfterMs: number;

  constructor(status: WebuiApiStateStatus, message: string, options: WebuiApiStateTransition = {}) {
    super(message);
    this.name = "ApiStateError";
    this.apiStatus = status;
    this.apiTarget = normalizeApiTarget(options.target);
    this.apiMessage = message;
    this.apiHandled = true;
    this.apiRetryAfterMs = Number(options.retryAfterMs || 0);
  }
}

function defaultApiStateEntry(target: string): WebuiApiStateEntry {
  const now = new Date().toISOString();
  return {
    status: "online",
    target,
    message: "",
    lastOkAt: now,
    updatedAt: now,
    consecutiveFailures: 0,
  };
}

function normalizeApiTarget(target?: unknown): string {
  const value = String(target || "local").trim();
  return value || "local";
}

function apiStateEntry(target?: unknown): WebuiApiStateEntry {
  const normalized = normalizeApiTarget(target);
  if (!state.apiStatus) {
    state.apiStatus = { local: defaultApiStateEntry("local"), peers: {} };
  }
  if (normalized === "local") {
    state.apiStatus.local = state.apiStatus.local || defaultApiStateEntry("local");
    return state.apiStatus.local;
  }
  state.apiStatus.peers = state.apiStatus.peers || {};
  state.apiStatus.peers[normalized] = state.apiStatus.peers[normalized] || defaultApiStateEntry(normalized);
  return state.apiStatus.peers[normalized];
}

function apiStateLabel(status: WebuiApiStateStatus): string {
  if (status === "online") return "Live";
  if (status === "restarting") return "Reconnecting";
  if (status === "auth-expired") return "Auth expired";
  if (status === "peer-unreachable") return "Peer unreachable";
  if (status === "stale-data") return "Stale data";
  if (status === "offline") return "Offline";
  return status;
}

function apiStateKind(status: WebuiApiStateStatus): string {
  return status === "online" ? "ok" : status === "stale-data" || status === "restarting" ? "warn" : "error";
}

function apiStateMessage(status: WebuiApiStateStatus, options: WebuiApiStateTransition = {}): string {
  if (options.message) return String(options.message);
  if (status === "online") return "";
  if (status === "auth-expired") return "Dashboard login expired. Sign in again to continue.";
  if (status === "peer-unreachable") return "The selected peer is not reachable. Local dashboard data remains available.";
  if (status === "stale-data") return "Showing the last loaded data while NordRelay refreshes this view.";
  if (status === "offline") return "The browser is offline. Reconnect the network to continue.";
  return "NordRelay is restarting or temporarily unreachable. Current dashboard data stays visible.";
}

function setApiState(status: WebuiApiStateStatus, options: WebuiApiStateTransition = {}): WebuiApiStateEntry {
  const target = normalizeApiTarget(options.target);
  const entry = apiStateEntry(target);
  const now = new Date().toISOString();
  const previousStatus = entry.status;
  entry.status = status;
  entry.target = target;
  entry.message = apiStateMessage(status, options);
  entry.updatedAt = now;
  entry.retryAt = options.retryAfterMs ? new Date(Date.now() + Number(options.retryAfterMs)).toISOString() : undefined;
  if (status === "online") {
    entry.lastOkAt = now;
    entry.consecutiveFailures = 0;
  } else if (previousStatus !== status || options.incrementFailure !== false) {
    entry.consecutiveFailures = Number(entry.consecutiveFailures || 0) + 1;
    entry.staleSince = entry.staleSince || now;
  }
  renderApiState();
  return entry;
}

function recordApiSuccess(target?: unknown): void {
  setApiState("online", { target: normalizeApiTarget(target), incrementFailure: false });
}

function createApiStateError(status: WebuiApiStateStatus, message: string, options: WebuiApiStateTransition = {}): ApiStateError {
  setApiState(status, { ...options, message });
  return new ApiStateError(status, message, options);
}

function isApiStateError(error: unknown): error is ApiStateError {
  return Boolean(error && typeof error === "object" && "apiHandled" in error && "apiStatus" in error);
}

function handleUiError(error: unknown): void {
  if (isApiStateError(error)) {
    renderApiState();
    return;
  }
  toast(error instanceof Error ? error.message : String(error));
}

function currentApiStateTarget(): string {
  const peer = normalizeApiTarget(state.selectedPeer);
  if (state.apiStatus?.local?.status === "auth-expired") return "local";
  if (state.apiStatus?.local?.status === "offline") return "local";
  return peer;
}

function currentApiStateEntry(): WebuiApiStateEntry {
  return apiStateEntry(currentApiStateTarget());
}

function renderApiState(): void {
  const entry = currentApiStateEntry();
  const label = apiStateLabel(entry.status);
  const kind = apiStateKind(entry.status);
  if (typeof setConnection === "function") setConnection(label, kind);
  const banner = document.getElementById("apiStateBanner");
  if (!banner) return;
  if (entry.status === "online") {
    banner.hidden = true;
    banner.textContent = "";
    banner.className = "api-state-banner";
    return;
  }
  const targetLabel = entry.target === "local" ? "Local node" : headerTargetName(entry.target);
  banner.hidden = false;
  banner.className = "api-state-banner api-state-" + kind;
  banner.innerHTML = "<strong>" + esc(label) + "</strong><span>" + esc(entry.message || label) + "</span><small>" + esc(targetLabel) + "</small>";
}

function apiFetchFailureStatus(target?: unknown): WebuiApiStateStatus {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  return normalizeApiTarget(target) === "local" ? "restarting" : "peer-unreachable";
}

function apiResponseFailureStatus(response: Response, message: string, target?: unknown): WebuiApiStateStatus | null {
  const normalized = normalizeApiTarget(target);
  const lower = String(message || "").toLowerCase();
  if (response.status === 401) return "auth-expired";
  if (response.status === 429) return "restarting";
  if (normalized !== "local" && (
    response.status === 502 ||
    response.status === 503 ||
    response.status === 504 ||
    lower.includes("peer") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("unreachable") ||
    lower.includes("fingerprint")
  )) return "peer-unreachable";
  if (response.status >= 500) return normalized === "local" ? "restarting" : "peer-unreachable";
  return null;
}
