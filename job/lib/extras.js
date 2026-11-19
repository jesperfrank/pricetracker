'use strict';
// Extra shops for a product (products.extra_urls, written by the AI agent or added by hand by the person): pure helpers for the job. No I/O.
// Two kinds of product have them: a single-shop product (the main shop plus the extras) and a product on prisjagt.dk (the Prisjagt offers
// plus the extras, which are the shops Prisjagt does not list, for example the manufacturer's own web shop).
//   products.extra_urls   1 to 5 https product-page links, one per shop (the database checks the rule; the job re-checks what it fetches)
//   products.extra_state  the job's own bookkeeping, one entry per link: {"seen": true, "fails": 0, "at": "<time of the last attempt>"}
//     seen  = the link has been read successfully and its offer was recorded once (so its price is not "new" any more)
//     fails = attempts in a row that gave nothing (error, no price, not in kroner, a price far from the other shops)
//     at    = the last attempt (rotation: the longest-untried link goes first when the run is capped)
//     offer = the last offer that was READ from this shop: {store, price, inStock, note, name, at} (at = when it was read; name = the page's own
//             product name, decoded, at most 120 characters, so that a wrong match can be seen in diag_products; absent when the page gave none). Kept up to 24 hours
//             when the shop cannot be read for a transient reason (refused, timeout, network, 5xx), so the lowest price and the hit do not
//             flicker. The main shop of a product with extras is kept the same way, under its own link (products.source_url as fetched).
//             Dropped at once when the page is read and shows no price / another product / is gone (that is real information).
//     why   = why the link does NOT contribute an offer after its last attempt, for the person's list "Butikker, vi følger" (absent when it
//             does, also when its last offer stands in for it): 'err' (the page could not be read), 'noprice' (read, no price), 'outlier'
//             (the price is far from the other shops: probably another product), 'dup' (the shop is among the Prisjagt offers already).
//             A stale offer is shown through the note of the offer itself ("pris fra i går").
//     origin = who chose the link: 'agent' (resolver_compare), 'hand' (the person, products_guard), 'brand' / 'search' (the job, discovery); absent on
//             links stored before this was recorded (they came from the agent). The page's own product name is checked against the product for
//             'agent' and absent (DS.identityMatch, run.js sameProduct): a page of another product is dropped with why 'outlier'.

const SHOP = require('./shop');
const PRICING = require('./pricing');

const MAX_FETCHES = 30;               // extra pages fetched per run, over all products
const FAIL_STREAK = 10;               // after this many failures in a row a link is tried once a day only
const SLOW_MS = 24 * 3600 * 1000;
const LOW_RATIO = 0.4, HIGH_RATIO = 2.5;   // an extra price below 40 % or above 250 % of the median of the other shops is another product
const MIN_OTHERS = 2;
const STALE_MS = 24 * 3600 * 1000;    // a shop that cannot be read keeps its last offer this long
const STALE_NOTE_MS = 6 * 3600 * 1000; // an offer older than this is marked "pris fra i går" / "pris fra tidligere i dag" in the offers list
const STALE_NOTES = ['pris fra i går', 'pris fra tidligere i dag'];
const NAME_MAX = 120;                  // the page's product name kept per link (extra_state[url].offer.name)

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function hostOf(u) { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; } }

// The links of a product that may be fetched: [] when the row has no such column (an older database) or when it is not an array. The
// product's own link may be a shop or a prisjagt.dk page. Each entry must pass the shop URL guard and be https and not be on prisjagt.dk;
// an entry that does not, is the same shop as the product's own link (same host) or repeats an earlier one is left out. At most 5.
function links(prod) {
  if (!prod || !has(prod, 'extra_urls') || !Array.isArray(prod.extra_urls)) return [];
  if (typeof prod.source_url !== 'string') return [];
  const taken = new Set([hostOf(prod.source_url)]), out = [];
  for (const raw of prod.extra_urls.slice(0, 5)) {
    const u = SHOP.validateShopUrl(raw);
    if (!u || !/^https:/i.test(u) || SHOP.isPrisjagtHost(new URL(u).hostname)) continue;
    const h = hostOf(u);
    if (taken.has(h)) continue;
    taken.add(h); out.push(u);
  }
  return out;
}

function stateOf(prod) {
  const s = prod && prod.extra_state;
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}

// Is this link's price new to us? With the state column: it has not been read and recorded before. Without it (should not happen, both
// columns come in one schema): the answer came after the last check (compare_at newer than last_checked), which is the first check only.
function isNew(prod, st) {
  if (has(prod, 'extra_state')) return !(st && st.seen);
  const at = Date.parse(prod.compare_at), last = prod.last_checked ? Date.parse(prod.last_checked) : -Infinity;
  return prod.compare_state === 'done' && isFinite(at) && at > last;
}

// failing for a long time: only one attempt a day
function slow(st, now) {
  if (!st || !(Number(st.fails) >= FAIL_STREAK)) return false;
  const at = Date.parse(st.at);
  return isFinite(at) && now.getTime() - at < SLOW_MS;
}

