'use strict';
// Import of a shared wish list from Onskeskyen (onskeskyen.dk, internationally gowish.com) into products.
// Unofficial: it uses the same public JSON the shared page itself loads, and may stop working if the site changes.
// Only public lists (accessLevel "Public") are read, anonymously, with an honest User-Agent, one request at a time with a
// pause, no retries. A login wall, a challenge, 401/403/429 or 5xx is an error state: nothing is done to get around it.
// Only three hosts are ever contacted from here: onskeskyen.dk, gowish.com (both with optional www.) and api.gowish.com.
// Titles and urls of the wishes are untrusted text: they only travel as JSON values (never into a query string or markup).

const PJ = require('./prisjagt');
const { safe } = require('./log');
const SHOP = require('./shop');

const TIMEOUT_MS = 20000;
const PAUSE_MS = 1000;
const MAX_REDIRECTS = 5;
const MAX_WISHES = 60;
const PAGE_SIZE = 30;
const MAX_PER_RUN = 3;
const MAX_SYNCS_PER_RUN = 3;     // standing imports re-read per run, on top of MAX_PER_RUN new imports
const SYNC_EVERY_MS = 22 * 3600 * 1000;   // a finished import is read again at most once a day
const MAX_SYNC_FAILS = 7;        // a wish list that cannot be read this many days in a row is given up (status 'error')
const SEEN_MAX = 300;            // wish ids remembered per import (imports.seen allows 500)
const TITLE_MAX = 100;           // imports.title
const NAME_MAX = 140;            // products.name
const LIST_NAME_MAX = 40;        // lists.name
const PRODUCT_CAP = 40;          // products per user (products_limit)
const LIST_CAP = 30;             // lists per user (lists_limit)
const MAX_BODY = 3000000;
const API_URL = 'https://api.gowish.com/graphql';

// Our own small query (title, access level and the fields we use); the server accepts it as well as the page's own query.
const QUERY = 'query getWishlistWishes($id: ID!, $input: PaginationInput) { wishlist(id: $id) { id title accessLevel ' +
  'wishes(input: $input) { data { id title description price currency url photos } totalCount nextCursor } } }';

const NOTE = {
  private: 'Ønskelisten er ikke offentlig eller findes ikke. Bed ejeren om at dele den offentligt.',
  unavailable: 'Ønskeskyen svarede ikke. Prøv igen senere.',
  empty: 'Ønskelisten er tom, så der var intet at tilføje.',
  badUrl: 'Linket til ønskelisten kan ikke bruges.',
  saveFail: 'Ønskerne kunne ikke gemmes. Prøv igen senere.',
  full: 'Du følger allerede ' + PRODUCT_CAP + ' varer, så der er ikke plads til flere. Fjern nogle varer først.',
  retryPrivate: 'Ønskelisten er ikke offentlig lige nu. Prøver igen i morgen.',
  retryUnavailable: 'Ønskeskyen svarede ikke. Prøver igen i morgen.',
};

class ImportError extends Error {
  constructor(kind, detail) { super(kind + (detail ? ': ' + detail : '')); this.kind = kind; this.detail = detail || ''; }
}

const isListHost = (h) => /^(www\.)?(onskeskyen\.dk|gowish\.com)$/i.test(String(h || ''));
const isApiHost = (h) => String(h || '').toLowerCase() === 'api.gowish.com';

// ---------------------------------------------------------------- the link

// {id} for a wish-list address (/wishlists/<id>, optional locale prefix such as /da/), {short} for a share link
// (/s/<code>), null for anything else. Only https, no user:password@, no port, only the two list hosts.
function parseListUrl(u) {
  let x;
  try { x = new URL(String(u == null ? '' : u).trim()); } catch (e) { return null; }
  if (x.protocol !== 'https:' || x.username || x.password || x.port || !isListHost(x.hostname)) return null;
  const m = /^\/(?:[A-Za-z]{2}(?:-[A-Za-z]{2})?\/)?wishlists\/([A-Za-z0-9_-]{1,64})\/?$/.exec(x.pathname);
  if (m) return { id: m[1] };
  if (/^\/s\/[A-Za-z0-9_-]{1,64}\/?$/.test(x.pathname)) return { short: 'https://' + x.hostname.toLowerCase() + x.pathname };
  return null;
}

// ---------------------------------------------------------------- http (pause, timeout, one request at a time, never retried)

