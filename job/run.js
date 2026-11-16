#!/usr/bin/env node
'use strict';
// Prisvagten price job. Runs on a schedule (GitHub Actions) with the Supabase service-role key.
//   node job/run.js
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, RESEND_API_KEY (optional), MAIL_FROM, SITE_URL

// Node's fetch ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 (Node 22.21+); only matters behind a proxy (local runs).
if (require.main === module && !process.env.NODE_USE_ENV_PROXY && (process.env.HTTPS_PROXY || process.env.https_proxy)) {
  const cp = require('child_process').spawnSync(process.execPath, ['--no-warnings'].concat(process.argv.slice(1)), { stdio: 'inherit', env: Object.assign({}, process.env, { NODE_USE_ENV_PROXY: '1' }) });
  process.exit(cp.status === null ? 1 : cp.status);
}

const P = require('./lib/pricing');
const PJ = require('./lib/prisjagt');
const SHOP = require('./lib/shop');
const WB = require('./lib/wayback');
const ONSKE = require('./lib/onskeskyen');
const D = require('./lib/digest');
const { composeMail, composeOwnerMail, composeApprovedMail, sendResend } = require('./lib/mail');
const { makeClient } = require('./lib/supabase');

const PAUSE_MS = 1500;
const MAX_MAILS = 20;
const ERROR_RETRY_MS = 6 * 3600 * 1000;
const DEADLINE_MS = 8.5 * 60 * 1000;      // the workflow times out at 10 minutes
const MAX_BACKFILL = 2;                   // products whose older prices are fetched from the Internet Archive per run
const BACKFILL_RETRY_MS = 6 * 3600 * 1000;
const IMPORT_BUDGET_MS = 2 * 60 * 1000;   // wish-list imports (Ønskeskyen) get at most this much of the run; the rest waits
const BACKFILL_MAX_TRIES = 2;             // a 429 / 5xx from the archive allows one later retry, then it is given up

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const isoNow = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');

// ---------------------------------------------------------------- per-product logic (pure given a parsed page)

function shopErrorNote(e) {
  if (e.kind === 'blocked') return 'Butikken afviser automatiske opslag.';
  if (e.kind === 'noprice') return 'Kunne ikke finde en pris på siden.';
  if (e.kind === 'currency') return 'Prisen på siden er ikke i kroner (' + e.message.slice(0, 40) + '), så den kan ikke følges.';
  if (e.kind === 'notfound') return 'Siden findes ikke (' + e.message + '). Tjek linket.';
  if (e.kind === 'timeout') return 'Butikken svarede ikke i tide.';
  return 'Siden kunne ikke hentes (' + e.message.slice(0, 80) + ').';
}

function errorNote(e) {
  if (e instanceof PJ.PageError && e.shop) return shopErrorNote(e);
  if (e instanceof PJ.PageError) {
    if (e.kind === 'blocked') return 'Prisjagt afviste forespørgslen (' + e.message + '). Vi prøver ikke at omgå det.';
    if (e.kind === 'notfound') return 'Siden findes ikke på Prisjagt (' + e.message + '). Tjek linket.';
    if (e.kind === 'timeout') return 'Prisjagt svarede ikke i tide.';
    if (e.kind === 'layout') return 'Siden kunne ikke læses (' + e.message.slice(0, 80) + ').';
    return 'Siden kunne ikke hentes (' + e.message.slice(0, 80) + ').';
  }
  return 'Uventet fejl: ' + String(e && e.message || e).slice(0, 80);
}

function variantsOut(parsed) {
  return parsed.variants.map((v) => ({ id: v.id, label: v.label, lowest: v.lowest, offers: v.offers, sample: v.sample }));
}

// First fetch of a product: title, variants, page history. Returns {patch, track} where track says
// the product has exactly one variant and can go straight to tracking.
function initialPatch(prod, parsed, now) {
  const iso = isoNow(now), today = P.copenhagenDate(now);
  if (!parsed.rows.length) return { patch: { status: 'error', check_note: 'Ingen tilbud fundet på siden.', last_checked: iso }, track: false };
  const patch = {
    title: parsed.title || prod.title || null,
    variants: variantsOut(parsed),
    history: P.mergePageHistory(prod.history, parsed.history, today),
    status: 'choose', check_note: null, last_checked: iso,
  };
  if (parsed.variants.length === 1) { patch.tracked_variants = [parsed.variants[0].id]; return { patch, track: true }; }
  return { patch, track: false };
}

