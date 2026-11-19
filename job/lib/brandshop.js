'use strict';
// Brand shop probe: finds a product's page in the MANUFACTURER'S OWN Danish web shop. No API key, no AI. The second candidate source of the
// shop discovery (next to the Brave search, see discover.js and step 5b of run.js), for the shops that Prisjagt does not list and that a web
// search from the USA never shows (Roborock's own Danish shop, say).
//
//   brand      the first word(s) of the product title ("Roborock Saros 10R" -> roborock; "Shaping New Tomorrow ..." -> shapingnewtomorrow)
//   shop base  where the brand's Danish web shop lives: a small list of shops that were checked by hand (ALIAS), else guesses (guessBases)
//   sitemap    robots.txt "Sitemap:" lines, else <base>/sitemap.xml; indexes, .gz and size caps are handled
//   page       the sitemap URL whose slug holds every model token of the product with the fewest extra words; the page is then read by the
//              ordinary shop reader and must pass the same checks as a search hit (price in kroner, the page's own name, the outlier rule)
//
// The outcome per brand is cached for 30 days (table brand_shops, positive and negative), so a brand is probed once a month, not per product.
// The rules of politeness: honest user agent, one request at a time with a pause, robots.txt is read first and obeyed, nothing is retried and
// a 401/403/429 or a bot-challenge page means "not available" (no other user agent, no way around it). Per run at most MAX_REQUESTS requests
// (robots, sitemaps, pages) and MAX_NEW_BRANDS brands probed.

const zlib = require('zlib');
const SHOP = require('./shop');
const { UA } = require('./prisjagt');
const DS = require('./discover');
const X = require('./extras');

const CACHE_MS = 30 * 24 * 3600 * 1000;
const MAX_REQUESTS = 20;               // per run: robots.txt, sitemaps and product pages together
const MAX_NEW_BRANDS = 2;              // per run
const GAP_MS = 1100;                   // between two requests
const TIMEOUT_MS = 10000;
const MAX_SITEMAP_BYTES = 8 * 1000 * 1000;   // a sitemap file over this is skipped (compressed or not)
const MAX_ROBOTS_BYTES = 500 * 1000;
const MAX_FILES = 3;                   // sitemap files read for the URLs of a brand (the children of an index count)
const MAX_INDEXES = 2;
const MAX_REDIRECTS = 3;
const MAX_URLS = 60000;
const TOP = 3;                         // candidate pages read per product
const ROBOTS_TOKEN = 'prisvagten-pricecheck';

// ---------------------------------------------------------------- the shops that were checked by hand
// Only entries that were fetched live on 2026-11-19 from the job's sandbox: robots.txt allows us and a sitemap with <loc> entries answers.
// Brand = the brand's words squashed (lower case, letters and digits only).
// Checked and NOT in the map, so that nobody adds them: they REFUSE automated requests (403, a bot challenge or a robots.txt that disallows
// everything): dyson.dk and lego.com (as told by the owner), dk.jbl.com (refused in the probe). They have no usable shop or sitemap at the address a Danish shop would have: store.nintendo.dk
// (does not resolve), www.bose.dk, www.ecovacs.com/dk, www.hp.com/dk-da, www.mi.com/dk, litter-robot.com (no sitemap), and www.xiaomi.dk (a
// parked page about millet, not Xiaomi's shop). The sitemaps of garmin.com/da-DK, logitech.com/da-dk and apple.com/dk answer too, but were not
// checked for Danish product URLs, so they stay with the generic guesses. Every probe's result is cached in brand_shops.
const ALIAS = {
  roborock: 'https://dk.roborock.com',
  dreame: 'https://dk.dreametech.com',
  sonos: 'https://www.sonos.com/da-dk',
  shapingnewtomorrow: 'https://shapingnewtomorrow.dk',
  samsung: 'https://www.samsung.com/dk',
  philips: 'https://www.philips.dk',
  bangolufsen: 'https://www.bang-olufsen.com/da',
  oneplus: 'https://www.oneplus.com/dk',
  nothing: 'https://dk.nothing.tech',
};