function makeHttp(opts) {
  opts = opts || {};
  const f = opts.fetch || fetch;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pause = opts.pauseMs === undefined ? PAUSE_MS : opts.pauseMs;
  const timeout = opts.timeoutMs || TIMEOUT_MS;
  const http = async function (url, init) {
    if (opts.deadlineAt && Date.now() > opts.deadlineAt) throw new ImportError('deadline');
    if (http.count > 0 && pause > 0) await sleep(pause);
    http.count++;
    http.urls.push(url);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await f(url, Object.assign({ redirect: 'manual', signal: ctl.signal }, init));
      const text = await r.text();
      if (text.length > MAX_BODY) throw new ImportError('unavailable', 'answer too large');
      return { status: r.status, location: r.headers && r.headers.get ? r.headers.get('location') : null, text };
    } catch (e) {
      if (e instanceof ImportError) throw e;
      throw new ImportError('unavailable', e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e).slice(0, 80));
    } finally { clearTimeout(timer); }
  };
  http.count = 0; http.urls = [];
  return http;
}

const isRedirect = (s) => s === 301 || s === 302 || s === 303 || s === 307 || s === 308;

function statusError(status) {
  if (status === 404 || status === 410) return new ImportError('private', 'HTTP ' + status);
  return new ImportError('unavailable', 'HTTP ' + status);
}

// A share link -> the wish-list id. A /wishlists/<id> link needs no request. Otherwise: GET with redirect 'manual',
// at most MAX_REDIRECTS redirects, followed only while the host is onskeskyen.dk or gowish.com.
async function resolveListId(url, http) {
  const cur = parseListUrl(url);
  if (!cur) throw new ImportError('badUrl');
  if (cur.id) return cur.id;
  let target = cur.short;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const r = await http(target, { method: 'GET', headers: { 'User-Agent': PJ.UA, Accept: 'text/html,*/*;q=0.5' } });
    if (!isRedirect(r.status)) {
      if (r.status === 404 || r.status === 410) throw statusError(r.status);
      if (r.status >= 200 && r.status < 300) throw new ImportError('private', 'no wish list behind the link');
      throw statusError(r.status);
    }
    let next;
    try { next = new URL(r.location || '', target); } catch (e) { throw new ImportError('unavailable', 'bad redirect'); }
    if (next.protocol !== 'https:' || next.username || next.password || next.port || !isListHost(next.hostname)) throw new ImportError('unavailable', 'redirect leaves the site');
    const p = parseListUrl(next.toString());
    if (p && p.id) return p.id;
    target = next.protocol + '//' + next.hostname.toLowerCase() + next.pathname + next.search;
  }
  throw new ImportError('unavailable', 'too many redirects');
}

// ---------------------------------------------------------------- the wishes

// POST the query. api.gowish.com may answer 308 to /graphql/<hash>: followed only inside api.gowish.com, the POST is sent again.
async function postGraphql(http, state, body) {
  let url = state.endpoint;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const r = await http(url, { method: 'POST', headers: { 'User-Agent': PJ.UA, 'Content-Type': 'application/json', Accept: 'application/json' }, body });
    if (isRedirect(r.status)) {
      let next;
      try { next = new URL(r.location || '', url); } catch (e) { throw new ImportError('unavailable', 'bad redirect'); }
      if (next.protocol !== 'https:' || next.username || next.password || next.port || !isApiHost(next.hostname)) throw new ImportError('unavailable', 'redirect leaves api.gowish.com');
      url = next.toString(); state.endpoint = url;
      continue;
    }
    if (r.status !== 200) throw new ImportError('unavailable', 'HTTP ' + r.status);     // also 404 here: a fault of the API, not a missing list
    let j;
    try { j = JSON.parse(r.text); } catch (e) { throw new ImportError('unavailable', 'answer is not JSON (challenge page?)'); }
    return j;
  }
  throw new ImportError('unavailable', 'too many redirects');
}

function listError(j) {
  const errs = Array.isArray(j.errors) ? j.errors : [];
  if (!errs.length) return null;
  const hit = errs.some((e) => {
    const c = String(e && e.extensions && e.extensions.code || '');
    return c === '404' || c === '403' || c === '401' || /does not exist|not found|forbidden|not allowed|private|access/i.test(String(e && e.message || ''));
  });
  return hit ? new ImportError('private', 'error from the API') : new ImportError('unavailable', 'API error: ' + String(errs[0] && errs[0].message || '').slice(0, 80));
}

