// Thin fetch wrapper. Attaches the JWT and normalises errors.
const TOKEN_KEY = 'audix_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(t) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

async function handle(res) {
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json().catch(() => ({})) : await res.blob();
  if (!res.ok) {
    const err = new Error((body && body.error) || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

function authHeaders(extra = {}) {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}`, ...extra } : extra;
}

export const api = {
  get: (path) => fetch(`/api${path}`, { headers: authHeaders() }).then(handle),
  post: (path, data) =>
    fetch(`/api${path}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data),
    }).then(handle),
  put: (path, data) =>
    fetch(`/api${path}`, {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(data),
    }).then(handle),
  del: (path) => fetch(`/api${path}`, { method: 'DELETE', headers: authHeaders() }).then(handle),
  // multipart (FormData); do NOT set Content-Type — browser sets boundary
  upload: (path, formData) =>
    fetch(`/api${path}`, { method: 'POST', headers: authHeaders(), body: formData }).then(handle),
  // returns a Blob (for report downloads)
  blob: (path) => fetch(`/api${path}`, { headers: authHeaders() }).then(handle),
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
