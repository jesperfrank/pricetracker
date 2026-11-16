#!/usr/bin/env node
'use strict';
// node job/test.js          offline tests (no network, no dependencies)
// node job/test.js --live   additionally ONE live fetch of one prisjagt.dk page (parser sanity check)

if (process.argv.includes('--live') && !process.env.NODE_USE_ENV_PROXY && (process.env.HTTPS_PROXY || process.env.https_proxy)) {
  const cp = require('child_process').spawnSync(process.execPath, ['--no-warnings'].concat(process.argv.slice(1)), { stdio: 'inherit', env: Object.assign({}, process.env, { NODE_USE_ENV_PROXY: '1' }) });
  process.exit(cp.status === null ? 1 : cp.status);
}

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const P = require('./lib/pricing');
const PJ = require('./lib/prisjagt');
const { composeMail } = require('./lib/mail');
const R = require('./run');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const FIX = path.join(__dirname, 'fixtures');
const PRODUCT_IDS = { dyson: 5745115, lego: 13113529, ps5: 13395263, roborock: 16373878, sonicare: 7253209, sony: 6219512 };
const htmlCache = {};
function fixtureHtml(n) { return htmlCache[n] || (htmlCache[n] = zlib.gunzipSync(fs.readFileSync(path.join(FIX, n + '.html.gz'))).toString()); }
const pageCache = {};
function fixturePage(n) { return pageCache[n] || (pageCache[n] = PJ.parsePage(fixtureHtml(n))); }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function urlOf(n) { return 'https://prisjagt.dk/product.php?p=' + PRODUCT_IDS[n]; }

// ---------------------------------------------------------------- shops, prefs, goal

test('shop matching', () => {
  assert(P.matchShop('Elgiganten', 'www.elgiganten.dk'));
  assert(P.matchShop('Komplett', 'komplett.dk'));
  assert(P.matchShop('Av-Cables.dk', 'avcables'));
  assert(P.matchShop('Føniks Computer', 'Føniks'));
  assert(!P.matchShop('Elga', 'Elgiganten') && P.matchShop('Power', 'Powershop'));
  assert(!P.matchShop('CDON', 'Coolshop'));
  assert(!P.matchShop('', 'x'));
});

test('preferences: exclude, only+always, profile merge', () => {
  const offs = [{ store: 'Elgiganten', price: 100, inStock: true }, { store: 'CDON', price: 90, inStock: true }, { store: 'Komplett.dk', price: 95, inStock: true }];
  const names = (o) => o.map((x) => x.store);
  assert.deepStrictEqual(names(P.applyPrefs(offs, P.mergePrefs({ shops_exclude: ['cdon'] }, { shops_exclude: ['Komplett'] }))), ['Elgiganten']);
  assert.deepStrictEqual(names(P.applyPrefs(offs, P.mergePrefs({ shops_only: true, shops_always: ['komplett'] }, null))), ['Komplett.dk']);
  assert.strictEqual(P.applyPrefs(offs, P.mergePrefs({ shops_only: true, shops_always: [] }, null)).length, 3);
  assert.strictEqual(P.applyPrefs(offs, P.mergePrefs({}, { shops_only: true, shops_always: ['Elgiganten'] })).length, 1);
});

test('goal and notify logic', () => {
  const now = '2026-11-16T10:00:00Z';
  const lo = (p) => ({ price: p, store: 'A' });
  const prod = { target_type: 'price', target_value: 100, notified_price: null };
  let g = P.goalOutcome(prod, lo(99), null, now);
  assert(g.newHit && g.fields.notified_price === 99 && g.fields.notified_at === now);
  g = P.goalOutcome({ target_type: 'price', target_value: 100, notified_price: 99 }, lo(99), null, now);
  assert(!g.newHit && g.fields.notified_price === 99 && !('notified_at' in g.fields), 'no re-announce');
  g = P.goalOutcome({ target_type: 'price', target_value: 100, notified_price: 99 }, lo(95), null, now);
  assert(g.newHit, 'lower price announces again');
  g = P.goalOutcome({ target_type: 'price', target_value: 100, notified_price: 99 }, lo(120), null, now);
  assert(!g.newHit && g.fields.notified_price === null, 'reset when no longer a hit');
  g = P.goalOutcome(prod, null, null, now);
  assert(!g.newHit && g.fields.notified_price === null);
  assert.strictEqual(P.targetPrice({ target_type: 'pct', target_value: 25 }, 400), 300);
  assert.strictEqual(P.targetPrice({ target_type: 'pct', target_value: 25 }, null), null);
  assert.strictEqual(P.goalOutcome({ target_type: 'pct', target_value: 25 }, lo(1), null, now).hit, false, 'pct goal needs a normal price');
});

test('sanity check', () => {
  const prev = [{ store: 'A', price: 1000, inStock: true }];
  assert.strictEqual(P.sanityCheck([], prev), 'Ingen tilbud fundet');
  assert(P.sanityCheck([{ store: 'A', price: 300, inStock: true }, { store: 'B', price: 900, inStock: true }], prev));
  assert.strictEqual(P.sanityCheck([{ store: 'A', price: 300, inStock: true }, { store: 'B', price: 340, inStock: true }], prev), null);
});