// ---------------------------------------------------------------- the brand of a title
const REVERSE_BRAND = { iphone: 'apple', ipad: 'apple', macbook: 'apple', airpods: 'apple', imac: 'apple', ipod: 'apple', galaxy: 'samsung', xbox: 'microsoft', surface: 'microsoft', playstation: 'sony', switch: 'nintendo' };

// The words of the title, in the order of the title, without the cleaning that coreTitle does (a filler word like "New" can be part of a brand).
function titleWords(title) { return DS.words(DS.firstSegment(title)).slice(0, 6); }

// Brand candidates [{brand, n}] (n = how many title words it is made of), most words first. The first word on its own (not a filler, category
// or colour word, no digit), the first two and the first three words joined when none of them is a category, colour, modifier or model word (a
// word with a digit). A brand the title implies (iPhone -> apple) is the only candidate.
function brandCandidates(title) {
  const ws = titleWords(title);
  if (!ws.length) return [];
  if (REVERSE_BRAND[ws[0]]) return [{ brand: REVERSE_BRAND[ws[0]], n: 1 }];
  const bad = (w) => /\d/.test(w) || DS.MODIFIERS.has(w) || (DS.isGeneric(w) && !isFiller(w));
  const out = [];
  for (let n = 3; n >= 1; n--) {
    const part = ws.slice(0, n);
    if (part.length < n || part.some(bad)) continue;
    if (n === 1 && isFiller(part[0])) continue;
    const brand = part.join('');
    if (brand.length < 3 || brand.length > 30) continue;
    out.push({ brand, n });
  }
  return out;
}
function isFiller(w) { return ['new', 'ny', 'nye', 'the', 'original', 'officiel', 'brand', 'og', 'and', 'for'].indexOf(w) !== -1; }

// The addresses tried for a brand that is not in ALIAS, in this order. Every one must pass the shop URL guard.
function guessBases(b) {
  return ['https://dk.' + b + '.com', 'https://www.' + b + '.dk', 'https://' + b + '.dk', 'https://shop.' + b + '.dk', 'https://store.' + b + '.dk',
    'https://www.' + b + '.com/da-dk', 'https://www.' + b + '.com/dk'].filter((u) => SHOP.validateShopUrl(u));
}

function baseParts(base) {
  const x = new URL(base);
  const path = x.pathname.replace(/\/+$/, '');
  const seg = path.split('/').filter(Boolean)[0] || '';
  return { origin: x.origin, host: x.hostname.toLowerCase(), path, locale: seg ? seg.toLowerCase() : null, domain: SHOP.registrableDomain(x.hostname) };
}

// ---------------------------------------------------------------- robots.txt
// Reads the group for our user agent, else the "*" group. rules = [[allow (bool), path pattern]], sitemaps = the "Sitemap:" lines.
function parseRobots(text) {
  const groups = [], sitemaps = [];
  let cur = null, lastWasAgent = false;
  String(text || '').split(/\r?\n/).forEach((raw) => {
    const line = raw.replace(/#.*$/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!cur || !lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasAgent = true; return;
    }
    lastWasAgent = false;
    if (k === 'sitemap') { if (v) sitemaps.push(v); return; }
    if ((k === 'allow' || k === 'disallow') && cur) { if (v) cur.rules.push([k === 'allow', v]); }
  });
  const mine = groups.filter((g) => g.agents.some((a) => a && a !== '*' && ROBOTS_TOKEN.indexOf(a) !== -1));
  const use = mine.length ? mine : groups.filter((g) => g.agents.indexOf('*') !== -1);
  const rules = [];
  use.forEach((g) => g.rules.forEach((r) => rules.push(r)));
  return { rules: rules.slice(0, 120), sitemaps };
}

