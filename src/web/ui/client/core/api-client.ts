/** @typedef {import("./api-client-types.js").WebApiPath} WebApiPath */
/** @typedef {import("./api-client-types.js").WebApiQuery} WebApiQuery */
/** @typedef {import("./api-client-types.js").WebApiMethod} WebApiMethod */
/** @typedef {{ path: string; methods: WebApiMethod[] } | { re: RegExp; methods: WebApiMethod[] }} ApiRouteRule */

/** @type {ApiRouteRule[]} */
const API_ROUTE_RULES = /** @type {{ NORDRELAY_WEB_API_CLIENT_ROUTE_RULES?: ApiRouteRule[] }} */ (globalThis).NORDRELAY_WEB_API_CLIENT_ROUTE_RULES ?? [];
const AUTH_REFRESH_STORAGE_KEY = 'nordrelayAuthRefreshAttemptedAt';
const WEB_PROXY_DEFAULT_CONTEXT_KEY = 'web:dashboard';
let dashboardAuthRefreshPromise: Promise<boolean> | null = null;

/**
 * @template {WebApiPath} P
 * @param {P} path
 * @param {import("./api-client-types.js").WebApiClientOptions<P> & { local?: boolean }} [options]
 * @returns {Promise<import("./api-client-types.js").WebApiClientResponse<P>>}
 */
async function api<P extends import("./api-client-types.js").WebApiPath>(
  path: P,
  options: import("./api-client-types.js").WebApiClientOptions<P> & { local?: boolean } = {},
): Promise<import("./api-client-types.js").WebApiClientResponse<P>> {
  const method = normalizeMethod(options.method, options.body);
  const url = apiUrl(path, options.query);
  assertApiRoute(url.pathname, method);
  if (!options.local && shouldProxyApi(url.pathname)) {
    const peerId = selectedPeerTarget();
    const query = queryObject(url);
    const body = bodyObject(options.body);
    const contextKey = webProxyContextKey(url.pathname, method, body, query, options.contextKey, peerId);
    const proxyBody = JSON.stringify({
      method,
      path: url.pathname,
      query,
      body,
      contextKey,
    });
    const context = { target: peerId, path: url.pathname, method, proxied: true };
    const send = () => fetchApi('/api/peers/'+encodeURIComponent(peerId)+'/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...csrfHeader() },
      body: proxyBody,
    }, context, options.timeoutMs);
    const res = await send();
    return await handleApiResponse<P>(res, send, false, context);
  }
  const body = normalizeBody(options.body);
  const context = { target: 'local', path: url.pathname, method, proxied: false };
  const send = () => fetchApi(url.pathname + url.search, {
    method,
    headers: {
      ...(body !== undefined && shouldSendJsonHeader(options.body) ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? csrfHeader() : {}),
      ...(options.headers || {}),
    },
    body,
  }, context, options.timeoutMs);
  const res = await send();
  return await handleApiResponse<P>(res, send, false, context);
}

/**
 * @template {WebApiPath} P
 * @param {string} peerId
 * @param {P} path
 * @param {import("./api-client-types.js").WebApiClientOptions<P>} [options]
 * @returns {Promise<import("./api-client-types.js").WebApiClientResponse<P>>}
 */
async function apiPeer<P extends import("./api-client-types.js").WebApiPath>(
  peerId: string,
  path: P,
  options: import("./api-client-types.js").WebApiClientOptions<P> = {},
): Promise<import("./api-client-types.js").WebApiClientResponse<P>> {
  const method = normalizeMethod(options.method, options.body);
  const url = apiUrl(path, options.query);
  assertApiRoute(url.pathname, method);
  const context = { target: peerId, path: url.pathname, method, proxied: true };
  const query = queryObject(url);
  const body = bodyObject(options.body);
  const contextKey = webProxyContextKey(url.pathname, method, body, query, options.contextKey, peerId);
  const send = () => fetchApi('/api/peers/'+encodeURIComponent(peerId)+'/proxy', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...csrfHeader() },
    body: JSON.stringify({
      method,
      path: url.pathname,
      query,
      body,
      contextKey,
    }),
  }, context, options.timeoutMs);
  const res = await send();
  return await handleApiResponse<P>(res, send, false, context);
}

/**
 * @template {WebApiPath} P
 * @param {Response} res
 * @returns {Promise<import("./api-client-types.js").WebApiClientResponse<P>>}
 */
