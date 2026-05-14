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