// Tracking run for one product. Returns {patch, hit}; hit = {low, newHit...} data for the e-mail.
function trackingPatch(prod, profile, parsed, now) {
  const iso = isoNow(now), today = P.copenhagenDate(now);
  const tracked = new Set(prod.tracked_variants || []);
  const variants = variantsOut(parsed);

  if (!parsed.variants.some((v) => tracked.has(v.id))) {
    return { patch: { status: 'choose', tracked_variants: null, variants, last_checked: iso, check_note: 'De valgte varianter findes ikke længere på siden. Vælg igen.' }, hit: null };
  }

  const rows = parsed.rows.filter((r) => tracked.has(r.variant));
  const deduped = P.onePerStore(rows);
  const bad = P.sanityCheck(deduped, Array.isArray(prod.offers) ? prod.offers : []);
  if (bad) return { patch: { check_note: 'Prisdata virker forkerte: ' + bad + '.', variants }, hit: null };

  const filtered = P.applyPrefs(deduped, P.mergePrefs(prod, profile));
  const low = P.lowestInStock(filtered);
  const offers = filtered.slice(0, P.MAX_OFFERS).map((o) => ({ store: o.store, price: o.price, url: o.url, inStock: o.inStock, note: o.note || null, variant: o.variant }));

  let history = Array.isArray(prod.history) ? prod.history : [];
  // Going from "choose" to "tracking": the page's own history is for the page as a whole. Keep it only when
  // the user follows every variant (or there is just one); otherwise it would mix in other variants' prices.
  if (prod.status !== 'tracking' && parsed.variants.length > 1 && !parsed.variants.every((v) => tracked.has(v.id))) {
    history = history.filter((x) => x && x.src !== 'page');
  }
  // The first tracking check after a switch to Prisjagt (compare_state 'done' with the old shop link kept in shop_url, and no check of
  // ours in the history yet) is silent: the cheapest of many shops being lower than the one shop followed before is no price drop.
  const firstAfterSwitch = prod.compare_state === 'done' && !!prod.shop_url && !history.some((x) => x && x.src === 'check');
  if (low) history = P.mergeHistory(history, today, low.price, low.store);

  const normal = P.normalPrice(history, today);
  const saleSignal = low ? (rows.some((r) => r.saleKnown) ? rows.some((r) => r.inStock && r.price === low.price && r.sale) : null) : null;
  const verdict = P.verdictFor(low ? low.price : null, normal, history, today, saleSignal);
  const warning = P.priceWarning(history, today, low ? low.price : undefined);
  // A bought product is still checked (the person can see what the price did after buying), but never notifies.
  const bought = !!prod.bought_at;
  let goal = bought ? { hit: false, newHit: false, fields: {}, reason: null } : P.goalOutcome(prod, low, normal, iso, { verdict, history });
  // Silent: a would-be hit is only remembered (notified_price), never announced. Only a later, lower price mails.
  if (firstAfterSwitch && !bought) goal = { hit: goal.hit, newHit: false, fields: goal.hit && low ? { notified_price: low.price } : { notified_price: null }, reason: null };

  const patch = Object.assign({
    status: 'tracking', title: prod.title || parsed.title || null, variants, offers, history, normal_price: normal, verdict, warning,
    check_note: filtered.length === 0 ? 'Ingen butikker matcher dine butiksvalg.' : (parsed.note || null), last_checked: iso,
  }, goal.fields);
  // One morning mail: a new hit of a person who wants it is collected (price and time) instead of mailed at once. A collected hit
  // that is no longer a hit, or a product that has been bought, is forgotten. Only where the database has the columns.
  if (Object.prototype.hasOwnProperty.call(prod, 'digest_price')) {
    if (goal.newHit && D.isDigestUser(profile)) { patch.digest_price = low.price; patch.digest_at = iso; }
    else if (prod.digest_price != null && (bought || goal.fields.notified_price === null)) { patch.digest_price = null; patch.digest_at = null; }
  }
  return {
    patch,
    hit: goal.newHit ? { productId: prod.id, userId: prod.user_id, name: prod.name, price: low.price, store: low.store, url: low.url, verdict: verdict.text, warning, reason: goal.reason } : null,
  };
}