// ---------------------------------------------------------------- history, normal price, verdict, warning

function series(today, spec) {   // spec: [[fromDaysAgo, toDaysAgo, price], ...] -> one point per day
  const t = P.dayNum(today), out = [];
  spec.forEach(([a, b, p]) => { for (let k = a; k >= b; k--) out.push({ d: P.numDay(t - k), p, s: 'X', src: 'check' }); });
  return out;
}
const TODAY = '2026-11-16';

test('history merge', () => {
  const h0 = [{ d: '2024-01-01', p: 5, s: 'X', src: 'check' }, { d: '2026-11-14', p: 120, s: 'A', src: 'check' }, { d: '2026-11-16', p: 100, s: 'B', src: 'check' }];
  const h1 = P.mergeHistory(h0, '2026-11-16', 110, 'C');
  assert.strictEqual(h1.length, 2); assert.strictEqual(h1[1].p, 100);
  assert.deepStrictEqual(P.mergeHistory(h0, '2026-11-16', 90, 'C')[1], { d: '2026-11-16', p: 90, s: 'C', src: 'check' });
  assert.deepStrictEqual(P.mergeHistory(undefined, '2026-11-17', 1, 'a'), [{ d: '2026-11-17', p: 1, s: 'a', src: 'check' }]);
  const ex = [{ d: '2026-10-02', p: 500, s: 'ours', src: 'check' }, { d: '2026-10-03', p: 300, s: 'ours', src: 'check' }, { d: '2026-10-04', p: 10, s: 'bf', src: 'backfill' }];
  const pg = [{ d: '2026-10-02', p: 400, s: 'P' }, { d: '2026-10-03', p: 350, s: 'P' }, { d: '2024-02-01', p: 7, s: 'P' }];
  assert.deepStrictEqual(P.mergePageHistory(ex, pg, TODAY), [{ d: '2026-10-02', p: 400, s: 'P', src: 'page' }, { d: '2026-10-03', p: 300, s: 'ours', src: 'check' }]);
  assert.strictEqual(P.copenhagenDate(new Date('2026-11-16T23:30:00Z')), '2026-11-17');
});

test('normal price', () => {
  assert.strictEqual(P.normalPrice(series(TODAY, [[100, 8, 100], [7, 0, 50]]), TODAY), 100, 'most recent 7 days are excluded');
  assert.strictEqual(P.normalPrice(series(TODAY, [[17, 0, 100]]), TODAY), 100, '11 days in window (day 17 to 7) is enough');
  assert.strictEqual(P.normalPrice(series(TODAY, [[15, 0, 100]]), TODAY), null, 'only 9 days of data: null');
  assert.strictEqual(P.normalPrice([], TODAY), null);
  // change points only: the price is carried forward
  assert.strictEqual(P.normalPrice([{ d: P.numDay(P.dayNum(TODAY) - 80), p: 200 }], TODAY), 200);
  // median, not mean, and nothing older than 90 days
  assert.strictEqual(P.normalPrice(series(TODAY, [[120, 100, 1], [89, 60, 100], [59, 8, 120]]), TODAY), 120);
  assert.strictEqual(P.normalPrice(series(TODAY, [[89, 80, 100], [79, 8, 200]]), TODAY), 200);
});

test('verdict', () => {
  const flat = series(TODAY, [[100, 1, 4600]]);
  let v = P.verdictFor(3999, 4600, flat, TODAY, null);
  assert.deepStrictEqual(v, { level: 'good', text: '3.999 kr. er 13 % under normalprisen (4.600 kr.) og den laveste pris i 30 dage.' });
  v = P.verdictFor(4600, 4600, flat, TODAY, null); assert.strictEqual(v.level, 'ok');
  v = P.verdictFor(4300, 4600, flat, TODAY, null); assert.strictEqual(v.level, 'ok');
  v = P.verdictFor(4700, 4600, flat, TODAY, null); assert.strictEqual(v.level, 'poor'); assert(/over normalprisen/.test(v.text));
  // 12 % under normal but it was cheaper 10 days ago: not "good"
  const dip = series(TODAY, [[100, 21, 4600], [20, 10, 3800], [9, 1, 4600]]);
  v = P.verdictFor(4048, 4600, dip, TODAY, null); assert.strictEqual(v.level, 'ok'); assert(/lavere de seneste 30 dage/.test(v.text));
  // a shop calls it a sale, but it is not below the previous 30-day low
  const low30 = series(TODAY, [[100, 21, 4600], [20, 1, 4500]]);
  v = P.verdictFor(4500, 4600, low30, TODAY, true); assert.strictEqual(v.level, 'poor'); assert(/kalder det et tilbud/.test(v.text));
  v = P.verdictFor(4500, 4600, low30, TODAY, null); assert.strictEqual(v.level, 'ok', 'no sale signal: only the first condition applies');
  v = P.verdictFor(4500, 4600, low30, TODAY, false); assert.strictEqual(v.level, 'ok');
  v = P.verdictFor(3999, null, flat, TODAY, null); assert.strictEqual(v.level, 'unknown');
  v = P.verdictFor(null, 4600, flat, TODAY, null); assert.strictEqual(v.level, 'unknown');
  assert.strictEqual(P.fmtKr(1299.5), '1.299,50 kr.'); assert.strictEqual(P.fmtKr(999), '999 kr.'); assert.strictEqual(P.fmtKr(1234567), '1.234.567 kr.');
});

