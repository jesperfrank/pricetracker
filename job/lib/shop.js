'use strict';
// "Any shop" product page: fetching (honest, plain HTTP GET) and parsing of the structured data that shops publish.
// Used for every source_url whose host is not prisjagt.dk. One shop, one price, one variant (id "shop").
//
// Order of sources (the first one that yields a usable price wins):
//   1. JSON-LD (<script type="application/ld+json">): Product / ProductGroup, offers as Offer, array of Offers, AggregateOffer
//   2. microdata / RDFa: itemprop="price" (+ priceCurrency, availability)
//   3. Open Graph / product meta tags: product:price:amount, og:price:amount (+ currency, availability)
// Only DKK is accepted (currency "DKK", or no currency at all AND a .dk host). Prices that only exist after
// JavaScript has run are not seen: this is a plain HTTP client, no headless browser.

const { UA, PageError, cleanImageUrl, metaImage } = require('./prisjagt');
const { decodeEntities, cleanText, squeeze } = require('./text');

const TIMEOUT_MS = 30000;
const MAX_HTML = 4000000;
const MAX_REDIRECTS = 5;
const SHOP_ID = 'shop';

// ---------------------------------------------------------------- small helpers

// decodeEntities / cleanText: the shared decoder for text out of pages (lib/text.js)

// "579,00" "1.299,00" "1299.00" "1,299.00" "579" "kr. 579,-" 579 -> number, or null. Never throws.
// A single separator followed by exactly three digits is a thousands separator ("1.299", "1,299"); otherwise it is the decimal mark.
function parseNumber(v) {
  if (typeof v === 'number') return isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string' || /^\s*-/.test(v)) return null;
  let s = v.replace(/[  \s]+/g, '').replace(/[,.]-+$/, '').replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;
  s = s.replace(/^[.,]+|[.,]+$/g, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.'), lastCom = s.lastIndexOf(',');
  let out;
  if (lastDot !== -1 && lastCom !== -1) {
    const dec = lastDot > lastCom ? '.' : ',', thou = dec === '.' ? ',' : '.';
    if (s.split(dec).length > 2) return null;
    const ip = s.slice(0, s.lastIndexOf(dec)).split(thou);
    if (ip[0].length > 3 || !ip.slice(1).every((g) => g.length === 3)) return null;   // "1.299.00,5" is not a number
    out = ip.join('') + '.' + s.slice(s.lastIndexOf(dec) + 1);
  } else if (lastDot !== -1 || lastCom !== -1) {
    const sep = lastDot !== -1 ? '.' : ',', parts = s.split(sep);
    if (parts.length > 2) {
      if (!parts.slice(1).every((p) => p.length === 3)) return null;  // "1.2.3" is no price
      out = parts.join('');
    } else if (parts[1].length === 3 && parts[0].length >= 1 && parts[0].length <= 3 && parts[0] !== '0') out = parts.join('');
    else out = parts[0] + '.' + parts[1];
  } else out = s;
  const n = Number(out);
  return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// ---------------------------------------------------------------- hosts and urls

const TWO_LEVEL = new Set(['co', 'com', 'org', 'net', 'ac', 'gov', 'edu', 'or', 'ne']);
// "www.bedrenaetter.dk" -> {domain: "bedrenaetter.dk", name: "bedrenaetter"}; "shop.example.co.uk" -> {domain: "example.co.uk", name: "example"}
function registrable(host) {
  const labels = String(host || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return { domain: labels.join('.'), name: labels[0] || '' };
  let n = 2;
  if (labels.length >= 3 && labels[labels.length - 1].length === 2 && TWO_LEVEL.has(labels[labels.length - 2])) n = 3;
  const d = labels.slice(-n);
  return { domain: d.join('.'), name: d[0] };
}
function registrableDomain(host) { return registrable(host).domain; }

function isPrisjagtHost(host) { return /^(www\.)?prisjagt\.dk$/i.test(String(host || '')); }

// The URL is supplied by users: only plain public web-shop addresses are fetched. Returns the trimmed URL, or null.
// Refused: anything but http(s), user:password@, a port, IP literals (v4/v6), localhost and local/internal names,
// hosts without a dot or with a non-alphabetic top-level domain, over-long urls.
function validateShopUrl(u) {
  if (typeof u !== 'string') return null;
  const raw = u.trim();
  if (!raw || raw.length > 500 || /[\s\u0000-\u001f]/.test(raw)) return null;
  let x;
  try { x = new URL(raw); } catch (e) { return null; }
  if (x.protocol !== 'https:' && x.protocol !== 'http:') return null;
  if (x.username || x.password || x.port) return null;
  const h = x.hostname.toLowerCase().replace(/\.$/, '');
  if (!h || h.indexOf('.') === -1 || h.charAt(0) === '[' || h.indexOf(':') !== -1) return null;
  if (/^[\d.]+$/.test(h) || /^0x[0-9a-f]+/i.test(h)) return null;                     // IPv4 in any notation
  const labels = h.split('.');
  if (labels.some((l) => !l || l.length > 63 || !/^[a-z0-9À-￿]([a-z0-9À-￿-]*[a-z0-9À-￿])?$/i.test(l))) return null;
  const tld = labels[labels.length - 1];
  if (!/^([a-z]{2,24}|xn--[a-z0-9-]+)$/i.test(tld)) return null;
  if (labels[0] === 'localhost' || /^(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|example|invalid|onion)$/i.test(tld)) return null;
  if (/(^|\.)(localhost|home\.arpa)$/.test(h)) return null;
  return raw;
}

// ---------------------------------------------------------------- html scanning

function parseAttrs(tag) {
  const out = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const inner = tag.replace(/^<[^\s>\/]+/, '').replace(/\/?>$/, '');
  let m;
  while ((m = re.exec(inner))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decodeEntities(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '');
  }
  return out;
}

function metaTags(html) {
  const out = [];
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = parseAttrs(m[0]);
    const key = String(a.property || a.name || '').toLowerCase();
    if (key && a.content !== undefined) out.push({ key, content: a.content });
  }
  return out;
}
function metaFirst(metas, keys) {
  for (const k of keys) { const f = metas.find((x) => x.key === k && x.content.trim() !== ''); if (f) return f.content.trim(); }
  return null;
}

function canonicalUrl(html, base) {
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const a = parseAttrs(m[0]);
    if (String(a.rel || '').toLowerCase().split(/\s+/).indexOf('canonical') !== -1 && a.href) {
      try { return new URL(a.href, base).toString(); } catch (e) { /* ignore */ }
    }
  }
  return null;
}

function pageTitle(html, metas) {
  const og = metaFirst(metas, ['og:title']);
  if (og && squeeze(og, 200)) return squeeze(og, 200);                     // meta content: decoded by parseAttrs already
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t && cleanText(t[1], 200)) return cleanText(t[1], 200);
  return null;
}

