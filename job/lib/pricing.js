'use strict';
// Pure price logic for Prisvagten: shop matching, preferences, history, normal price, verdict,
// warning, goal/notify. No I/O. (Shop matching, merge and goal logic are taken over from the
// tested pricecheck.js; normal price / verdict / warning are new.)

const HISTORY_DAYS = 400;
const MAX_OFFERS = 15;
const DAY = 86400000;

// ---------------------------------------------------------------- dates

function copenhagenDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}
function dayNum(iso) { return Math.round(Date.parse(iso + 'T00:00:00Z') / DAY); }
function numDay(n) { return new Date(n * DAY).toISOString().slice(0, 10); }

// ---------------------------------------------------------------- formatting (Danish)

function fmtKr(n) {
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  const v = whole ? String(Math.round(n)) : n.toFixed(2).replace('.', ',');
  const [int, dec] = v.split(',');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (dec ? ',' + dec : '') + ' kr.';
}

// ---------------------------------------------------------------- shops

function normShop(s) {
  s = String(s || '').toLowerCase().trim().replace(/^www\./, '').replace(/\.(dk|com)$/, '');
  return s.replace(/[^\p{L}\p{N}]/gu, '');
}

function matchShop(a, b) {
  const x = normShop(a), y = normShop(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length <= y.length ? x : y, long = x.length <= y.length ? y : x;
  return short.length >= 5 && long.indexOf(short) !== -1;
}

function anyMatch(name, list) {
  for (let i = 0; i < (list || []).length; i++) if (matchShop(name, list[i])) return true;
  return false;
}

// product (snake_case DB row) prefs merged with profile prefs
function mergePrefs(prod, profile) {
  prod = prod || {}; profile = profile || {};
  const arr = (x) => (Array.isArray(x) ? x : []);
  const exclude = arr(prod.shops_exclude).concat(arr(profile.shops_exclude));
  const always = arr(prod.shops_always).concat(arr(profile.shops_always));
  const only = prod.shops_only === true || profile.shops_only === true;
  return { exclude, always, only: only && always.length > 0 };
}

function applyPrefs(offers, prefs) {
  return offers.filter((o) => {
    if (anyMatch(o.store, prefs.exclude)) return false;
    if (prefs.only && !anyMatch(o.store, prefs.always)) return false;
    return true;
  });
}

function lowestInStock(offers) {
  let best = null;
  (offers || []).forEach((o) => {
    if (o && o.inStock === true && typeof o.price === 'number' && (!best || o.price < best.price)) best = o;
  });
  return best;
}

// one offer per shop (in stock first, then cheapest), sorted in stock first then by price
function onePerStore(rows) {
  const byStore = {};
  rows.forEach((o) => {
    const k = normShop(o.store), cur = byStore[k];
    if (!cur || (o.inStock && !cur.inStock) || (o.inStock === cur.inStock && o.price < cur.price)) byStore[k] = o;
  });
  const list = Object.keys(byStore).map((k) => byStore[k]);
  list.sort((a, b) => (a.inStock === b.inStock ? 0 : a.inStock ? -1 : 1) || a.price - b.price);
  return list;
}

// returns null when ok, else a Danish reason
function sanityCheck(offers, prevOffers) {
  if (!offers || !offers.length) return 'Ingen tilbud fundet';
  for (let i = 0; i < offers.length; i++) {
    const pr = offers[i].price;
    if (typeof pr !== 'number' || !isFinite(pr) || pr <= 0) return 'Ugyldig pris i tilbud';
  }
  const low = lowestInStock(offers), prev = lowestInStock(prevOffers);
  if (low && prev && low.price < 0.4 * prev.price) {
    const stores = {};
    offers.forEach((o) => { if (o.inStock && o.price <= low.price * 1.15) stores[normShop(o.store)] = 1; });
    if (Object.keys(stores).length < 2) return 'Laveste pris faldt mistænkeligt meget (' + low.price + ' mod ' + prev.price + ' kr.)';
  }
  return null;
}

// ---------------------------------------------------------------- history

function cutoffDate(today) { return numDay(dayNum(today) - HISTORY_DAYS); }

// add today's point (src 'check'); same date keeps the lower price; 400-day window; one point per date
function mergeHistory(history, today, price, store) {
  let h = Array.isArray(history) ? history.slice() : [];
  let idx = -1;
  for (let i = 0; i < h.length; i++) if (h[i] && h[i].d === today) { idx = i; break; }
  if (idx === -1) h.push({ d: today, p: price, s: store, src: 'check' });
  else if (price < h[idx].p) h[idx] = { d: today, p: price, s: store, src: 'check' };
  const cutoff = cutoffDate(today);
  h = h.filter((x) => x && typeof x.d === 'string' && x.d >= cutoff);
  const seen = {}, dd = [];
  h.forEach((x) => {
    if (seen[x.d] === undefined) { seen[x.d] = dd.length; dd.push(x); }
    else if (x.p < dd[seen[x.d]].p) dd[seen[x.d]] = x;
  });
  dd.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return dd;
}

// page points (src 'page') + existing non-page, non-backfill points; one per date, lower price wins
function mergePageHistory(existing, pagePoints, today) {
  const cutoff = cutoffDate(today);
  const byDate = {};
  (pagePoints || []).forEach((x) => {
    if (!x || x.d < cutoff) return;
    const cur = byDate[x.d];
    if (!cur || x.p < cur.p) byDate[x.d] = { d: x.d, p: x.p, s: x.s, src: 'page' };
  });
  (Array.isArray(existing) ? existing : []).forEach((x) => {
    if (!x || typeof x.d !== 'string' || x.d < cutoff || x.src === 'backfill' || x.src === 'page') return;
    const cur = byDate[x.d];
    if (!cur || x.p < cur.p) byDate[x.d] = x;
  });
  return Object.keys(byDate).sort().map((k) => byDate[k]);
}

// The page history only has the days where the lowest price CHANGED, so a "daily lowest" series
// carries the last known price forward. Starts at the first point; ends at today.
function dailySeries(history, today) {
  const pts = (Array.isArray(history) ? history : [])
    .filter((x) => x && typeof x.d === 'string' && typeof x.p === 'number' && x.d <= today)
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  if (!pts.length) return [];
  const out = [], end = dayNum(today);
  let i = 0, cur = null;
  for (let n = dayNum(pts[0].d); n <= end; n++) {
    const d = numDay(n);
    while (i < pts.length && pts[i].d <= d) { cur = pts[i].p; i++; }
    out.push({ n, d, p: cur });
  }
  return out;
}

// median of the daily lowest prices over the last 90 days, excluding the most recent 7 days;
// null with fewer than 10 days of data.
function normalPrice(history, today) {
  const t = dayNum(today);
  const vals = dailySeries(history, today).filter((x) => x.n >= t - 89 && x.n <= t - 7).map((x) => x.p);
  if (vals.length < 10) return null;
  vals.sort((a, b) => a - b);
  const m = vals.length >> 1;
  const med = vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  return Math.round(med * 100) / 100;
}

// ---------------------------------------------------------------- verdict and warning

// low: today's lowest in-stock price after preferences (number|null).
// saleSignal: true/false when the page tells whether the shop calls the lowest offer a sale; null when it gives no signal.
function verdictFor(low, normal, history, today, saleSignal) {
  if (typeof low !== 'number') return { level: 'unknown', text: 'Ingen butikker har varen på lager lige nu.' };
  if (normal === null || normal === undefined) return { level: 'unknown', text: 'Der er endnu ikke nok prishistorik til at vurdere prisen.' };
  const t = dayNum(today);
  const prior = dailySeries(history, today).filter((x) => x.n >= t - 30 && x.n <= t - 1).map((x) => x.p);
  const min30 = prior.length ? Math.min.apply(null, prior) : null;
  const pctUnder = Math.round((1 - low / normal) * 100);
  const notAboveMin = min30 === null || low <= min30;
  if (low <= normal * 0.9 && notAboveMin) {
    return { level: 'good', text: fmtKr(low) + ' er ' + pctUnder + ' % under normalprisen (' + fmtKr(normal) + ') og den laveste pris i 30 dage.' };
  }
  if (low > normal) {
    return { level: 'poor', text: fmtKr(low) + ' er over normalprisen (' + fmtKr(normal) + ').' };
  }
  if (saleSignal === true && min30 !== null && low >= min30) {
    return { level: 'poor', text: 'Butikkerne kalder det et tilbud, men ' + fmtKr(low) + ' er ikke lavere end den laveste pris de seneste 30 dage (' + fmtKr(min30) + ').' };
  }
  if (low <= normal * 0.9) {
    return { level: 'ok', text: fmtKr(low) + ' er ' + pctUnder + ' % under normalprisen (' + fmtKr(normal) + '), men prisen har været lavere de seneste 30 dage (' + fmtKr(min30) + ').' };
  }
  return { level: 'ok', text: fmtKr(low) + ' ligger tæt på normalprisen (' + fmtKr(normal) + ').' };
}

// A price that rose by more than 10 % within the last 30 days and then fell back to (about) the
// old level looks like a staged discount.
function priceWarning(history, today, current) {
  const t = dayNum(today);
  const win = dailySeries(history, today).filter((x) => x.n >= t - 30);
  if (win.length < 3) return null;
  let pk = 0;
  for (let i = 1; i < win.length; i++) if (win[i].p > win[pk].p) pk = i;
  if (pk === 0 || pk === win.length - 1) return null;
  let base = Infinity;
  for (let i = 0; i < pk; i++) base = Math.min(base, win[i].p);
  const cur = typeof current === 'number' ? current : win[win.length - 1].p;
  const peak = win[pk].p;
  if (!(peak > base * 1.1) || !(cur <= base * 1.03)) return null;
  const ago = t - win[pk].n;
  return 'Prisen steg fra ' + fmtKr(base) + ' til ' + fmtKr(peak) + ' for ' + ago + (ago === 1 ? ' dag' : ' dage') +
    ' siden og er nu faldet tilbage til ' + fmtKr(cur) + ' Rabatten er måske ikke så stor, som den ser ud.';
}

// ---------------------------------------------------------------- goal / notify

function targetPrice(prod, normal) {
  const v = Number(prod.target_value);
  if (prod.target_value === null || prod.target_value === undefined || !isFinite(v)) return null;
  if (prod.target_type === 'price') return v;
  if (prod.target_type === 'pct') {
    const n = Number(normal);
    if (normal === null || normal === undefined || !isFinite(n) || n <= 0) return null;
    return n * (1 - v / 100);
  }
  return null;
}

// hit = lowest in-stock offer at or below the goal. Announce once, again only if the price drops
// further; reset when no longer a hit. Returns the notified_* fields to write.
function goalOutcome(prod, low, normal, iso) {
  const tgt = targetPrice(prod, normal);
  const hit = !!(low && tgt !== null && low.price <= tgt);
  const prevN = prod.notified_price;
  const hasPrev = typeof prevN === 'number';
  const out = { hit, newHit: false, fields: {} };
  if (hit) {
    if (!hasPrev || low.price < prevN) {
      out.newHit = true;
      out.fields = { notified_price: low.price, notified_at: iso };
    } else out.fields = { notified_price: prevN };
  } else out.fields = { notified_price: null };
  return out;
}

module.exports = {
  HISTORY_DAYS, MAX_OFFERS, copenhagenDate, dayNum, numDay, fmtKr, normShop, matchShop, anyMatch, mergePrefs, applyPrefs,
  lowestInStock, onePerStore, sanityCheck, mergeHistory, mergePageHistory, dailySeries, normalPrice, verdictFor,
  priceWarning, targetPrice, goalOutcome,
};