function patternToRegExp(p) {
  const end = /\$$/.test(p);
  const body = p.replace(/\$$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + body + (end ? '$' : ''));
}
// May the path (with its query) be fetched? The longest matching pattern wins, an allow wins a tie, no match means allowed.
function robotsAllows(rules, path) {
  let best = null;
  (rules || []).forEach((r) => {
    let re; try { re = patternToRegExp(String(r[1])); } catch (e) { return; }
    if (!re.test(path)) return;
    const len = String(r[1]).replace(/\*/g, '').length;
    if (!best || len > best.len || (len === best.len && r[0])) best = { len, allow: !!r[0] };
  });
  return best ? best.allow : true;
}
function disallowsAll(rules) { return !robotsAllows(rules, '/') && !robotsAllows(rules, '/products/x') && !robotsAllows(rules, '/da-dk/x'); }

// ---------------------------------------------------------------- sitemaps
function decodeXml(s) {
  return String(s).replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ''; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ''; } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
// {kind: 'index' | 'urlset' | null, locs: [...]}. Only <loc> (an <image:loc> is another element). Entities and CDATA are decoded.
function parseSitemap(text) {
  const t = String(text || '');
  const kind = /<sitemapindex[\s>]/i.test(t) ? 'index' : (/<urlset[\s>]/i.test(t) ? 'urlset' : null);
  const locs = [];
  if (!kind) return { kind, locs };
  const re = /<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*?))\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(t)) && locs.length < MAX_URLS) {
    const v = decodeXml(m[1] !== undefined ? m[1] : m[2]).trim();
    if (v) locs.push(v);
  }
  return { kind, locs };
}

// ---------------------------------------------------------------- the slug of a product URL
const fold = (s) => String(s).replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a');
const GENERIC_FOLDED = new Set();
const GENERIC_SUFFIX = /(stovsuger|stovsugere|maskine|telefon|computer|hojttaler|hovedtelefoner|horetelefoner|fjernsyn|klapvogn|smartphone|sneakers)$/;
// the generic words of discover.js, also without æ ø å (a slug has none: "robotstovsuger")
['og', 'med', 'til', 'den', 'det', 'de', 'en', 'et', 'i', 'pa', 'af', 'for', 'the', 'and', 'with', 'ny', 'nye', 'new', 'original', 'officiel', 'officielle', 'tilbud', 'udsalg', 'gratis', 'fragt', 'pris', 'kob', 'online',
  'robot', 'vacuum', 'cleaner', 'shoes', 'phone', 'headphones', 'speaker', 'watch', 'wireless', 'men', 'women', 'kids', 'unisex', 'herre', 'dame', 'born', 'sort', 'hvid', 'gra', 'bla', 'rod', 'gron', 'black', 'white', 'grey', 'blue', 'red', 'green', 'silver',
  'tv', 'skaerm', 'monitor', 'pc', 'laptop', 'tablet', 'sko', 'ur', 'spil', 'kamera', 'konsol', 'saet', 'bundle', 'pak'].forEach((w) => GENERIC_FOLDED.add(w));
function genericSlugWord(w) { const f = fold(w); return DS.isGeneric(w) || GENERIC_FOLDED.has(f) || GENERIC_SUFFIX.test(f); }

// The words of the last path segment (and the one before it when the last is a number or a single word), lower case, a model letter set apart
// from its number joined (10-r -> 10r). The locale segment is not part of it.
function slugTokens(u) {
  let segs = DS.segmentsOf(u);
  if (DS.localeOf(segs)) segs = segs.slice(1);
  if (!segs.length) return [];
  const clean = (s) => s.replace(/\.(html?|php|aspx?)$/, '').replace(/[-_.+]+/g, ' ');
  let t = DS.words(clean(segs[segs.length - 1]));
  if (t.length < 2 && segs.length > 1) t = DS.words(clean(segs[segs.length - 2])).concat(t);
  return t;
}

// The model tokens of a product: its key tokens without the brand's own words. [] means there is nothing to tell the product from the brand.
function modelTokens(title, brandWords) {
  return DS.keyTokens(title).filter((k) => brandWords.indexOf(k) === -1);
}