// ---------------------------------------------------------------- stock

// Returns true / false. Unknown or missing text counts as in stock (the caller only asks when a price exists).
function stockFrom(v) {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) v = v[0];
  if (v && typeof v === 'object') v = v['@id'] || v.name || '';
  const s = String(v).toLowerCase().replace(/^.*[\/#]/, '').replace(/[^a-z]/g, '');
  if (!s) return true;
  if (/outofstock|soldout|discontinued|unavailable|nostock|oos|ikkepalager|udsolgt|udgaet/.test(s)) return false;
  if (/preorder|presale|backorder|forbestilling|awaiting|comingsoon|madetoorder/.test(s)) return false;
  return true;                                                                  // InStock, LimitedAvailability, OnlineOnly, InStoreOnly, unknown
}

// ---------------------------------------------------------------- 1. JSON-LD

function typesOf(n) { const t = n && n['@type']; return (Array.isArray(t) ? t : [t]).map((x) => String(x || '').replace(/^.*[\/#:]/, '')); }
function isType(n, name) { return typesOf(n).indexOf(name) !== -1; }

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (!/type\s*=\s*["']?\s*application\/ld\+json/i.test(m[1])) continue;
    let body = m[2].trim().replace(/^<!--/, '').replace(/-->$/, '').replace(/^\/\/\s*<!\[CDATA\[|\/\/\s*\]\]>$/g, '').replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
    try { out.push(JSON.parse(body)); } catch (e) {
      try { out.push(JSON.parse(body.replace(/[\u0000-\u001f]+/g, ' '))); } catch (e2) { /* unreadable block: skip it */ }
    }
  }
  return out;
}

// all nodes (objects) of the blocks, @graph and arrays flattened, in document order; by @id for references
function flattenNodes(blocks) {
  const nodes = [], byId = {};
  const seen = new Set();
  const walk = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 12 || seen.has(n)) return;
    seen.add(n);
    if (Array.isArray(n)) { n.forEach((x) => walk(x, depth + 1)); return; }
    nodes.push(n);
    if (typeof n['@id'] === 'string' && Object.keys(n).length > 1 && !byId[n['@id']]) byId[n['@id']] = n;
    if (n['@graph']) walk(n['@graph'], depth + 1);
    ['mainEntity', 'mainEntityOfPage', 'itemListElement', 'item', 'isVariantOf', 'hasVariant', 'offers'].forEach((k) => { if (n[k] && typeof n[k] === 'object') walk(n[k], depth + 1); });
  };
  blocks.forEach((b) => walk(b, 0));
  return { nodes, byId };
}

function resolveRef(x, byId) {
  if (x && typeof x === 'object' && !Array.isArray(x) && typeof x['@id'] === 'string' && Object.keys(x).length === 1 && byId[x['@id']]) return byId[x['@id']];
  return x;
}

function priceOf(o, byId) {
  let spec = resolveRef(o.priceSpecification, byId);
  if (Array.isArray(spec)) spec = spec.map((s) => resolveRef(s, byId)).find((s) => s && parseNumber(s.price !== undefined ? s.price : s.minPrice) !== null) || spec[0];
  const raw = o.price !== undefined ? o.price : (spec && spec.price !== undefined ? spec.price : (o.lowPrice !== undefined ? o.lowPrice : (spec && spec.minPrice)));
  const cur = o.priceCurrency || (spec && spec.priceCurrency) || null;
  return { price: parseNumber(raw), currency: cur ? String(cur).trim().toUpperCase() : null };
}

// Candidates {price, currency, inStock, url, sku, name, high, multi} from one Offer / AggregateOffer / array of them.
function offerCandidates(offers, byId, parent, out) {
  const list = Array.isArray(offers) ? offers : [offers];
  list.forEach((o0) => {
    const o = resolveRef(o0, byId);
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { offerCandidates(o, byId, parent, out); return; }
    const nested = o.offers ? (Array.isArray(o.offers) ? o.offers : [o.offers]) : [];
    if (isType(o, 'AggregateOffer') && nested.length) { offerCandidates(nested, byId, parent, out); return; }
    const pr = priceOf(o, byId);
    if (pr.price === null) return;
    const high = isType(o, 'AggregateOffer') ? parseNumber(o.highPrice) : null;
    out.push({
      price: pr.price, currency: pr.currency || (parent.currency || null), inStock: stockFrom(o.availability !== undefined ? o.availability : parent.availability),
      url: typeof o.url === 'string' ? o.url : null, sku: o.sku !== undefined ? String(o.sku) : (o.mpn !== undefined ? String(o.mpn) : null),
      name: typeof o.name === 'string' ? o.name : null, spread: high !== null && high > pr.price,
    });
  });
}

function productCandidates(p, byId) {
  const out = [];
  const parent = { currency: p.priceCurrency || null, availability: p.availability };
  if (p.offers) offerCandidates(p.offers, byId, parent, out);
  out.forEach((c) => { c.sku = c.sku || null; c.productSku = p.sku !== undefined ? String(p.sku) : null; c.productUrl = typeof p.url === 'string' ? p.url : null; c.productName = typeof p.name === 'string' ? p.name : null; });
  return out;
}

function sameUrl(a, b) {
  const n = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, '').toLowerCase() + x.pathname.replace(/\/+$/, '') + x.search; } catch (e) { return null; } };
  const x = n(a), y = n(b);
  return !!x && x === y;
}

