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
const { composeMail, composeOwnerMail, composeApprovedMail, sendResend } = require('./lib/mail');
const { makeClient } = require('./lib/supabase');

const PAUSE_MS = 1500;
const MAX_MAILS = 20;
const ERROR_RETRY_MS = 6 * 3600 * 1000;
const DEADLINE_MS = 8.5 * 60 * 1000;      // the workflow times out at 10 minutes

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
  if (low) history = P.mergeHistory(history, today, low.price, low.store);

  const normal = P.normalPrice(history, today);
  const saleSignal = low ? (rows.some((r) => r.saleKnown) ? rows.some((r) => r.inStock && r.price === low.price && r.sale) : null) : null;
  const verdict = P.verdictFor(low ? low.price : null, normal, history, today, saleSignal);
  const warning = P.priceWarning(history, today, low ? low.price : undefined);
  const goal = P.goalOutcome(prod, low, normal, iso);

  const patch = Object.assign({
    status: 'tracking', title: prod.title || parsed.title || null, variants, offers, history, normal_price: normal, verdict, warning,
    check_note: filtered.length === 0 ? 'Ingen butikker matcher dine butiksvalg.' : (parsed.note || null), last_checked: iso,
  }, goal.fields);
  return {
    patch,
    hit: goal.newHit ? { productId: prod.id, userId: prod.user_id, name: prod.name, price: low.price, store: low.store, url: low.url, verdict: verdict.text, warning } : null,
  };
}

// The page kind of a source_url: {url, shop} or null when the link may not be fetched at all.
function classify(src) {
  let host;
  try { host = new URL(String(src || '').trim()).hostname; } catch (e) { return null; }
  if (SHOP.isPrisjagtHost(host)) { const u = PJ.validateProductUrl(src); return u ? { url: u, shop: false } : null; }
  const u = SHOP.validateShopUrl(src);
  return u ? { url: u, shop: true } : null;
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
  const stats = { total: 0, pending: 0, tracking: 0, choose: 0, error: 0, pages: 0, pageFail: 0, blocked: false, blockedHosts: [], hits: 0, sent: 0, mailSkipped: 0, mailNote: '', accessOwner: 0, accessApproved: 0, written: 0, writeFail: 0, deadline: false };

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
    if (stats.blockedHosts.indexOf(hostKey) !== -1) continue;       // refused earlier in this run: leave the rest of that host alone
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
        if (todo === 'initial') results.push({ prod, patch: { status: 'error', check_note: note, last_checked: isoNow(now) }, hit: null });
        else results.push({ prod, patch: { check_note: note }, hit: null });
        continue;
      }
      const parsed = got.page;
      const profile = profiles[prod.user_id] || null;
      if (todo === 'initial') {
        const ip = initialPatch(prod, parsed, now);
        if (ip.track) {
          const next = Object.assign({}, prod, ip.patch);
          const tp = trackingPatch(next, profile, parsed, now);
          results.push({ prod, patch: Object.assign({}, ip.patch, tp.patch), hit: tp.hit });
        } else results.push({ prod, patch: ip.patch, hit: null });
      } else {
        const tp = trackingPatch(prod, profile, parsed, now);
        results.push({ prod, patch: tp.patch, hit: tp.hit });
      }
    } catch (e) {
      stats.pageFail++;
      log('  ' + (prod.name || prod.id) + ': uventet fejl: ' + (e && e.stack || e));
    }
  }

  // 5. e-mail
  const hitsByUser = {};
  results.forEach((r) => { if (r.hit) (hitsByUser[r.hit.userId] = hitsByUser[r.hit.userId] || []).push(r); });
  stats.hits = results.filter((r) => r.hit).length;
  const revert = (rs) => rs.forEach((r) => { r.patch.notified_price = typeof r.prod.notified_price === 'number' ? r.prod.notified_price : null; delete r.patch.notified_at; });
  const canMail = !!ctx.resendKey && !!ctx.mailFrom;
  if (stats.hits && !canMail) { stats.mailNote = ctx.resendKey ? 'MAIL_FROM mangler' : 'RESEND_API_KEY mangler'; log('E-mail springes over: ' + stats.mailNote + '.'); }
  for (const userId of Object.keys(hitsByUser)) {
    const rs = hitsByUser[userId];
    const profile = profiles[userId];
    if (profile && profile.notify_email === false) { stats.mailSkipped++; continue; }       // opted out: hit is recorded, no mail
    if (!canMail) { revert(rs); stats.mailSkipped++; continue; }                            // retry once mail is configured
    try {
      if (stats.sent >= MAX_MAILS) { revert(rs); stats.mailSkipped++; stats.mailNote = 'loft på ' + MAX_MAILS + ' e-mails nået'; continue; }
      const u = await sb.authUser(userId);
      const addr = String(u && u.email || '').trim().toLowerCase();
      if (!addr) { stats.mailSkipped++; continue; }
      const allowed = await sb.select('allowed_emails', 'select=email&email=eq.' + encodeURIComponent(addr));
      if (!allowed.length) { log('  Bruger ' + userId + ' står ikke i allowed_emails: ingen e-mail.'); stats.mailSkipped++; continue; }
      const mail = composeMail(rs.map((r) => r.hit), ctx.siteUrl);
      await sendResend(fetchImpl, ctx.resendKey, ctx.mailFrom, addr, mail);
      stats.sent++;
    } catch (e) {
      log('  E-mail til bruger ' + userId + ' fejlede: ' + (e && e.message || e));
      revert(rs); stats.mailSkipped++;
    }
  }

  // write (one product failing does not stop the others)
  for (const r of results) {
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
    'Nye hits: ' + stats.hits + '.',
    'E-mails sendt: ' + stats.sent + ', sprunget over: ' + stats.mailSkipped + (stats.mailNote ? ' (' + stats.mailNote + ')' : '') + ' Adgang: ' + stats.accessOwner + ' til ejer, ' + stats.accessApproved + ' godkendte.',
    'Skrevet til databasen: ' + stats.written + ', skrivefejl: ' + stats.writeFail + '. Tid: ' + ((Date.now() - started) / 1000).toFixed(1) + ' s.',
  ];
  summary.forEach((l) => log(l));
  return { stats, summary, results };
}

module.exports = { run, initialPatch, trackingPatch, errorNote, classify };

if (require.main === module) {
  const e = process.env;
  if (!e.SUPABASE_URL || !e.SUPABASE_SERVICE_KEY) { console.error('SUPABASE_URL og SUPABASE_SERVICE_KEY skal være sat.'); process.exit(1); }
  run({ supabaseUrl: e.SUPABASE_URL, serviceKey: e.SUPABASE_SERVICE_KEY, resendKey: e.RESEND_API_KEY, mailFrom: e.MAIL_FROM, siteUrl: e.SITE_URL })
    .then(() => process.exit(0))
    .catch((err) => { console.error('CRASH', err && err.stack || err); process.exit(1); });
}