// Rank the URLs of a shop for a product: every model token must be in the slug (same whole-word rule as titleMatch), then the fewest extra
// words (after the brand's words, generic words and the product's own words are taken away), then the shortest. Best `top` of them.
function rankUrls(urls, title, brandWords, top) {
  const model = modelTokens(title, brandWords);
  if (!model.length) return [];
  const own = new Set(DS.words(title).concat(brandWords));
  const out = [];
  urls.forEach((u, i) => {
    const toks = slugTokens(u);
    if (!toks.length) return;
    const sq = DS.squash(toks);
    if (!model.every((k) => DS.hasKey(sq, k))) return;
    const extra = toks.filter((w) => !own.has(w) && !genericSlugWord(w) && model.indexOf(w) === -1).length;
    out.push({ url: u, extra, len: toks.join('').length, i });
  });
  out.sort((a, b) => (a.extra - b.extra) || (a.len - b.len) || (a.i - b.i));
  const seen = new Set(), res = [];
  out.forEach((o) => { if (res.length < (top || TOP) && !seen.has(o.url)) { seen.add(o.url); res.push(o); } });
  return res;
}

// ---------------------------------------------------------------- one request
// A GET with the honest user agent, redirects only inside the registrable domain (each one is a request of its own), at most maxBytes read
// (a file over it is "tooBig"), .gz and gzip bytes unpacked (the unpacked size is capped the same way). Never throws.
// -> {status, text} | {status, refused: true} | {status: 0, error: 'network' | 'timeout' | 'url'} | {tooBig: true} | {deferred: true}
async function request(url, o) {
  const start = SHOP.validateShopUrl(url);
  if (!start) return { status: 0, error: 'url' };
  const home = SHOP.registrableDomain(new URL(start).hostname);
  let cur = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!o.spend()) return { deferred: true };
    await o.pause();
    const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await o.fetch(cur, { headers: { 'User-Agent': UA, 'Accept': 'application/xml,text/xml,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'da-DK,da;q=0.9' }, signal: ctl.signal, redirect: 'manual' });
      const s = r.status;
      if (s >= 300 && s < 400 && s !== 304) {
        const loc = r.headers && typeof r.headers.get === 'function' ? r.headers.get('location') : null;
        let next = null; try { next = loc ? SHOP.validateShopUrl(new URL(loc, cur).toString()) : null; } catch (e) { next = null; }
        if (!next || SHOP.registrableDomain(new URL(next).hostname) !== home) return { status: s, error: 'redirect' };
        cur = next; continue;
      }
      if (s === 401 || s === 403 || s === 429) return { status: s, refused: true };
      if (s !== 200) return { status: s };
      const body = await readBody(r, o.maxBytes);
      if (body.tooBig) return { status: s, tooBig: true };
      let buf = body.buf;
      if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        try { buf = zlib.gunzipSync(buf, { maxOutputLength: o.maxBytes }); } catch (e) { return { status: s, tooBig: true }; }
      }
      const text = buf.toString('utf8');
      if (SHOP_CHALLENGE.test(text.slice(0, 20000)) && !/<(urlset|sitemapindex)[\s>]/i.test(text.slice(0, 2000))) return { status: s, refused: true };
      return { status: s, text, url: cur };
    } catch (e) {
      return { status: 0, error: e && e.name === 'AbortError' ? 'timeout' : 'network' };
    } finally { clearTimeout(t); }
  }
  return { status: 0, error: 'redirect' };
}
const SHOP_CHALLENGE = /<title[^>]*>\s*(Just a moment|Attention Required|Access denied|Are you a (human|robot)|Checking your browser|Please verify you are a human|Security check)|cf-chl|challenge-platform|_Incapsula_Resource|px-captcha|captcha-delivery|Enable JavaScript and cookies to continue/i;

async function readBody(r, maxBytes) {
  if (r.body && typeof r.body.getReader === 'function') {
    const rd = r.body.getReader(), chunks = [];
    let total = 0;
    for (;;) {
      const x = await rd.read();
      if (x.done) break;
      total += x.value.length;
      if (total > maxBytes) { try { await rd.cancel(); } catch (e) { /* closed */ } return { tooBig: true }; }
      chunks.push(Buffer.from(x.value));
    }
    return { buf: Buffer.concat(chunks) };
  }
  const buf = typeof r.arrayBuffer === 'function' ? Buffer.from(await r.arrayBuffer()) : Buffer.from(String(await r.text()), 'utf8');
  return buf.length > maxBytes ? { tooBig: true } : { buf };
}