function samePath(a, b) {
  const n = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, '').toLowerCase() + x.pathname.replace(/\/+$/, ''); } catch (e) { return null; } };
  const x = n(a), y = n(b);
  return !!x && x === y;
}

// Which candidate is "the one this url shows"? By canonical / page url, then sku (also a sku in the url's query),
// else the lowest in-stock price. Returns {cand, note}.
function pickCandidate(cands, ctx) {
  if (cands.length === 1) return { cand: cands[0], note: cands[0].spread ? MULTI_NOTE : null };
  const key = (c) => c.price + '|' + c.inStock;
  if (new Set(cands.map(key)).size === 1) return { cand: cands[0], note: null };
  const byUrl = (fn) => cands.filter((c) => (c.url && (fn(c.url, ctx.pageUrl) || (ctx.canonical && fn(c.url, ctx.canonical)))));
  let m = byUrl(sameUrl);
  if (m.length !== 1) m = byUrl(samePath).length === 1 ? byUrl(samePath) : m;
  if (m.length === 1) return { cand: m[0], note: null };
  // sku: a value in the page url's query that equals exactly one candidate's sku
  let vals = [];
  try { new URL(ctx.pageUrl).searchParams.forEach((v) => { if (v) vals.push(v); }); } catch (e) { /* none */ }
  const bySku = cands.filter((c) => c.sku && vals.indexOf(c.sku) !== -1);
  if (bySku.length === 1) return { cand: bySku[0], note: null };
  // the product's own sku equals exactly one offer's sku
  const own = cands.filter((c) => c.sku && c.productSku && c.sku === c.productSku);
  if (own.length === 1) return { cand: own[0], note: null };
  const inStock = cands.filter((c) => c.inStock);
  const pool = inStock.length ? inStock : cands;
  const best = pool.slice().sort((a, b) => a.price - b.price)[0];
  return { cand: best, note: MULTI_NOTE };
}
const MULTI_NOTE = 'Siden viser flere varianter med forskellige priser. Vi følger den billigste, der er på lager.';