test('warning: raised then lowered', () => {
  const fake = series(TODAY, [[60, 21, 4000], [20, 10, 5000], [9, 0, 4000]]);
  const w = P.priceWarning(fake, TODAY, 4000);
  assert(w && /4\.000 kr\./.test(w) && /5\.000 kr\./.test(w) && /20 dage siden/.test(w) && !/\.\./.test(w), w);
  assert.strictEqual(P.priceWarning(series(TODAY, [[60, 21, 4000], [20, 10, 4150], [9, 0, 4000]]), TODAY, 4000), null, 'bump under 10 %');
  assert.strictEqual(P.priceWarning(series(TODAY, [[60, 31, 5000], [30, 15, 4500], [14, 0, 4000]]), TODAY, 4000), null, 'plain decline');
  assert.strictEqual(P.priceWarning(series(TODAY, [[60, 21, 4000], [20, 0, 5000]]), TODAY, 5000), null, 'still high');
  assert.strictEqual(P.priceWarning(series(TODAY, [[60, 21, 4000], [20, 10, 5000], [9, 0, 4600]]), TODAY, 4600), null, 'not back at the old level');
  assert.strictEqual(P.priceWarning([], TODAY, 1), null);
});

// ---------------------------------------------------------------- parser on the saved real pages

test('parser: titles, variants, lowest per variant (independent check against the rows)', () => {
  const expectLabels = {
    dyson: ['Dyson V15 Detect Absolute Ledningsfri'],
    lego: ['LEGO Star Wars 75375 Millennium Falcon'],
    ps5: ['Sony PlayStation 5 Pro (PS5) 2TB'],
    roborock: ['Black', 'White'],
    sonicare: ['Aquamarine Gradient', 'Black', 'Pink', 'Rose Gold', 'Rose Gold, White', 'Silk Pink To White Gradient', 'White', 'Øvrige tilbud (uden variant)'],
    sony: ['Black', 'Midnight Blue', 'Platinum Silver', 'Smoky Pink', 'Øvrige tilbud (uden variant)'],
  };
  Object.keys(PRODUCT_IDS).forEach((n) => {
    const pg = fixturePage(n);
    assert(pg.title && pg.rows.length > 5, n);
    assert.deepStrictEqual(pg.variants.map((v) => v.label).sort(), expectLabels[n].slice().sort(), n + ' labels');
    pg.variants.forEach((v) => {
      const rs = pg.rows.filter((r) => r.variant === v.id);
      assert.strictEqual(v.offers, rs.length, n + ' offer count ' + v.id);
      const ins = rs.filter((r) => r.inStock).map((r) => r.price);
      assert.strictEqual(v.lowest, ins.length ? Math.min.apply(null, ins) : null, n + ' lowest ' + v.id);
    });
    assert.strictEqual(pg.variants.reduce((s, v) => s + v.offers, 0), pg.rows.length);
    assert(pg.history.length > 3, n + ' history');
  });
  // spot checks of label -> variant (verified by reading the offer names of each group)
  const byLabel = (n, l) => fixturePage(n).variants.find((v) => v.label === l);
  assert.strictEqual(byLabel('roborock', 'Black').lowest, 5298);
  assert(/sort/i.test(byLabel('roborock', 'Black').sample) && /hvid/i.test(byLabel('roborock', 'White').sample));
  assert.strictEqual(byLabel('sonicare', 'Pink').id, '16560768');
  assert.strictEqual(byLabel('sonicare', 'Rose Gold, White').id, '16572737');
  assert.strictEqual(byLabel('sony', 'Midnight Blue').id, '16797046');
  assert.strictEqual(byLabel('sony', 'Platinum Silver').lowest, 1899);
});

test('parser: listing keys are stable, unique and as in the go-to-shop link', () => {
  const a = PJ.parsePage(fixtureHtml('sonicare')), b = PJ.parsePage(zlib.gunzipSync(fs.readFileSync(path.join(FIX, 'sonicare.html.gz'))).toString());
  assert.deepStrictEqual(a.rows.map((r) => r.key), b.rows.map((r) => r.key));
  Object.keys(PRODUCT_IDS).forEach((n) => {
    const keys = fixturePage(n).rows.map((r) => r.key);
    assert.strictEqual(new Set(keys).size, keys.length, n + ' keys unique');
    fixturePage(n).rows.forEach((r) => assert(/^\d+\/.+/.test(r.key) && r.key === PJ.listingKey(r.url), n + ' ' + r.key));
  });
  assert.strictEqual(PJ.listingKey('https://prisjagt.dk/go-to-shop/1/offer/HX9911%2F84?client_id=1'), '1/HX9911/84');
  assert(fixturePage('dyson').rows.some((r) => r.key === '35148/494719-01'));
  // keys do not change when only the price changes
  const mod = clone(fixturePage('roborock')); mod.rows.forEach((r) => { r.price += 7; });
  assert.deepStrictEqual(mod.rows.map((r) => r.key), fixturePage('roborock').rows.map((r) => r.key));
});

