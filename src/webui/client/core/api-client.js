// @ts-check

/** @typedef {import("../../../web-api-types.js").WebApiPath} WebApiPath */
/** @typedef {import("../../../web-api-types.js").WebApiQuery} WebApiQuery */
/** @typedef {import("../../../web-api-types.js").WebApiMethod} WebApiMethod */
/** @typedef {{ path: string; methods: WebApiMethod[] } | { re: RegExp; methods: WebApiMethod[] }} ApiRouteRule */

/** @type {ApiRouteRule[]} */
const API_ROUTE_RULES = /** @type {{ NORDRELAY_WEB_API_CLIENT_ROUTE_RULES?: ApiRouteRule[] }} */ (globalThis).NORDRELAY_WEB_API_CLIENT_ROUTE_RULES ?? [];

/**
 * @template {WebApiPath} P
 * @param {P} path
 * @param {import("../../../web-api-types.js").WebApiClientOptions<P> & { local?: boolean }} [options]
 * @returns {Promise<import("../../../web-api-types.js").WebApiClientResponse<P>>}
 */
async function api(path, options = {}) {
  const method = normalizeMethod(options.method, options.body);
  const url = apiUrl(path, options.query);
  assertApiRoute(url.pathname, method);
  if (!options.local && shouldProxyApi(url.pathname)) {
    const peerId = selectedPeerTarget();
    const proxyBody = JSON.stringify({
      method,
      path: url.pathname,
      query: queryObject(url),
      body: bodyObject(options.body),
      contextKey: 'web:dashboard',
    });
    const res = await fetch('/api/peers/'+encodeURIComponent(peerId)+'/proxy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: proxyBody,
    });
    if (res.status === 401) { location.reload(); return /** @type {never} */ (undefined); }
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }
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
 */
function shouldProxyApi(path) {
  const peerId = selectedPeerTarget();
  if (!peerId || peerId === 'local') return false;
  if (!path.startsWith('/api/')) return false;
  return !(
    path === '/api/auth/me' ||
    path === '/api/dashboard/logout' ||
    path === '/api/peers' ||
    path === '/api/peers/invite' ||
    path === '/api/peers/pair' ||
    /^\/api\/peers\/[^/]+(?:\/events|\/proxy)?$/.test(path) ||
    isLocalAdminApi(path)
  );
}

/**
 * @param {string} path
 */
function isLocalAdminApi(path) {
  return path === '/api/permissions' ||
    path === '/api/settings' ||
    path === '/api/audit' ||
    path === '/api/locks' ||
    path === '/api/users' ||
    path === '/api/groups' ||
    path === '/api/telegram-chats' ||
    path === '/api/discord-channels' ||
    path === '/api/slack-channels' ||
    /^\/api\/users\//.test(path) ||
    /^\/api\/groups\//.test(path) ||
    /^\/api\/telegram-chats\//.test(path) ||
    /^\/api\/discord-channels\//.test(path) ||
    /^\/api\/slack-channels\//.test(path);
}

function selectedPeerTarget() {
  const runtimeState = /** @type {{ NORDRELAY_WEBUI_RUNTIME_STATE?: { selectedPeer?: string } }} */ (globalThis).NORDRELAY_WEBUI_RUNTIME_STATE;
  return runtimeState?.selectedPeer || 'local';
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
