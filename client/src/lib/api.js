// Thin fetch wrapper. Attaches the JWT, transparently refreshes an expired
// access token, and — critically — distinguishes a NETWORK failure from an
// AUTH failure so a dropped signal never logs an auditor out.
const TOKEN_KEY = 'audix_token';
const REFRESH_KEY = 'audix_refresh_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}
export function getRefreshToken() {
  return localStorage.getItem(REFRESH_KEY);
}
export function setRefreshToken(t) {
  if (t) localStorage.setItem(REFRESH_KEY, t);
  else localStorage.removeItem(REFRESH_KEY);
}
export function clearTokens() {
  setToken(null);
  setRefreshToken(null);
}

// Raised when the request never reached the server (offline, DNS, timeout).
// Callers must treat this as "try again later", NEVER as "you are logged out".
export class NetworkError extends Error {
  constructor(cause) {
    super('Network unavailable');
    this.name = 'NetworkError';
    this.isNetwork = true;
    this.cause = cause;
  }
}

// Notifies the app that the session is genuinely over (refresh token rejected).
let onAuthFailure = () => {};
export function setAuthFailureHandler(fn) { onAuthFailure = fn; }

async function handle(res) {
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json().catch(() => ({})) : await res.blob();
  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = body && body.code;
    err.body = body;
    throw err;
  }
  return body;
}

function authHeaders(extra = {}) {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}`, ...extra } : extra;
}

// ── Single-flight refresh ───────────────────────────────────────────────────
// Concurrent 401s share one refresh call instead of stampeding the endpoint.
let refreshInFlight = null;

async function refreshAccessToken() {
  const rt = getRefreshToken();
  if (!rt) return false;
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      let res;
      try {
        res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: rt }),
        });
      } catch (e) {
        // Offline: keep the tokens, the session is still valid.
        throw new NetworkError(e);
      }
      if (!res.ok) return false;            // refresh genuinely rejected
      const data = await res.json();
      setToken(data.token);
      return true;
    })().finally(() => { refreshInFlight = null; });
  }
  return refreshInFlight;
}

// Performs a request, refreshing once on an expired-token 401 and retrying.
async function request(path, init = {}, { retry = true } = {}) {
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch (e) {
    throw new NetworkError(e); // never an auth problem
  }

  if (res.status === 401 && retry && getRefreshToken()) {
    let refreshed = false;
    try {
      refreshed = await refreshAccessToken();
    } catch (e) {
      if (e.isNetwork) throw e; // offline — do not log out
      refreshed = false;
    }
    if (refreshed) {
      const nextInit = { ...init, headers: { ...init.headers, ...authHeaders() } };
      return request(path, nextInit, { retry: false });
    }
    // Refresh token itself is invalid/expired → the session really is over.
    onAuthFailure();
  }
  return handle(res);
}

export const api = {
  get: (path) => request(path, { headers: authHeaders() }),
  post: (path, data) =>
    request(path, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data),
    }),
  put: (path, data) =>
    request(path, {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data),
    }),
  del: (path) => request(path, { method: 'DELETE', headers: authHeaders() }),
  // multipart (FormData); do NOT set Content-Type — browser sets boundary
  upload: (path, formData) =>
    request(path, { method: 'POST', headers: authHeaders(), body: formData }),
  // returns a Blob (for report downloads)
  blob: (path) => request(path, { headers: authHeaders() }),
};

// Trigger a browser download from a report endpoint.
export async function downloadReport(path, filename) {
  const blob = await api.blob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Cache-busting for photo URLs so a freshly-uploaded image shows immediately.
export function bustCache(url, version) {
  if (!url) return url;
  const v = version || Date.now();
  return url + (url.includes('?') ? '&' : '?') + 'v=' + encodeURIComponent(v);
}
