'use strict';
// Minimal PostgREST / GoTrue-admin client with fetch and the service-role key.

function makeClient(baseUrl, key, fetchImpl) {
  const base = String(baseUrl).replace(/\/+$/, '');
  const f = fetchImpl || fetch;
  // New-style Supabase keys (sb_secret_...) are not JWTs: they go in `apikey` only. Legacy service_role JWTs go in both headers.
  const auth = /^sb_/.test(String(key)) ? { apikey: key } : { apikey: key, Authorization: 'Bearer ' + key };
  async function call(method, path, body, extra) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await f(base + path, {
        method,
        headers: Object.assign({}, auth, { 'Content-Type': 'application/json' }, extra || {}),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
      });
      const text = await r.text();
      if (!r.ok) { const err = new Error(method + ' ' + path.split('?')[0] + ' -> HTTP ' + r.status + ' ' + text.slice(0, 200)); err.status = r.status; err.body = text.slice(0, 500); throw err; }
      return text ? JSON.parse(text) : null;
    } finally { clearTimeout(t); }
  }
  return {
    select: (table, query) => call('GET', '/rest/v1/' + table + '?' + query),
    patch: (table, filter, body) => call('PATCH', '/rest/v1/' + table + '?' + filter, body, { Prefer: 'return=minimal' }),
    // rows: one object or an array (one request). returning: true gives the stored rows back (ids), otherwise nothing.
    insert: (table, rows, returning) => call('POST', '/rest/v1/' + table, rows, { Prefer: returning ? 'return=representation' : 'return=minimal' }),
    authUser: (id) => call('GET', '/auth/v1/admin/users/' + encodeURIComponent(id)),
  };
}

module.exports = { makeClient };
