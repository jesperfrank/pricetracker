'use strict';
// Minimal PostgREST / GoTrue-admin client with fetch and the service-role key.

function makeClient(baseUrl, key, fetchImpl) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const f = fetchImpl || fetch;
  async function call(method, path, body, extra) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await f(base + path, {
        method,
        headers: Object.assign({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, extra || {}),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await r.text();
      if (!r.ok) throw new Error(method + ' ' + path.split('?')[0] + ' -> HTTP ' + r.status + ' ' + text.slice(0, 200));
      return text ? JSON.parse(text) : null;
    } finally { clearTimeout(t); }
  }
  return {
    select: (table, query) => call('GET', '/rest/v1/' + table + '?' + query),
    patch: (table, filter, body) => call('PATCH', '/rest/v1/' + table + '?' + filter, body, { Prefer: 'return=minimal' }),
    authUser: (id) => call('GET', '/auth/v1/admin/users/' + encodeURIComponent(id)),
  };
}

module.exports = { makeClient };