test('parser: layout errors and url validation', () => {
  assert.throws(() => PJ.parsePage('<html>blocked</html>'), /layout/);
  assert.strictEqual(PJ.validateProductUrl('https://www.prisjagt.dk/product.php?p=1'), 'https://prisjagt.dk/product.php?p=1');
  ['http://prisjagt.dk/x', 'https://prisjagt.dk.evil.com/x', 'https://evil.com/prisjagt.dk/x', 'https://prisjagt.dk/', 'javascript:alert(1)', '', null, 'https://u:p@prisjagt.dk/x']
    .forEach((u) => assert.strictEqual(PJ.validateProductUrl(u), null, String(u)));
});

test('parser: fetchPage treats 403/429/challenge as blocked', async () => {
  const mk = (status, body) => async () => ({ status, url: 'https://prisjagt.dk/x', text: async () => body });
  for (const st of [403, 429, 503]) await assert.rejects(PJ.fetchPage('https://prisjagt.dk/x', mk(st, '')), (e) => e.kind === 'blocked');
  await assert.rejects(PJ.fetchPage('https://prisjagt.dk/x', mk(200, '<title>Just a moment...</title>')), (e) => e.kind === 'blocked');
  await assert.rejects(PJ.fetchPage('https://prisjagt.dk/x', mk(404, '')), (e) => e.kind === 'notfound');
  let seen; await PJ.fetchPage('https://prisjagt.dk/x', async (u, o) => { seen = o; return { status: 200, url: u, text: async () => fixtureHtml('dyson') }; });
  assert(/^Prisvagten-pricecheck/.test(seen.headers['User-Agent']) && !('Cookie' in seen.headers));
});

// ---------------------------------------------------------------- e-mail text

test('e-mail text for two hits; untrusted text stays plain', () => {
  const m = composeMail([
    { name: 'Roborock <b>Saros</b>\nBcc: x@y.z', price: 5298, store: 'Av-Cables.dk', url: 'https://prisjagt.dk/go-to-shop/1/offer/2', verdict: '5.298 kr. er 10 % under normalprisen (5.900 kr.) og den laveste pris i 30 dage.', warning: null },
    { name: 'Dyson V15', price: 3999, store: '<img src=x>', url: 'https://prisjagt.dk/go-to-shop/3/offer/4', verdict: null, warning: 'Prisen steg fra 4.000 kr. til 5.000 kr.' },
  ], 'https://example.github.io/prisvagten/');
  assert.strictEqual(m.subject, 'Prisvagten: 2 priser har ramt dit mål');
  assert(m.text.includes('1. Roborock <b>Saros</b> Bcc: x@y.z') && m.text.includes('Pris: 5.298 kr. hos Av-Cables.dk'));
  assert(m.text.includes('2. Dyson V15') && m.text.includes('Link til butikken: https://prisjagt.dk/go-to-shop/3/offer/4'));
  assert(m.text.includes('OBS: Prisen steg') && m.text.includes('laveste pris i 30 dage.'));
  assert(m.text.includes('https://example.github.io/prisvagten/') && /e-mails/.test(m.text));
  assert(!/\r/.test(m.text) && !/\n[ ]*Bcc:/.test(m.text), 'newline in a product name cannot start a new line');
  assert.strictEqual(composeMail([{ name: 'A', price: 1, store: 'S', url: 'https://x' }], '').subject, 'Prisvagten: 1 pris har ramt dit mål');
});

// ---------------------------------------------------------------- full run against an in-memory Supabase

const NOW = new Date('2026-11-16T10:00:00Z');
const SERVICE_KEY = 'service-key-123';