async function handleApiResponse<P extends import("./api-client-types.js").WebApiPath>(
  res: Response,
  retry?: () => Promise<Response>,
  authRetried = false,
  context: WebuiApiRequestContext = { target: 'local', path: '', method: 'GET' },
): Promise<import("./api-client-types.js").WebApiClientResponse<P>> {
  const data = await readApiResponse(res);
  if (shouldRefreshDashboardForAuth(res, data)) {
    if (retry && !authRetried && await refreshDashboardForAuth()) {
      return await handleApiResponse<P>(await retry(), undefined, true, context);
    }
    const status = res.status === 401 ? "auth-expired" : "restarting";
    throw createApiStateError(status, "Dashboard session changed. Wait until NordRelay is reachable, then retry the action.", { target: "local", statusCode: res.status });
  }
  if (!res.ok) {
    const message = apiErrorMessage(data, res.statusText);
    const status = apiResponseFailureStatus(res, message, context.target);
    if (status) {
      const retryAfterMs = retryAfterFromResponse(res, data);
      throw createApiStateError(status, message, { target: context.target, statusCode: res.status, path: context.path, method: context.method, retryAfterMs });
    }
    throw new Error(message);
  }
  clearDashboardAuthRefreshAttempt();
  if (context.proxied) recordApiSuccess('local');
  recordApiSuccess(context.target);
  return data as import("./api-client-types.js").WebApiClientResponse<P>;
}

function csrfHeader() {
  const csrfToken = /** @type {{ NORDRELAY_WEBUI_RUNTIME_STATE?: { csrfToken?: string | null } }} */ (globalThis).NORDRELAY_WEBUI_RUNTIME_STATE?.csrfToken;
  return csrfToken ? { 'x-nordrelay-csrf': csrfToken } : {};
}

/**
 * @param {Response} res
 * @returns {Promise<Record<string, unknown>>}
 */
async function readApiResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

/**
 * @param {Response} res
 * @param {Record<string, unknown>} data
 */
function shouldRefreshDashboardForAuth(res: Response, data: Record<string, unknown>) {
  if (res.status === 401) return true;
  if (res.status !== 403) return false;
  return /csrf/i.test(apiErrorMessage(data, ''));
}

/**
 * @param {Record<string, unknown>} data
 * @param {string} fallback
 */
function apiErrorMessage(data: Record<string, unknown>, fallback: string) {
  const error = typeof data.error === 'string' ? data.error : '';
  const message = typeof data.message === 'string' ? data.message : '';
  return error || message || fallback || 'Request failed';
}

async function refreshDashboardForAuth(): Promise<boolean> {
  if (dashboardAuthRefreshPromise) return dashboardAuthRefreshPromise;
  dashboardAuthRefreshPromise = refreshDashboardAuthState().finally(() => {
    dashboardAuthRefreshPromise = null;
  });
  return dashboardAuthRefreshPromise;
}

async function refreshDashboardAuthState(): Promise<boolean> {
  const runtimeState = globalThis.NORDRELAY_WEBUI_RUNTIME_STATE;
  if (runtimeState) runtimeState.authReloading = true;
  rememberDashboardAuthRefreshAttempt();
  setApiState('restarting', { target: 'local', message: 'Dashboard session changed. Waiting for NordRelay API...', incrementFailure: false });
  try {
    const auth = await waitForDashboardAuthState();
    if (!auth?.csrfToken) {
      setApiState('auth-expired', { target: 'local', message: 'Dashboard login expired. Sign in again.' });
      return false;
    }
    if (runtimeState) {
      runtimeState.auth = auth;
      runtimeState.csrfToken = auth.csrfToken || null;
      runtimeState.permissions = auth.permissions || [];
    }
    if (typeof applyAccountChrome === 'function') applyAccountChrome(auth);
    if (typeof clearStickyToast === 'function') clearStickyToast();
    recordApiSuccess('local');
    return true;
  } catch {
    setApiState('restarting', { target: 'local', message: 'NordRelay is restarting. Actions will resume when the API is reachable.', retryAfterMs: 1000 });
    return false;
  } finally {
    if (runtimeState) runtimeState.authReloading = false;
  }
}

