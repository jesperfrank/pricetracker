'use strict';
// prisjagt.dk product page: fetching (honest, plain HTTP GET) and parsing of the server-rendered
// Next.js payload. Offer/history parsing is taken over from the tested pricecheck.js.
//
// Variants: every offer row ("offerRows") carries a numeric `variantId` (colour/size/bundle) or none.
//   variant id  = String(variantId), or 'none' when the row has no variantId.
//   listing key = "<shopId>/<offerId>" from the row's go-to-shop link (survives price changes).
//   label       = (1) the attribute values of the matching variant in the page's JSON-LD (hasVariant),
//                     matched by lowest price and by colour words in the offer names;
//                 (2) else the words that distinguish this variant's offer names from the others;
//                 (3) else "Variant N".

const { normShop, copenhagenDate } = require('./pricing');

const UA = 'Prisvagten-pricecheck/1.0 (personal price watch; plain HTTP client)';
const TIMEOUT_MS = 30000;

// ---------------------------------------------------------------- payload decoding

function decodeNextChunks(html) {
  const re = /self\.__next_f\.push\(\[1,"(.*?)"\]\)<\/script>/gs;
  let m, out = '';
  while ((m = re.exec(html))) {
    try { out += JSON.parse('"' + m[1] + '"'); } catch (e) { /* skip bad chunk */ }
  }
  return out;
}

function extractJsonArrayAfter(s, key) {
  let from = 0;
  for (;;) {
    const i = s.indexOf(key, from);
    if (i === -1) return null;
    const start = i + key.length;
    let depth = 0, inStr = false, esc = false;
    if (s[start] !== '[') { from = start; continue; }
    for (let j = start; j < s.length; j++) {
      const ch = s[j];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) { try { return JSON.parse(s.slice(start, j + 1)); } catch (e) { break; } } }
    }
    from = start;
  }
}

// "go-to-shop/<shopId>/offer/<offerId>" identifies one shop listing.
function listingKey(url) {
  const m = /go-to-shop\/(\d+)\/offer\/([^?#]+)/.exec(String(url || ''));
  if (!m) return String(url || '');
  let id = m[2];
  try { id = decodeURIComponent(id); } catch (e) { /* keep raw */ }
  return m[1] + '/' + id;
}

// ---------------------------------------------------------------- history (3 months, from the price chart's data)

// minor units (ore); timestamps are UTC instants of Copenhagen midnight
function parsePrisjagtHistory(html) {
  const s = decodeNextChunks(html);
  const items = extractJsonArrayAfter(s, '"historyItems":');
  if (!items) throw new Error('layout ikke genkendt (historyItems mangler)');
  const byDate = {};
  items.forEach((x) => {
    if (!x || x.active === false || x.isPaidMembership === true || typeof x.price !== 'number' || !isFinite(x.price) || x.price <= 0) return;
    const t = new Date(x.date); if (isNaN(t.getTime())) return;
    const d = copenhagenDate(t), p = x.price / 100;
    if (!byDate[d] || p < byDate[d].p) byDate[d] = { d, p, s: x.shopName || null };
  });
  return Object.keys(byDate).sort().map((k) => byDate[k]);
}

// ---------------------------------------------------------------- offers

function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
}

// returns eligible rows (new, DKK, no membership price, https link), one per listing key:
// {key, variant, store, price, url, inStock, stock, note, sale, name}
function parseRows(s) {
  const rows = extractJsonArrayAfter(s, '"offerRows":');
  if (!rows) throw new Error('layout ikke genkendt (offerRows mangler)');
  if (rows.length && (!rows[0] || !rows[0].price)) throw new Error('layout ikke genkendt (offerRows uden pris)');
  const byKey = {};
  rows.forEach((r) => {
    if (!r || !r.price || typeof r.price.amount !== 'number') return;
    if (r.condition && r.condition !== 'New') return;
    if (r.isPaidMembership === true) return;
    if (r.price.currency && r.price.currency !== 'DKK') return;
    const store = r.shop && r.shop.name; if (!store) return;
    const url = typeof r.clickoutUrl === 'string' && /^https:\/\//.test(r.clickoutUrl) ? r.clickoutUrl : null; if (!url) return;
    const o = {
      key: listingKey(url),
      variant: typeof r.variantId === 'number' || (typeof r.variantId === 'string' && /^\d+$/.test(r.variantId)) ? String(r.variantId) : 'none',
      store: cleanText(store, 80), price: r.price.amount, url, inStock: r.stockStatus === 'InStock', stock: r.stockStatus || null,
      note: null, name: cleanText(r.name, 200),
      saleKnown: typeof r.priceType === 'string',
      sale: r.priceType === 'SalePrice' && !!r.originalPrice && typeof r.originalPrice.amount === 'number' && r.originalPrice.amount > r.price.amount,
    };
    let ship = null;
    if (r.shipping && r.shipping.nodes && r.shipping.nodes.length) {
      r.shipping.nodes.forEach((n) => { if (n && n.price && typeof n.price.amount === 'number' && (ship === null || n.price.amount < ship)) ship = n.price.amount; });
    }
    if (ship === 0) o.note = 'Fri fragt'; else if (ship !== null) o.note = '+' + ship + ' kr. fragt';
    const cur = byKey[o.key];
    if (!cur || (o.inStock && !cur.inStock) || (o.inStock === cur.inStock && o.price < cur.price)) byKey[o.key] = o;
  });
  return Object.keys(byKey).map((k) => byKey[k]);
}

// ---------------------------------------------------------------- title

function parseTitle(s, html) {
  const m = /"@type":"Product(?:Group)?","name":"((?:[^"\\]|\\.)*)"/.exec(s);
  if (m) { try { const t = cleanText(JSON.parse('"' + m[1] + '"'), 200); if (t) return t; } catch (e) { /* fall through */ } }
  const t = /<title>([^<]*)<\/title>/.exec(html);
  if (t) {
    const x = cleanText(t[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/\s+-\s+(Black Friday.*|fra \d.*|Sammenlign.*)$/i, ''), 200);
    if (x) return x;
  }
  return null;
}