function makeFake(db) {
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined || body === null ? '' : JSON.stringify(body)) });
  const fake = async function (url, opts) {
    opts = opts || {};
    const u = new URL(url), h = opts.headers || {};
    const m = (opts.method || 'GET');
    if (db.down && u.hostname.endsWith('supabase.test')) throw new Error('fetch failed (ENOTFOUND)');
    if (u.hostname === 'api.resend.com') {
      if (h.Authorization !== 'Bearer resend-key') return reply(401, { message: 'bad key' });
      const b = JSON.parse(opts.body);
      if (db.resendFail) return reply(500, { message: 'boom' });
      db.sent.push(b); return reply(200, { id: 'x' });
    }
    assert.strictEqual(u.hostname, 'x.supabase.test', 'only the configured Supabase host is called: ' + url);
    assert.strictEqual(h.apikey, SERVICE_KEY); assert.strictEqual(h.Authorization, 'Bearer ' + SERVICE_KEY);
    let mm;
    if ((mm = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(u.pathname))) {
      const usr = db.users[decodeURIComponent(mm[1])]; return usr ? reply(200, { id: mm[1], email: usr }) : reply(404, { msg: 'not found' });
    }
    if ((mm = /^\/rest\/v1\/(\w+)$/.exec(u.pathname))) {
      const t = db[mm[1]]; assert(t, 'unknown table ' + mm[1]);
      const q = u.searchParams;
      if (m === 'GET') {
        let rows = t.slice();
        if (mm[1] === 'products') {
          assert.strictEqual(q.get('active'), 'eq.true'); assert.strictEqual(q.get('source_url'), 'not.is.null');
          rows = rows.filter((r) => r.active !== false && r.source_url);
        }
        if (q.get('user_id') && /^in\.\((.*)\)$/.test(q.get('user_id'))) { const ids = /^in\.\((.*)\)$/.exec(q.get('user_id'))[1].split(','); rows = rows.filter((r) => ids.indexOf(r.user_id) !== -1); }
        if (q.get('email') && /^eq\./.test(q.get('email'))) rows = rows.filter((r) => r.email === q.get('email').slice(3));
        return reply(200, JSON.parse(JSON.stringify(rows)));
      }
      if (m === 'PATCH') {
        assert.strictEqual(h.Prefer, 'return=minimal');
        const id = /^eq\.(.+)$/.exec(q.get('id'))[1];
        const row = t.find((r) => r.id === id); if (!row) return reply(204);
        if (db.patchFail && db.patchFail === id) return reply(500, { message: 'db error' });
        const body = JSON.parse(opts.body);
        ['id', 'user_id', 'name', 'source_url', 'target_type', 'target_value', 'active'].forEach((k) => assert(!(k in body), 'job must not write user column ' + k));
        Object.assign(row, body); db.patches.push({ id, body }); return reply(204);
      }
    }
    return reply(404, { message: 'no route ' + url });
  };
  return fake;
}

function newDb() {
  return {
    products: [], profiles: [], allowed_emails: [{ email: 'anna@example.dk' }, { email: 'bo@example.dk' }],
    users: { u1: 'Anna@Example.dk', u2: 'eve@evil.dk', u3: 'bo@example.dk' }, sent: [], patches: [],
  };
}
function product(id, user, fixture, extra) {
  return Object.assign({
    id, user_id: user, name: 'Produkt ' + id, source_url: urlOf(fixture), target_type: 'price', target_value: 1, tracked_variants: null,
    shops_always: [], shops_exclude: [], shops_only: false, active: true, status: 'pending', title: null, variants: null, offers: null, history: null,
    normal_price: null, verdict: null, warning: null, check_note: null, last_checked: null, notified_price: null, notified_at: null,
  }, extra || {});
}
function pageFor(fixture, priceFn) {
  const p = clone(fixturePage(fixture));
  if (priceFn) p.rows.forEach((r) => { r.price = priceFn(r); });
  // recompute variants' lowest from the modified rows
  p.variants.forEach((v) => { const ins = p.rows.filter((r) => r.variant === v.id && r.inStock).map((r) => r.price); v.lowest = ins.length ? Math.min.apply(null, ins) : null; });
  return p;
}
function ctxFor(db, pages, extra) {
  const fetched = [];
  return Object.assign({
    supabaseUrl: 'https://x.supabase.test', serviceKey: SERVICE_KEY, resendKey: 'resend-key', mailFrom: 'Prisvagten <pris@example.dk>', siteUrl: 'https://example.github.io/prisvagten/',
    fetch: makeFake(db), now: () => NOW, sleep: async () => {}, log: () => {}, fetched,
    getPage: async (url) => { fetched.push(url); const f = pages[url]; if (f instanceof Error) throw f; if (!f) throw new PJ.PageError('notfound', 'HTTP 404'); return typeof f === 'function' ? f() : f; },
  }, extra || {});
}

