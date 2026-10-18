// Starts an isolated JARVIS server (in-memory DB) and returns a tiny cookie-aware client.
export async function startServer(env = {}) {
  Object.assign(process.env, { JARVIS_DB: ':memory:', JARVIS_DISABLE_SCHEDULER: '1', JARVIS_SKIP_DOTENV: '1', ...env });
  const { createApp } = await import('../server/index.js');
  const app = createApp();
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

export function client(base) {
  let cookie = '';
  const call = async (method, path, body, { csrf = true, headers = {} } = {}) => {
    const h = { ...headers };
    if (csrf) h['x-jarvis-csrf'] = '1';
    if (cookie) h.cookie = cookie;
    let payload;
    if (body !== undefined) {
      if (typeof body === 'string') payload = body;
      else { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    }
    const res = await fetch(base + path, { method, headers: h, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  };
  return {
    get: (p, o) => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b ?? {}, o),
    patch: (p, b, o) => call('PATCH', p, b, o),
    put: (p, b, o) => call('PUT', p, b, o),
    del: (p, o) => call('DELETE', p, undefined, o),
    async signup(email, tz = 'Asia/Kolkata') {
      const r = await call('POST', '/auth/signup', { email, password: 'a-long-password-1', name: email.split('@')[0], timezone: tz });
      if (r.status !== 201) throw new Error(JSON.stringify(r.data));
      return r.data.user;
    },
  };
}