// The id of a wish as text, or null (a wish without an id is added by the first import but never by a later sync).
function wishId(v) {
  if (typeof v === 'number' && isFinite(v)) return String(v);
  return typeof v === 'string' && v.length > 0 && v.length <= 100 ? v : null;
}

// The first usable picture of a wish (an https address, the same rule as products.image_url), or null. Only the address is kept.
function firstPhoto(photos) {
  const list = Array.isArray(photos) ? photos : (typeof photos === 'string' ? [photos] : []);
  for (const p of list.slice(0, 5)) { const c = PJ.cleanImageUrl(typeof p === 'string' ? p : null); if (c) return c; }
  return null;
}

// {title, wishes: [{id, title, url, image, description}], total, truncated}. Up to MAX_WISHES wishes, PAGE_SIZE per request.
async function fetchWishList(id, http) {
  const state = { endpoint: API_URL };
  let cursor = 0, title = null, total = null;
  const wishes = [];
  for (let page = 0; page < 4 && wishes.length < MAX_WISHES; page++) {
    const body = JSON.stringify({ operationName: 'getWishlistWishes', variables: { id, input: { cursor, limit: PAGE_SIZE } }, query: QUERY });
    const j = await postGraphql(http, state, body);
    const err = listError(j);
    if (err) throw err;
    const wl = j && j.data && j.data.wishlist;
    if (!wl) throw new ImportError('private', 'no wish list');
    if (wl.accessLevel && wl.accessLevel !== 'Public') throw new ImportError('private', 'accessLevel ' + String(wl.accessLevel).slice(0, 20));
    const w = wl.wishes;
    if (!w || !Array.isArray(w.data)) throw new ImportError('unavailable', 'unexpected answer');
    if (title === null && typeof wl.title === 'string') title = wl.title;
    if (typeof w.totalCount === 'number') total = w.totalCount;
    w.data.forEach((x) => { if (x && typeof x === 'object') wishes.push({ id: wishId(x.id), title: x.title, url: x.url, image: firstPhoto(x.photos), description: x.description }); });
    const next = w.nextCursor;
    if (typeof next !== 'number' || next <= cursor || !w.data.length) break;
    cursor = next;
  }
  const truncated = wishes.length > MAX_WISHES || (total !== null && total > MAX_WISHES);
  return { title, wishes: wishes.slice(0, MAX_WISHES), total, truncated };
}

// ---------------------------------------------------------------- one wish -> one product

const TRACKING = /^(utm_.*|gclid|gclsrc|gad_.*|fbclid|msclkid|dclid|yclid|mc_cid|mc_eid)$/i;

// The same rule as products.source_url_check: https, a host with a dot, no user:password@ or port, no spaces, at most 500
// characters. On top of that the job's own guard for shop pages (no IP addresses or local names), so that an unusable link
// never becomes a product in the error state: the wish then simply has no link and is found by name.
const DB_URL_RULE = /^https:\/\/[^/?#@:\s]+\.[^/?#@:\s]+([/?#][^\s]*)?$/;
function cleanWishUrl(u) {
  if (typeof u !== 'string') return null;
  const raw = u.trim();
  if (!raw || raw.length > 2000) return null;
  let x;
  try { x = new URL(raw); } catch (e) { return null; }
  if (x.protocol !== 'https:') return null;
  x.hash = '';
  Array.from(x.searchParams.keys()).forEach((k) => { if (TRACKING.test(k)) x.searchParams.delete(k); });
  const out = x.toString();
  if (out.length > 500 || !DB_URL_RULE.test(out)) return null;
  if (SHOP.isPrisjagtHost(x.hostname)) return PJ.validateProductUrl(out);        // a prisjagt.dk page: without www., as everywhere else
  return SHOP.validateShopUrl(out) ? out : null;
}

// Comparison key: host without www., path without trailing slash, query sorted, no fragment and no tracking parameters.
function urlKey(u) {
  let x;
  try { x = new URL(String(u || '').trim()); } catch (e) { return null; }
  Array.from(x.searchParams.keys()).forEach((k) => { if (TRACKING.test(k)) x.searchParams.delete(k); });
  x.searchParams.sort();
  return x.hostname.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '') + x.search;
}

