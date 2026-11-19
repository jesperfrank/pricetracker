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
      if (!r.ok) {
        // the message ends up in the public log: only the error's code and message, never its details (a failing row is quoted there, names included)
        let brief = text.slice(0, 200);
        try { const j = JSON.parse(text); if (j && typeof j === 'object') brief = [j.code, j.message || j.msg].filter((x) => typeof x === 'string').join(' ').slice(0, 200); } catch (e) { /* not json: the text as it is */ }
        const err = new Error(method + ' ' + path.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id') + ' -> HTTP ' + r.status + ' ' + brief); err.status = r.status; err.body = text.slice(0, 500); throw err; }
      return text ? JSON.parse(text) : null;
    } finally { clearTimeout(t); }
  }
  return {
    select: (table, query) => call('GET', '/rest/v1/' + table + '?' + query),
    // returning: true gives the changed rows back (to tell how many were changed), otherwise nothing.
    patch: (table, filter, body, returning) => call('PATCH', '/rest/v1/' + table + '?' + filter, body, { Prefer: returning ? 'return=representation' : 'return=minimal' }),
    // rows: one object or an array (one request). returning: true gives the stored rows back (ids), otherwise nothing.
    insert: (table, rows, returning) => call('POST', '/rest/v1/' + table, rows, { Prefer: returning ? 'return=representation' : 'return=minimal' }),
    authUser: (id) => call('GET', '/auth/v1/admin/users/' + encodeURIComponent(id)),
  };
}

module.exports = { makeClient };