function fromJsonLd(html, ctx) {
  const { nodes, byId } = flattenNodes(jsonLdBlocks(html));
  const products = nodes.filter((n) => isType(n, 'Product') || isType(n, 'ProductGroup'));
  if (!products.length) return null;
  // one group of candidates per top-level product; a ProductGroup brings its hasVariant products along.
  // Variants listed on their own are part of their group, not groups of their own.
  const asList = (x) => (x ? (Array.isArray(x) ? x : [x]) : []).map((v) => resolveRef(v, byId)).filter((v) => v && typeof v === 'object');
  const variantNodes = new Set();
  products.forEach((p) => asList(p.hasVariant).forEach((v) => variantNodes.add(v)));
  const groups = [];
  products.forEach((p) => {
    if (variantNodes.has(p)) return;
    const cands = productCandidates(p, byId);
    asList(p.hasVariant).forEach((v) => {
      productCandidates(v, byId).forEach((c) => { c.productUrl = c.productUrl || (typeof v.url === 'string' ? v.url : null); cands.push(c); });
    });
    if (cands.length) groups.push({ p, cands });
  });
  if (!groups.length) return null;
  let g = groups.find((x) => x.cands.some((c) => (c.url && (sameUrl(c.url, ctx.pageUrl) || (ctx.canonical && sameUrl(c.url, ctx.canonical)))) || (x.p.url && (sameUrl(x.p.url, ctx.pageUrl) || (ctx.canonical && sameUrl(x.p.url, ctx.canonical))))));
  if (!g) g = groups.find((x) => x.p.url && (samePath(x.p.url, ctx.pageUrl) || (ctx.canonical && samePath(x.p.url, ctx.canonical))));
  if (!g) g = groups[0];
  // variants of a ProductGroup: the url identifies a variant by its own url
  const cands = g.cands.map((c) => Object.assign({}, c, { url: c.url || c.productUrl }));
  const pick = pickCandidate(cands, ctx);
  const name = pick.cand.productName || (typeof g.p.name === 'string' ? g.p.name : null);
  const asImg = (x) => (Array.isArray(x) ? x : [x]).map((i) => { const r = resolveRef(i, byId); return typeof r === 'string' ? r : (r && typeof r === 'object' ? (r.url || r.contentUrl) : null); });
  let image = null;
  [g.p].concat(asList(g.p.hasVariant)).forEach((n) => { if (!image && n.image) image = asImg(n.image).map((u) => cleanImageUrl(u, ctx.pageUrl)).filter(Boolean)[0] || null; });
  return { price: pick.cand.price, currency: pick.cand.currency, inStock: pick.cand.inStock, note: pick.note, title: name ? cleanText(name, 200) : null, image, source: 'json-ld' };
}

// ---------------------------------------------------------------- 2. microdata / RDFa