// A single-shop product whose shop cannot be followed asks the AI agent to look for the product on Prisjagt (compare_state 'wanted'),
// once: only while compare_state is null (never again after 'done' or 'none', whatever the person or the agent decided). The errors that
// count: the shop refuses or blocks automated requests (401/403/429, a bot-challenge page: kind 'blocked'), the page has no price we can
// read ('noprice': no structured data, which is what a shop that hides its product data from us looks like, and Prisjagt may still list
// the product) or a price in another currency ('currency'). Not for a page that is gone (404/410: the product itself may be gone), a
// timeout or a network error (temporary), and never for a prisjagt.dk link. A row without the key at all means the column has not been
// added to the database yet: nothing is written then.
function wantsCompare(prod, target, error) {
  if (!target || !target.shop || !Object.prototype.hasOwnProperty.call(prod, 'compare_state') || prod.compare_state !== null) return false;
  return error instanceof PJ.PageError && !!error.shop && ['blocked', 'noprice', 'currency'].indexOf(error.kind) !== -1;
}

// The page kind of a source_url: {url, shop} or null when the link may not be fetched at all.
function classify(src) {
  let host;
  try { host = new URL(String(src || '').trim()).hostname; } catch (e) { return null; }
  if (SHOP.isPrisjagtHost(host)) { const u = PJ.validateProductUrl(src); return u ? { url: u, shop: false } : null; }
  const u = SHOP.validateShopUrl(src);
  return u ? { url: u, shop: true } : null;
}

// Older prices for a single-shop product, once. prod.backfill_state: null = not attempted; {at, result, found, tries}.
// 'done' = never again; 'retry' = the archive refused us (429 / 5xx / unreachable): one more try after BACKFILL_RETRY_MS.
// A row without the key at all means the column has not been added to the database yet: nothing is attempted.
function backfillDue(prod, now) {
  if (!Object.prototype.hasOwnProperty.call(prod, 'backfill_state')) return false;
  const st = prod.backfill_state;
  if (st === null || st === undefined) return true;
  if (!st || typeof st !== 'object' || st.result !== 'retry') return false;
  const at = Date.parse(st.at);
  return (st.tries || 0) < BACKFILL_MAX_TRIES && isFinite(at) && now.getTime() - at >= BACKFILL_RETRY_MS;
}

function backfillState(prev, res, iso) {
  const tries = ((prev && prev.tries) || 0) + 1;
  if (res.status === 'ok') return { at: iso, result: 'done', found: res.points.length, tries };
  return { at: iso, result: tries >= BACKFILL_MAX_TRIES ? 'done' : 'retry', found: res.points.length, tries };
}

// Merge archive points into the tracking patch of one product and recompute normal price, verdict and warning from the
// longer history. Notification safety: the goal outcome (and with it the e-mail) stays what it was BEFORE the archive
// points; if the longer history alone would now make a new hit, that hit is recorded silently (notified_price set, no
// e-mail), so old archive data never fires a message by itself. Returns the new {patch, hit}.
function applyBackfill(r, points, state, now) {
  const today = P.copenhagenDate(now);
  const merged = P.mergeBackfill(r.base.history, points, today);
  const again = trackingPatch(Object.assign({}, r.base, { history: merged }), r.profile, r.parsed, now);
  const patch = Object.assign({}, r.patch, again.patch, { backfill_state: state });
  let hit = r.hit;
  if (!r.hit && again.hit) {
    patch.notified_price = again.hit.price;                       // silent: remembered as already announced
    delete patch.notified_at;
  } else {
    ['notified_price', 'notified_at'].forEach((k) => { if (k in r.patch) patch[k] = r.patch[k]; else delete patch[k]; });
  }
  return { patch, hit };
}

// ---------------------------------------------------------------- access requests