// ---------------------------------------------------------------- variants and labels

const COLOUR_WORDS = {
  black: ['sort'], white: ['hvid'], blue: ['blå', 'bla'], silver: ['sølv', 'solv'], pink: ['lyserød', 'rosa'], red: ['rød'],
  green: ['grøn'], grey: ['grå'], gray: ['grå'], gold: ['guld'], purple: ['lilla'], yellow: ['gul'], brown: ['brun'],
  orange: ['orange'], beige: ['beige'], rose: ['rosa'], midnight: ['blå'], graphite: ['grafit'], cream: ['creme'],
};

function keywordsFor(label) {
  const out = {};
  String(label).toLowerCase().split(/[^\p{L}\p{N}]+/u).forEach((t) => {
    if (t.length < 3) return;
    out[t] = 1;
    (COLOUR_WORDS[t] || []).forEach((w) => { out[w] = 1; });
  });
  return Object.keys(out);
}

function ldVariants(s) {
  const arr = extractJsonArrayAfter(s, '"hasVariant":');
  if (!arr) return [];
  const out = [];
  arr.forEach((v) => {
    if (!v || typeof v !== 'object') return;
    let label = '';
    try {
      const u = new URL(String(v.url || ''), 'https://prisjagt.dk');
      const vals = [];
      u.searchParams.forEach((val, k) => { if (/^a-/.test(k) && val) vals.push(val); });
      label = vals.join(' / ');
    } catch (e) { /* no url */ }
    if (!label && typeof v.name === 'string' && / - /.test(v.name)) label = v.name.split(' - ').pop();
    if (!label && typeof v.color === 'string') label = v.color;
    label = cleanText(label, 60);
    const low = v.offers && typeof v.offers.lowPrice === 'number' ? v.offers.lowPrice : null;
    if (label) out.push({ label, low });
  });
  return out;
}