test('full run: pending -> choose -> tracking -> hit -> second run without a new e-mail', async () => {
  const db = newDb();
  // anna (u1): roborock (two variants, goal 5300 kr.), dyson (one variant, goal 4000 kr.). eve (u2, not invited): dyson goal 4000. bo (u3) opted out.
  db.products.push(product('A', 'u1', 'roborock', { name: 'Roborock', target_value: 5300 }));
  db.products.push(product('B', 'u1', 'dyson', { name: 'Dyson', target_value: 4000 }));
  db.products.push(product('C', 'u2', 'dyson', { name: 'Dyson (eve)', target_value: 4000 }));
  db.products.push(product('D', 'u3', 'dyson', { name: 'Dyson (bo)', target_value: 4000 }));
  db.profiles.push({ user_id: 'u3', notify_email: false, shops_always: [], shops_exclude: [], shops_only: false });
  const pages = {}; pages[urlOf('roborock')] = pageFor('roborock'); pages[urlOf('dyson')] = pageFor('dyson');

  // run 1
  let ctx = ctxFor(db, pages);
  let res = await R.run(ctx);
  const byId = (id) => db.products.find((p) => p.id === id);
  assert.strictEqual(res.summary.length, 5);
  assert.deepStrictEqual(ctx.fetched.sort(), [urlOf('roborock'), urlOf('dyson')], 'one page load per distinct url (dyson shared by three products)');
  const A = byId('A');
  assert.strictEqual(A.status, 'choose'); assert.strictEqual(A.title, 'Roborock Saros 20 Sonic'); assert.strictEqual(A.variants.length, 2);
  assert(A.history.length > 3 && A.history.every((x) => x.src === 'page'));
  assert.strictEqual(A.offers, null); assert.strictEqual(A.tracked_variants, null);
  const B = byId('B');
  assert.strictEqual(B.status, 'tracking'); assert.deepStrictEqual(B.tracked_variants, ['none']);
  assert(B.offers.length > 5 && B.offers.every((o) => typeof o.price === 'number' && /^https:/.test(o.url) && 'note' in o && o.variant === 'none'));
  assert.strictEqual(B.offers[0].price, 3999); assert.strictEqual(B.notified_price, 3999); assert(B.notified_at);
  assert(B.history.some((x) => x.src === 'check' && x.d === '2026-11-16' && x.p === 3999) && B.history.some((x) => x.src === 'page'));
  assert(B.last_checked === '2026-11-16T10:00:00Z'); assert(B.verdict && ['good', 'ok', 'poor', 'unknown'].includes(B.verdict.level) && typeof B.verdict.text === 'string');
  assert.strictEqual(db.sent.length, 1, 'anna gets one e-mail (B); eve is not in allowed_emails; bo opted out');
  assert.deepStrictEqual(db.sent[0].to, ['anna@example.dk']); assert.strictEqual(db.sent[0].from, 'Prisvagten <pris@example.dk>');
  assert(db.sent[0].text.includes('Dyson') && !db.sent[0].text.includes('(eve)') && db.sent[0].text.includes('3.999 kr.'));
  assert.strictEqual(byId('C').status, 'tracking'); assert.strictEqual(byId('C').notified_price, 3999, 'eve is tracked, but never mailed');
  assert.strictEqual(byId('D').notified_price, 3999, 'opted out: hit recorded without mail');
  const betweenA = db.patches.length;

  // run 2: nothing chosen yet -> A is not fetched again; B/C/D already announced
  ctx = ctxFor(db, pages); res = await R.run(ctx);
  assert.deepStrictEqual(ctx.fetched, [urlOf('dyson')], 'a product waiting for a choice is not fetched');
  assert.strictEqual(db.sent.length, 1, 'no new e-mail');

  // the user picks the black variant (the frontend writes tracked_variants)
  const black = A.variants.find((v) => v.label === 'Black').id;
  A.tracked_variants = [black];
  ctx = ctxFor(db, pages); res = await R.run(ctx);
  assert.strictEqual(byId('A').status, 'tracking');
  assert(byId('A').offers.length > 3 && byId('A').offers.every((o) => o.variant === black));
  assert.strictEqual(byId('A').offers[0].price, 5298); assert.strictEqual(byId('A').notified_price, 5298);
  assert(byId('A').history.every((x) => x.src === 'check'), 'page history of a multi-variant page is dropped when only some variants are followed');
  assert.strictEqual(byId('A').normal_price, null); assert.strictEqual(byId('A').verdict.level, 'unknown');
  assert.strictEqual(db.sent.length, 2); assert(db.sent[1].text.includes('Roborock') && db.sent[1].text.includes('5.298 kr.') && !db.sent[1].text.includes('Dyson'));

  // run 3: same prices -> no new e-mail
  ctx = ctxFor(db, pages); await R.run(ctx);
  assert.strictEqual(db.sent.length, 2, 'second run without a new e-mail');

  // price drops further -> announced again
  pages[urlOf('roborock')] = pageFor('roborock', (r) => (r.variant === black ? r.price - 100 : r.price));
  ctx = ctxFor(db, pages); await R.run(ctx);
  assert.strictEqual(db.sent.length, 3); assert.strictEqual(byId('A').notified_price, 5198);
  // price goes up above the goal -> reset, then a new hit mails again
  pages[urlOf('roborock')] = pageFor('roborock', (r) => r.price + 500);
  ctx = ctxFor(db, pages); await R.run(ctx);
  assert.strictEqual(byId('A').notified_price, null); assert.strictEqual(db.sent.length, 3);
  pages[urlOf('roborock')] = pageFor('roborock');
  ctx = ctxFor(db, pages); await R.run(ctx);
  assert.strictEqual(db.sent.length, 4);
  void betweenA;
});

