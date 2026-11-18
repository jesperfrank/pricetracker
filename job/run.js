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
const X = require('./lib/extras');
const WB = require('./lib/wayback');
const ONSKE = require('./lib/onskeskyen');
const D = require('./lib/digest');
const { composeMail, composeOverview, composeOwnerMail, composeApprovedMail, sendResend } = require('./lib/mail');
const { makeClient } = require('./lib/supabase');

const PAUSE_MS = 1500;
const MAX_MAILS = 20;
const ERROR_RETRY_MS = 6 * 3600 * 1000;
const COMPARE_RETRY_MS = 24 * 3600 * 1000;   // a 'none' is asked again after this long (only while the product is in error) ...
const COMPARE_MAX_TRIES = 3;                 // ... and at most this many times in all
const DEADLINE_MS = 8.5 * 60 * 1000;      // the workflow times out at 10 minutes
const MAX_BACKFILL = 2;                   // products whose older prices are fetched from the Internet Archive per run
const BACKFILL_RETRY_MS = 6 * 3600 * 1000;
const IMPORT_BUDGET_MS = 2 * 60 * 1000;   // wish-list imports (Ønskeskyen) get at most this much of the run; the rest waits
const BACKFILL_MAX_TRIES = 2;             // a 429 / 5xx from the archive allows one later retry, then it is given up

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));
const isoNow = (d) => d.toISOString().replace(/\.\d+Z$/, 'Z');

// ---------------------------------------------------------------- per-product logic (pure given a parsed page)

const NOTE_CURRENCY_PREFIX = 'Prisen på siden er ikke i kroner (';