// Pending requests not yet reported -> ONE e-mail to every admin. Approved requests not yet reported -> one e-mail each.
// Nothing is marked as notified unless the e-mail was accepted by Resend. Both count towards MAX_MAILS; the rest waits.
async function accessMails(ctx, sb, fetchImpl, stats, log, canMail, now) {
  const iso = isoNow(now);
  const mark = (email, col) => sb.patch('access_requests', 'email=eq.' + encodeURIComponent(email) + '&' + col + '=is.null', { [col]: iso });
  const note = () => { if (!stats.mailNote) stats.mailNote = ctx.resendKey ? 'MAIL_FROM mangler' : 'RESEND_API_KEY mangler'; };

  // 1. the owner(s)
  try {
    const pending = await sb.select('access_requests', 'select=email,name,created_at&status=eq.pending&owner_notified_at=is.null&order=created_at.asc&limit=50');
    if (pending.length) {
      if (!canMail) { note(); log('Adgangsanmodninger til ejer springes over: ' + stats.mailNote + '.'); }
      else if (stats.sent >= MAX_MAILS) { stats.mailNote = stats.mailNote || 'loft på ' + MAX_MAILS + ' e-mails nået'; }
      else {
        const admins = Array.from(new Set((await sb.select('allowed_emails', 'select=email&is_admin=eq.true'))
          .map((a) => String(a.email || '').trim().toLowerCase()).filter(Boolean)));
        if (!admins.length) log('Adgangsanmodninger: ingen administrator i allowed_emails, ingen e-mail.');
        else {
          await sendResend(fetchImpl, ctx.resendKey, ctx.mailFrom, admins, composeOwnerMail(pending, ctx.siteUrl));
          stats.sent++; stats.accessOwner++;
          for (const r of pending) { try { await mark(r.email, 'owner_notified_at'); } catch (e) { log('  Kunne ikke markere anmodning som meldt: ' + (e && e.message || e)); } }
        }
      }
    }
  } catch (e) { log('Adgangsanmodninger til ejer fejlede: ' + (e && e.message || e)); }

  // 2. approved requesters
  try {
    const approved = await sb.select('access_requests', 'select=email&status=eq.approved&requester_notified_at=is.null&order=decided_at.asc&limit=50');
    if (approved.length) {
      if (!canMail) { note(); log('Godkendelsesmails springes over: ' + stats.mailNote + '.'); }
      else {
        const allowed = new Set((await sb.select('allowed_emails', 'select=email')).map((a) => String(a.email || '').toLowerCase()));
        for (const r of approved) {
          const addr = String(r.email || '').trim().toLowerCase();
          if (!addr || !allowed.has(addr)) continue;                       // approved, but access was removed again: say nothing
          if (stats.sent >= MAX_MAILS) { stats.mailNote = stats.mailNote || 'loft på ' + MAX_MAILS + ' e-mails nået'; break; }
          try {
            await sendResend(fetchImpl, ctx.resendKey, ctx.mailFrom, addr, composeApprovedMail(ctx.siteUrl));
            stats.sent++; stats.accessApproved++;
            await mark(addr, 'requester_notified_at');
          } catch (e) { log('  En godkendelsesmail fejlede: ' + (e && e.message || e)); }
        }
      }
    }
  } catch (e) { log('Godkendelsesmails fejlede: ' + (e && e.message || e)); }
}

// ---------------------------------------------------------------- the run