function clip(s, max) { return Array.from(s).slice(0, max).join('').trim(); }
function cleanName(t, max) {
  if (typeof t !== 'string') return '';
  return clip(t.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim(), max || NAME_MAX);
}

const wishes = (n) => n + (n === 1 ? ' ønske' : ' ønsker');

// ---------------------------------------------------------------- one import

async function pickList(sb, imp, title, log) {
  if (imp.list_id) return { listId: imp.list_id, name: null, note: '' };
  const name = cleanName(title, LIST_NAME_MAX);
  if (!name) return { listId: null, name: null, note: '' };
  const find = async () => (await sb.select('lists', 'select=id,name&user_id=eq.' + encodeURIComponent(imp.user_id) + '&limit=100'));
  const same = (rows) => rows.filter((l) => String(l.name || '').toLowerCase() === name.toLowerCase())[0];
  const rows = await find();
  const hit = same(rows);
  if (hit) return { listId: hit.id, name: hit.name, note: ' De er lagt på listen ' + hit.name + '.' };
  if (rows.length >= LIST_CAP) return { listId: null, name: null, note: ' Du har allerede ' + LIST_CAP + ' lister, så varerne ligger uden liste.' };
  try {
    const made = await sb.insert('lists', { user_id: imp.user_id, name }, true);
    const id = Array.isArray(made) && made[0] && made[0].id;
    if (id) return { listId: id, name, note: ' De er lagt på en ny liste, ' + name + '.' };
  } catch (e) {
    log('  Import: kunne ikke oprette listen: ' + safe(e));
    try { const again = same(await find()); if (again) return { listId: again.id, name: again.name, note: ' De er lagt på listen ' + again.name + '.' }; } catch (e2) { /* fall through */ }
  }
  return { listId: null, name: null, note: '' };
}

// A wish's own note ("XL", "hvid, str. 43") becomes the product's requirements (products.requirements): the text with control characters and
// angle brackets removed, white space collapsed and trimmed, kept only when it is 1 to 120 characters long (the database rule). Else null.
const REQ_MAX = 120;
function cleanRequirements(t) {
  if (typeof t !== 'string') return null;
  const s = t.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029<>]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length >= 1 && s.length <= REQ_MAX ? s : null;
}

const uniqueTail = (ids, max) => {
  const seen = new Set(), out = [];
  ids.forEach((i) => { if (!seen.has(i)) { seen.add(i); out.push(i); } });
  return out.slice(-max);
};

// From the wishes still to be looked at: the ones that become products (cands), how many were links the person already follows (dup)
// and how many had no usable name. have: link keys of the person's products, extended here so that a link listed twice counts once.
function pickCandidates(wishList, have) {
  let noTitle = 0, dup = 0;
  const cands = [];
  wishList.forEach((w) => {
    const name = cleanName(w.title);
    if (!name) { noTitle++; return; }
    const url = cleanWishUrl(w.url), key = url ? urlKey(url) : null;
    if (key) { if (have.has(key)) { dup++; return; } have.add(key); }
    cands.push({ id: w.id, name, source_url: url, image: w.image || null, requirements: cleanRequirements(w.description) });
  });
  return { cands, dup, noTitle };
}

async function addProducts(sb, imp, take, title, log) {
  const pl = await pickList(sb, imp, title, log);
  // status exactly as a product added in the browser: 'pending' (the job fetches the first price), goal 'auto'
  // A wish with one shop's link only follows that shop: the AI agent is asked to look for the product on Prisjagt (compare_state
  // 'wanted'). A prisjagt.dk link is already the comparison; a wish without a link is found by name first.
  // image_url: the wish's first photo (the address only), from the answer the job already has
  let rows = take.map((c) => ({ user_id: imp.user_id, name: c.name, source_url: c.source_url, target_type: 'auto', target_value: null, list_id: pl.listId, active: true, status: 'pending', compare_state: wantsCompare(c.source_url) ? 'wanted' : null, image_url: c.image || null }));
  // requirements: only at insert, from the wish's own note when it has a usable one (never written again, so the person's own words are never
  // overwritten). The key is on EVERY row, null when there is no note: all rows of one insert must have the same keys, or PostgREST refuses
  // the whole insert (PGRST102 "All object keys must match"), which is what happened when some wishes had a note and others did not.
  rows = rows.map((r, i) => Object.assign(r, { requirements: take[i].requirements || null }));
  // the database has not been given the newer columns yet (the script is applied on push): add the products without them
  for (let tries = 0; tries < 4; tries++) {
    try { await sb.insert('products', rows, false); return pl; }
    catch (e) {
      const msg = String(e && (e.body || e.message) || '');
      const col = /image_url/i.test(msg) ? 'image_url' : /compare_state/i.test(msg) ? 'compare_state' : /requirements/i.test(msg) ? 'requirements' : null;
      if (!col || tries === 3) throw e;
      rows = rows.map((r) => { const o = Object.assign({}, r); delete o[col]; return o; });
    }
  }
  return pl;
}