test('run: preferences exclude the cheapest shop; pct goal uses the computed normal price', async () => {
  const db = newDb();
  db.products.push(product('P', 'u1', 'dyson', { shops_exclude: ['Dyson', 'Elgiganten'], target_value: 1 }));
  db.profiles.push({ user_id: 'u1', notify_email: true, shops_exclude: ['Proshop'], shops_always: [], shops_only: false });
  const pages = {}; pages[urlOf('dyson')] = pageFor('dyson');
  const ctx = ctxFor(db, pages); await R.run(ctx);
  const P1 = db.products[0];
  assert(P1.offers.length > 0 && !P1.offers.some((o) => /^(dyson|elgiganten|proshop)/i.test(o.store)));
  // pct goal: first run gives a normal price from the page's history; 1 % below normal is then reachable
  const n = P1.normal_price; assert(typeof n === 'number' && n > 0, 'normal price from 3 months of page history');
  const db2 = newDb(); db2.products.push(product('Q', 'u1', 'dyson', { target_type: 'pct', target_value: 1 }));
  await R.run(ctxFor(db2, pages));
  const Q = db2.products[0];
  const tgt = Q.normal_price * 0.99;
  assert.strictEqual(Q.notified_price !== null, Q.offers[0].price <= tgt, 'hit decision follows normal_price');
});

test('run: errors per product do not stop the others; blocked stops further fetching', async () => {
  const db = newDb();
  db.products.push(product('E1', 'u1', 'dyson', { source_url: 'https://evil.example.com/x' }));
  db.products.push(product('E2', 'u1', 'roborock', { source_url: 'https://prisjagt.dk/product.php?p=999' }));        // 404
  db.products.push(product('E3', 'u1', 'lego'));
  db.products.push(product('E4', 'u1', 'ps5'));
  const pages = {}; pages[urlOf('lego')] = pageFor('lego'); pages[urlOf('ps5')] = new PJ.PageError('blocked', 'HTTP 429');
  let ctx = ctxFor(db, pages); await R.run(ctx);
  const by = (id) => db.products.find((p) => p.id === id);
  assert.strictEqual(by('E1').status, 'error'); assert(/prisjagt\.dk/.test(by('E1').check_note));
  assert.strictEqual(by('E2').status, 'error'); assert(/findes ikke/.test(by('E2').check_note));
  assert.strictEqual(by('E3').status, 'tracking', 'a good product is processed although others fail');
  assert.strictEqual(by('E4').status, 'error'); assert(/afviste/.test(by('E4').check_note));
  // blocked: nothing else is fetched afterwards
  const db2 = newDb();
  db2.products.push(product('F1', 'u1', 'ps5', { last_checked: '2026-11-16T09:00:00Z' }), product('F2', 'u1', 'lego', { last_checked: '2026-11-16T09:30:00Z' }));
  ctx = ctxFor(db2, pages); const r2 = await R.run(ctx);
  assert.deepStrictEqual(ctx.fetched, [urlOf('ps5')]); assert(r2.stats.blocked);
  assert.strictEqual(db2.products[1].status, 'pending');
  // an error row is retried only after six hours
  const db3 = newDb(); db3.products.push(product('G', 'u1', 'lego', { status: 'error', last_checked: '2026-11-16T08:00:00Z' }));
  ctx = ctxFor(db3, { [urlOf('lego')]: pageFor('lego') }); await R.run(ctx); assert.strictEqual(ctx.fetched.length, 0);
  db3.products[0].last_checked = '2026-11-16T03:00:00Z'; ctx = ctxFor(db3, { [urlOf('lego')]: pageFor('lego') }); await R.run(ctx);
  assert.strictEqual(db3.products[0].status, 'tracking');
});

test('run: tracked variants that vanish send the product back to "choose"; suspicious price drops are not stored', async () => {
  const db = newDb();
  db.products.push(product('V', 'u1', 'roborock', { status: 'tracking', tracked_variants: ['111'], offers: [{ store: 'X', price: 5000, inStock: true, url: 'https://x', note: null, variant: '111' }] }));
  const pages = { [urlOf('roborock')]: pageFor('roborock') };
  await R.run(ctxFor(db, pages));
  assert.strictEqual(db.products[0].status, 'choose'); assert.strictEqual(db.products[0].tracked_variants, null); assert(/Vælg igen/.test(db.products[0].check_note));
  const db2 = newDb();
  const id = fixturePage('roborock').variants[0].id;
  const cheapKey = fixturePage('roborock').rows.find((r) => r.variant === id && r.inStock).key;
  db2.products.push(product('W', 'u1', 'roborock', { status: 'tracking', tracked_variants: [id], offers: [{ store: 'X', price: 90000, inStock: true, url: 'https://x', note: null, variant: id }] }));
  await R.run(ctxFor(db2, { [urlOf('roborock')]: pageFor('roborock', (r) => (r.variant === id && r.key === cheapKey ? 300 : r.price)) }));
  assert(/forkerte/.test(db2.products[0].check_note)); assert.strictEqual(db2.products[0].offers[0].price, 90000, 'old offers kept');
});