function fromMicrodata(html) {
  // itemprop (microdata) or property (RDFa) on any tag; the value is content=, value=, href= or the text up to the next tag
  const props = [];
  const re = /<(meta|link|span|div|p|strong|b|s|data|em|i|bdi|ins|del|td|li|h\d|a|time)\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (!/\b(itemprop|property)\s*=/i.test(m[2])) continue;
    const a = parseAttrs('<' + m[1] + ' ' + m[2] + '>');
    const name = String(a.itemprop || a.property || '').toLowerCase().replace(/^(schema|s|product|og):/, '');
    if (!/^(price|pricecurrency|availability|name)$/.test(name)) continue;
    let val = a.content !== undefined ? a.content : a.value !== undefined ? a.value : (m[1].toLowerCase() === 'link' || m[1].toLowerCase() === 'a') && a.href ? a.href : null;
    if (val === null) { const t = /^([^<]*)/.exec(html.slice(m.index + m[0].length)); val = decodeEntities(t ? t[1] : ''); }   // attribute values are decoded by parseAttrs already
    props.push({ name, val: val.trim(), pos: m.index });
  }
  const prices = props.filter((p) => p.name === 'price' && parseNumber(p.val) !== null);
  if (!prices.length) return null;
  const first = prices[0];
  const nearest = (n) => {
    const c = props.filter((p) => p.name === n && p.val);
    if (!c.length) return null;
    return c.sort((x, y) => Math.abs(x.pos - first.pos) - Math.abs(y.pos - first.pos))[0].val;
  };
  const cur = nearest('pricecurrency');
  const nm = props.filter((p) => p.name === 'name' && p.val && p.pos < first.pos).pop() || props.find((p) => p.name === 'name' && p.val);
  return { price: parseNumber(first.val), currency: cur ? cur.toUpperCase() : null, inStock: stockFrom(nearest('availability')), note: null, title: nm ? squeeze(nm.val, 200) : null, source: 'microdata' };
}

// ---------------------------------------------------------------- 3. Open Graph / product meta tags

function fromMeta(metas) {
  const raw = metaFirst(metas, ['product:price:amount', 'og:price:amount', 'product:sale_price:amount']);
  const price = parseNumber(raw);
  if (price === null) return null;
  const cur = metaFirst(metas, ['product:price:currency', 'og:price:currency', 'product:sale_price:currency']);
  const av = metaFirst(metas, ['product:availability', 'og:availability']);
  return { price, currency: cur ? cur.toUpperCase() : null, inStock: stockFrom(av), note: null, title: null, source: 'meta' };
}

// ---------------------------------------------------------------- page

// Letters and digits only, lower case, æøå written out ("Tøjeksperten" = "toejeksperten"): to compare a name with a host name.
function hostForm(s) {
  return String(s || '').toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa').replace(/[^a-z0-9]/g, '');
}

const STORE_MAX = 40;
// The name of the shop from a site name that may be a title with a marketing tail ("Tøjeksperten - Shop herretøj online - Hurtig levering",
// "Xiaomi Smart Air Purifier 4 Lite - luftrenser, hvid - Babysupply.dk"). A name without a separator (" - ", " – ", " — ", " | ", " · ") is
// a real site name and stays ("Roborock Officiel Butik i Danmark"). Otherwise the segment that best matches the host's registrable name is
// the shop (equal, else one holds the other, at least 3 letters; a trailing .dk / .com is dropped: "Babysupply.dk" -> "Babysupply"); when no
// segment matches, the host's registrable name with a capital first letter. At most 40 characters.
function cleanStoreName(raw, host) {
  const name = squeeze(raw, 200);
  const hn = hostForm(registrable(String(host || '').replace(/^www\./i, '')).name);
  const fallback = () => { const n = registrable(String(host || '').replace(/^www\./i, '')).name; return n ? n.charAt(0).toUpperCase() + n.slice(1) : 'Butikken'; };
  if (!name) return fallback();
  const segs = name.split(/\s+[-\u2013\u2014|\u00b7]\s+/).map((x) => x.trim()).filter(Boolean);
  if (segs.length <= 1) return name.slice(0, STORE_MAX).trim() || fallback();
  let best = null, bestScore = 0;
  segs.forEach((sg) => {
    const f = hostForm(sg.replace(/\.(dk|com|se|no|de|eu)$/i, ''));
    if (f.length < 3 || !hn) return;
    const score = f === hn ? 3 : (hn.indexOf(f) !== -1 || f.indexOf(hn) !== -1) ? 2 : 0;
    if (score > bestScore) { best = sg; bestScore = score; }
  });
  if (!best) return fallback();
  return best.replace(/\.(dk|com)$/i, '').slice(0, STORE_MAX).trim() || fallback();
}

function shopNameFor(host, metas) {
  const og = metaFirst(metas, ['og:site_name']);                            // decoded by parseAttrs already
  return og && squeeze(og, 200) ? cleanStoreName(og, host) : cleanStoreName('', host);
}