async function waitForDashboardAuthState(timeoutMs = 30000): Promise<WebuiAuth | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const res = await fetch('/api/auth/me', { method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store' });
      if (res.ok) return await readApiResponse(res) as WebuiAuth;
      if (res.status === 401) return null;
    } catch {
      // NordRelay may be between shutdown and startup; keep the current page stable and retry.
    }
    await delay(1000);
  }
  throw new Error('Timed out waiting for NordRelay API.');
}

function rememberDashboardAuthRefreshAttempt(now = Date.now()): void {
  try {
    sessionStorage.setItem(AUTH_REFRESH_STORAGE_KEY, String(now));
  } catch {
    // Ignore storage failures; the in-memory promise still prevents duplicate auth refreshes.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clearDashboardAuthRefreshAttempt(): void {
  try {
    sessionStorage.removeItem(AUTH_REFRESH_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
  const runtimeState = globalThis.NORDRELAY_WEBUI_RUNTIME_STATE;
  if (runtimeState) {
    runtimeState.authReloading = false;
  }
}

/**
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 */
async function fetchApi(input, init, context: WebuiApiRequestContext = { target: 'local', path: '', method: 'GET' }, timeoutMs = 0) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let requestInit: RequestInit = init || {};
  if (timeoutMs > 0 && typeof AbortController !== 'undefined') {
    const controller = new AbortController();
    const previousSignal = requestInit.signal;
    if (previousSignal?.aborted) controller.abort();
    else previousSignal?.addEventListener?.('abort', () => controller.abort(), { once: true });
    timer = setTimeout(() => controller.abort(), timeoutMs);
    requestInit = { ...requestInit, signal: controller.signal };
  }
  try {
    return await fetch(input, requestInit);
  } catch (error) {
    const status = apiFetchFailureStatus(context.target);
    const timedOut = timeoutMs > 0 && error instanceof Error && error.name === 'AbortError';
    const message = timedOut
      ? context.target === 'local'
        ? 'NordRelay API timed out. Keeping current dashboard data visible.'
        : 'Peer API timed out. Local dashboard data remains available.'
      : status === 'peer-unreachable'
      ? 'Peer API is unreachable. Local dashboard data remains available.'
      : 'NordRelay API is restarting or unreachable. Keeping current dashboard data visible.';
    throw createApiStateError(status, message, { target: context.target, path: context.path, method: context.method, retryAfterMs: 5000 });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param {Response} res
 * @param {Record<string, unknown>} data
 */
function retryAfterFromResponse(res: Response, data: Record<string, unknown>): number {
  const header = Number(res.headers.get('retry-after-ms') || 0);
  if (Number.isFinite(header) && header > 0) return header;
  const body = Number(data.retryAfterMs || 0);
  return Number.isFinite(body) && body > 0 ? body : 0;
}

/**
 * @param {string} path
 */
function shouldProxyApi(path) {
  const peerId = selectedPeerTarget();
  if (!peerId || peerId === 'local') return false;
  if (!path.startsWith('/api/')) return false;
  return !(
    path === '/api/auth/me' ||
    path === '/api/dashboard/logout' ||
    path === '/api/profile' ||
    path === '/api/profile/password' ||
    path === '/api/profile/logout-other-sessions' ||
    path === '/api/peers' ||
    path === '/api/peers/invite' ||
    path === '/api/peers/pair' ||
    path === '/api/peers/probe' ||
    path === '/api/peers/discover' ||
    path === '/api/peers/discovery-jobs' ||
    path === '/api/peers/relay' ||
    path === '/api/peers/global-sessions' ||
    path === '/api/peers/identity/backup' ||
    path === '/api/peers/identity/restore' ||
    path === '/api/settings/wizard/test' ||
    path === '/api/plugins/marketplace' ||
    isLocalWorkflowApi(path) ||
    /^\/api\/peers\/discovery-jobs\//.test(path) ||
    /^\/api\/peers\/[^/]+(?:\/events|\/proxy)?$/.test(path) ||
    /^\/api\/peers\/[^/]+\/repin$/.test(path) ||
    /^\/api\/peers\/[^/]+\/rotate$/.test(path) ||
    isLocalAdminApi(path)
  );
}

/**
 * @param {string} path
 */
function isLocalAdminApi(path) {
  return path === '/api/permissions' ||
    path === '/api/settings' ||
    path === '/api/doctor' ||
    path === '/api/doctor/fix' ||
    path === '/api/audit' ||
    path === '/api/locks' ||
    path === '/api/users' ||
    path === '/api/groups' ||
    path === '/api/telegram-chats' ||
    path === '/api/discord-channels' ||
    path === '/api/slack-channels' ||
    path === '/api/matrix-rooms' ||
    /^\/api\/users\//.test(path) ||
    /^\/api\/groups\//.test(path) ||
    /^\/api\/telegram-chats\//.test(path) ||
    /^\/api\/discord-channels\//.test(path) ||
    /^\/api\/slack-channels\//.test(path) ||
    /^\/api\/matrix-rooms\//.test(path);
}

/**
 * @param {string} path
 */
function isLocalWorkflowApi(path) {
  return path === '/api/templates' ||
    path === '/api/workflows' ||
    /^\/api\/templates\//.test(path) ||
    /^\/api\/workflows\//.test(path) ||
    /^\/api\/workflow-runs\//.test(path);
}

function selectedPeerTarget() {
  const runtimeState = /** @type {{ NORDRELAY_WEBUI_RUNTIME_STATE?: { selectedPeer?: string } }} */ (globalThis).NORDRELAY_WEBUI_RUNTIME_STATE;
  return runtimeState?.selectedPeer || 'local';
}

/**
 * @param {string} path
 * @param {WebApiMethod} [method]
 * @param {Record<string, unknown>} [body]
 * @param {Record<string, string | string[]>} [query]
 * @param {string} [explicitContextKey]
 * @param {string} [peerId]
 * @returns {string}
 */
function webProxyContextKey(path, method = 'GET', body = {}, query = {}, explicitContextKey = '', peerId = selectedPeerTarget()) {
  const explicit = typeof explicitContextKey === 'string' ? explicitContextKey.trim() : '';
  if (explicit) return explicit;
  const target = threadTargetForWebProxyPath(path, method, body, query, peerId);
  return target?.threadId ? webProxyThreadContextKey(target.agentId, target.threadId) : WEB_PROXY_DEFAULT_CONTEXT_KEY;
}

function webProxyEventContextKey() {
  return webProxyContextKey('/api/events', 'GET');
}

/**
 * @param {string} agentId
 * @param {string} threadId
 */
function webProxyThreadContextKey(_agentId, threadId) {
  const thread = contextPart(threadId);
  if (!thread) return WEB_PROXY_DEFAULT_CONTEXT_KEY;
  return WEB_PROXY_DEFAULT_CONTEXT_KEY + ':thread:' + thread;
}

/**
 * @param {string} path
 * @param {WebApiMethod} method
 * @param {Record<string, unknown>} body
 * @param {Record<string, string | string[]>} query
 * @param {string} peerId
 * @returns {{ agentId: string; threadId: string } | null}
 */
function threadTargetForWebProxyPath(path, method, body, query, peerId) {
  if (path === '/api/sessions/switch') {
    const threadId = firstString(body.threadId);
    return threadId ? { agentId: activeWebProxyAgentId(peerId, body), threadId } : null;
  }
  if (path === '/api/sessions/detail') {
    const threadId = firstString(query.threadId);
    return threadId ? { agentId: firstString(query.agent) || activeWebProxyAgentId(peerId, body), threadId } : null;
  }
  if (path === '/api/sessions/name') {
    const threadId = firstString(body.threadId);
    return threadId ? { agentId: firstString(body.agentId) || activeWebProxyAgentId(peerId, body), threadId } : null;
  }
  if (!isChatThreadScopedProxyPath(path, method)) return null;
  return activeWebProxyThreadTarget(peerId);
}

/**
 * @param {string} path
 * @param {WebApiMethod} method
 */
function isChatThreadScopedProxyPath(path, method) {
  const runtimeState = (globalThis as typeof globalThis & { NORDRELAY_WEBUI_RUNTIME_STATE?: DashboardState }).NORDRELAY_WEBUI_RUNTIME_STATE;
  if (runtimeState?.currentPage !== 'chat') return false;
  if (path === '/api/bootstrap' ||
    path === '/api/chat/history' ||
    path === '/api/chat/attachment' ||
    path === '/api/chat/mirror' ||
    path === '/api/prompt' ||
    path === '/api/prompt/upload' ||
    path === '/api/queue' ||
    path === '/api/tasks' ||
    path === '/api/models' ||
    path === '/api/control-options' ||
    path === '/api/abort' ||
    path === '/api/stop' ||
    path === '/api/retry' ||
    path === '/api/sync' ||
    path === '/api/handback' ||
    path === '/api/session/model' ||
    path === '/api/session/reasoning' ||
    path === '/api/session/fast' ||
    path === '/api/session/launch') return true;
  return method === 'POST' && /^\/api\/approvals\/[^/]+\/respond$/.test(path);
}

/**
 * @param {string} peerId
 * @returns {{ agentId: string; threadId: string } | null}
 */
function activeWebProxyThreadTarget(peerId) {
  const state = (globalThis as typeof globalThis & { NORDRELAY_WEBUI_RUNTIME_STATE?: DashboardState }).NORDRELAY_WEBUI_RUNTIME_STATE;
  const selectedPeer = state?.selectedPeer || 'local';
  if (peerId && peerId !== selectedPeer) return null;
  const activeTab = Array.isArray(state?.chatTabs)
    ? state.chatTabs.find((tab) => tab.id === state.activeChatTabId && (tab.peerId || 'local') === selectedPeer)
    : null;
  const session = state?.snapshot?.session || {};
  const threadId = firstString(activeTab?.threadId) || firstString(session.threadId);
  if (!threadId) return null;
  return {
    agentId: firstString(activeTab?.agentId) || firstString(session.agentId),
    threadId,
  };
}

/**
 * @param {string} peerId
 * @param {Record<string, unknown>} body
 */
function activeWebProxyAgentId(peerId, body) {
  const fromBody = firstString(body.agentId) || firstString(body.agent);
  if (fromBody) return fromBody;
  return activeWebProxyThreadTarget(peerId)?.agentId || '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function firstString(value) {
  if (Array.isArray(value)) return firstString(value[0]);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function contextPart(value) {
  return firstString(value).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180);
}

/**
 * @param {URL} url
 * @returns {Record<string, string | string[]>}
 */
function queryObject(url) {
  /** @type {Record<string, string | string[]>} */
  const result = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (result[key] === undefined) result[key] = value;
    else if (Array.isArray(result[key])) result[key].push(value);
    else result[key] = [result[key], value];
  }
  return result;
}

/**
 * @param {unknown} body
 * @returns {Record<string, unknown>}
 */
function bodyObject(body) {
  if (body === undefined || body === null) return {};
  if (typeof body === 'string') {
    try { return body ? JSON.parse(body) : {}; } catch { return { value: body }; }
  }
  if (isNativeBody(body)) return {};
  return /** @type {Record<string, unknown>} */ (body);
}

/**
 * @param {string} path
 * @param {WebApiQuery} [query]
 */
function apiUrl(path, query) {
  const url = new URL(path, location.origin);
  if (query) {
    for (const [key, rawValue] of Object.entries(query)) {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      for (const value of values) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.append(key, String(value));
        }
      }
    }
  }
  return url;
}

/**
 * @param {string} value
 * @returns {string}
 */
function apiSegment(value) {
  return encodeURIComponent(value);
}

/**
 * @param {WebApiMethod | undefined} method
 * @param {unknown} body
 * @returns {WebApiMethod}
 */
function normalizeMethod(method, body) {
  if (method) {
    const upper = method.toUpperCase();
    if (upper === 'GET' || upper === 'POST' || upper === 'PATCH' || upper === 'PUT' || upper === 'DELETE') {
      return upper;
    }
  }
  return body === undefined || body === null ? 'GET' : 'POST';
}

/**
 * @param {unknown} body
 * @returns {BodyInit | undefined}
 */
function normalizeBody(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (isNativeBody(body)) return body;
  return JSON.stringify(body);
}

/**
 * @param {unknown} body
 */
function shouldSendJsonHeader(body) {
  return body !== undefined && body !== null && !isNativeBody(body);
}

/**
 * @param {unknown} body
 * @returns {body is BodyInit}
 */
function isNativeBody(body) {
  return (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer);
}

/**
 * @param {string} path
 * @param {WebApiMethod} method
 */
function assertApiRoute(path, method) {
  const rule = API_ROUTE_RULES.find(candidate =>
    ('path' in candidate && candidate.path === path) ||
    ('re' in candidate && candidate.re.test(path))
  );
  if (!rule) {
    throw new Error('Unknown WebUI API route: ' + path);
  }
  if (!rule.methods.includes(method)) {
    throw new Error('Unsupported WebUI API method: ' + method + ' ' + path);
  }
}