async function run(ctx) {
  const log = ctx.log || console.log;
  const now = ctx.now ? ctx.now() : new Date();
  const sleep = ctx.sleep || sleepReal;
  // prisjagt.dk pages list many shops; every other host is a single web shop (generic structured-data parser)
  const getPage = ctx.getPage || ((u) => (SHOP.isPrisjagtHost(new URL(u).hostname) ? PJ.fetchPage(u, ctx.fetch) : SHOP.fetchShopPage(u, ctx.fetch)));
  const fetchImpl = ctx.fetch || fetch;
  const sb = makeClient(ctx.supabaseUrl, ctx.serviceKey, fetchImpl);
  const started = Date.now();
  const stats = { total: 0, pending: 0, tracking: 0, choose: 0, error: 0, pages: 0, pageFail: 0, blocked: false, blockedHosts: [], hits: 0, sent: 0, mailSkipped: 0, mailNote: '', accessOwner: 0, accessApproved: 0, written: 0, writeFail: 0, deadline: false, digests: 0, backfilled: 0, backfillPoints: 0, waybackStopped: false, imports: null };

  // 0. wish-list imports (Ønskeskyen): before the price checks, so that the new products get their first price in this run.
  // Own step: it never fails the run, and it is skipped quietly when the imports table does not exist yet.
  try {
    stats.imports = await ONSKE.runImports({ sb, fetch: ctx.onskeFetch || fetchImpl, sleep: ctx.onskeSleep || sleep, pauseMs: ctx.onskePauseMs, log, now: ctx.now || (() => now), deadlineAt: started + IMPORT_BUDGET_MS });
    if (stats.imports.pending) log('Ønskelister: ' + stats.imports.pending + ' behandlet, ' + stats.imports.done + ' færdige, ' + stats.imports.error + ' fejlede, ' + stats.imports.added + ' varer tilføjet.');
    if (stats.imports.synced) log('Ønskelister fulgt: ' + stats.imports.synced + ' læst igen, ' + stats.imports.syncAdded + ' nye varer, ' + stats.imports.syncFailed + ' kunne ikke læses.');
  } catch (e) { log('Ønskelister: ' + (e && e.message || e)); }

  // 1. load (a failure here means Supabase is unreachable: let it throw)
  // Products added by name only (source_url null) wait for a link (from the name-lookup assistant or the user):
  // the query leaves them out, and the filter below keeps them out even if the query is changed. Never fetched,
  // never counted, never retried (also not by the 6-hour error retry).
  const products = (await sb.select('products', 'select=*&active=eq.true&source_url=not.is.null&order=last_checked.asc.nullsfirst&limit=1000'))
    .filter((p) => p.source_url);
  const ownerIds = Array.from(new Set(products.map((p) => p.user_id)));
  const profiles = {};
  for (let i = 0; i < ownerIds.length; i += 50) {
    const rows = await sb.select('profiles', 'select=*&user_id=in.(' + ownerIds.slice(i, i + 50).join(',') + ')');
    rows.forEach((r) => { profiles[r.user_id] = r; });
  }

  // 2/3. fetch and compute
  const results = [];       // {prod, patch, hit}
  const pageCache = new Map();
  let lastFetchAt = 0;
  stats.total = products.length;
  for (const prod of products) {
    const st = prod.status || 'pending';
    stats[st] = (stats[st] || 0) + 1;
    let todo = null;
    if (st === 'pending') todo = 'initial';
    else if (st === 'error') todo = prod.last_checked && now.getTime() - Date.parse(prod.last_checked) < ERROR_RETRY_MS ? null : 'initial';
    else if (st === 'tracking') todo = Array.isArray(prod.tracked_variants) && prod.tracked_variants.length ? 'track' : 'initial';
    else if (st === 'choose') todo = Array.isArray(prod.tracked_variants) && prod.tracked_variants.length ? 'track' : null;
    if (!todo) continue;

    const target = classify(prod.source_url);
    if (!target) {
      let host = ''; try { host = new URL(String(prod.source_url).trim()).hostname; } catch (e) { /* not a url */ }
      const note = SHOP.isPrisjagtHost(host) ? 'Linket er ikke et gyldigt produktlink fra prisjagt.dk.' : 'Linket kan ikke bruges. Brug en https-adresse til en produktside hos en butik eller på prisjagt.dk.';
      results.push({ prod, patch: { status: 'error', check_note: note, last_checked: isoNow(now) }, hit: null }); continue;
    }
    const url = target.url, hostKey = SHOP.registrableDomain(new URL(url).hostname);
    if (stats.blockedHosts.indexOf(hostKey) !== -1) {                // refused earlier in this run: leave the rest of that host alone
      if (wantsCompare(prod, target, Object.assign(new PJ.PageError('blocked', 'afvist tidligere i kørslen'), { shop: true }))) results.push({ prod, patch: { compare_state: 'wanted', compare_at: isoNow(now) }, hit: null });
      continue;
    }
    if (Date.now() - started > DEADLINE_MS) { stats.deadline = true; continue; }

    try {
      let pr = pageCache.get(url);
      if (!pr) {
        const wait = lastFetchAt ? PAUSE_MS - (Date.now() - lastFetchAt) : 0;
        if (wait > 0) await sleep(wait);
        lastFetchAt = Date.now();
        stats.pages++;
        pr = getPage(url).then((page) => ({ page }), (error) => ({ error }));
        pageCache.set(url, pr);
      }
      const got = await pr;
      if (got.error) {
        stats.pageFail++;
        if (got.error instanceof PJ.PageError && got.error.kind === 'blocked') { stats.blocked = true; if (stats.blockedHosts.indexOf(hostKey) === -1) stats.blockedHosts.push(hostKey); }
        const note = errorNote(got.error);
        log('  ' + (prod.name || prod.id) + ': ' + note);
        const want = wantsCompare(prod, target, got.error) ? { compare_state: 'wanted', compare_at: isoNow(now) } : {};
        if (todo === 'initial') results.push({ prod, patch: Object.assign({ status: 'error', check_note: note, last_checked: isoNow(now) }, want), hit: null });
        else results.push({ prod, patch: Object.assign({ check_note: note }, want), hit: null });
        continue;
      }
      const parsed = got.page;
      const profile = profiles[prod.user_id] || null;
      if (todo === 'initial') {
        const ip = initialPatch(prod, parsed, now);
        if (ip.track) {
          const next = Object.assign({}, prod, ip.patch);
          const tp = trackingPatch(next, profile, parsed, now);
          results.push({ prod, patch: Object.assign({}, ip.patch, tp.patch), hit: tp.hit, base: next, parsed, profile, shop: target.shop });
        } else results.push({ prod, patch: ip.patch, hit: null });
      } else {
        const tp = trackingPatch(prod, profile, parsed, now);
        results.push({ prod, patch: tp.patch, hit: tp.hit, base: prod, parsed, profile, shop: target.shop });
      }
    } catch (e) {
      stats.pageFail++;
      log('  ' + (prod.name || prod.id) + ': uventet fejl: ' + (e && e.stack || e));
    }
  }

  // 4. older prices from the Internet Archive: single-shop products in tracking whose attempt has not been made yet.
  // After the normal check (same run), at most MAX_BACKFILL products per run, only web.archive.org is contacted.
  const wbFetch = ctx.waybackFetch || fetchImpl;
  let backfilled = 0;
  for (const r of results) {
    if (backfilled >= MAX_BACKFILL || stats.waybackStopped) break;
    if (!r.shop || !r.base || r.patch.status !== 'tracking' || !backfillDue(r.prod, now)) continue;
    if (Date.now() - started > DEADLINE_MS - WB.BUDGET_MS - 10000) { stats.deadline = true; break; }
    backfilled++; stats.backfilled++;
    let res;
    try { res = await WB.backfill(classify(r.prod.source_url).url, { fetch: wbFetch, sleep: ctx.waybackSleep || sleep, today: P.copenhagenDate(now) }); }
    catch (e) { log('  Internet Archive: uventet fejl for ' + (r.prod.name || r.prod.id) + ': ' + (e && e.message || e)); stats.waybackStopped = true; continue; }
    if (res.status !== 'ok') stats.waybackStopped = true;       // 429 / 5xx / unreachable: leave the archive alone for the rest of this run
    stats.backfillPoints += res.points.length;
    log('  ' + (r.prod.name || r.prod.id) + ': ' + res.points.length + ' ældre priser fra Internet Archive' + (res.status === 'ok' ? '.' : ' (arkivet afbrød, prøver evt. igen senere).'));
    try {
      const out = applyBackfill(r, res.points, backfillState(r.prod.backfill_state, res, isoNow(now)), now);
      r.patch = out.patch; r.hit = out.hit;
    } catch (e) { log('  Internet Archive: kunne ikke bruge priserne for ' + (r.prod.name || r.prod.id) + ': ' + (e && e.message || e)); }
  }

  // 5. e-mail
  // A person with "one morning mail" switched on gets their hits collected (see trackingPatch) and mailed in one go, once a day, at the
  // first run from 07:00 Copenhagen time. Everybody else gets a mail per run with hits, as before.
  const hitsByUser = {};
  results.forEach((r) => { if (r.hit) (hitsByUser[r.hit.userId] = hitsByUser[r.hit.userId] || []).push(r); });
  stats.hits = results.filter((r) => r.hit).length;
  const revert = (rs) => rs.forEach((r) => { r.patch.notified_price = typeof r.prod.notified_price === 'number' ? r.prod.notified_price : null; delete r.patch.notified_at; });
  const canMail = !!ctx.resendKey && !!ctx.mailFrom;
  if (stats.hits && !canMail) { stats.mailNote = ctx.resendKey ? 'MAIL_FROM mangler' : 'RESEND_API_KEY mangler'; log('E-mail springes over: ' + stats.mailNote + '.'); }
  const resultOf = new Map(results.map((r) => [r.prod.id, r]));
  // products with a collected hit: from an earlier run, or collected just now
  const collected = (p) => { const r = resultOf.get(p.id); return typeof p.digest_price === 'number' || !!(r && typeof r.patch.digest_price === 'number'); };
  const withDigest = new Set(products.filter(collected).map((p) => p.user_id));
  // the product as it is after this run's check, and the collected hits of one person that are waiting
  const waiting = (userId, profile) => products.filter((p) => p.user_id === userId && collected(p)).map((prod) => {
    const r = resultOf.get(prod.id), state = Object.assign({}, prod, r ? r.patch : {}), low = D.pendingLow(state, profile && profile.digest_sent_at);
    return low ? { prod, r, hit: r && r.hit ? r.hit : D.hitFromState(state, low) } : null;
  }).filter(Boolean);
  // the address of a person who may be mailed, or null (and why in the log)
  const addressOf = async (userId) => {
    const u = await sb.authUser(userId);
    const addr = String(u && u.email || '').trim().toLowerCase();
    if (!addr) { stats.mailSkipped++; return null; }
    const allowed = await sb.select('allowed_emails', 'select=email&email=eq.' + encodeURIComponent(addr));
    if (!allowed.length) { log('  Bruger ' + userId + ' står ikke i allowed_emails: ingen e-mail.'); stats.mailSkipped++; return null; }
    return addr;
  };

  // the morning mail. Claim-then-send: the day is claimed in profiles.digest_sent_at (only if nobody else changed it meanwhile)
  // BEFORE the mail goes out, so a crash or a parallel run can never send a second one for the same day. A failed send gives the
  // claim back, so the next run tries again. The hits found in this run are saved first, so they cannot turn up as "new" again.
  const sendDigest = async (userId, profile) => {
    const sentAt = profile.digest_sent_at || null;
    const items = waiting(userId, profile);
    if (!items.length || !D.digestWindow(now, sentAt)) return;
    if (!canMail) { stats.mailSkipped++; stats.mailNote = ctx.resendKey ? 'MAIL_FROM mangler' : 'RESEND_API_KEY mangler'; return; }
    if (stats.sent >= MAX_MAILS) { stats.mailSkipped++; stats.mailNote = 'loft på ' + MAX_MAILS + ' e-mails nået'; return; }
    const addr = await addressOf(userId);
    if (!addr) return;
    const send = [];
    for (const it of items) {
      if (it.r && it.r.hit && !it.r.written) {
        try { await sb.patch('products', 'id=eq.' + encodeURIComponent(it.prod.id), it.r.patch); it.r.written = true; stats.written++; }
        catch (e) { it.r.skipWrite = true; stats.writeFail++; log('  Kunne ikke skrive ' + (it.prod.name || it.prod.id) + ': ' + (e && e.message || e)); continue; }   // found again, as new, in the next run
      }
      send.push(it);
    }
    if (!send.length) return;
    const claim = isoNow(now);
    const rows = await sb.patch('profiles', 'user_id=eq.' + encodeURIComponent(userId) + '&digest_sent_at=' + (sentAt ? 'eq.' + encodeURIComponent(sentAt) : 'is.null'), { digest_sent_at: claim }, true);
    if (!Array.isArray(rows) || !rows.length) { log('  Morgenmail til bruger ' + userId + ' er allerede taget af en anden kørsel.'); return; }
    try {
      const mail = composeMail(send.map((it) => it.hit), ctx.siteUrl);
      mail.subject = D.digestSubject(send.length);
      await sendResend(fetchImpl, ctx.resendKey, ctx.mailFrom, addr, mail);
      stats.sent++; stats.digests++;
    } catch (e) {
      log('  Morgenmail til bruger ' + userId + ' fejlede: ' + (e && e.message || e));
      stats.mailSkipped++;
      try { await sb.patch('profiles', 'user_id=eq.' + encodeURIComponent(userId) + '&digest_sent_at=eq.' + encodeURIComponent(claim), { digest_sent_at: sentAt }); }
      catch (e2) { log('  Kunne ikke give dagens morgenmail tilbage: ' + (e2 && e2.message || e2)); }
    }
  };

  for (const userId of Array.from(new Set(Object.keys(hitsByUser).concat(Array.from(withDigest))))) {
    const rs = hitsByUser[userId] || [];
    const profile = profiles[userId];
    try {
      if (profile && profile.notify_email === false) { if (rs.length) stats.mailSkipped++; continue; }       // opted out: hit is recorded, no mail
      if (D.isDigestUser(profile)) { await sendDigest(userId, profile); continue; }
      // everybody else: a mail per run. Hits still waiting from a time the morning mail was switched on go along (switched off again).
      const flush = withDigest.has(userId) ? waiting(userId, profile).filter((it) => !rs.some((r) => r === it.r)) : [];
      if (!rs.length && !flush.length) continue;
      if (!canMail) { revert(rs); stats.mailSkipped++; continue; }                            // retry once mail is configured
      if (stats.sent >= MAX_MAILS) { revert(rs); stats.mailSkipped++; stats.mailNote = 'loft på ' + MAX_MAILS + ' e-mails nået'; continue; }
      const addr = await addressOf(userId);
      if (!addr) continue;
      await sendResend(fetchImpl, ctx.resendKey, ctx.mailFrom, addr, composeMail(rs.map((r) => r.hit).concat(flush.map((it) => it.hit)), ctx.siteUrl));
      stats.sent++;
      flush.forEach((it) => {                                                                    // sent now: no longer waiting
        if (it.r) Object.assign(it.r.patch, { digest_price: null, digest_at: null });
        else { const nr = { prod: it.prod, patch: { digest_price: null, digest_at: null }, hit: null }; results.push(nr); resultOf.set(it.prod.id, nr); }
      });
    } catch (e) {
      log('  E-mail til bruger ' + userId + ' fejlede: ' + (e && e.message || e));
      if (!D.isDigestUser(profile)) revert(rs);                // a collected hit stays collected; a hit for a normal mail is found again next run
      stats.mailSkipped++;
    }
  }

  // write (one product failing does not stop the others)
  for (const r of results) {
    if (r.written || r.skipWrite) continue;
    try { await sb.patch('products', 'id=eq.' + encodeURIComponent(r.prod.id), r.patch); stats.written++; }
    catch (e) { stats.writeFail++; log('  Kunne ikke skrive ' + (r.prod.name || r.prod.id) + ': ' + (e && e.message || e)); }
  }

  // access requests: e-mails to the owner(s) and to approved requesters (own step: a failure here changes nothing above)
  try { await accessMails(ctx, sb, fetchImpl, stats, log, canMail, now); }
  catch (e) { log('Adgangsanmodninger: ' + (e && e.message || e)); }

  // 6. summary (5 lines)
  const summary = [
    'Produkter: ' + stats.total + ' aktive (nye: ' + stats.pending + ', følges: ' + stats.tracking + ', venter på valg: ' + stats.choose + ', fejl: ' + stats.error + ').',
    'Sider hentet: ' + stats.pages + ', fejlede: ' + stats.pageFail + (stats.blockedHosts.length ? ' (afvist af ' + stats.blockedHosts.join(', ') + ': resten derfra sprunget over)' : '') + (stats.deadline ? ' (tidsgrænse nået)' : '') + '.',
    'Nye hits: ' + stats.hits + '.' + (stats.backfilled ? ' Ældre priser fra Internet Archive: ' + stats.backfillPoints + ' for ' + stats.backfilled + ' produkt(er).' : ''),
    'E-mails sendt: ' + stats.sent + (stats.digests ? ' (heraf morgenmails: ' + stats.digests + ')' : '') + ', sprunget over: ' + stats.mailSkipped + (stats.mailNote ? ' (' + stats.mailNote + ')' : '') + ' Adgang: ' + stats.accessOwner + ' til ejer, ' + stats.accessApproved + ' godkendte.',
    'Skrevet til databasen: ' + stats.written + ', skrivefejl: ' + stats.writeFail + '. Tid: ' + ((Date.now() - started) / 1000).toFixed(1) + ' s.',
  ];
  summary.forEach((l) => log(l));
  return { stats, summary, results };
}

module.exports = { run, initialPatch, trackingPatch, errorNote, classify, backfillDue, wantsCompare, MAX_BACKFILL };

if (require.main === module) {
  const e = process.env;
  if (!e.SUPABASE_URL || !e.SUPABASE_SERVICE_KEY) { console.error('SUPABASE_URL og SUPABASE_SERVICE_KEY skal være sat.'); process.exit(1); }
  run({ supabaseUrl: e.SUPABASE_URL, serviceKey: e.SUPABASE_SERVICE_KEY, resendKey: e.RESEND_API_KEY, mailFrom: e.MAIL_FROM, siteUrl: e.SITE_URL })
    .then(() => process.exit(0))
    .catch((err) => { console.error('CRASH', err && err.stack || err); process.exit(1); });
}
