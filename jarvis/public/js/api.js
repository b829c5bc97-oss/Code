export class ApiError extends Error {
  constructor(status, message, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/** JSON fetch wrapper. Sends the CSRF header the server requires on every mutation. */
export async function api(path, { method = 'GET', body, raw, headers = {}, signal } = {}) {
  const init = { method, headers: { 'x-jarvis-csrf': '1', ...headers }, credentials: 'same-origin', signal };
  if (body !== undefined) {
    if (typeof body === 'string') init.body = body;
    else {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  let res;
  try {
    res = await fetch(`/api${path}`, init);
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError(0, 'Network error — check your connection.');
  }
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new CustomEvent('jarvis:unauthorized'));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data);
  }
  return data;
}

export const get = (p, o) => api(p, o);
export const post = (p, body, o) => api(p, { ...o, method: 'POST', body: body ?? {} });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const put = (p, body) => api(p, { method: 'PUT', body });
export const del = (p) => api(p, { method: 'DELETE' });