// true for a link to one web shop's product page (not prisjagt.dk)
function wantsCompare(u) {
  if (!u) return false;
  try { return !SHOP.isPrisjagtHost(new URL(u).hostname); } catch (e) { return false; }
}

// Returns {status, note, found, added, ...}. Throws ImportError('deadline') when out of time (the import then stays pending).
// On success it also returns what makes the import a standing link: title, seen (ids of the wishes handled) and listId.
async function importOne(imp, deps) {
  const { sb, http, log, now } = deps;
  const result = (status, note, found, added, extra) => Object.assign({ status, note: String(note).slice(0, 300), found: found == null ? null : found, added: added == null ? null : added }, extra || {});
  let listData;
  try {
    const id = await resolveListId(imp.url, http);
    listData = await fetchWishList(id, http);
  } catch (e) {
    if (!(e instanceof ImportError)) throw e;
    if (e.kind === 'deadline') throw e;
    log('  Import ' + imp.id + ': ' + e.kind + (e.detail ? ' (' + e.detail + ')' : ''));
    return result('error', e.kind === 'private' ? NOTE.private : e.kind === 'badUrl' ? NOTE.badUrl : NOTE.unavailable, null, null);
  }
  const found = listData.wishes.length;
  if (!found) return result('error', NOTE.empty, 0, 0);

  // the user's own products (all of them, also name-only ones): for the cap and for the "already followed" check
  const mine = await sb.select('products', 'select=id,source_url&user_id=eq.' + encodeURIComponent(imp.user_id) + '&limit=200');
  const have = new Set();
  mine.forEach((p) => { const k = p.source_url ? urlKey(p.source_url) : null; if (k) have.add(k); });

  const { cands, dup, noTitle } = pickCandidates(listData.wishes, have);

  const room = Math.max(0, PRODUCT_CAP - mine.length);
  if (cands.length && !room) return result('error', NOTE.full, found, 0);
  const take = cands.slice(0, room);
  let listNote = '', listId = null;
  if (take.length) {
    try { const pl = await addProducts(sb, imp, take, listData.title, log); listId = pl.listId; listNote = pl.note; }
    catch (e) { log('  Import ' + imp.id + ': kunne ikke gemme varerne: ' + safe(e)); return result('error', NOTE.saveFail, found, 0); }
  }

  const parts = [];
  if (cands.length > take.length) parts.push('Der var kun plads til ' + take.length + ' af ' + cands.length + ' ønsker. Du kan højst følge ' + PRODUCT_CAP + ' varer.');
  if (dup) parts.push((dup === 1 ? '1 ønske' : dup + ' ønsker') + ' fandtes allerede.');
  if (noTitle) parts.push(wishes(noTitle) + ' uden navn blev sprunget over.');
  if (listData.truncated) parts.push('Kun de første ' + MAX_WISHES + ' ønsker blev hentet.');
  let note = parts.join(' ');
  if (listNote) note = (note ? note + ' ' : '') + listNote.trim();
  // every wish with an id has been handled now (added, already followed, no name) except the ones that did not fit
  const left = new Set(cands.slice(take.length).map((c) => c.id));
  const seen = uniqueTail(listData.wishes.filter((w) => w.id && !left.has(w.id)).map((w) => w.id), SEEN_MAX);
  return result('done', note, found, take.length, { title: cleanName(listData.title, TITLE_MAX) || null, seen, listId: imp.list_id ? null : listId });
}

