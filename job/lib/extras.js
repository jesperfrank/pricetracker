'use strict';
// Extra shops for a single-shop product (products.extra_urls, written by the AI agent): pure helpers for the job. No I/O.
//   products.extra_urls   1 to 5 https product-page links, one per shop (the database checks the rule; the job re-checks what it fetches)
//   products.extra_state  the job's own bookkeeping, one entry per link: {"seen": true, "fails": 0, "at": "<time of the last attempt>"}
//     seen  = the link has been read successfully and its offer was recorded once (so its price is not "new" any more)
//     fails = attempts in a row that gave nothing (error, no price, not in kroner, a price far from the other shops)
//     at    = the last attempt (rotation: the longest-untried link goes first when the run is capped)

const SHOP = require('./shop');

const MAX_FETCHES = 30;               // extra pages fetched per run, over all products
const FAIL_STREAK = 10;               // after this many failures in a row a link is tried once a day only
const SLOW_MS = 24 * 3600 * 1000;
const LOW_RATIO = 0.4, HIGH_RATIO = 2.5;   // an extra price below 40 % or above 250 % of the median of the other shops is another product
const MIN_OTHERS = 2;

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

module.exports = { MAX_FETCHES, FAIL_STREAK, SLOW_MS, LOW_RATIO, HIGH_RATIO, links, stateOf, isNew, slow, median, isOutlier, pick, hostOf };