function median(nums) {
  const a = nums.slice().sort((x, y) => x - y), n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

// Is the extra price (kroner) another product? Compared with the median of the other prices of this run; needs at least two others.
function isOutlier(price, others) {
  const o = (others || []).filter((x) => typeof x === 'number' && isFinite(x) && x > 0);
  if (o.length < MIN_OTHERS) return false;
  const m = median(o);
  return price < LOW_RATIO * m || price > HIGH_RATIO * m;
}

// Is this extra shop one that the Prisjagt offers cover already? Then the Prisjagt row is kept and the extra one dropped. The rule, in this order:
//  1. an offer whose link is NOT on prisjagt.dk (a direct link) and has the same registrable domain as the extra link;
//  2. an offer whose shop name equals the extra offer's shop name, both normalised (lower case, no www, no .dk / .com, letters and digits only);
//  3. an offer whose normalised shop name equals the registrable name of the extra link (roborock.com/dk -> "roborock").
// Equality only, never "contains": a shop that is only similar in name (Coolshop / Coolshop Outlet) is a shop of its own and stays.
// Prisjagt's own offer links are go-to-shop links on prisjagt.dk, so in practice it is the names that decide. rows = the offers of the
// product's tracked variants; extra = {url, store}.
function covered(rows, extra) {
  const dom = (h) => SHOP.registrableDomain(h), name = (s) => PRICING.normShop(s);
  const eh = hostOf(extra.url), ed = eh ? dom(eh) : '', en = name(extra.store), eg = eh ? name(SHOP.registrable(eh).name) : '';
  return (rows || []).some((r) => {
    const rh = hostOf(r.url);
    if (rh && !SHOP.isPrisjagtHost(rh) && ed && dom(rh) === ed) return true;
    const rn = name(r.store);
    return !!rn && (rn === en || rn === eg);
  });
}

// Does Prisjagt list the manufacturer's own shop under the brand's name? True when one of the offers has a store whose normalised name (as in
// covered()) equals the brand ("Dreame" for brand dreame) or is the brand followed by a word that only says "shop" ("Dreame Official Store",
// "Roborock Danmark", "Dreame DK"). Never "contains": "Dreamer" or "Roborock Outlet" are other shops. brand = the squashed brand words
// (brandshop.js: the ALIAS key or the brand candidate that won). rows = the offers of the product's tracked variants.
const SHOP_WORDS = /^(?:official|officiel|store|shop|butik|danmark|denmark|dk)+$/;
function brandListed(rows, brand) {
  const bs = (Array.isArray(brand) ? brand : [brand]).map((x) => PRICING.normShop(x)).filter((b) => b.length >= 3);
  if (!bs.length) return false;
  return (rows || []).some((r) => {
    const n = PRICING.normShop(r && r.store);
    return !!n && bs.some((b) => n === b || (n.indexOf(b) === 0 && SHOP_WORDS.test(n.slice(b.length))));
  });
}

// The fetches of this run: candidates [{key, at, n}] (at = time of the last attempt, 0 = never), the longest-untried first, at most max.
function pick(cands, max) {
  return cands.slice().sort((a, b) => (a.at - b.at) || (a.n - b.n)).slice(0, max === undefined ? MAX_FETCHES : max).map((c) => c.key);
}

// Failures that say nothing about the page itself: the shop refuses us, does not answer in time, or the network / the server is down.
// (A page that is gone, has no price, is not in kroner or cannot be parsed is real information and replaces the old offer.)
function transient(error) { return !!error && ['blocked', 'timeout', 'network'].indexOf(error.kind) !== -1; }

const strip = (note) => {
  let n = typeof note === 'string' ? note : '';
  STALE_NOTES.forEach((m) => { if (n === m) n = ''; else if (n.slice(-m.length - 3) === ' · ' + m) n = n.slice(0, -m.length - 3); });
  return n || null;
};

// The page's own product name for extra_state: squeezed (already decoded by the page parser), at most 120 characters, or null.
function pageName(s) {
  const n = typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim() : '';
  return n || null;
}

// The last known offer of one link (the main shop's link or an extra link): {store, price, inStock, note, at (ms)} or null when there is none
// or it was read more than 24 hours ago. From extra_state[url].offer; for a row from before this existed, from products.offers (readAt of
// the entry, else the time of the last check).
function lastOffer(prod, st, url, now) {
  let o = null, at = NaN;
  const so = st && st.offer;
  if (so && typeof so === 'object' && typeof so.price === 'number' && so.price > 0) { o = { store: so.store, price: so.price, inStock: so.inStock !== false, note: strip(so.note), name: pageName(so.name) }; at = Date.parse(so.at); }
  else {
    const f = (Array.isArray(prod && prod.offers) ? prod.offers : []).find((x) => x && x.url === url && typeof x.price === 'number' && x.price > 0);
    if (f) { o = { store: f.store, price: f.price, inStock: f.inStock !== false, note: strip(f.note) }; at = Date.parse(f.readAt || prod.last_checked); }
  }
  if (!o || !isFinite(at) || at > now.getTime() + 60000 || now.getTime() - at > STALE_MS || !o.store) return null;
  o.at = at;
  return o;
}

// The quiet marker for an offer that was read more than 6 hours ago, or null.
function staleNote(readAtMs, now, copenhagenDate) {
  if (!(now.getTime() - readAtMs > STALE_NOTE_MS)) return null;
  return copenhagenDate(new Date(readAtMs)) === copenhagenDate(now) ? STALE_NOTES[1] : STALE_NOTES[0];
}

module.exports = { pageName, STALE_MS, STALE_NOTE_MS, transient, lastOffer, staleNote, strip, MAX_FETCHES, FAIL_STREAK, covered, brandListed, SLOW_MS, LOW_RATIO, HIGH_RATIO, links, stateOf, isNew, slow, median, isOutlier, pick, hostOf };
