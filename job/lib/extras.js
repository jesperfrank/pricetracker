'use strict';
// Extra shops for a single-shop product (products.extra_urls, written by the AI agent): pure helpers for the job. No I/O.
//   products.extra_urls   1 to 5 https product-page links, one per shop (the database checks the rule; the job re-checks what it fetches)
//   products.extra_state  the job's own bookkeeping, one entry per link: {"seen": true, "fails": 0, "at": "<time of the last attempt>"}
//     seen  = the link has been read successfully and its offer was recorded once (so its price is not "new" any more)
//     fails = attempts in a row that gave nothing (error, no price, not in kroner, a price far from the other shops)
//     at    = the last attempt (rotation: the longest-untried link goes first when the run is capped)
//     offer = the last offer that was READ from this shop: {store, price, inStock, note, at} (at = when it was read). Kept up to 24 hours
//             when the shop cannot be read for a transient reason (refused, timeout, network, 5xx), so the lowest price and the hit do not
//             flicker. The main shop of a product with extras is kept the same way, under its own link (products.source_url as fetched).
//             Dropped at once when the page is read and shows no price / another product / is gone (that is real information).

const SHOP = require('./shop');

const MAX_FETCHES = 30;               // extra pages fetched per run, over all products
const FAIL_STREAK = 10;               // after this many failures in a row a link is tried once a day only
const SLOW_MS = 24 * 3600 * 1000;
const LOW_RATIO = 0.4, HIGH_RATIO = 2.5;   // an extra price below 40 % or above 250 % of the median of the other shops is another product
const MIN_OTHERS = 2;
const STALE_MS = 24 * 3600 * 1000;    // a shop that cannot be read keeps its last offer this long
const STALE_NOTE_MS = 6 * 3600 * 1000; // an offer older than this is marked "pris fra i går" / "pris fra tidligere i dag" in the offers list
const STALE_NOTES = ['pris fra i går', 'pris fra tidligere i dag'];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function hostOf(u) { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; } }

// The links of a product that may be fetched: [] when the row has no such column (an older database), when it is not an array, or when
// the product's own link is a prisjagt.dk page. Each entry must pass the shop URL guard and be https; an entry that does not, is the same
// shop as the product's own link (same host) or repeats an earlier one is left out. At most 5.
function links(prod) {
  if (!prod || !has(prod, 'extra_urls') || !Array.isArray(prod.extra_urls)) return [];
  if (typeof prod.source_url !== 'string' || SHOP.isPrisjagtHost(hostOf(prod.source_url))) return [];
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

// The last known offer of one link (the main shop's link or an extra link): {store, price, inStock, note, at (ms)} or null when there is none
// or it was read more than 24 hours ago. From extra_state[url].offer; for a row from before this existed, from products.offers (readAt of
// the entry, else the time of the last check).
function lastOffer(prod, st, url, now) {
  let o = null, at = NaN;
  const so = st && st.offer;
  if (so && typeof so === 'object' && typeof so.price === 'number' && so.price > 0) { o = { store: so.store, price: so.price, inStock: so.inStock !== false, note: strip(so.note) }; at = Date.parse(so.at); }
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

module.exports = { STALE_MS, STALE_NOTE_MS, transient, lastOffer, staleNote, strip, MAX_FETCHES, FAIL_STREAK, SLOW_MS, LOW_RATIO, HIGH_RATIO, links, stateOf, isNew, slow, median, isOutlier, pick, hostOf };