// One daily re-read of a finished import. Adds the wishes that are new since last time (not in imp.seen); never deletes or
// changes a product, never adds a wish again that is in imp.seen (also when the person removed the product).
// imp.seen null = an import from before this feature: the list is only memorised, nothing is added.
// Returns {ok: true, patch} or {ok: false, kind}. Throws ImportError('deadline') when out of time.
async function syncOne(imp, deps) {
  const { sb, http, log } = deps;
  let listData;
  try {
    const id = await resolveListId(imp.url, http);
    listData = await fetchWishList(id, http);
  } catch (e) {
    if (!(e instanceof ImportError)) throw e;
    if (e.kind === 'deadline') throw e;
    log('  Opdatering ' + imp.id + ': ' + e.kind + (e.detail ? ' (' + e.detail + ')' : ''));
    return { ok: false, kind: e.kind === 'private' ? 'private' : 'unavailable' };
  }
  const found = listData.wishes.length;
  const title = cleanName(listData.title, TITLE_MAX) || imp.title || null;
  const known = Array.isArray(imp.seen) ? imp.seen.map(String) : null;
  const patch = { found, title, sync_fails: 0, note: null };
  if (known === null) {
    patch.seen = uniqueTail(listData.wishes.filter((w) => w.id).map((w) => w.id), SEEN_MAX);
    return { ok: true, patch, added: 0 };
  }
  const knownSet = new Set(known);
  const fresh = listData.wishes.filter((w) => w.id && !knownSet.has(w.id));
  let added = 0, handled = [];
  if (fresh.length) {
    const mine = await sb.select('products', 'select=id,source_url&user_id=eq.' + encodeURIComponent(imp.user_id) + '&limit=200');
    const have = new Set();
    mine.forEach((p) => { const k = p.source_url ? urlKey(p.source_url) : null; if (k) have.add(k); });
    const { cands } = pickCandidates(fresh, have);
    const take = cands.slice(0, Math.max(0, PRODUCT_CAP - mine.length));
    if (take.length) {
      let pl;
      try { pl = await addProducts(sb, imp, take, listData.title, log); }
      catch (e) { log('  Opdatering ' + imp.id + ': kunne ikke gemme varerne: ' + safe(e)); return { ok: false, kind: 'save' }; }
      added = take.length;
      if (!imp.list_id && pl.listId) patch.list_id = pl.listId;
    }
    // handled: new wishes that were added, were already followed or had no name; those that did not fit are looked at again tomorrow
    const left = new Set(cands.slice(take.length).map((c) => c.id));
    handled = fresh.filter((w) => !left.has(w.id)).map((w) => w.id);
  }
  patch.seen = uniqueTail(known.concat(handled), SEEN_MAX);
  if (added) patch.added = (imp.added || 0) + added;
  return { ok: true, patch, added };
}

// ---------------------------------------------------------------- the step in the run

function isMissingTable(e) {
  const m = String(e && (e.body || e.message) || '');
  return (e && e.status === 404) || /PGRST205|42P01|does not exist|schema cache/i.test(m);
}

const isoSec = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');

// 1) Pending imports, oldest first, at most MAX_PER_RUN. 2) Then the standing ones: finished imports not read for a day, the
// longest-unread first, at most MAX_SYNCS_PER_RUN. Quiet when the table does not exist yet.
// ctx: {sb, fetch, sleep, log, now, pauseMs, timeoutMs, deadlineAt}. Returns {pending, done, error, added, missing, synced, syncAdded, syncFailed}.
async function runImports(ctx) {
  const log = ctx.log || (() => {});
  const stats = { pending: 0, done: 0, error: 0, added: 0, missing: false, synced: 0, syncAdded: 0, syncFailed: 0 };
  let rows;
  try {
    rows = await ctx.sb.select('imports', 'select=id,user_id,list_id,url&status=eq.pending&order=created_at.asc&limit=' + MAX_PER_RUN);
  } catch (e) {
    if (isMissingTable(e)) { stats.missing = true; return stats; }
    log('Ønskelister: kunne ikke læse importer: ' + safe(e));
    return stats;
  }
  const http = makeHttp({ fetch: ctx.fetch, sleep: ctx.sleep, pauseMs: ctx.pauseMs, timeoutMs: ctx.timeoutMs, deadlineAt: ctx.deadlineAt });
  const deps = { sb: ctx.sb, http, log, now: ctx.now };
  const nowIso = () => isoSec(ctx.now ? ctx.now() : new Date());
  let outOfTime = false;
  for (const imp of (Array.isArray(rows) ? rows : []).slice(0, MAX_PER_RUN)) {
    stats.pending++;
    let res;
    try { res = await importOne(imp, deps); }
    catch (e) {
      if (e instanceof ImportError && e.kind === 'deadline') { log('Ønskelister: tidsgrænse, resten venter til næste kørsel.'); outOfTime = true; break; }
      log('  Import ' + imp.id + ': ' + safe(e));      // a database read failed: the import stays pending, tried again next run
      continue;
    }
    const body = { status: res.status, note: res.note || null, found: res.found, added: res.added, done_at: nowIso() };
    const full = Object.assign({}, body);
    if (res.status === 'done') { full.synced_at = body.done_at; full.sync_fails = 0; full.title = res.title; full.seen = res.seen; if (res.listId) full.list_id = res.listId; }
    const filter = 'id=eq.' + encodeURIComponent(imp.id) + '&status=eq.pending';
    try {
      try { await ctx.sb.patch('imports', filter, full); }
      catch (e) {
        // a database without the sync columns yet (schema.sql not run again): save the plain result so the import is not read twice
        if (full === body || !/42703|PGRST204|column/i.test(String(e && (e.body || e.message) || ''))) throw e;
        await ctx.sb.patch('imports', filter, body);
      }
    } catch (e) { log('  Import ' + imp.id + ': kunne ikke gemme resultatet: ' + safe(e)); continue; }
    if (res.status === 'done') { stats.done++; stats.added += res.added || 0; } else stats.error++;
    log('  Ønskeliste: ' + res.status + (res.added != null ? ', ' + res.added + ' tilføjet' : ''));   // the note names the person's list: not logged
  }
  if (!outOfTime) await runSyncs(ctx, deps, stats, nowIso);
  return stats;
}

