'use strict';
// Older prices for a single-shop product from the Internet Archive (Wayback Machine).
// Only web.archive.org is ever contacted. One sequential request at a time, a pause between requests, an honest user
// agent, a timeout per request, no retries, and the whole thing stops at the first HTTP 429 or 5xx.
//
//   1. CDX API: one capture per month (collapse=timestamp:6) of the last 13 months, status 200, text/html
//   2. for up to MAX_CAPTURES of them (spread over the period, oldest and newest included):
//      https://web.archive.org/web/<timestamp>id_/<url>   ("id_" = the page as it was archived, without the archive toolbar)
//   3. the ordinary shop parser reads the price; only DKK prices that parse cleanly and are in stock are kept
//
// backfill(url, opts) resolves to {status, points, captures, tried}:
//   status 'ok'       finished (points may be empty: no captures, or none had a usable price)
//   status 'stopped'  HTTP 429 / 5xx, a timeout or a network error on the CDX request, or the time budget ran out;
//                     points holds what was found until then. The caller may allow one later retry.
//   points            [{d: 'YYYY-MM-DD', p: price, s: shop name, src: 'backfill'}], oldest first, only dates before today

const P = require('./pricing');
const { UA } = require('./prisjagt');
const SHOP = require('./shop');

const HOST = 'web.archive.org';
const CDX = 'https://' + HOST + '/cdx/search/cdx';
const MAX_CAPTURES = 14;
const MONTHS = 13;
const PAUSE_MS = 1500;
const TIMEOUT_MS = 20000;
const BUDGET_MS = 60000;
const MAX_HTML = 4000000;
const MAX_REDIRECTS = 5;

class Stop extends Error {}                       // 429 / 5xx / out of time: end the whole backfill

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

// "2026-11-16" -> "202510" (the month 13 months back: with collapse=timestamp:6 that is at most 14 captures)
function fromMonth(today) {
  const y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const idx = y * 12 + (m - 1) - MONTHS;
  return String(Math.floor(idx / 12)) + String((idx % 12) + 1).padStart(2, '0');
}

function cdxUrl(url, today) {
  return CDX + '?url=' + encodeURIComponent(url) + '&output=json&filter=statuscode:200&filter=mimetype:text/html&collapse=timestamp:6&from=' + fromMonth(today) + '&limit=40';
}

function captureUrl(ts, url) { return 'https://' + HOST + '/web/' + ts + 'id_/' + url; }

// the CDX json: first row is the header row (["urlkey","timestamp","original",...]); an empty result is [] or an empty body
function parseCdx(text) {
  const body = String(text || '').trim();
  if (!body) return [];
  let rows;
  try { rows = JSON.parse(body); } catch (e) { return null; }
  if (!Array.isArray(rows)) return null;
  if (!rows.length) return [];
  let ti = 1, si = 4, mi = 3;
  if (Array.isArray(rows[0]) && rows[0].indexOf('timestamp') !== -1) {
    ti = rows[0].indexOf('timestamp'); si = rows[0].indexOf('statuscode'); mi = rows[0].indexOf('mimetype');
    rows = rows.slice(1);
  }
  const out = [];
  rows.forEach((r) => {
    if (!Array.isArray(r)) return;
    const ts = String(r[ti] || '');
    if (!/^\d{14}$/.test(ts)) return;
    if (si !== -1 && r[si] !== undefined && String(r[si]) !== '200') return;
    if (mi !== -1 && r[mi] !== undefined && !/^text\/html/i.test(String(r[mi]))) return;
    out.push(ts);
  });
  out.sort();
  return out.filter((t, i) => out.indexOf(t) === i);
}

// at most n entries spread evenly over the list, first and last always included
function spread(list, n) {
  if (list.length <= n) return list.slice();
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round(i * (list.length - 1) / (n - 1))]);
  return out.filter((x, i) => out.indexOf(x) === i);
}

function tsToDate(ts) {
  const d = new Date(Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8), +ts.slice(8, 10), +ts.slice(10, 12), +ts.slice(12, 14)));
  return P.copenhagenDate(d);
}

async function backfill(url, opts) {
  opts = opts || {};
  const f = opts.fetch || fetch;
  const sleep = opts.sleep || sleepReal;
  const clock = opts.now || Date.now;
  const budget = opts.budgetMs || BUDGET_MS;
  const today = opts.today || P.copenhagenDate(new Date(clock()));
  const started = clock();
  const out = { status: 'ok', points: [], captures: 0, tried: 0 };
  if (!SHOP.validateShopUrl(url)) return out;
  let lastAt = null;

  // one GET to web.archive.org (redirects only to web.archive.org), pause before every request but the first.
  // Returns {status, text}; throws Stop on 429 / 5xx / out of time, plain Error on timeout / network trouble.
  async function get(u, accept) {
    for (let hop = 0; ; hop++) {
      const x = new URL(u);
      if (x.protocol !== 'https:' || x.hostname !== HOST || x.port || x.username || x.password) throw new Error('not web.archive.org');
      if (lastAt !== null) { const wait = (opts.pauseMs === undefined ? PAUSE_MS : opts.pauseMs) - (clock() - lastAt); if (wait > 0) await sleep(wait); }
      if (clock() - started >= budget) throw new Stop('time budget');
      lastAt = clock();
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), opts.timeoutMs || TIMEOUT_MS);
      try {
        const r = await f(u, { headers: { 'User-Agent': UA, 'Accept': accept }, signal: ctl.signal, redirect: 'manual' });
        if (r.status === 429 || r.status >= 500) throw new Stop('HTTP ' + r.status);
        if (r.status >= 300 && r.status < 400) {
          const loc = r.headers && typeof r.headers.get === 'function' ? r.headers.get('location') : null;
          if (!loc || hop >= MAX_REDIRECTS) return { status: r.status, text: '' };
          u = new URL(loc, u).toString();
          continue;
        }
        const text = r.status === 200 ? String(await r.text()).slice(0, MAX_HTML) : '';
        return { status: r.status, text };
      } finally { clearTimeout(t); }
    }
  }

  let stamps;
  try {
    const r = await get(cdxUrl(url, today), 'application/json');
    if (r.status !== 200) { out.status = 'stopped'; return out; }
    stamps = parseCdx(r.text);
    if (stamps === null) { out.status = 'stopped'; return out; }           // not json: leave it to a later try
  } catch (e) { out.status = 'stopped'; return out; }

  const cutoff = P.cutoffDate(today);
  const picked = spread(stamps, MAX_CAPTURES);
  out.captures = picked.length;
  for (const ts of picked) {
    out.tried++;
    try {
      const r = await get(captureUrl(ts, url), 'text/html');
      if (r.status !== 200 || !r.text) continue;
      const page = SHOP.parseShopPage(r.text, url);
      const row = page.rows[0];
      const d = tsToDate(ts);
      if (!row || row.inStock !== true || typeof row.price !== 'number' || !(row.price > 0) || !isFinite(row.price)) continue;
      if (d >= today || d < cutoff) continue;
      if (out.points.some((x) => x.d === d)) continue;
      out.points.push({ d, p: row.price, s: row.store, src: 'backfill' });
    } catch (e) {
      if (e instanceof Stop) { out.status = 'stopped'; break; }
      // a page without a price, in another currency, a timeout or a network error on one capture: skip it
    }
  }
  out.points.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return out;
}

module.exports = { backfill, parseCdx, cdxUrl, captureUrl, fromMonth, spread, HOST, MAX_CAPTURES, PAUSE_MS, TIMEOUT_MS, BUDGET_MS };