// returns {title, rows, variants, history, note, shop, source, image}; throws PageError('noprice' | 'currency')
function parseShopPage(html, pageUrl) {
  html = String(html || '');
  let host = '';
  try { host = new URL(pageUrl).hostname.toLowerCase(); } catch (e) { /* guarded elsewhere */ }
  const metas = metaTags(html);
  const ctx = { pageUrl, canonical: canonicalUrl(html, pageUrl) };
  const found = fromJsonLd(html, ctx) || fromMicrodata(html) || fromMeta(metas);
  if (!found) throw Object.assign(new PageError('noprice', 'ingen pris i sidens strukturerede data'), { shop: true });
  const cur = found.currency;
  if (cur ? cur !== 'DKK' : !/\.dk$/.test(host)) throw Object.assign(new PageError('currency', cur ? 'valuta ' + cur : 'valuta mangler'), { shop: true });
  const title = found.title || pageTitle(html, metas);
  const store = shopNameFor(host, metas);
  const row = { key: pageUrl, variant: SHOP_ID, store, price: found.price, url: pageUrl, inStock: found.inStock, stock: found.inStock ? 'InStock' : 'OutOfStock', note: null, name: title || store, saleKnown: false, sale: false };
  const variants = [{ id: SHOP_ID, label: store, lowest: found.inStock ? found.price : null, offers: 1, sample: title ? squeeze(title, 100) : null }];
  // the picture: the product's own in the JSON-LD, else the page's og:image (never fetched, only the address is kept)
  const image = found.image || metaImage(html, pageUrl);
  return { title, rows: [row], variants, history: [], note: found.note || null, shop: true, source: found.source, image };
}

// ---------------------------------------------------------------- fetching

const CHALLENGE = /<title[^>]*>\s*(Just a moment|Attention Required|Access denied|Are you a (human|robot)|Checking your browser|Please verify you are a human|Security check)|cf-chl|challenge-platform|_Incapsula_Resource|px-captcha|captcha-delivery|Enable JavaScript and cookies to continue/i;

// One plain GET (plus redirects inside the same registrable domain), honest user agent, 30 s timeout, no retries.
// 401/403/429 or a bot-challenge page means "refused": the caller must not try again in this run.
async function fetchShopPage(url, fetchImpl) {
  const start = validateShopUrl(url);
  if (!start) throw Object.assign(new PageError('layout', 'ugyldigt link'), { shop: true });
  const f = fetchImpl || fetch;
  const home = registrableDomain(new URL(start).hostname);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let r, html, cur = start;
  try {
    for (let hop = 0; ; hop++) {
      r = await f(cur, { headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Accept-Language': 'da-DK,da;q=0.9' }, signal: ctl.signal, redirect: 'manual' });
      if (r.status >= 300 && r.status < 400 && r.status !== 304) {
        const loc = r.headers && typeof r.headers.get === 'function' ? r.headers.get('location') : null;
        if (!loc || hop >= MAX_REDIRECTS) throw Object.assign(new PageError('network', 'for mange omdirigeringer'), { shop: true });
        let next = null;
        try { next = validateShopUrl(new URL(loc, cur).toString()); } catch (e) { next = null; }
        if (!next || registrableDomain(new URL(next).hostname) !== home) throw Object.assign(new PageError('network', 'omdirigeret væk fra butikken'), { shop: true });
        cur = next;
        continue;
      }
      break;
    }
    html = r.status === 304 ? '' : String(await r.text()).slice(0, MAX_HTML);
  } catch (e) {
    if (e instanceof PageError) throw e;
    throw Object.assign(new PageError(e && e.name === 'AbortError' ? 'timeout' : 'network', e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e)), { shop: true });
  } finally { clearTimeout(t); }
  const shop = (e) => Object.assign(e, { shop: true });
  if (r.status === 401 || r.status === 403 || r.status === 429) throw shop(new PageError('blocked', 'HTTP ' + r.status));
  if (r.status === 404 || r.status === 410) throw shop(new PageError('notfound', 'HTTP ' + r.status));
  if (r.status !== 200) {
    if (CHALLENGE.test(html.slice(0, 20000))) throw shop(new PageError('blocked', 'udfordringsside'));
    throw shop(new PageError('network', 'HTTP ' + r.status));
  }
  try { return parseShopPage(html, start); } catch (e) {
    if (e instanceof PageError && e.kind === 'noprice' && CHALLENGE.test(html.slice(0, 20000))) throw shop(new PageError('blocked', 'udfordringsside'));
    if (e instanceof PageError) throw e;
    throw shop(new PageError('layout', String(e && e.message || e)));
  }
}

module.exports = { cleanStoreName, SHOP_ID, parseNumber, registrable, registrableDomain, isPrisjagtHost, validateShopUrl, stockFrom, parseShopPage, fetchShopPage, MULTI_NOTE };