// ---------------------------------------------------------------- the run
// opts: fetch, sleep, cache {get(brand) -> row | null, put(row)} (async), read(url) -> {page} | {error} | {skip} (the run's page reader),
// now() -> Date, requestCap, newBrandCap. A brand row is {brand, base, sitemaps, robots, status ('ok' | 'none' | 'refused'), checked_at}.
function makeBrandRun(opts) {
  const f = opts.fetch || fetch, sleep = opts.sleep || (() => Promise.resolve());
  const now = opts.now || (() => new Date());
  const cap = opts.requestCap || MAX_REQUESTS, brandCap = opts.newBrandCap === undefined ? MAX_NEW_BRANDS : opts.newBrandCap;
  const st = { requests: 0, newBrands: 0 };
  const memo = new Map();            // sitemap url -> parsed document
  const robotsMem = new Map();       // origin -> robots result
  const rows = new Map();            // brand -> row (this run)
  const stamp = () => now().toISOString().replace(/\.\d+Z$/, 'Z');
  let lastAt = false;
  const spend = () => { if (st.requests >= cap || (opts.expired && opts.expired())) return false; st.requests++; return true; };   // expired(): the run is out of time
  const pause = async () => { if (lastAt) await sleep(GAP_MS); lastAt = true; };
  const get = (url, maxBytes) => request(url, { fetch: f, spend, pause, maxBytes });

  async function getRobots(origin) {
    if (robotsMem.has(origin)) return robotsMem.get(origin);
    const r = await get(origin + '/robots.txt', MAX_ROBOTS_BYTES);
    let out;
    if (r.deferred) return r;                                        // not remembered: the budget ran out
    if (r.refused) out = { refused: true };
    else if (r.status === 200 && r.text !== undefined) {
      const p = parseRobots(r.text);
      out = disallowsAll(p.rules) ? { refused: true, why: 'robots' } : { rules: p.rules, sitemaps: p.sitemaps };
    } else if (r.status === 404 || r.status === 410) out = { rules: [], sitemaps: [] };
    else out = { error: true, transient: r.status >= 500, net: r.status === 0 };
    robotsMem.set(origin, out);
    return out;
  }

  async function getSitemap(url) {
    if (memo.has(url)) return memo.get(url);
    const r = await get(url, MAX_SITEMAP_BYTES);
    if (r.deferred) return r;
    let out;
    if (r.refused) out = { refused: true };
    else if (r.tooBig) out = { tooBig: true };
    else if (r.status === 200 && r.text !== undefined) { const p = parseSitemap(r.text); out = p.kind && p.locs.length ? { usable: true, kind: p.kind, locs: p.locs } : { notSitemap: true }; }
    else out = { error: true, transient: r.status >= 500, net: r.status === 0 };
    memo.set(url, out);
    return out;
  }

  // The sitemap addresses to try for a base: the robots.txt lines of the same registrable domain (those that hold the base's locale first),
  // else <base>/sitemap.xml. At most two.
  function sitemapCandidates(bp, robots) {
    const own = (robots.sitemaps || []).map((u) => SHOP.validateShopUrl(u)).filter((u) => u && SHOP.registrableDomain(new URL(u).hostname) === bp.domain);
    if (bp.locale) own.sort((a, b) => (b.toLowerCase().indexOf('/' + bp.locale + '/') !== -1) - (a.toLowerCase().indexOf('/' + bp.locale + '/') !== -1));
    // a base with a locale (www.sonos.com/da-dk): its own sitemap comes right after the robots.txt lines that name the locale, before the global ones
    const mine = bp.origin + bp.path + '/sitemap.xml';
    const list = bp.locale ? own.filter((u) => u.toLowerCase().indexOf('/' + bp.locale + '/') !== -1).concat([mine], own) : (own.length ? own : [mine]);
    return list.filter((u, i) => list.indexOf(u) === i).slice(0, 2);
  }

  // Probe one brand: its shop base and sitemaps, or why there is none. -> {row, cache (bool)} | {deferred: true}
  async function probe(brand, onlyBases) {
    const bases = onlyBases ? onlyBases.slice() : [];
    if (!onlyBases) {
      if (ALIAS[brand]) bases.push(ALIAS[brand]);
      if (/^[a-z0-9]+$/.test(brand)) guessBases(brand).forEach((b) => { if (bases.indexOf(b) === -1) bases.push(b); });
    }
    let refused = false, transient = false;
    outer:
    for (const base of bases) {
      if (!SHOP.validateShopUrl(base)) continue;
      const bp = baseParts(base);
      // A shop from ALIAS is known to exist. When it gives no answer at all (network error, timeout) or a server error, that says nothing about
      // the shop: nothing is remembered and the product stays due, so the next run asks again. Without this, one network hiccup would be
      // remembered as "no shop" for 30 days.
      const known = !onlyBases && ALIAS[brand] === base;
      const rb = await getRobots(bp.origin);
      if (rb.deferred) return { deferred: true };
      if (rb.refused) { refused = true; break; }
      if (rb.error && known && (rb.net || rb.transient)) { if (opts.log) opts.log('  Producentbutik: en kendt butik svarede ikke; prøver igen i næste kørsel.'); return { deferred: true }; }
      if (rb.error) { if (rb.transient) transient = true; continue; }
      for (const sm of sitemapCandidates(bp, rb)) {
        if (!robotsAllows(rb.rules, new URL(sm).pathname)) continue;
        const d = await getSitemap(sm);
        if (d.deferred) return { deferred: true };
        if (d.refused) { refused = true; break outer; }
        if (d.error && known && (d.net || d.transient)) { if (opts.log) opts.log('  Producentbutik: en kendt butik svarede ikke; prøver igen i næste kørsel.'); return { deferred: true }; }
        if (d.error && d.transient) transient = true;
        // a base with a locale must have its locale in the sitemap (its address or a <loc>): a global sitemap of a shop that has no Danish site
        // does not make the shop a Danish one
        const localeIn = !bp.locale || sm.toLowerCase().indexOf('/' + bp.locale + '/') !== -1 || (d.locs || []).some((u) => u.toLowerCase().indexOf('/' + bp.locale + '/') !== -1);
        if (d.usable && localeIn) return { cache: true, row: { brand, base, sitemaps: [sm], robots: rb.rules.slice(0, 60), status: 'ok', checked_at: stamp() } };
      }
    }
    const status = refused ? 'refused' : 'none';
    return { cache: refused || !transient, row: { brand, base: null, sitemaps: [], robots: null, status, checked_at: stamp() } };
  }

  // The product pages of a brand's sitemaps, as URLs of the shop's own registrable domain (and under its locale): reads at most MAX_FILES files.
  async function shopUrls(row) {
    const bp = baseParts(row.base);
    const urls = [];
    let files = 0, indexes = 0;
    const ok = (u) => {
      const v = SHOP.validateShopUrl(u);
      if (!v || !/^https:/i.test(v)) return false;
      const x = new URL(v);
      if (SHOP.registrableDomain(x.hostname) !== bp.domain) return false;
      return !bp.locale || x.pathname.toLowerCase().indexOf('/' + bp.locale + '/') === 0;
    };
    for (const top of (row.sitemaps || []).slice(0, 2)) {
      if (files >= MAX_FILES) break;
      const d = await getSitemap(top);
      if (d.deferred) return { deferred: true };
      if (d.refused) return { refused: true };
      if (!d.usable) continue;
      if (d.kind === 'urlset') { files++; d.locs.forEach((u) => { if (ok(u)) urls.push(u); }); continue; }
      if (++indexes > MAX_INDEXES) break;
      // the children of an index: the product ones first, then those of the base's locale; the shop's own domain only
      const kids = d.locs.filter((u) => { const v = SHOP.validateShopUrl(u); return v && SHOP.registrableDomain(new URL(v).hostname) === bp.domain; });
      const score = (u) => (/product/i.test(u) ? 0 : 2) + (bp.locale && u.toLowerCase().indexOf(bp.locale) !== -1 ? 0 : 1);
      // when the index names product sitemaps, only those are read (the pages, collections and blog files are not product pages)
      const named = kids.filter((u) => /product/i.test(u));
      const pick = (named.length ? named : kids).map((u, i) => ({ u, i, s: score(u) })).sort((a, b) => (a.s - b.s) || (a.i - b.i)).slice(0, MAX_FILES - files);
      for (const k of pick) {
        const c = await getSitemap(k.u);
        if (c.deferred) return { deferred: true };
        if (c.refused) return { refused: true };
        if (!c.usable || c.kind !== 'urlset') continue;
        files++; c.locs.forEach((u) => { if (ok(u)) urls.push(u); });
      }
    }
    return { urls };
  }

  const fresh = (r) => r && Date.parse(r.checked_at) > now().getTime() - CACHE_MS && Date.parse(r.checked_at) <= now().getTime() + 3600 * 1000;
  async function cached(brand) {
    if (rows.has(brand)) return rows.get(brand);
    let r = null;
    try { r = await opts.cache.get(brand); } catch (e) { r = null; }
    r = fresh(r) ? r : null;
    if (r) rows.set(brand, r);
    return r;
  }
  async function remember(row, write) {
    rows.set(row.brand, row);
    if (!write) return;
    try { await opts.cache.put(row); } catch (e) { if (opts.log) opts.log('  Producentbutik: kunne ikke gemme ' + row.brand + ' (' + String(e && e.message || e).slice(0, 80) + ').'); }
  }

  // Everything for one product. prod = {title | name, source_url, extra_urls, extra_state, offers}. -> {deferred: true} or
  // {result, brand, shop (host), verified: {url, price, store, title, inStock} | null}; result: 'added' is for the caller (planBrand) to decide:
  // here 'found' | 'covered' | 'no shop' | 'refused' | 'own shop' | 'no model' | 'no match' | 'not same product'.
  async function process(prod) {
    const title = (typeof prod.title === 'string' && prod.title.trim()) ? prod.title : prod.name;
    const cands = brandCandidates(title);
    if (!cands.length) return { result: 'no shop', brand: null, shop: null, verified: null };
    // 1. the brands in this order: those in ALIAS (longest first), then the others (shortest first: the first word is the likeliest brand). For
    // each, what was found out this month (the cache), else a probe while this run has brands and requests left. The first with a shop wins; a
    // brand that refuses, or a known brand whose shop is not there (any more), ends it (its longer look-alikes are not tried).
    const order = cands.slice().sort((a, b) => ((ALIAS[b.brand] ? 1 : 0) - (ALIAS[a.brand] ? 1 : 0)) || (ALIAS[a.brand] && ALIAS[b.brand] ? b.n - a.n : a.n - b.n));
    let row = null, used = null, refusedSeen = false;
    for (const c of order) {
      let r = await cached(c.brand);
      if (!r) {
        if (st.newBrands >= brandCap) return { deferred: true };
        const p = await probe(c.brand);
        if (p.deferred) return { deferred: true };
        st.newBrands++;
        await remember(p.row, p.cache);
        r = p.row;
      }
      if (r.status === 'ok') { row = r; used = c; break; }
      if (r.status === 'refused') { refusedSeen = true; break; }
      if (ALIAS[c.brand]) break;
    }
    if (!row) return { result: refusedSeen ? 'refused' : 'no shop', brand: cands[cands.length - 1].brand, shop: null, verified: null };
    const shop = new URL(row.base).hostname.replace(/^www\./, '');
    const out = (result, verified) => ({ result, brand: used.brand, shop, verified: verified || null });
    const bp = baseParts(row.base);
    // 3. a shop that is followed already (the product's own shop, a link, or a Prisjagt offer)
    if (prod.source_url && SHOP.registrableDomain(DS.hostOf(prod.source_url)) === bp.domain) return out('own shop');
    if ((Array.isArray(prod.extra_urls) ? prod.extra_urls : []).some((e) => SHOP.registrableDomain(DS.hostOf(e)) === bp.domain)) return out('covered');
    const offers = Array.isArray(prod.offers) ? prod.offers : [];
    if (X.covered(offers, { url: row.base, store: '' }) || X.brandListed(offers, used.brand)) return out('covered');
    // 4. the model tokens and the product's URLs in the sitemaps
    const brandWords = titleWords(title).slice(0, used.n);
    if (!modelTokens(title, brandWords).length) return out('no model');
    const su = await shopUrls(row);
    if (su.deferred) return { deferred: true };
    if (su.refused) return out('refused');
    const ranked = rankUrls(su.urls || [], title, brandWords, TOP);
    if (!ranked.length) return out('no match');
    // 5. read the best pages in rank order: the first that is the same product at a sensible price in kroner wins
    let sawRefusal = false, sawCovered = false, read = 0;
    for (const c of ranked) {
      if (!robotsAllows(row.robots, new URL(c.url).pathname + new URL(c.url).search)) continue;
      if (!spend()) return { deferred: true };
      const got = await opts.read(c.url);
      if (got.skip) { if (read === 0) return { deferred: true }; break; }
      read++;
      if (got.error) { if (got.error.kind === 'blocked') { sawRefusal = true; break; } continue; }
      if (!got.page) continue;
      const v = DS.verifyPage(prod, { url: c.url }, got.page, { allowOutOfStock: true });
      if (v.ok) return out('found', v);
      if (v.reason === 'med på Prisjagt') sawCovered = true;
    }
    return out(sawRefusal ? 'refused' : sawCovered ? 'covered' : 'not same product');
  }

  return { process, probe, shopUrls, stats: st, get requests() { return st.requests; }, get newBrands() { return st.newBrands; }, spend };
}