function distinguishingLabel(group, others) {
  const tok = (name) => Array.from(new Set(String(name).toLowerCase().split(/[^\p{L}\p{N}\-\/]+/u).filter((t) => t.length >= 3 && !/^\d+$/.test(t))));
  const share = (rows) => {
    const c = {};
    rows.forEach((r) => tok(r.name).forEach((t) => { c[t] = (c[t] || 0) + 1; }));
    Object.keys(c).forEach((t) => { c[t] /= rows.length || 1; });
    return c;
  };
  const sg = share(group), so = share(others);
  const cand = Object.keys(sg).filter((t) => sg[t] >= 0.3 && sg[t] - (so[t] || 0) >= 0.3).sort((a, b) => (sg[b] - (so[b] || 0)) - (sg[a] - (so[a] || 0)) || (a < b ? -1 : 1)).slice(0, 3);
  if (!cand.length) return null;
  const first = group.slice().sort((a, b) => a.price - b.price)[0].name.toLowerCase();
  cand.sort((a, b) => first.indexOf(a) - first.indexOf(b));
  const text = cand.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildVariants(rows, ld, title) {
  const groups = {};
  rows.forEach((r) => { (groups[r.variant] = groups[r.variant] || []).push(r); });
  const ids = Object.keys(groups);
  const info = ids.map((id) => {
    const g = groups[id];
    const nonOut = g.filter((r) => r.stock !== 'OutOfStock').map((r) => r.price);
    const inSt = g.filter((r) => r.inStock).map((r) => r.price);
    return { id, rows: g, minAvail: nonOut.length ? Math.min.apply(null, nonOut) : null, minIn: inSt.length ? Math.min.apply(null, inSt) : null, minAll: Math.min.apply(null, g.map((r) => r.price)) };
  });

  // match variant groups to JSON-LD variants: lowest price (strong) + colour words in offer names
  const labels = {};
  const real = info.filter((g) => g.id !== 'none');
  if (real.length === 1 && info.length === 1 && ld.length === 1) labels[real[0].id] = ld[0].label;
  else if (ld.length) {
    const score = (g, e) => {
      let ps = 0;
      if (e.low !== null) ps = e.low === g.minAvail ? 3 : e.low === g.minIn ? 2 : e.low === g.minAll ? 1 : 0;
      const kw = keywordsFor(e.label);
      const hit = g.rows.filter((r) => { const n = r.name.toLowerCase(); return kw.some((k) => n.indexOf(k) !== -1); }).length;
      return ps + 3 * (hit / g.rows.length);
    };
    const taken = {}, usedE = {};
    for (;;) {
      let best = null;
      real.forEach((g) => {
        if (taken[g.id]) return;
        const sc = ld.map((e, ei) => ({ ei, s: usedE[ei] ? -1 : score(g, e) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s);
        if (!sc.length || sc[0].s < 1.5) return;
        if (sc.length > 1 && sc[0].s - sc[1].s < 0.5) return;                    // ambiguous for this group
        const back = real.filter((h) => !taken[h.id]).map((h) => score(h, ld[sc[0].ei])).sort((a, b) => b - a);
        if (back.length > 1 && back[0] - back[1] < 0.5) return;                  // ambiguous for this label
        if (!best || sc[0].s > best.s) best = { g, ei: sc[0].ei, s: sc[0].s };
      });
      if (!best) break;
      taken[best.g.id] = true; usedE[best.ei] = true; labels[best.g.id] = ld[best.ei].label;
    }
  }

  const variants = info.map((g, i) => {
    let label = labels[g.id];
    if (!label && g.id === 'none') label = info.length === 1 ? (title || 'Standard') : 'Øvrige tilbud (uden variant)';
    if (!label) {
      const others = [].concat.apply([], info.filter((h) => h !== g).map((h) => h.rows));
      label = distinguishingLabel(g.rows, others) || ('Variant ' + (i + 1));
    }
    const cheapest = g.rows.slice().sort((a, b) => a.price - b.price)[0];
    return { id: g.id, label: cleanText(label, 80), lowest: g.minIn, offers: g.rows.length, sample: cheapest ? cleanText(cheapest.name, 100) : null };
  });
  const seen = {};
  variants.forEach((v) => { seen[v.label] = (seen[v.label] || 0) + 1; if (seen[v.label] > 1) v.label += ' (' + seen[v.label] + ')'; });
  variants.sort((a, b) => (a.lowest === null) - (b.lowest === null) || (a.lowest || 0) - (b.lowest || 0) || (a.id < b.id ? -1 : 1));
  return variants;
}

// ---------------------------------------------------------------- page

// returns {title, rows, variants, history, image}; throws on an unrecognised layout
function parsePage(html) {
  const s = decodeNextChunks(html);
  const rows = parseRows(s);
  const title = parseTitle(s, html);
  let history = [];
  try { history = parsePrisjagtHistory(html); } catch (e) { /* history is optional */ }
  return { title, rows, variants: buildVariants(rows, ldVariants(s), title), history, image: metaImage(html, 'https://prisjagt.dk/') };
}

// ---------------------------------------------------------------- product picture

// The address of a product picture to store (products.image_url), or null. Only https, the same rule as the database check
// (a host with a dot, no user:password@ or port, no spaces, at most 500 characters). A relative or protocol-relative address is
// resolved against the page it came from. The picture itself is never fetched or stored by the job.
const IMAGE_RULE = /^https:\/\/[^/?#@:\s]+\.[^/?#@:\s]+([/?#][^\s]*)?$/;
function cleanImageUrl(u, base) {
  if (typeof u !== 'string') return null;
  const raw = u.trim();
  if (!raw || raw.length > 2000 || /\s/.test(raw)) return null;
  let x;
  try { x = new URL(raw, base || undefined); } catch (e) { return null; }
  if (x.protocol !== 'https:' || x.username || x.password || x.port) return null;
  const h = x.hostname.toLowerCase();
  if (/^[\d.]+$/.test(h) || h.charAt(0) === '[') return null;
  x.hash = '';
  const out = x.toString();
  return out.length <= 500 && IMAGE_RULE.test(out) ? out : null;
}
// <meta property="og:image" content="..."> (or twitter:image) of an html page, as a clean https address, or null
function metaImage(html, base) {
  const re = /<meta\b[^>]*>/gi;
  const found = {};
  let m;
  while ((m = re.exec(String(html || '')))) {
    const tag = m[0];
    const key = /\b(?:property|name)\s*=\s*["']?\s*([a-z:_]+)/i.exec(tag);
    const val = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    if (!key || !val) continue;
    const k = key[1].toLowerCase();
    if ((k === 'og:image' || k === 'og:image:secure_url' || k === 'twitter:image') && !(k in found)) found[k] = (val[1] !== undefined ? val[1] : val[2]).replace(/&amp;/g, '&');
  }
  for (const k of ['og:image:secure_url', 'og:image', 'twitter:image']) { const c = cleanImageUrl(found[k], base); if (c) return c; }
  return null;
}

// ---------------------------------------------------------------- url + fetching

// returns the normalised URL, or null if it is not a prisjagt.dk page
function validateProductUrl(u) {
  let x;
  try { x = new URL(String(u || '')); } catch (e) { return null; }
  if (x.protocol !== 'https:' || !/^(www\.)?prisjagt\.dk$/i.test(x.hostname) || x.username || x.password) return null;
  if (x.pathname === '/' || x.pathname === '') return null;
  x.hostname = 'prisjagt.dk';
  return x.toString();
}

class PageError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }   // kind: blocked | notfound | timeout | network | layout
}

// One plain GET, honest user agent, 30 s timeout. 403/429/503 or a challenge page means "unavailable".
async function fetchPage(url, fetchImpl) {
  const f = fetchImpl || fetch;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let r, html;
  try {
    r = await f(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'da-DK,da;q=0.9' }, signal: ctl.signal, redirect: 'follow' });
    html = await r.text();
  } catch (e) {
    throw new PageError(e && e.name === 'AbortError' ? 'timeout' : 'network', e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e));
  } finally { clearTimeout(t); }
  if (r.status === 403 || r.status === 429 || r.status === 503) throw new PageError('blocked', 'HTTP ' + r.status);
  if (r.status === 404 || r.status === 410) throw new PageError('notfound', 'HTTP ' + r.status);
  if (r.status !== 200) throw new PageError('network', 'HTTP ' + r.status);
  if (r.url && !validateProductUrl(r.url)) throw new PageError('layout', 'omdirigeret væk fra prisjagt.dk');
  try { return parsePage(html); } catch (e) {
    if (/cf-chl|captcha|Just a moment|Attention Required/i.test(html.slice(0, 20000))) throw new PageError('blocked', 'udfordringsside');
    throw new PageError('layout', e.message);
  }
}

module.exports = { cleanImageUrl, metaImage, UA, decodeNextChunks, extractJsonArrayAfter, listingKey, parsePrisjagtHistory, parseRows, parseTitle, buildVariants, parsePage, validateProductUrl, PageError, fetchPage, normShop };