async function runSyncs(ctx, deps, stats, nowIso) {
  const { sb, log } = deps;
  const now = (ctx.now ? ctx.now() : new Date()).getTime();
  let rows;
  try {
    rows = await sb.select('imports', 'select=id,user_id,list_id,url,seen,sync_fails,synced_at,title,added&status=eq.done&order=synced_at.asc.nullsfirst&limit=50');
  } catch (e) { log('Ønskelister: kunne ikke læse opdateringer: ' + safe(e)); return; }
  const due = (Array.isArray(rows) ? rows : []).filter((r) => {
    const at = r.synced_at ? Date.parse(r.synced_at) : NaN;
    return !isFinite(at) || now - at >= SYNC_EVERY_MS;
  }).slice(0, MAX_SYNCS_PER_RUN);
  for (const imp of due) {
    let res;
    try { res = await syncOne(imp, deps); }
    catch (e) {
      if (e instanceof ImportError && e.kind === 'deadline') { log('Ønskelister: tidsgrænse, resten opdateres næste gang.'); return; }
      log('  Opdatering ' + imp.id + ': ' + safe(e));
      res = { ok: false, kind: 'save' };
    }
    stats.synced++;
    const filter = 'id=eq.' + encodeURIComponent(imp.id) + '&status=eq.done';
    let body;
    if (res.ok) body = Object.assign({ synced_at: nowIso() }, res.patch);
    else if (res.kind === 'save') body = { synced_at: nowIso() };           // our own trouble: try again tomorrow, no failure counted against the list
    else {
      const fails = (imp.sync_fails || 0) + 1;
      body = { synced_at: nowIso(), sync_fails: fails };
      if (fails >= MAX_SYNC_FAILS) { body.status = 'error'; body.note = res.kind === 'private' ? NOTE.private : NOTE.unavailable; }
      else body.note = res.kind === 'private' ? NOTE.retryPrivate : NOTE.retryUnavailable;
      stats.syncFailed++;
    }
    try { await sb.patch('imports', filter, body); }
    catch (e) { log('  Opdatering ' + imp.id + ': kunne ikke gemme: ' + safe(e)); continue; }
    if (res.ok) stats.syncAdded += res.added || 0;
    log('  Ønskeliste fulgt: ' + (res.ok ? res.added + ' nye' : 'kunne ikke læses (' + res.kind + ')'));
  }
}

module.exports = {
  runImports, runSyncs, importOne, syncOne, parseListUrl, resolveListId, fetchWishList, makeHttp, cleanWishUrl, urlKey, cleanName, cleanRequirements, isMissingTable,
  ImportError, QUERY, API_URL, NOTE, MAX_PER_RUN, MAX_SYNCS_PER_RUN, MAX_SYNC_FAILS, SYNC_EVERY_MS, MAX_WISHES, PAGE_SIZE, PRODUCT_CAP, LIST_CAP, NAME_MAX,
};