test('run: e-mail cap of 20, missing Resend key, failing Resend, never mail non-invited users', async () => {
  const mk = (n) => {
    const db = newDb(); db.allowed_emails = [];
    for (let i = 0; i < n; i++) { db.users['m' + i] = 'user' + i + '@example.dk'; db.allowed_emails.push({ email: 'user' + i + '@example.dk' }); db.products.push(product('M' + i, 'm' + i, 'dyson', { target_value: 4000 })); }
    return db;
  };
  const pages = { [urlOf('dyson')]: pageFor('dyson') };
  const db = mk(22); const ctx = ctxFor(db, pages); const r = await R.run(ctx);
  assert.strictEqual(db.sent.length, 20); assert.strictEqual(r.stats.sent, 20);
  const unsent = db.products.filter((p) => p.notified_price === null).length;
  assert.strictEqual(unsent, 2, 'users over the cap are not marked as notified, so they are mailed next run');
  await R.run(ctxFor(db, pages)); assert.strictEqual(db.sent.length, 22);
  // no key
  const db2 = mk(1); const r2 = await R.run(ctxFor(db2, pages, { resendKey: '' }));
  assert.strictEqual(db2.sent.length, 0); assert.strictEqual(db2.products[0].notified_price, null); assert(/RESEND_API_KEY/.test(r2.summary.join('\n')));
  await R.run(ctxFor(db2, pages)); assert.strictEqual(db2.sent.length, 1, 'mailed once the key exists');
  // resend failure keeps the hit for the next run
  const db3 = mk(1); db3.resendFail = true; await R.run(ctxFor(db3, pages)); assert.strictEqual(db3.products[0].notified_price, null);
  db3.resendFail = false; await R.run(ctxFor(db3, pages)); assert.strictEqual(db3.sent.length, 1);
  // a user missing from allowed_emails is never mailed
  const db4 = mk(1); db4.allowed_emails = []; await R.run(ctxFor(db4, pages)); assert.strictEqual(db4.sent.length, 0);
});

test('run: Supabase unreachable rejects; one failing write does not stop the others', async () => {
  const db = newDb(); db.products.push(product('A1', 'u1', 'lego')); db.down = true;
  await assert.rejects(R.run(ctxFor(db, {})), /fetch failed|ENOTFOUND/);
  const db2 = newDb(); db2.products.push(product('A1', 'u1', 'lego'), product('A2', 'u1', 'ps5')); db2.patchFail = 'A1';
  const r = await R.run(ctxFor(db2, { [urlOf('lego')]: pageFor('lego'), [urlOf('ps5')]: pageFor('ps5') }));
  assert.strictEqual(r.stats.writeFail, 1); assert.strictEqual(db2.products[1].status, 'tracking');
});

test('job never writes user-owned columns (id, user_id, name, source_url, targets, active)', async () => {
  const db = newDb(); db.products.push(product('Z', 'u1', 'sony'));
  await R.run(ctxFor(db, { [urlOf('sony')]: pageFor('sony') }));   // the fake asserts this on every PATCH
  assert(db.patches.length === 1 && db.products[0].status === 'choose' && db.products[0].variants.length === 5);
});

// ---------------------------------------------------------------- live sanity check (opt-in)

async function live() {
  const url = 'https://prisjagt.dk/product.php?p=' + PRODUCT_IDS.roborock;
  const pg = await PJ.fetchPage(url);
  const fx = fixturePage('roborock');
  console.log('LIVE ' + url + ': title "' + pg.title + '", ' + pg.rows.length + ' offers, history points ' + pg.history.length);
  pg.variants.forEach((v) => console.log('  variant ' + v.id + ' "' + v.label + '" lowest ' + v.lowest + ' offers ' + v.offers));
  assert(pg.rows.length > 5 && pg.variants.length >= 1 && pg.history.length > 3);
  const keys = new Set(pg.rows.map((r) => r.key)), shared = fx.rows.filter((r) => keys.has(r.key)).length;
  console.log('  listing keys shared with the saved page: ' + shared + ' of ' + fx.rows.length);
  assert(shared > fx.rows.length / 2, 'listing keys should be stable between fetches');
  const variantOf = new Map(pg.rows.map((r) => [r.key, r.variant]));
  fx.rows.forEach((r) => { if (variantOf.has(r.key)) assert.strictEqual(variantOf.get(r.key), r.variant, 'same listing, same variant: ' + r.key); });
  assert.deepStrictEqual(pg.variants.map((v) => v.label).sort(), ['Black', 'White']);
}

(async () => {
  let fail = 0;
  for (const t of tests) {
    try { await t.fn(); console.log('ok   ' + t.name); } catch (e) { fail++; console.log('FAIL ' + t.name + '\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  if (process.argv.includes('--live')) {
    try { await live(); console.log('ok   live sanity fetch'); } catch (e) { fail++; console.log('FAIL live sanity fetch\n     ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n     ')); }
  }
  console.log(fail ? fail + ' of ' + tests.length + ' FAILED' : 'all ' + tests.length + ' tests passed');
  process.exit(fail ? 1 : 0);
})();