function shopErrorNote(e) {
  if (e.kind === 'blocked') return 'Butikken afviser automatiske opslag.';
  if (e.kind === 'noprice') return 'Kunne ikke finde en pris på siden.';
  if (e.kind === 'currency') return NOTE_CURRENCY_PREFIX + e.message.slice(0, 40) + '), så den kan ikke følges.';
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

// The product picture's address from the page just read (no extra request): stored when the row has the column (an older database does not
// send it) and the address is new or changed. Only the address; the picture is never fetched or kept here.
function addImage(patch, prod, parsed) {
  if (!Object.prototype.hasOwnProperty.call(prod, 'image_url')) return;
  if (parsed && parsed.image && parsed.image !== prod.image_url) patch.image_url = parsed.image;
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
  addImage(patch, prod, parsed);
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
  const offers = filtered.slice(0, P.MAX_OFFERS).map((o) => {
    const out = { store: o.store, price: o.price, url: o.url, inStock: o.inStock, note: o.note || null, variant: o.variant };
    if (o.stale && isFinite(o.readAt)) {          // the shop could not be read this time: its last offer, with when it was read
      out.readAt = new Date(o.readAt).toISOString().replace(/\.\d+Z$/, 'Z');
      const m = X.staleNote(o.readAt, now, P.copenhagenDate);
      if (m) out.note = out.note ? out.note + ' · ' + m : m;
    }
    return out;
  });

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
  // Silent: a would-be hit is only remembered (notified_price, notified_at), never announced. Only a later, lower price mails.
  // The same when the cheapest offer comes from an extra shop (products.extra_urls) that has not been read before: a newly added shop being
  // cheaper than the one shop followed so far is no price drop (the rows carry extraNew, see runWithExtras). And for the first 24 hours after
  // the one-mail-per-deal rules shipped (products.notify_silent_until, set once by the schema): a hit that used to flicker and be mailed
  // again and again must not mail once more only because its notified state was cleared under the old rules.
  const quiet = prod.notify_silent_until ? Date.parse(prod.notify_silent_until) > now.getTime() : false;
  const silent = firstAfterSwitch || !!(low && low.extraNew) || quiet;
  if (silent && !bought && goal.newHit) goal = { hit: goal.hit, newHit: false, fields: goal.fields, reason: null };

  const patch = Object.assign({
    status: 'tracking', title: prod.title || parsed.title || null, variants, offers, history, normal_price: normal, verdict, warning,
    check_note: filtered.length === 0 ? 'Ingen butikker matcher dine butiksvalg.' : (parsed.note || null), last_checked: iso,
  }, goal.fields);
  addImage(patch, prod, parsed);
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

// The failure kind is not stored on the row, only the Danish check_note that shopErrorNote wrote. An error row from before the compare
// feature existed is recognised by that note, built from the same function so it cannot drift: the same kinds as wantsCompare
// (blocked, noprice, currency), never notfound / timeout / network. Used to mark such rows without fetching the page again.
function noteWantsCompare(note) {
  if (typeof note !== 'string' || !note) return false;
  const mk = (kind) => Object.assign(new PJ.PageError(kind, ''), { shop: true });
  return note === shopErrorNote(mk('blocked')) || note === shopErrorNote(mk('noprice')) || note.indexOf(NOTE_CURRENCY_PREFIX) === 0;
}
function oldErrorWantsCompare(prod, target) {
  if (!target || !target.shop || prod.status !== 'error' || !Object.prototype.hasOwnProperty.call(prod, 'compare_state') || prod.compare_state !== null) return false;
  return noteWantsCompare(prod.check_note);
}

// The AI agent may have answered 'none' too hastily (a shop that refuses automated requests looks the same as a product that is not
// on Prisjagt). A single-shop product that is still in error for one of those reasons, 'none' for over 24 hours, is marked 'wanted'
// again by the job, at most COMPARE_MAX_TRIES times in all (compare_tries, the first marking counts as 1; people's own requests do not
// count). `error` is the failure just seen, or null to go by the stored note. A database without the compare_tries column (the row has
// no such key) never does it, as the count could not be kept.
function wantsCompareAgain(prod, target, error, now) {
  if (!target || !target.shop || prod.status !== 'error' || prod.compare_state !== 'none') return false;
  if (!Object.prototype.hasOwnProperty.call(prod, 'compare_tries') || !(Number(prod.compare_tries) < COMPARE_MAX_TRIES)) return false;
  const at = prod.compare_at ? Date.parse(prod.compare_at) : NaN;
  if (isFinite(at) && now.getTime() - at < COMPARE_RETRY_MS) return false;
  if (error) return error instanceof PJ.PageError && !!error.shop && ['blocked', 'noprice', 'currency'].indexOf(error.kind) !== -1;
  return noteWantsCompare(prod.check_note);
}

// The patch that asks the AI agent (compare_state 'wanted', now); compare_tries is counted when the database has the column. `tries`
// (optional) is the value compare_tries is set to instead of counting up by one (the marking for extra shops on a Prisjagt product, rule 5).
function wantedPatch(prod, now, tries) {
  const patch = { compare_state: 'wanted', compare_at: isoNow(now) };
  if (Object.prototype.hasOwnProperty.call(prod, 'compare_tries')) patch.compare_tries = tries !== undefined ? tries : (Number(prod.compare_tries) || 0) + 1;
  return patch;
}

// AUTOMATIC COMPARE MARKINGS (the job marks a single-shop product 'wanted' so that the AI agent looks for it in other shops). All rules:
//  1. wantsCompare: compare_state null and the shop refused / has no readable price / not in kroner (at the fetch).
//  2. oldErrorWantsCompare / wantsCompareAgain: an error row (refusing shop) answered 'none' more than 24 hours ago, while tries < 3.
//  3. autoCompare 'first' (rule A): EVERY active single-shop product that is not bought, compare_state null, gets 'wanted', whatever its status.
//  4. autoCompare 'second' (rule B): compare_state 'none', no extra_urls, compare_tries < 2, compare_at at least 1 hour old: 'wanted' once more.
//  5. autoCompare 'prisjagt' (rule C): a product that is on Prisjagt already (an active, not bought, tracking product with tracked variants and
//     no extra_urls yet) is asked ONCE to look for the shops Prisjagt does not list (the manufacturer's own web shop and so on, the answer is
//     extra_urls): compare_state null (never asked, a link the person added), or 'done' with shop_url (the agent switched it, before this rule
//     existed or after a change of requirements). It sets compare_tries to COMPARE_EXTRAS_TRIES (4), and it needs compare_tries below that, so
//     it can happen once per product and link, whatever the answer is (a 'done' stays 'done' for a switched product, the null answer).
// Rules 1 to 3 start from null, which only exists before the first marking, after an import without a marking, and after a browser link
// change (the guard resets compare_tries to 0 then). Every marking made here goes through wantedPatch and adds 1 to compare_tries, and rules 2
// and 4 need compare_tries < 3 / < 2. So after the first marking (tries 1) a product can get at most two more: B at tries < 2 (1 -> 2, and
// 0 -> 1 -> 2 for rows from before compare_tries existed), then the 24-hour error rule at tries < 3 (2 -> 3). From 3 on nothing marks it
// again: the MAXIMUM is 3 automatic markings per product and link while it follows one shop (a row that went through rule 4 twice from tries 0
// still ends at 3). Rule 5 comes on top, once, after the product is on Prisjagt (the agent switched it, or the person gave a Prisjagt link):
// so the MAXIMUM IN ALL is 4 automatic markings per product and link (3 as a single-shop product, then 1 for extra shops; a Prisjagt
// product the person added itself gets 1). Plus the one an import writes at insert (not counted) and the person's own "Find flere
// butikker" (never counted, one click each). A browser link change starts a new count, and so does a change of requirements on a product
// the agent switched (the guard sets compare_tries to 0): each such start gets the same limits again. A database without compare_tries /
// compare_state / extra_urls never gets any of them.
// To protect the agent's queue (10 rows per hourly run) rules 3, 4 and 5 together mark at most AUTO_COMPARE_MAX products per run, in the
// order 4, 3, 5 (single-shop products go before Prisjagt products); markings of rules 1 and 2 count against that budget but are never
// held back by it.
const AUTO_COMPARE_MAX = 10;
const COMPARE_EXTRAS_TRIES = 4;
const COMPARE_SECOND_AFTER_MS = 3600 * 1000;
const COMPARE_SECOND_TRIES = 2;

// Rule 5: a product on Prisjagt that should be looked for in the shops Prisjagt does not list.
function prisjagtExtrasDue(prod) {
  const has = (k) => Object.prototype.hasOwnProperty.call(prod, k);
  if (!has('extra_urls') || !has('compare_tries') || prod.status !== 'tracking') return false;
  if (prod.extra_urls !== null && prod.extra_urls !== undefined) return false;                      // shops are there already (the agent's or the person's)
  if (!Array.isArray(prod.tracked_variants) || !prod.tracked_variants.length) return false;
  if (!(Number(prod.compare_tries) < COMPARE_EXTRAS_TRIES)) return false;                          // asked before
  return prod.compare_state === null || (prod.compare_state === 'done' && !!prod.shop_url);
}

// 'first' | 'second' | 'prisjagt' | null: which automatic marking (rules 3, 4 and 5) applies to this product now.
function autoCompare(prod, target, now) {
  if (!target || prod.bought_at || prod.active === false) return null;
  if (!Object.prototype.hasOwnProperty.call(prod, 'compare_state')) return null;
  // A product the agent switched to Prisjagt earlier (shop_url keeps the original shop link) whose requirements the person changed has
  // compare_state null again (products_guard): the agent looks once more. A Prisjagt link the person added themself (no shop_url) never.
  if (!target.shop) {
    if (prod.compare_state === null && !!prod.shop_url) return 'first';
    return prisjagtExtrasDue(prod) ? 'prisjagt' : null;
  }
  if (prod.compare_state === null) return 'first';
  if (prod.compare_state !== 'none') return null;
  if (!Object.prototype.hasOwnProperty.call(prod, 'compare_tries') || !(Number(prod.compare_tries) < COMPARE_SECOND_TRIES)) return null;
  if (prod.extra_urls !== undefined && prod.extra_urls !== null) return null;
  const at = prod.compare_at ? Date.parse(prod.compare_at) : NaN;
  if (isFinite(at) && now.getTime() - at < COMPARE_SECOND_AFTER_MS) return null;
  return 'second';
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
    patch.notified_at = again.patch.notified_at;
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
        if (admins.length) {   // no administrator: step 3 logs that, once per run
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

  // 3. counts for the run summary (never addresses). A read error leaves them null: the summary then leaves them out.
  try {
    stats.accessPending = (await sb.select('access_requests', 'select=email&status=eq.pending&limit=1000')).length;
    stats.accessAdmins = (await sb.select('allowed_emails', 'select=email&is_admin=eq.true&limit=1000')).length;
    if (stats.accessAdmins === 0) log('Ingen administrator i allowed_emails.');
  } catch (e) { /* quiet, as above */ }
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
  const stats = { total: 0, pending: 0, tracking: 0, choose: 0, error: 0, pages: 0, pageFail: 0, blocked: false, blockedHosts: [], hits: 0, sent: 0, mailSkipped: 0, mailNote: '', accessOwner: 0, accessApproved: 0, accessPending: null, accessAdmins: null, written: 0, writeFail: 0, deadline: false, extraPages: 0, extraFail: 0, extraDropped: 0, digests: 0, backfilled: 0, backfillPoints: 0, waybackStopped: false, imports: null };

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

  // what a product needs this run: 'initial' (first fetch), 'track', or null. An error row waits out the 6-hour retry, except that an
  // answer with extra shops that came after the last check (compare_at newer than last_checked) is tried at once.
  const todoOf = (prod) => {
    const st = prod.status || 'pending';
    if (st === 'pending') return 'initial';
    if (st === 'error') {
      const last = prod.last_checked ? Date.parse(prod.last_checked) : NaN;
      if (isFinite(last) && now.getTime() - last < ERROR_RETRY_MS) {
        const t = X.links(prod).length ? classify(prod.source_url) : null;
        return t && t.shop && prod.compare_state === 'done' && Date.parse(prod.compare_at) > last ? 'initial' : null;
      }
      return 'initial';
    }
    if (st === 'tracking') return Array.isArray(prod.tracked_variants) && prod.tracked_variants.length ? 'track' : 'initial';
    if (st === 'choose') return Array.isArray(prod.tracked_variants) && prod.tracked_variants.length ? 'track' : null;
    return null;
  };

  // Extra shops: at most X.MAX_FETCHES extra pages per run over all products, the link that has gone longest without an attempt first
  // (extra_state.at), so every product gets its turn. A link that has failed 10 times in a row is left out unless a day has passed.
  const extraOK = new Set();
  {
    const cands = [];
    products.forEach((prod) => {
      const ls = X.links(prod), td = todoOf(prod);
      if (!ls.length || !td) return;
      const t = classify(prod.source_url);
      if (!t || (!t.shop && td !== 'track')) return;       // a Prisjagt product gets its extras in the tracking check only
      ls.forEach((u) => {
        const stt = X.stateOf(prod)[u] || {};
        if (X.slow(stt, now)) return;
        const at = Date.parse(stt.at);
        cands.push({ key: prod.id + '|' + u, at: isFinite(at) ? at : 0, n: cands.length });
      });
    });
    X.pick(cands).forEach((k) => extraOK.add(k));
  }

  // One page, once per run (a link several products share is read once), with the pause between two requests.
  const fetchCached = async (url) => {
    let pr = pageCache.get(url);
    if (!pr) {
      const wait = lastFetchAt ? PAUSE_MS - (Date.now() - lastFetchAt) : 0;
      if (wait > 0) await sleep(wait);
      lastFetchAt = Date.now();
      stats.pages++;
      pr = getPage(url).then((page) => ({ page }), (error) => ({ error }));
      pageCache.set(url, pr);
    }
    return pr;
  };
  const noteBlocked = (error, hostKey) => {
    if (error instanceof PJ.PageError && error.kind === 'blocked') { stats.blocked = true; if (stats.blockedHosts.indexOf(hostKey) === -1) stats.blockedHosts.push(hostKey); }
  };

  // The extra pages of one product, each read at most once per run: {fresh, carried, keep}. fresh = [{url, hostKey, stt, page, row}] (the row
  // carries extraNew: its price is new to us), carried = rows of shops that were not read this time and whose last offer (at most 24 hours
  // old, X.lastOffer) stands in for them. prev = the product's extra_state; next and offerOf are filled in (the new state of each link that
  // was tried or carried, see extra_state in extras.js); vid = the variant the rows are given. A shop that is not tried (over the per-run cap,
  // out of time) or was refused earlier in this run (per host) keeps what it had; a transient failure (refused, timeout, network, 5xx) keeps
  // its last offer, any other failure drops it.
  const readExtras = async (prod, ls, vid, prev, next, offerOf, iso) => {
    const fresh = [], carried = [];
    // The last known offer of a shop that was not read this run (see above). It counts like a fresh offer for up to 24 hours after it
    // was last READ (X.lastOffer); then it is gone. Marked stale with the time it was read; kept in extra_state[url].offer.
    const keep = (url) => {
      const o = X.lastOffer(prod, prev[url], url, now);
      if (!o) return null;
      offerOf[url] = { store: o.store, price: o.price, inStock: o.inStock, note: o.note, at: new Date(o.at).toISOString().replace(/\.\d+Z$/, 'Z') };
      return { key: url, variant: vid, store: o.store, price: o.price, url, inStock: o.inStock, stock: o.inStock ? 'InStock' : 'OutOfStock', note: o.note, name: o.store, saleKnown: false, sale: false, carried: true, stale: true, readAt: o.at };
    };
    const carry = (url) => {
      const row = keep(url);
      if (row) carried.push(row);
      if (prev[url]) next[url] = prev[url];
    };
    for (const url of ls) {
      const stt = prev[url] || {}, hostKey = SHOP.registrableDomain(new URL(url).hostname);
      if (!extraOK.has(prod.id + '|' + url)) { carry(url); continue; }
      if (stats.blockedHosts.indexOf(hostKey) !== -1) { carry(url); continue; }     // refused earlier in this run: left alone, its last offer stands
      if (Date.now() - started > DEADLINE_MS) { stats.deadline = true; carry(url); continue; }
      stats.extraPages++;
      const got = await fetchCached(url);
      const fail = (why, code) => { stats.extraFail++; log('  ' + (prod.name || prod.id) + ' (' + hostKey + '): ' + why); next[url] = { seen: !!stt.seen, fails: (Number(stt.fails) || 0) + 1, at: iso, why: code }; };
      if (got.error) {
        noteBlocked(got.error, hostKey); fail(errorNote(got.error), got.error.kind === 'noprice' ? 'noprice' : 'err');
        if (X.transient(got.error)) { const row = keep(url); if (row) { carried.push(row); delete next[url].why; } }
        continue;
      }
      const row = got.page && Array.isArray(got.page.rows) ? got.page.rows[0] : null;
      if (!row || typeof row.price !== 'number') { fail('ingen pris', 'noprice'); continue; }
      fresh.push({ url, hostKey, stt, page: got.page, row: Object.assign({}, row, { variant: vid, url, key: url, extraNew: X.isNew(prod, stt) }) });
    }
    return { fresh, carried, keep };
  };

  // A single-shop product with extra shops: the main page as always plus each extra page; the result is ONE tracking check in the same
  // shape as a Prisjagt product (the rows of all shops, one variant "shop"). The main shop failing is not an error while an extra shop
  // answers. Extra offers whose price is far from the other shops' are another product and are dropped. Pushes to results (or not at
  // all when the time is up, like the plain path).
  const runWithExtras = async (prod, todo, target, ls) => {
    const profile = profiles[prod.user_id] || null, iso = isoNow(now);
    const mainKey = SHOP.registrableDomain(new URL(target.url).hostname);
    const prev = X.stateOf(prod), next = {}, offerOf = {};
    let main = null, mainErr = null;
    if (stats.blockedHosts.indexOf(mainKey) !== -1) mainErr = Object.assign(new PJ.PageError('blocked', 'afvist tidligere i kørslen'), { shop: true });
    else {
      if (Date.now() - started > DEADLINE_MS) { stats.deadline = true; return; }
      const got = await fetchCached(target.url);
      if (got.error) { stats.pageFail++; noteBlocked(got.error, mainKey); mainErr = got.error; } else main = got.page;
    }
    const vid = main && main.variants && main.variants[0] ? main.variants[0].id : SHOP.SHOP_ID;
    const rd = await readExtras(prod, ls, vid, prev, next, offerOf, iso);
    const { fresh, carried, keep } = rd;
    // the main shop could not be read for a transient reason: its last offer stands in for it
    let mainStale = null;
    if (!main && X.transient(mainErr)) mainStale = keep(target.url);
    if (!main && mainStale) carried.push(mainStale);
    // another product: far from the median of the other shops' prices of this run (the main shop and the carried offers count as others)
    const all = (main ? main.rows : []).concat(carried, fresh.map((f) => f.row));
    const kept = fresh.filter((f) => {
      if (!X.isOutlier(f.row.price, all.filter((r) => r !== f.row).map((r) => r.price))) return true;
      stats.extraDropped++;
      log('  ' + (prod.name || prod.id) + ' (' + f.hostKey + '): prisen ' + f.row.price + ' kr. ligner en anden vare og bruges ikke.');
      next[f.url] = { seen: !!f.stt.seen, fails: (Number(f.stt.fails) || 0) + 1, at: iso, why: 'outlier' };
      return false;
    });
    // one offer per shop name: a second shop with the same name is called by its address instead
    const mainRows = main ? main.rows : (mainStale ? [mainStale] : []);
    const names = new Set(mainRows.map((r) => String(r.store || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')));
    const extraRows = [];
    kept.concat(carried.filter((c) => c !== mainStale).map((c) => ({ carriedRow: c, url: c.url, row: c }))).forEach((f) => {
      const row = f.row;
      let k = String(row.store || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (names.has(k)) { row.store = X.hostOf(f.url); k = row.store.replace(/[^\p{L}\p{N}]/gu, ''); }
      if (names.has(k)) { if (f.carriedRow) delete offerOf[f.url]; return; }
      names.add(k); extraRows.push(row);
    });
    const hasFresh = !!main || kept.length > 0;
    const extraPatch = (tp) => {     // the job's own bookkeeping, written along with the check
      if (!Object.prototype.hasOwnProperty.call(prod, 'extra_state')) return {};
      const recorded = !!tp && Object.prototype.hasOwnProperty.call(tp.patch, 'offers');
      kept.forEach((f) => {
        if (extraRows.indexOf(f.row) !== -1) {
          next[f.url] = { seen: !!f.stt.seen || recorded, fails: 0, at: iso };
          offerOf[f.url] = { store: f.row.store, price: f.row.price, inStock: f.row.inStock !== false, note: f.row.note || null, at: iso };
        } else next[f.url] = { seen: !!f.stt.seen, fails: (Number(f.stt.fails) || 0) + 1, at: iso, why: 'dup' };
      });
      const out = {};
      ls.forEach((u) => {
        if (!next[u]) return;
        const e = Object.assign({}, next[u]); delete e.offer;
        if (offerOf[u]) e.offer = offerOf[u];
        out[u] = e;
      });
      // the main shop has an entry only to remember its last offer (it is not an extra link)
      if (main && main.rows[0] && typeof main.rows[0].price === 'number') out[target.url] = { offer: { store: main.rows[0].store, price: main.rows[0].price, inStock: main.rows[0].inStock !== false, note: main.rows[0].note || null, at: iso } };
      else if (mainStale && offerOf[target.url]) out[target.url] = { offer: offerOf[target.url] };
      const val = Object.keys(out).length ? out : null;
      return JSON.stringify(val) === JSON.stringify(prod.extra_state === undefined ? null : prod.extra_state) ? {} : { extra_state: val };
    };
    if (!hasFresh && !carried.length) {      // nothing to go on: as a plain failure of the main page (the failing extras are counted in the state)
      const err = mainErr || new PJ.PageError('layout', 'ingen butikker kunne læses');
      const note = errorNote(err);
      log('  ' + (prod.name || prod.id) + ': ' + note);
      const want = wantsCompare(prod, target, err) || wantsCompareAgain(prod, target, err, now) ? wantedPatch(prod, now) : {};
      const ep = extraPatch(null);
      if (todo === 'initial') results.push({ prod, patch: Object.assign({ status: 'error', check_note: note, last_checked: iso }, want, ep), hit: null });
      else results.push({ prod, patch: Object.assign({ check_note: note }, want, ep), hit: null });
      return;
    }
    const rows = mainRows.concat(extraRows);
    const inStock = rows.filter((r) => r.inStock).map((r) => r.price);
    const first = kept[0] ? kept[0].page : null;
    const variant = main
      ? Object.assign({}, main.variants[0], { lowest: inStock.length ? Math.min.apply(null, inStock) : null, offers: rows.length })
      : { id: vid, label: rows[0].store, lowest: inStock.length ? Math.min.apply(null, inStock) : null, offers: rows.length, sample: first && first.variants && first.variants[0] ? first.variants[0].sample : null };
    const parsed = main ? Object.assign({}, main, { rows: mainRows.concat(extraRows), variants: [variant] })
      : { title: first ? first.title : null, rows, variants: [variant], history: [], note: null, shop: true, source: first ? first.source : null, image: null };
    // nothing at all was read this time (every shop is refused or down, the prices are the last known ones): the product is still checked
    // with them, but "last checked" does not move and the note says why
    const noteOnly = !hasFresh ? errorNote(mainErr || new PJ.PageError('network', 'ingen butikker kunne læses')) : null;
    const fin = (tp) => { if (noteOnly && tp.patch.status === 'tracking') { delete tp.patch.last_checked; tp.patch.check_note = noteOnly; } return tp; };
    if (todo === 'initial') {
      const ip = initialPatch(prod, parsed, now);
      if (ip.track) {
        const nb = Object.assign({}, prod, ip.patch);
        const tp = trackingPatch(nb, profile, parsed, now);
        results.push({ prod, patch: Object.assign({}, ip.patch, tp.patch, extraPatch(tp)), hit: tp.hit, base: nb, parsed, profile, shop: true });
      } else results.push({ prod, patch: Object.assign({}, ip.patch, extraPatch(null)), hit: null });
    } else {
      const tp = fin(trackingPatch(prod, profile, parsed, now));
      results.push({ prod, patch: Object.assign({}, tp.patch, extraPatch(tp)), hit: tp.hit, base: prod, parsed, profile, shop: true });
    }
  };
  // A product on prisjagt.dk with extra shops (the shops Prisjagt does not list): called by the tracking check right after the Prisjagt page
  // was read successfully (a failing Prisjagt page is handled as always and the extras are not even tried, so stale extras alone never change
  // the product). Returns {parsed, extraPatch} or null when there is nothing to add (no tracked variant on the page: trackingPatch sends the
  // product back to "choose" then). `parsed` = the Prisjagt page with the extra offers added as rows of the first tracked variant on the page
  // (the person or the agent is responsible for linking the page of the right colour); the Prisjagt variants and counts are left as they are.
  //  * dedupe: an extra shop the Prisjagt offers of the tracked variants cover already (X.covered) is dropped in favour of the Prisjagt row;
  //  * outlier: an extra price below 40 % or above 250 % of the median of the OTHER prices in this run (all Prisjagt offers of the tracked
  //    variants, carried offers and the other extras) is another product (accessory, other model) and is dropped;
  //  * the offers of a shop that could not be read stay for 24 hours (stale, "pris fra i går"), as for a single-shop product;
  //  * a cheapest price from an extra shop that was never read before is silent (extraNew, see trackingPatch).
  const withPrisjagtExtras = async (prod, parsed, ls) => {
    const iso = isoNow(now), prev = X.stateOf(prod), next = {}, offerOf = {};
    const tracked = new Set(prod.tracked_variants || []);
    const variant = parsed.variants.find((v) => tracked.has(v.id));
    const base = parsed.rows.filter((r) => tracked.has(r.variant));
    if (!variant || !base.length) return null;
    const { fresh, carried } = await readExtras(prod, ls, variant.id, prev, next, offerOf, iso);
    // 1. a shop that Prisjagt lists already: the Prisjagt row stays
    const drop = (f) => { next[f.url] = { seen: !!f.stt.seen, fails: 0, at: iso, why: 'dup' }; };
    const fresh1 = fresh.filter((f) => {
      if (!X.covered(base, { url: f.url, store: f.row.store })) return true;
      log('  ' + (prod.name || prod.id) + ' (' + f.hostKey + '): butikken er med på Prisjagt, Prisjagts pris bruges.');
      drop(f); return false;
    });
    const carried1 = carried.filter((c) => {
      if (!X.covered(base, { url: c.url, store: c.store })) return true;
      delete offerOf[c.url]; next[c.url] = Object.assign({}, prev[c.url], { why: 'dup' }); return false;
    });
    // 2. another product: far from the median of the other prices of this run
    const all = base.concat(carried1, fresh1.map((f) => f.row));
    const kept = fresh1.filter((f) => {
      if (!X.isOutlier(f.row.price, all.filter((r) => r !== f.row).map((r) => r.price))) return true;
      stats.extraDropped++;
      log('  ' + (prod.name || prod.id) + ' (' + f.hostKey + '): prisen ' + f.row.price + ' kr. ligner en anden vare og bruges ikke.');
      next[f.url] = { seen: !!f.stt.seen, fails: (Number(f.stt.fails) || 0) + 1, at: iso, why: 'outlier' };
      return false;
    });
    // 3. one offer per shop name among the extras (a second shop with the same name is called by its address)
    const names = new Set(base.map((r) => P.normShop(r.store)));
    const extraRows = [];
    kept.concat(carried1.map((c) => ({ carriedRow: c, url: c.url, row: c }))).forEach((f) => {
      const row = f.row;
      let k = P.normShop(row.store);
      if (names.has(k)) { row.store = X.hostOf(f.url); k = P.normShop(row.store); }
      if (names.has(k)) { if (f.carriedRow) delete offerOf[f.url]; return; }
      names.add(k); extraRows.push(row);
    });
    const extraPatch = (tp) => {     // the job's own bookkeeping, written along with the check
      if (!Object.prototype.hasOwnProperty.call(prod, 'extra_state')) return {};
      const recorded = !!tp && Object.prototype.hasOwnProperty.call(tp.patch, 'offers');
      kept.forEach((f) => {
        if (extraRows.indexOf(f.row) !== -1) {
          next[f.url] = { seen: !!f.stt.seen || recorded, fails: 0, at: iso };
          offerOf[f.url] = { store: f.row.store, price: f.row.price, inStock: f.row.inStock !== false, note: f.row.note || null, at: iso };
        } else next[f.url] = { seen: !!f.stt.seen, fails: (Number(f.stt.fails) || 0) + 1, at: iso, why: 'dup' };
      });
      const out = {};
      ls.forEach((u) => {
        if (!next[u]) return;
        const e = Object.assign({}, next[u]); delete e.offer;
        if (offerOf[u]) e.offer = offerOf[u];
        out[u] = e;
      });
      const val = Object.keys(out).length ? out : null;
      return JSON.stringify(val) === JSON.stringify(prod.extra_state === undefined ? null : prod.extra_state) ? {} : { extra_state: val };
    };
    return { parsed: Object.assign({}, parsed, { rows: parsed.rows.concat(extraRows) }), extraPatch };
  };
  for (const prod of products) {
    const st = prod.status || 'pending';
    stats[st] = (stats[st] || 0) + 1;
    const todo = todoOf(prod);
    if (!todo) {
      // an old error row still waiting out the 6-hour retry: mark it (no fetch) if its stored note says the shop refuses us
      if (st === 'error') {
        const t = classify(prod.source_url);
        if (oldErrorWantsCompare(prod, t) || wantsCompareAgain(prod, t, null, now)) results.push({ prod, patch: wantedPatch(prod, now), hit: null });
      }
      continue;
    }

    const target = classify(prod.source_url);
    if (!target) {
      let host = ''; try { host = new URL(String(prod.source_url).trim()).hostname; } catch (e) { /* not a url */ }
      const note = SHOP.isPrisjagtHost(host) ? 'Linket er ikke et gyldigt produktlink fra prisjagt.dk.' : 'Linket kan ikke bruges. Brug en https-adresse til en produktside hos en butik eller på prisjagt.dk.';
      results.push({ prod, patch: { status: 'error', check_note: note, last_checked: isoNow(now) }, hit: null }); continue;
    }
    const extraLinks = X.links(prod);
    if (target.shop && extraLinks.length) {
      try { await runWithExtras(prod, todo, target, extraLinks); }
      catch (e) { stats.pageFail++; log('  ' + (prod.name || prod.id) + ': uventet fejl: ' + (e && e.stack || e)); }
      continue;
    }
    const url = target.url, hostKey = SHOP.registrableDomain(new URL(url).hostname);
    if (stats.blockedHosts.indexOf(hostKey) !== -1) {                // refused earlier in this run: leave the rest of that host alone
      const blockedErr = Object.assign(new PJ.PageError('blocked', 'afvist tidligere i kørslen'), { shop: true });
      if (wantsCompare(prod, target, blockedErr) || wantsCompareAgain(prod, target, blockedErr, now)) results.push({ prod, patch: wantedPatch(prod, now), hit: null });
      continue;
    }
    if (Date.now() - started > DEADLINE_MS) { stats.deadline = true; continue; }

    try {
      const got = await fetchCached(url);
      if (got.error) {
        stats.pageFail++;
        noteBlocked(got.error, hostKey);
        const note = errorNote(got.error);
        log('  ' + (prod.name || prod.id) + ': ' + note);
        const want = wantsCompare(prod, target, got.error) || wantsCompareAgain(prod, target, got.error, now) ? wantedPatch(prod, now) : {};
        if (todo === 'initial') results.push({ prod, patch: Object.assign({ status: 'error', check_note: note, last_checked: isoNow(now) }, want), hit: null });
        else results.push({ prod, patch: Object.assign({ check_note: note }, want), hit: null });
        continue;
      }
      let parsed = got.page, xp = null;
      const profile = profiles[prod.user_id] || null;
      if (!target.shop && todo === 'track' && extraLinks.length) {
        xp = await withPrisjagtExtras(prod, parsed, extraLinks);
        if (xp) parsed = xp.parsed;
      }
      if (todo === 'initial') {
        const ip = initialPatch(prod, parsed, now);
        if (ip.track) {
          const next = Object.assign({}, prod, ip.patch);
          const tp = trackingPatch(next, profile, parsed, now);
          results.push({ prod, patch: Object.assign({}, ip.patch, tp.patch), hit: tp.hit, base: next, parsed, profile, shop: target.shop });
        } else results.push({ prod, patch: ip.patch, hit: null });
      } else {
        const tp = trackingPatch(prod, profile, parsed, now);
        results.push({ prod, patch: Object.assign({}, tp.patch, xp ? xp.extraPatch(tp) : {}), hit: tp.hit, base: prod, parsed, profile, shop: target.shop });
      }
    } catch (e) {
      stats.pageFail++;
      log('  ' + (prod.name || prod.id) + ': uventet fejl: ' + (e && e.stack || e));
    }
  }

  // 3b. automatic compare markings (rules 3, 4 and 5 above), at most AUTO_COMPARE_MAX new ones per run. A product that already got a marking in
  // this run (rules 1 and 2) is not marked twice; its marking counts against the budget. The second chances go first (a hasty 'none'
  // is more likely wrong than a never-asked product is a problem), then the never-asked, each in the order of the list (oldest check first).
  {
    const resultOf0 = new Map(results.map((r) => [r.prod.id, r]));
    let budget = AUTO_COMPARE_MAX;
    results.forEach((r) => { if (r.patch.compare_state === 'wanted') budget--; });
    const due = { second: [], first: [], prisjagt: [] };
    products.forEach((prod) => {
      const r = resultOf0.get(prod.id);
      if (r && r.patch.compare_state !== undefined) return;
      const kind = autoCompare(prod, classify(prod.source_url), now);
      if (kind) due[kind].push(prod);
    });
    due.second.concat(due.first, due.prisjagt).slice(0, Math.max(0, budget)).forEach((prod) => {
      const r = resultOf0.get(prod.id), patch = wantedPatch(prod, now, due.prisjagt.indexOf(prod) !== -1 ? COMPARE_EXTRAS_TRIES : undefined);
      if (r) Object.assign(r.patch, patch); else results.push({ prod, patch, hit: null });
      stats.autoCompare = (stats.autoCompare || 0) + 1;
    });
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
  // Two kinds, independent of each other:
  //  a) "Mail ved nyt tilbud" (profiles.notify_email, default on): a mail per run and person with the products that became a hit under the
  //     rules of goalOutcome (first hit, a further drop, or a hit again after 7 days; a changed goal or link starts over). Never held back.
  //  b) "Daglig oversigt om morgenen" (profiles.mail_digest, default off): once a day, at the first run from 07:00 Copenhagen time, what is
  //     on offer now and what moved at least 5 % since yesterday. Only for a person with a) switched on (the master switch).
  const hitsByUser = {};
  results.forEach((r) => { if (r.hit) (hitsByUser[r.hit.userId] = hitsByUser[r.hit.userId] || []).push(r); });
  stats.hits = results.filter((r) => r.hit).length;
  // a mail that could not go out: the hit is found again as new in the next run (the notified fields are not written)
  const revert = (rs) => rs.forEach((r) => { delete r.patch.notified_price; delete r.patch.notified_at; });
  const canMail = !!ctx.resendKey && !!ctx.mailFrom;
  if (stats.hits && !canMail) { stats.mailNote = ctx.resendKey ? 'MAIL_FROM mangler' : 'RESEND_API_KEY mangler'; log('E-mail springes over: ' + stats.mailNote + '.'); }
  const resultOf = new Map(results.map((r) => [r.prod.id, r]));
  // the address of a person who may be mailed, or null (and why in the log)
  const addressOf = async (userId) => {
    const u = await sb.authUser(userId);
    const addr = String(u && u.email || '').trim().toLowerCase();
    if (!addr) { stats.mailSkipped++; return null; }
    const allowed = await sb.select('allowed_emails', 'select=email&email=eq.' + encodeURIComponent(addr));
    if (!allowed.length) { log('  Bruger ' + userId + ' står ikke i allowed_emails: ingen e-mail.'); stats.mailSkipped++; return null; }
    return addr;
  };

  for (const userId of Object.keys(hitsByUser)) {
    const rs = hitsByUser[userId];
    const profile = profiles[userId];
    try {
      // Mail is opt-in: no profile row (the person never signed in and chose) or the switch off means no mail; the hit is still recorded
      if (!profile || profile.notify_email === false) { stats.mailSkipped++; continue; }
      if (!canMail) { revert(rs); stats.mailSkipped++; continue; }                            // retry once mail is configured
      if (stats.sent >= MAX_MAILS) { revert(rs); stats.mailSkipped++; stats.mailNote = 'loft på ' + MAX_MAILS + ' e-mails nået'; continue; }
      const addr = await addressOf(userId);
      if (!addr) continue;
      await sendResend(fetchImpl, ctx.resendKey, ctx.mailFrom, addr, composeMail(rs.map((r) => r.hit), ctx.siteUrl));
      stats.sent++;
    } catch (e) {
      log('  E-mail til bruger ' + userId + ' fejlede: ' + (e && e.message || e));
      revert(rs);
      stats.mailSkipped++;
    }
  }

  // the daily overview. Claim-then-send: the day is claimed in profiles.digest_sent_at (only if nobody else changed it meanwhile) BEFORE
  // the mail goes out, so a crash or a parallel run can never send a second one for the same day. A failed send gives the claim back, so
  // the next run tries again. A day with nothing to say is claimed too (nothing is sent), so the job does not look again every run.
  for (const userId of Object.keys(profiles)) {
    const profile = profiles[userId];
    try {
      if (!D.isDigestUser(profile)) continue;
      const sentAt = profile.digest_sent_at || null;
      if (!D.digestWindow(now, sentAt)) continue;
      const states = products.filter((p) => p.user_id === userId).map((p) => { const r = resultOf.get(p.id); return r ? Object.assign({}, p, r.patch) : p; });
      const ov = D.overview(states, now);
      const empty = !ov.hits.length && !ov.changes.length;
      let addr = null;
      if (!empty) {
        if (!canMail) { stats.mailSkipped++; stats.mailNote = ctx.resendKey ? 'MAIL_FROM mangler' : 'RESEND_API_KEY mangler'; continue; }
        if (stats.sent >= MAX_MAILS) { stats.mailSkipped++; stats.mailNote = 'loft på ' + MAX_MAILS + ' e-mails nået'; continue; }
        addr = await addressOf(userId);
        if (!addr) continue;
      }
      const claim = isoNow(now);
      const rows = await sb.patch('profiles', 'user_id=eq.' + encodeURIComponent(userId) + '&digest_sent_at=' + (sentAt ? 'eq.' + encodeURIComponent(sentAt) : 'is.null'), { digest_sent_at: claim }, true);
      if (!Array.isArray(rows) || !rows.length) { log('  Oversigten til bruger ' + userId + ' er allerede taget af en anden kørsel.'); continue; }
      if (empty) continue;
      try {
        await sendResend(fetchImpl, ctx.resendKey, ctx.mailFrom, addr, composeOverview(ov, ctx.siteUrl));
        stats.sent++; stats.digests++;
      } catch (e) {
        log('  Oversigten til bruger ' + userId + ' fejlede: ' + (e && e.message || e));
        stats.mailSkipped++;
        try { await sb.patch('profiles', 'user_id=eq.' + encodeURIComponent(userId) + '&digest_sent_at=eq.' + encodeURIComponent(claim), { digest_sent_at: sentAt }); }
        catch (e2) { log('  Kunne ikke give dagens oversigt tilbage: ' + (e2 && e2.message || e2)); }
      }
    } catch (e) {
      log('  Oversigten til bruger ' + userId + ' fejlede: ' + (e && e.message || e));
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
    'Sider hentet: ' + stats.pages + ', fejlede: ' + stats.pageFail + (stats.extraPages ? ' (ekstra butikker: ' + stats.extraPages + ', uden pris: ' + stats.extraFail + ', forkastet som anden vare: ' + stats.extraDropped + ')' : '') + (stats.blockedHosts.length ? ' (afvist af ' + stats.blockedHosts.join(', ') + ': resten derfra sprunget over)' : '') + (stats.deadline ? ' (tidsgrænse nået)' : '') + '.',
    'Nye hits: ' + stats.hits + '.' + (stats.backfilled ? ' Ældre priser fra Internet Archive: ' + stats.backfillPoints + ' for ' + stats.backfilled + ' produkt(er).' : ''),
    'E-mails sendt: ' + stats.sent + (stats.digests ? ' (heraf oversigter: ' + stats.digests + ')' : '') + ', sprunget over: ' + stats.mailSkipped + (stats.mailNote ? ' (' + stats.mailNote + ')' : '') + ' Adgang: ' + stats.accessOwner + ' til ejer, ' + stats.accessApproved + ' godkendte' + (stats.accessPending == null ? '' : ', ' + stats.accessPending + ' venter') + (stats.accessAdmins == null ? '' : ', ' + stats.accessAdmins + (stats.accessAdmins === 1 ? ' administrator' : ' administratorer')) + '.',
    'Skrevet til databasen: ' + stats.written + ', skrivefejl: ' + stats.writeFail + '. Tid: ' + ((Date.now() - started) / 1000).toFixed(1) + ' s.',
  ];
  summary.forEach((l) => log(l));
  return { stats, summary, results };
}

module.exports = { autoCompare, AUTO_COMPARE_MAX, COMPARE_EXTRAS_TRIES, run, initialPatch, trackingPatch, errorNote, classify, backfillDue, wantsCompare, wantsCompareAgain, oldErrorWantsCompare, MAX_BACKFILL };

if (require.main === module) {
  const e = process.env;
  if (!e.SUPABASE_URL || !e.SUPABASE_SERVICE_KEY) { console.error('SUPABASE_URL og SUPABASE_SERVICE_KEY skal være sat.'); process.exit(1); }
  run({ supabaseUrl: e.SUPABASE_URL, serviceKey: e.SUPABASE_SERVICE_KEY, resendKey: e.RESEND_API_KEY, mailFrom: e.MAIL_FROM, siteUrl: e.SITE_URL })
    .then(() => process.exit(0))
    .catch((err) => { console.error('CRASH', err && err.stack || err); process.exit(1); });
}
