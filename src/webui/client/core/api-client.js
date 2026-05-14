// @ts-check

/** @typedef {import("../../../web-api-types.js").WebApiPath} WebApiPath */
/** @typedef {import("../../../web-api-types.js").WebApiQuery} WebApiQuery */
/** @typedef {import("../../../web-api-types.js").WebApiMethod} WebApiMethod */
/** @typedef {{ path: string; methods: WebApiMethod[] } | { re: RegExp; methods: WebApiMethod[] }} ApiRouteRule */

/** @type {ApiRouteRule[]} */
const API_ROUTE_RULES = [
  route('/api/auth/me', ['GET']),
  route('/api/dashboard/logout', ['POST']),
  route('/api/bootstrap', ['GET']),
  route('/api/health', ['GET']),
  route('/api/snapshot', ['GET']),
  route('/api/tasks', ['GET']),
  route('/api/progress', ['GET']),
  route('/api/version', ['GET']),
  route('/api/update', ['POST']),
  route('/api/agent-updates', ['GET']),
  route('/api/agent-update', ['POST']),
  route('/api/adapters/health', ['GET']),
  route('/api/permissions', ['GET']),
  route('/api/users', ['GET', 'POST']),
  route('/api/groups', ['GET', 'POST']),
  route('/api/telegram-chats', ['GET', 'POST']),
  route('/api/audit', ['GET']),
  route('/api/locks', ['GET', 'POST', 'DELETE']),
  route('/api/auth/status', ['GET']),
  route('/api/auth/login', ['POST']),
  route('/api/auth/logout', ['POST']),
  route('/api/settings', ['GET', 'PATCH']),
  route('/api/control-options', ['GET']),
  route('/api/sessions', ['GET']),
  route('/api/sessions/new', ['POST']),
  route('/api/sessions/switch', ['POST']),
  route('/api/sessions/attach', ['POST']),
  route('/api/sessions/detail', ['GET']),
  route('/api/agent', ['POST']),
  route('/api/models', ['GET']),
  route('/api/session/model', ['POST']),
  route('/api/session/reasoning', ['POST']),
  route('/api/session/fast', ['POST']),
  route('/api/session/launch', ['POST']),
  route('/api/prompt', ['POST']),
  route('/api/prompt/upload', ['POST']),
  route('/api/abort', ['POST']),
  route('/api/stop', ['POST']),
  route('/api/handback', ['POST']),
  route('/api/retry', ['POST']),
  route('/api/sync', ['POST']),
  route('/api/queue', ['GET', 'POST']),
  route('/api/chat/history', ['GET', 'DELETE']),
  route('/api/activity', ['GET']),
  route('/api/artifacts', ['GET', 'DELETE']),
  route('/api/artifacts/bulk', ['POST']),
  route('/api/artifacts/zip', ['GET']),
  route('/api/artifacts/file', ['GET']),
  route('/api/artifacts/preview', ['GET']),
  route('/api/logs', ['GET']),
  route('/api/logs/clear', ['POST']),
  route('/api/diagnostics', ['GET']),
  route('/api/runtime/restart', ['POST']),
  pattern(/^\/api\/users\/[^/]+$/, ['PATCH']),
  pattern(/^\/api\/users\/[^/]+\/password$/, ['POST']),
  pattern(/^\/api\/users\/[^/]+\/sessions$/, ['GET', 'DELETE']),
  pattern(/^\/api\/users\/[^/]+\/sessions\/[^/]+$/, ['DELETE']),
  pattern(/^\/api\/users\/[^/]+\/telegram$/, ['POST']),
  pattern(/^\/api\/users\/[^/]+\/telegram\/[^/]+$/, ['DELETE']),
  pattern(/^\/api\/groups\/[^/]+$/, ['PATCH']),
  pattern(/^\/api\/telegram-chats\/[^/]+$/, ['PATCH']),
  pattern(/^\/api\/agent-update\/[^/]+\/log$/, ['GET', 'DELETE']),
  pattern(/^\/api\/agent-update\/[^/]+\/input$/, ['POST']),
  pattern(/^\/api\/agent-update\/[^/]+\/cancel$/, ['POST']),
];

/**
 * @template {WebApiPath} P
 * @param {P} path
 * @param {import("../../../web-api-types.js").WebApiClientOptions<P>} [options]
 * @returns {Promise<import("../../../web-api-types.js").WebApiClientResponse<P>>}
 */
async function api(path, options = {}) {
  const method = normalizeMethod(options.method, options.body);
  const url = apiUrl(path, options.query);
  assertApiRoute(url.pathname, method);
  const body = normalizeBody(options.body);
  const headers = {
    ...(body !== undefined && shouldSendJsonHeader(options.body) ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  const res = await fetch(url.pathname + url.search, { method, headers, body });
  if (res.status === 401) { location.reload(); return /** @type {never} */ (undefined); }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
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
 * @param {WebApiMethod[]} methods
 */
function route(path, methods) {
  return { path, methods };
}

/**
 * @param {RegExp} re
 * @param {WebApiMethod[]} methods
 */
function pattern(re, methods) {
  return { re, methods };
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