// ---------------------------------------------------------------- adding the shop
// What to change in extra_urls for a verified brand-shop page v = {url, price, store}. fresh = {extra_urls, extra_state} as they are now.
// The shop is added whatever its price (also dearer than the lowest, also sold out), unless it is covered (the product's own shop, a link that
// is there). Room in the list (cap 5): add. A full list: it replaces the most expensive link found by the search (origin 'search') that is not
// the product's cheapest, else it is not added. Returns {add: [{url, price, store, origin: 'brand'}], remove: [url], why}.
function planBrand(prod, fresh, v) {
  const none = (why) => ({ add: [], remove: [], why });
  const st = fresh && fresh.extra_state && typeof fresh.extra_state === 'object' && !Array.isArray(fresh.extra_state) ? fresh.extra_state : {};
  let list = Array.isArray(fresh && fresh.extra_urls) ? fresh.extra_urls.slice() : [];
  const dom = SHOP.registrableDomain(DS.hostOf(v.url));
  const taken = new Set(list.map((u) => SHOP.registrableDomain(DS.hostOf(u))).concat([SHOP.registrableDomain(DS.hostOf(prod.source_url || ''))]));
  if (taken.has(dom)) return none('covered');
  const lowest = DS.lowestPrice(prod);
  const remove = [];
  if (list.length >= DS.MAX_EXTRAS) {
    let victim = null, vp = -1;
    list.forEach((u) => {
      if (DS.originOf(st, u) !== 'search') return;
      const p = DS.priceOfLink(prod, st, u);
      if (lowest !== null && p <= lowest) return;           // the product's cheapest (or as cheap as it) stays
      if (p > vp) { victim = u; vp = p; }
    });
    if (!victim) return none('full');
    remove.push(victim);
  }
  return { add: [{ url: v.url, price: v.price, store: v.store, origin: 'brand' }], remove, why: null };
}

module.exports = {
  ALIAS, CACHE_MS, MAX_REQUESTS, MAX_NEW_BRANDS, GAP_MS, MAX_SITEMAP_BYTES, MAX_FILES, TOP,
  brandCandidates, guessBases, baseParts, parseRobots, robotsAllows, disallowsAll, parseSitemap, slugTokens, modelTokens, rankUrls, request,
  makeBrandRun, planBrand, titleWords,
};
