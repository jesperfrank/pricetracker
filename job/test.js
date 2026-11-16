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
const SHOP = require('./lib/shop');
const WB = require('./lib/wayback');
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

test("goal 'auto': good verdict, or 10 % under the first price when history is too short; de-duplicated", () => {
  const now = '2026-11-16T10:00:00Z', today = '2026-11-16';
  const lo = (p) => ({ price: p, store: 'A' });
  const auto = { target_type: 'auto', target_value: null, notified_price: null };
  // a good verdict fires, and the reason is the verdict's own sentence
  const good = { level: 'good', text: '450 kr. er 10 % under normalprisen (500 kr.) og den laveste pris i 30 dage.' };
  let g = P.goalOutcome(auto, lo(450), 500, now, { verdict: good, history: [] });
  assert(g.hit && g.newHit && g.reason === good.text && g.fields.notified_price === 450 && g.fields.notified_at === now);
  // ok / poor verdicts do not fire, even far below the first price
  const hist = [{ d: '2026-09-01', p: 1000, s: 'A', src: 'check' }];
  ['ok', 'poor'].forEach((level) => {
    g = P.goalOutcome(auto, lo(500), 800, now, { verdict: { level, text: 'x' }, history: hist });
    assert(!g.hit && !g.newHit && g.reason === null && g.fields.notified_price === null, level);
  });
  // too little history (verdict unknown): >= 10 % under the first price fires; 9 % does not
  const unk = { level: 'unknown', text: 'Der er endnu ikke nok prishistorik til at vurdere prisen.' };
  g = P.goalOutcome(auto, lo(900), null, now, { verdict: unk, history: [{ d: '2026-11-10', p: 1000 }, { d: '2026-11-15', p: 950 }] });
  assert(g.hit && g.newHit, 'exactly 10 % under the first price');
  assert.strictEqual(g.reason, '900 kr. er 10 % under den første pris, vi har set (1.000 kr.).');
  g = P.goalOutcome(auto, lo(910), null, now, { verdict: unk, history: [{ d: '2026-11-10', p: 1000 }] });
  assert(!g.hit, '9 % is not enough');
  g = P.goalOutcome(auto, lo(500), null, now, { verdict: unk, history: [] });
  assert(!g.hit, 'no history at all: nothing to compare with');
  g = P.goalOutcome(auto, null, null, now, { verdict: { level: 'unknown', text: 'x' }, history: hist });
  assert(!g.hit && g.fields.notified_price === null, 'nothing in stock');
  // the first point is the earliest by date, not by position
  assert(P.autoReason(lo(80), unk, [{ d: '2026-11-15', p: 200 }, { d: '2026-11-01', p: 100 }]), '80 is 20 % under 100');
  assert.strictEqual(P.autoReason(lo(95), unk, [{ d: '2026-11-15', p: 200 }, { d: '2026-11-01', p: 100 }]), null);
  // a verdict with a normal price (ok) never falls back to the first-price rule
  assert.strictEqual(P.autoReason(lo(1), { level: 'ok', text: 'x' }, hist), null);
  // de-duplication through notified_price, same as for price goals
  const prev = Object.assign({}, auto, { notified_price: 450 });
  g = P.goalOutcome(prev, lo(450), 500, now, { verdict: good, history: [] });
  assert(g.hit && !g.newHit && g.fields.notified_price === 450 && !('notified_at' in g.fields), 'same price: no second message');
  g = P.goalOutcome(prev, lo(440), 500, now, { verdict: good, history: [] });
  assert(g.newHit, 'lower price: announced again');
  g = P.goalOutcome(prev, lo(520), 500, now, { verdict: { level: 'poor', text: 'x' }, history: [] });
  assert(!g.hit && g.fields.notified_price === null, 'reset when no longer good');
  assert.strictEqual(P.targetPrice(auto, 500), null, 'auto has no target price');
  // today's own verdictFor produces what autoReason expects
  const v = P.verdictFor(450, 500, [], today, null);
  assert.strictEqual(v.level, 'good');
  assert.strictEqual(P.autoReason(lo(450), v, []), v.text);
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


// ---------------------------------------------------------------- generic shop pages (any host except prisjagt.dk)

const SHOP_FIX = {};
function shopHtml(n) { return SHOP_FIX[n] || (SHOP_FIX[n] = fs.readFileSync(path.join(FIX, n + '.html'), 'utf8')); }
function shopParse(n, url) { return SHOP.parseShopPage(shopHtml(n), url || 'https://www.example.dk/x'); }
const BED_URL = 'https://www.bedrenaetter.dk/mayan-kuvertlagen-180x200-hvid.html';
function resp(status, body, headers) {
  const h = headers || {};
  return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (k.toLowerCase() in h ? h[k.toLowerCase()] : null) }, text: async () => (body === undefined ? '' : body) };
}

test('shop: number formats', () => {
  const cases = [['579,00', 579], ['1.299,00', 1299], ['1299.00', 1299], ['579', 579], ['1,299.00', 1299], ['kr. 579,-', 579], ['579,-', 579], ['1.299', 1299],
    ['1 299,50', 1299.5], [' 1.299,95 kr.', 1299.95], ['12.5', 12.5], ['0,5', 0.5], ['1.234.567,89', 1234567.89], ['249.95', 249.95], ['89,9', 89.9]];
  cases.forEach(([i, o]) => assert.strictEqual(SHOP.parseNumber(i), o, JSON.stringify(i)));
  assert.strictEqual(SHOP.parseNumber(579), 579); assert.strictEqual(SHOP.parseNumber(12.5), 12.5);
  [['abc'], [''], ['-5'], ['0'], ['0,00'], [null], [undefined], [NaN], [Infinity], [{}], [[]], ['1.2.3'], ['1.299.00,5'], [0], [-3]]
    .forEach(([i]) => assert.strictEqual(SHOP.parseNumber(i), null, JSON.stringify(i)));
  assert.strictEqual(SHOP.stockFrom('https://schema.org/InStock'), true); assert.strictEqual(SHOP.stockFrom('http://schema.org/OutOfStock'), false);
  assert.strictEqual(SHOP.stockFrom('PreOrder'), false); assert.strictEqual(SHOP.stockFrom('https://schema.org/BackOrder'), false);
  assert.strictEqual(SHOP.stockFrom('LimitedAvailability'), true); assert.strictEqual(SHOP.stockFrom(undefined), true); assert.strictEqual(SHOP.stockFrom('Noget andet'), true);
  assert.strictEqual(SHOP.stockFrom('out of stock'), false); assert.strictEqual(SHOP.stockFrom('Udsolgt'), false);
});

test('shop: url guard (user-supplied links)', () => {
  ['https://www.bedrenaetter.dk/mayan.html', 'https://shop.example.com/p?id=1#x', 'http://shop.dk/vare', 'https://xn--bdrenatter-xyz.dk/a', 'https://shop.co.uk/a', '  https://shop.dk/a  ']
    .forEach((u) => assert.strictEqual(SHOP.validateShopUrl(u), u.trim(), u));
  ['', null, undefined, 42, 'ftp://shop.dk/a', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'shop.dk/a', '//shop.dk/a',
    'https://localhost/a', 'https://LOCALHOST./a', 'https://foo.localhost/a', 'https://intranet/a', 'https://printer.local/a', 'https://db.internal/a', 'https://router.lan/a', 'https://x.home.arpa/a',
    'https://127.0.0.1/a', 'https://10.0.0.5/a', 'https://192.168.1.1/a', 'https://169.254.169.254/latest/meta-data', 'https://2130706433/a', 'https://0x7f.0.0.1/a', 'https://017700000001/a', 'https://[::1]/a', 'https://[fe80::1]/a', 'https://1.2.3.4.5/a',
    'https://user:pw@shop.dk/a', 'https://shop.dk@evil.dk:80/a', 'https://shop.dk:8443/a', 'https://shop.dk:443x/a', 'https://shop/a', 'https://.dk/a', 'https://shop..dk/a', 'https://shop.d1/a', 'https://shop.dk./a/b c',
    'https://shop.dk/' + 'a'.repeat(500), 'https://shop.dk/a\nb']
    .forEach((u) => assert.strictEqual(SHOP.validateShopUrl(u), null, String(u)));
  assert.strictEqual(SHOP.registrableDomain('www.bedrenaetter.dk'), 'bedrenaetter.dk'); assert.strictEqual(SHOP.registrableDomain('shop.example.co.uk'), 'example.co.uk');
  assert.strictEqual(SHOP.registrableDomain('a.b.shop.dk'), 'shop.dk'); assert(SHOP.isPrisjagtHost('www.prisjagt.dk') && SHOP.isPrisjagtHost('prisjagt.dk') && !SHOP.isPrisjagtHost('prisjagt.dk.evil.com'));
  assert.strictEqual(R.classify('https://www.prisjagt.dk/product.php?p=1').shop, false); assert.strictEqual(R.classify(BED_URL).shop, true);
  assert.strictEqual(R.classify('http://prisjagt.dk/product.php?p=1'), null, 'a prisjagt link must stay a valid prisjagt link'); assert.strictEqual(R.classify('https://prisjagt.dk.evil.com/x').shop, true);
});

test('shop: parser on saved pages (JSON-LD, @graph, AggregateOffer, offers array, microdata, meta, stock, title, shop name)', () => {
  let r = shopParse('shop-jsonld-single', BED_URL);
  assert.strictEqual(r.source, 'json-ld'); assert.strictEqual(r.title, 'Mayan kuvertlagen 180x200 hvid');
  assert.deepStrictEqual(r.rows.map((x) => [x.store, x.price, x.url, x.inStock, x.note, x.variant]), [['Bedre Nætter', 579, BED_URL, true, null, 'shop']]);
  assert.deepStrictEqual(r.variants, [{ id: 'shop', label: 'Bedre Nætter', lowest: 579, offers: 1, sample: 'Mayan kuvertlagen 180x200 hvid' }]);
  assert.strictEqual(r.note, null); assert.deepStrictEqual(r.history, []);
  r = shopParse('shop-graph', 'https://www.soveshoppen.dk/dundyne-alpe');
  assert.strictEqual(r.source, 'json-ld'); assert.strictEqual(r.rows[0].price, 1299); assert.strictEqual(r.title, 'Dundyne Alpe 140x200');
  assert.strictEqual(r.rows[0].store, 'Soveshoppen', 'no og:site_name: host name, capitalised, without www and TLD');
  assert.strictEqual(SHOP.parseShopPage(shopHtml('shop-graph'), 'https://shop.example.co.uk/x').rows[0].store, 'Example');
  r = shopParse('shop-aggregate');
  assert.strictEqual(r.rows[0].price, 1449); assert.strictEqual(r.rows[0].store, 'Pudebutikken'); assert(/flere varianter/.test(r.note), 'lowPrice < highPrice: several prices');
  r = shopParse('shop-offers-array');
  assert.strictEqual(r.rows[0].price, 399, 'lowest in-stock price (the cheaper one is out of stock)'); assert.strictEqual(r.rows[0].inStock, true); assert.strictEqual(r.note, SHOP.MULTI_NOTE);
  // the page's canonical url / a sku in the url identify the variant
  const withUrls = shopHtml('shop-offers-array').replace('"sku":"SET-140"', '"sku":"SET-140","url":"https://www.tekstilhuset.dk/sengesaet?v=140"').replace('"sku":"SET-200"', '"sku":"SET-200","url":"https://www.tekstilhuset.dk/sengesaet?v=200"');
  r = SHOP.parseShopPage(withUrls, 'https://www.tekstilhuset.dk/sengesaet?v=140');
  assert.strictEqual(r.rows[0].price, 349); assert.strictEqual(r.rows[0].inStock, false); assert.strictEqual(r.note, null, 'url identifies the variant: no remark');
  r = SHOP.parseShopPage(withUrls.replace('<title>', '<link rel="canonical" href="https://www.tekstilhuset.dk/sengesaet?v=200"><title>'), 'https://www.tekstilhuset.dk/sengesaet?utm_source=x');
  assert.strictEqual(r.rows[0].price, 399); assert.strictEqual(r.note, null, 'canonical identifies the variant');
  r = SHOP.parseShopPage(shopHtml('shop-offers-array'), 'https://www.tekstilhuset.dk/sengesaet?sku=SET-140');
  assert.strictEqual(r.rows[0].price, 349, 'sku in the url'); assert.strictEqual(r.note, null);
  r = shopParse('shop-microdata');
  assert.strictEqual(r.source, 'microdata'); assert.strictEqual(r.rows[0].price, 249.95); assert.strictEqual(r.title, 'Plaid Hygge 130x170'); assert.strictEqual(r.rows[0].inStock, true);
  r = shopParse('shop-meta');
  assert.strictEqual(r.source, 'meta'); assert.strictEqual(r.rows[0].price, 1099); assert.strictEqual(r.title, 'Sengetøj Flora 140x200', 'og:title'); assert.strictEqual(r.rows[0].inStock, true);
  r = shopParse('shop-outofstock');
  assert.strictEqual(r.rows[0].price, 799); assert.strictEqual(r.rows[0].inStock, false); assert.strictEqual(r.variants[0].lowest, null); assert.strictEqual(r.title, 'Topmadras Komfort 90x200');
  // JSON-LD wins over meta tags; title falls back to <title>
  r = SHOP.parseShopPage(shopHtml('shop-jsonld-single').replace('</head>', '<meta property="product:price:amount" content="1"><meta property="product:price:currency" content="DKK"></head>'), BED_URL);
  assert.strictEqual(r.rows[0].price, 579);
  r = SHOP.parseShopPage('<title>Kun titel &amp; pris</title><meta property="og:price:amount" content="99,50"><meta property="og:price:currency" content="dkk">', 'https://x.dk/a');
  assert.strictEqual(r.rows[0].price, 99.5); assert.strictEqual(r.title, 'Kun titel & pris');
  // no currency: only for .dk hosts
  const nocur = '<script type="application/ld+json">{"@type":"Product","name":"N","offers":{"@type":"Offer","price":"100"}}</script>';
  assert.strictEqual(SHOP.parseShopPage(nocur, 'https://shop.dk/a').rows[0].price, 100);
  assert.throws(() => SHOP.parseShopPage(nocur, 'https://shop.com/a'), (e) => e.kind === 'currency');
  // broken JSON-LD is skipped, the next block is used
  r = SHOP.parseShopPage('<script type="application/ld+json">{not json</script>' + shopHtml('shop-jsonld-single'), BED_URL); assert.strictEqual(r.rows[0].price, 579);
  // a variant listed through @id reference and hasVariant (ProductGroup)
  const grp = '<script type="application/ld+json">{"@context":"https://schema.org","@type":"ProductGroup","name":"G","hasVariant":[{"@type":"Product","name":"G rød","sku":"R","url":"https://s.dk/g?c=r","offers":{"@type":"Offer","priceCurrency":"DKK","price":200,"availability":"InStock"}},{"@type":"Product","name":"G blå","sku":"B","url":"https://s.dk/g?c=b","offers":{"@type":"Offer","priceCurrency":"DKK","price":300,"availability":"InStock"}}]}</script>';
  r = SHOP.parseShopPage(grp, 'https://s.dk/g?c=b'); assert.strictEqual(r.rows[0].price, 300); assert.strictEqual(r.note, null); assert.strictEqual(r.title, 'G blå');
  r = SHOP.parseShopPage(grp, 'https://s.dk/g'); assert.strictEqual(r.rows[0].price, 200); assert(/flere varianter/.test(r.note));
});

test('shop: rejected pages (EUR, no price data, JavaScript-only price, bot challenge)', async () => {
  assert.throws(() => shopParse('shop-eur', 'https://www.nordichome.dk/duvet'), (e) => e instanceof PJ.PageError && e.kind === 'currency' && e.shop === true);
  assert.throws(() => shopParse('shop-noprice'), (e) => e.kind === 'noprice');
  assert.throws(() => shopParse('shop-challenge'), (e) => e.kind === 'noprice');
  const note = (n, u) => fetchShop(u || 'https://www.example.dk/x', { 'https://www.example.dk/x': shopHtml(n) }).then(() => null, (e) => R.errorNote(e));
  assert.strictEqual(await note('shop-challenge'), 'Butikken afviser automatiske opslag.');
  assert.strictEqual(await note('shop-noprice'), 'Kunne ikke finde en pris på siden.');
  assert(/ikke i kroner/.test(await note('shop-eur')));
});

async function fetchShop(url, map, calls) {
  return SHOP.fetchShopPage(url, async (u, o) => {
    if (calls) calls.push({ u, o });
    const x = map[u]; if (x === undefined) return resp(404, '');
    return typeof x === 'function' ? x() : resp(200, x);
  });
}

test('shop: fetching rules (plain GET, honest user agent, one request, blocks are final, redirects stay in the domain)', async () => {
  const calls = [];
  const r = await fetchShop(BED_URL, { [BED_URL]: shopHtml('shop-jsonld-single') }, calls);
  assert.strictEqual(r.rows[0].price, 579); assert.strictEqual(calls.length, 1, 'one request');
  const o = calls[0].o;
  assert(!o.method || o.method === 'GET'); assert(!('body' in o)); assert(/^Prisvagten-pricecheck/.test(o.headers['User-Agent']) && o.headers['User-Agent'] === PJ.UA);
  assert(!('Cookie' in o.headers) && !('Authorization' in o.headers) && !('Referer' in o.headers)); assert(o.signal && o.redirect === 'manual');
  // 401/403/429 are refusals; a challenge page too (also with status 503); nothing is retried
  for (const st of [401, 403, 429]) {
    const c = []; await assert.rejects(fetchShop(BED_URL, { [BED_URL]: () => resp(st, 'nej') }, c), (e) => e.kind === 'blocked' && e.shop);
    assert.strictEqual(c.length, 1, 'no retry after ' + st);
  }
  await assert.rejects(fetchShop(BED_URL, { [BED_URL]: shopHtml('shop-challenge') }), (e) => e.kind === 'blocked');
  await assert.rejects(fetchShop(BED_URL, { [BED_URL]: () => resp(503, shopHtml('shop-challenge')) }), (e) => e.kind === 'blocked');
  await assert.rejects(fetchShop(BED_URL, { [BED_URL]: () => resp(503, 'Vedligehold') }), (e) => e.kind === 'network');
  await assert.rejects(fetchShop(BED_URL, { [BED_URL]: () => resp(404, '') }), (e) => e.kind === 'notfound');
  await assert.rejects(fetchShop(BED_URL, { [BED_URL]: () => { throw new Error('ECONNRESET'); } }), (e) => e.kind === 'network');
  await assert.rejects(fetchShop(BED_URL, { [BED_URL]: () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; } }), (e) => e.kind === 'timeout');
  // a captcha script on a normal page with a price is not a block
  const withCaptcha = shopHtml('shop-jsonld-single').replace('</body>', '<script src="https://www.google.com/recaptcha/api.js?render=x"></script><div class="g-recaptcha captcha"></div></body>');
  assert.strictEqual((await fetchShop(BED_URL, { [BED_URL]: withCaptcha })).rows[0].price, 579);
  // unsafe links are refused before any request
  const c2 = []; await assert.rejects(fetchShop('https://127.0.0.1/x', {}, c2), (e) => e.shop); await assert.rejects(fetchShop('ftp://shop.dk/x', {}, c2)); assert.strictEqual(c2.length, 0);
  // redirects: followed inside the registrable domain only
  const c3 = [];
  const ok = await fetchShop('https://bedrenaetter.dk/gammel', { 'https://bedrenaetter.dk/gammel': () => resp(301, '', { location: BED_URL }), [BED_URL]: shopHtml('shop-jsonld-single') }, c3);
  assert.strictEqual(ok.rows[0].price, 579); assert.deepStrictEqual(c3.map((x) => x.u), ['https://bedrenaetter.dk/gammel', BED_URL]);
  for (const loc of ['https://evil.example.com/p', 'http://localhost/p', 'https://10.0.0.1/p', 'https://bedrenaetter.dk.evil.com/p', 'ftp://bedrenaetter.dk/p']) {
    const c = []; await assert.rejects(fetchShop(BED_URL, { [BED_URL]: () => resp(302, '', { location: loc }) }, c), (e) => e.kind === 'network' && e.shop, loc);
    assert.strictEqual(c.length, 1, 'the foreign location is never requested: ' + loc);
  }
  await assert.rejects(fetchShop(BED_URL, { [BED_URL]: () => resp(302, '', { location: BED_URL }) }), (e) => /omdirigeringer/.test(e.message), 'redirect loop ends');
});

function shopProduct(id, user, url, extra) { return product(id, user, 'dyson', Object.assign({ source_url: url, name: 'Vare ' + id }, extra || {})); }
function shopCtx(db, map, extra) {
  const calls = [];
  const ctx = ctxFor(db, {}, Object.assign({
    getPage: async (url) => { ctx.fetched.push(url); return fetchShop(url, map, calls); }, calls,
  }, extra || {}));
  return ctx;
}

test('run: shop link pending -> tracking, later run with a lower price mails, no mail twice', async () => {
  const db = newDb();
  db.products.push(shopProduct('S1', 'u1', BED_URL, { name: 'Mayan kuvertlagen', target_value: 500 }));
  const map = { [BED_URL]: shopHtml('shop-jsonld-single') };
  let ctx = shopCtx(db, map);
  let res = await R.run(ctx);
  const S = () => db.products[0];
  assert.deepStrictEqual(ctx.fetched, [BED_URL]); assert.strictEqual(res.summary.length, 5);
  assert.strictEqual(S().status, 'tracking'); assert.deepStrictEqual(S().tracked_variants, ['shop']);
  assert.strictEqual(S().title, 'Mayan kuvertlagen 180x200 hvid');
  assert.deepStrictEqual(S().variants, [{ id: 'shop', label: 'Bedre Nætter', lowest: 579, offers: 1, sample: 'Mayan kuvertlagen 180x200 hvid' }]);
  assert.deepStrictEqual(S().offers, [{ store: 'Bedre Nætter', price: 579, url: BED_URL, inStock: true, note: null, variant: 'shop' }]);
  assert.deepStrictEqual(S().history, [{ d: '2026-11-16', p: 579, s: 'Bedre Nætter', src: 'check' }], 'history starts with today\'s own check');
  assert.strictEqual(S().verdict.level, 'unknown'); assert.strictEqual(S().normal_price, null); assert.strictEqual(S().warning, null); assert.strictEqual(S().check_note, null);
  assert.strictEqual(S().notified_price, null); assert.strictEqual(db.sent.length, 0); assert.strictEqual(S().last_checked, '2026-11-16T10:00:00Z');
  // the next run: a lower price at or under the goal -> one hit e-mail
  map[BED_URL] = shopHtml('shop-jsonld-single').replace('"579.00"', '"489,00"');
  ctx = shopCtx(db, map); res = await R.run(ctx);
  assert.strictEqual(S().offers[0].price, 489); assert.strictEqual(S().notified_price, 489); assert.strictEqual(res.stats.hits, 1);
  assert.strictEqual(db.sent.length, 1); assert.deepStrictEqual(db.sent[0].to, ['anna@example.dk']); assert(db.sent[0].text.includes('Mayan') && db.sent[0].text.includes('489 kr.') && db.sent[0].text.includes('Bedre Nætter'), db.sent[0].text);
  assert.strictEqual(S().history.length, 1); assert.strictEqual(S().history[0].p, 489, 'same day: the lower point wins');
  ctx = shopCtx(db, map); await R.run(ctx); assert.strictEqual(db.sent.length, 1, 'same price again: no second e-mail');
  // out of stock: no hit, no new history price
  map[BED_URL] = shopHtml('shop-jsonld-single').replace('https://schema.org/InStock', 'https://schema.org/OutOfStock');
  ctx = shopCtx(db, map); await R.run(ctx);
  assert.strictEqual(S().offers[0].inStock, false); assert.strictEqual(S().verdict.level, 'unknown'); assert.strictEqual(S().notified_price, null);
  // several variants on the page: a short Danish remark in check_note
  const db2 = newDb(); const U2 = 'https://www.tekstilhuset.dk/sengesaet';
  db2.products.push(shopProduct('S2', 'u1', U2, { target_value: 1 }));
  await R.run(shopCtx(db2, { [U2]: shopHtml('shop-offers-array') }));
  assert.strictEqual(db2.products[0].status, 'tracking'); assert.strictEqual(db2.products[0].offers[0].price, 399); assert.strictEqual(db2.products[0].check_note, SHOP.MULTI_NOTE);
  // the sanity check against the previous lowest applies to shops too
  const db3 = newDb();
  db3.products.push(shopProduct('S3', 'u1', BED_URL, { status: 'tracking', tracked_variants: ['shop'], offers: [{ store: 'Bedre Nætter', price: 2000, inStock: true, url: BED_URL, note: null, variant: 'shop' }] }));
  await R.run(shopCtx(db3, { [BED_URL]: shopHtml('shop-jsonld-single') }));
  assert(/forkerte/.test(db3.products[0].check_note) && db3.products[0].offers[0].price === 2000);
});

test('run: shop errors are specific; a refusal skips the rest of that host only; error retry after six hours', async () => {
  const db = newDb();
  const A1 = 'https://www.afvisende.dk/a', A2 = 'https://afvisende.dk/b', B1 = 'https://www.fornuftig.dk/c', EUR = 'https://www.udlandet.dk/d', NOP = 'https://www.tom.dk/e', CH = 'https://www.udfordring.dk/f', CH2 = 'https://www.udfordring.dk/g';
  db.products.push(shopProduct('X1', 'u1', A1), shopProduct('X2', 'u1', A2), shopProduct('X3', 'u1', B1, { target_value: 1 }), shopProduct('X4', 'u1', EUR), shopProduct('X5', 'u1', NOP),
    shopProduct('X6', 'u1', CH), shopProduct('X7', 'u1', CH2), product('X8', 'u1', 'dyson', { target_value: 1 }));
  const map = { [A1]: () => resp(403, 'Forbidden'), [A2]: shopHtml('shop-jsonld-single'), [B1]: shopHtml('shop-jsonld-single'), [EUR]: shopHtml('shop-eur'), [NOP]: shopHtml('shop-noprice'), [CH]: shopHtml('shop-challenge'), [CH2]: shopHtml('shop-jsonld-single') };
  let ctx = shopCtx(db, map, { getPage: undefined });
  const dyson = pageFor('dyson');
  ctx.getPage = async (url) => { ctx.fetched.push(url); return url.indexOf('prisjagt.dk') !== -1 ? dyson : fetchShop(url, map, ctx.calls); };
  const res = await R.run(ctx);
  const by = (id) => db.products.find((p) => p.id === id);
  assert.strictEqual(by('X1').status, 'error'); assert.strictEqual(by('X1').check_note, 'Butikken afviser automatiske opslag.');
  assert.strictEqual(by('X2').status, 'pending', 'same host (www dropped): not fetched, not touched'); assert(!ctx.fetched.includes(A2));
  assert.strictEqual(by('X3').status, 'tracking', 'other hosts carry on'); assert.strictEqual(by('X8').status, 'tracking', 'prisjagt carries on');
  assert(/ikke i kroner/.test(by('X4').check_note) && by('X4').status === 'error');
  assert.strictEqual(by('X5').status, 'error'); assert.strictEqual(by('X5').check_note, 'Kunne ikke finde en pris på siden.');
  assert.strictEqual(by('X6').status, 'error'); assert.strictEqual(by('X6').check_note, 'Butikken afviser automatiske opslag.'); assert.strictEqual(by('X7').status, 'pending'); assert(!ctx.fetched.includes(CH2));
  assert.deepStrictEqual(res.stats.blockedHosts.sort(), ['afvisende.dk', 'udfordring.dk']); assert(res.stats.blocked);
  assert(/afvist af afvisende\.dk, udfordring\.dk/.test(res.summary[1]), res.summary[1]);
  assert.strictEqual(res.stats.pages, ctx.fetched.length, 'one request per product at most');
  // the error is retried after six hours (not before), and still only one request per product
  ctx = shopCtx(db, map); await R.run(ctx); assert(!ctx.fetched.includes(A1) && !ctx.fetched.includes(NOP), 'error rows wait six hours');
  by('X1').last_checked = '2026-11-16T03:00:00Z'; map[A1] = shopHtml('shop-jsonld-single');
  ctx = shopCtx(db, map); await R.run(ctx); assert.strictEqual(by('X1').status, 'tracking'); assert(ctx.fetched.includes(A1));
  // an unusable link: error without any fetch
  const db4 = newDb(); db4.products.push(shopProduct('Y1', 'u1', 'http://localhost/x'), shopProduct('Y2', 'u1', 'https://intranet/x'), shopProduct('Y3', 'u1', 'https://prisjagt.dk/'));
  ctx = shopCtx(db4, {}); await R.run(ctx);
  assert.deepStrictEqual(ctx.fetched, []); assert(db4.products.every((p) => p.status === 'error' && /Linket/.test(p.check_note)));
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

test("e-mail text for goal 'auto': one sentence on why, own subject; price goals unchanged", () => {
  const r = 'Prisen er 12 % under den første pris, vi har set (600 kr.).';
  const m = composeMail([{ name: 'Vare', price: 528, store: 'Shop', url: 'https://shop.dk/x', verdict: 'Der er endnu ikke nok prishistorik til at vurdere prisen.', warning: null, reason: r }], '');
  assert.strictEqual(m.subject, 'Prisvagten: 1 godt tilbud');
  assert(m.text.includes('Derfor får du besked: ' + r) && !m.text.includes('ikke nok prishistorik') && !/målpris/.test(m.text), m.text);
  const two = composeMail([{ name: 'A', price: 1, store: 'S', url: 'https://x', reason: r }, { name: 'B', price: 2, store: 'S', url: 'https://x', reason: r }], '');
  assert.strictEqual(two.subject, 'Prisvagten: 2 gode tilbud');
  const mixed = composeMail([{ name: 'A', price: 1, store: 'S', url: 'https://x', reason: r }, { name: 'B', price: 2, store: 'S', url: 'https://x' }], '');
  assert.strictEqual(mixed.subject, 'Prisvagten: 2 priser at kigge på');
  assert(mixed.text.includes('Derfor får du besked') && mixed.text.includes('2. B'));
  assert(!/—/.test(m.text + mixed.text + two.text), 'no em-dash');
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
          rows = rows.filter((r) => r.active !== false && (r.source_url || db.ignoreLinkFilter));   // db.ignoreLinkFilter: a server that wrongly returns name-only rows
        }
        if (q.get('user_id') && /^in\.\((.*)\)$/.test(q.get('user_id'))) { const ids = /^in\.\((.*)\)$/.exec(q.get('user_id'))[1].split(','); rows = rows.filter((r) => ids.indexOf(r.user_id) !== -1); }
        if (mm[1] === 'access_requests') {
          ['status', 'owner_notified_at', 'requester_notified_at'].forEach((c) => {
            const f = q.get(c); if (!f) return;
            if (f === 'is.null') rows = rows.filter((r) => r[c] == null); else if (/^eq\./.test(f)) rows = rows.filter((r) => r[c] === f.slice(3));
          });
        }
        if (mm[1] === 'allowed_emails' && q.get('is_admin') === 'eq.true') rows = rows.filter((r) => r.is_admin === true);
        if (q.get('email') && /^eq\./.test(q.get('email'))) rows = rows.filter((r) => r.email === q.get('email').slice(3));
        return reply(200, JSON.parse(JSON.stringify(rows)));
      }
      if (m === 'PATCH') {
        assert.strictEqual(h.Prefer, 'return=minimal');
        if (mm[1] === 'access_requests') {
          const em = /^eq\.(.+)$/.exec(q.get('email'))[1];
          assert.strictEqual(Object.keys(JSON.parse(opts.body)).length, 1, 'only one *_notified_at column is written');
          const rr = t.find((r) => r.email === em); if (!rr) return reply(204);
          const col = Object.keys(JSON.parse(opts.body))[0]; assert(/_notified_at$/.test(col));
          if (q.get(col) === 'is.null' && rr[col] != null) return reply(204);
          if (db.accessPatchFail) return reply(500, { message: 'db error' });
          rr[col] = JSON.parse(opts.body)[col]; return reply(204);
        }
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
    products: [], profiles: [], allowed_emails: [{ email: 'anna@example.dk', is_admin: true }, { email: 'bo@example.dk' }], access_requests: [],
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

test("run: goal 'auto' notifies once with the reason; no history gives no mail; price goals need no verdict", async () => {
  // tracking product with an earlier price of 700 in its history (too short for a normal price); today the shop has 579 (17 % under)
  const db = newDb();
  const old = [{ d: '2026-11-01', p: 700, s: 'Bedre Nætter', src: 'check' }];
  db.products.push(shopProduct('AU', 'u1', BED_URL, { name: 'Mayan', target_type: 'auto', target_value: null, status: 'tracking', tracked_variants: ['shop'], history: old }));
  const map = { [BED_URL]: shopHtml('shop-jsonld-single') };
  let res = await R.run(shopCtx(db, map));
  const A = () => db.products[0];
  assert.strictEqual(res.stats.hits, 1); assert.strictEqual(A().notified_price, 579); assert(A().notified_at);
  assert.strictEqual(db.sent.length, 1); assert.strictEqual(db.sent[0].subject, 'Prisvagten: 1 godt tilbud');
  assert(db.sent[0].text.includes('Derfor får du besked: 579 kr. er 17 % under den første pris, vi har set (700 kr.).'), db.sent[0].text);
  await R.run(shopCtx(db, map)); assert.strictEqual(db.sent.length, 1, 'same price again: no second e-mail');
  assert.strictEqual(A().target_type, 'auto');
  // the next price is lower: one more message
  map[BED_URL] = shopHtml('shop-jsonld-single').replace('"579.00"', '"489,00"');
  await R.run(shopCtx(db, map)); assert.strictEqual(db.sent.length, 2); assert.strictEqual(A().notified_price, 489);
  // new product with no history: first run records the first price, no mail
  const db2 = newDb();
  db2.products.push(shopProduct('AU2', 'u1', BED_URL, { target_type: 'auto', target_value: null }));
  await R.run(shopCtx(db2, { [BED_URL]: shopHtml('shop-jsonld-single') }));
  assert.strictEqual(db2.products[0].status, 'tracking'); assert.strictEqual(db2.products[0].notified_price, null); assert.strictEqual(db2.sent.length, 0);
  // only 5 % under the first price: no mail
  const db3 = newDb();
  db3.products.push(shopProduct('AU3', 'u1', BED_URL, { target_type: 'auto', target_value: null, status: 'tracking', tracked_variants: ['shop'], history: [{ d: '2026-11-01', p: 610, s: 'x', src: 'check' }] }));
  await R.run(shopCtx(db3, { [BED_URL]: shopHtml('shop-jsonld-single') }));
  assert.strictEqual(db3.products[0].notified_price, null); assert.strictEqual(db3.sent.length, 0);
  // opted out of e-mail: the hit is recorded, nothing is sent
  const db4 = newDb();
  db4.products.push(shopProduct('AU4', 'u3', BED_URL, { target_type: 'auto', target_value: null, status: 'tracking', tracked_variants: ['shop'], history: old }));
  db4.profiles.push({ user_id: 'u3', notify_email: false, shops_always: [], shops_exclude: [], shops_only: false });
  await R.run(shopCtx(db4, { [BED_URL]: shopHtml('shop-jsonld-single') }));
  assert.strictEqual(db4.products[0].notified_price, 579); assert.strictEqual(db4.sent.length, 0);
});

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
  db.products.push(product('E1', 'u1', 'dyson', { source_url: 'https://127.0.0.1/x' }));
  db.products.push(product('E2', 'u1', 'roborock', { source_url: 'https://prisjagt.dk/product.php?p=999' }));        // 404
  db.products.push(product('E3', 'u1', 'lego'));
  db.products.push(product('E4', 'u1', 'ps5'));
  const pages = {}; pages[urlOf('lego')] = pageFor('lego'); pages[urlOf('ps5')] = new PJ.PageError('blocked', 'HTTP 429');
  let ctx = ctxFor(db, pages); await R.run(ctx);
  const by = (id) => db.products.find((p) => p.id === id);
  assert.strictEqual(by('E1').status, 'error'); assert(/Linket kan ikke bruges/.test(by('E1').check_note));
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

test('name-only products (source_url null) are skipped silently: no fetch, no write, no 6-hour error retry', async () => {
  for (const wrongServer of [false, true]) {
    const db = newDb(); db.ignoreLinkFilter = wrongServer;
    db.products.push(
      product('N1', 'u1', 'lego', { source_url: null, name: 'Kun et navn' }),
      product('N2', 'u1', 'lego', { source_url: null, status: 'error', check_note: 'Ikke fundet', last_checked: '2026-11-10T10:00:00Z' }),   // error for > 6 h
      product('N3', 'u1', 'lego', { source_url: null, status: 'error', check_note: 'Ikke fundet', last_checked: null }),
      product('L1', 'u1', 'ps5'));
    const logs = [];
    const ctx = ctxFor(db, { [urlOf('ps5')]: pageFor('ps5') }, { log: (l) => logs.push(l) });
    const r = await R.run(ctx);
    assert.deepStrictEqual(ctx.fetched, [urlOf('ps5')], 'only the product with a link is fetched');
    assert.deepStrictEqual(db.patches.map((x) => x.id), ['L1']);
    assert.strictEqual(r.stats.total, 1);
    assert(db.products.slice(0, 3).every((x) => x.source_url === null) && db.products[1].status === 'error' && db.products[1].check_note === 'Ikke fundet');
    assert(!logs.some((l) => /Kun et navn|N1|N2|N3/.test(l)), 'nothing logged about them');
  }
});

test('access requests: one e-mail to the admins, one to each approved person, sanitised, never twice, never without Resend', async () => {
  const mk = () => {
    const db = newDb();
    db.allowed_emails.push({ email: 'far@example.dk', is_admin: true }, { email: 'ny@example.dk' }, { email: 'tidligere@example.dk' });
    db.access_requests.push(
      { email: 'kim@example.dk', name: 'Kim\r\nBcc: spam@evil.dk\u0000\u202e Hansen', status: 'pending', owner_notified_at: null, requester_notified_at: null },
      { email: 'lis@example.dk', name: null, status: 'pending', owner_notified_at: null, requester_notified_at: null },
      { email: 'gammel@example.dk', name: 'Allerede meldt', status: 'pending', owner_notified_at: '2026-11-15T10:00:00Z', requester_notified_at: null },
      { email: 'ny@example.dk', name: 'Ny', status: 'approved', owner_notified_at: '2026-11-15T10:00:00Z', requester_notified_at: null },
      { email: 'tidligere@example.dk', name: 'Tidligere', status: 'approved', owner_notified_at: '2026-11-15T10:00:00Z', requester_notified_at: '2026-11-15T11:00:00Z' },
      { email: 'nej@example.dk', name: 'Afvist', status: 'rejected', owner_notified_at: '2026-11-15T10:00:00Z', requester_notified_at: null });
    return db;
  };
  const arq = (db, e) => db.access_requests.find((r) => r.email === e);

  // no Resend key: nothing sent, nothing marked; the price work is unaffected
  const db0 = mk();
  const logs = [];
  const r0 = await R.run(ctxFor(db0, {}, { resendKey: '', log: (l) => logs.push(l) }));
  assert.strictEqual(db0.sent.length, 0);
  assert.strictEqual(arq(db0, 'kim@example.dk').owner_notified_at, null); assert.strictEqual(arq(db0, 'ny@example.dk').requester_notified_at, null);
  assert(/RESEND_API_KEY/.test(r0.summary.join('\n')) && logs.some((l) => /springes over/.test(l)));

  // with a key: one mail to both admins, one to the approved person
  const db = mk();
  const r1 = await R.run(ctxFor(db, {}));
  assert.strictEqual(db.sent.length, 2); assert.strictEqual(r1.stats.sent, 2);
  const owner = db.sent.find((m) => m.to.length === 2), req = db.sent.find((m) => m.to.length === 1);
  assert.deepStrictEqual(owner.to.slice().sort(), ['anna@example.dk', 'far@example.dk']);
  assert(/2 nye anmodninger/.test(owner.subject) && owner.text.includes('kim@example.dk') && owner.text.includes('lis@example.dk'));
  assert(owner.text.includes('https://example.github.io/prisvagten/') && /Godkend/.test(owner.text));
  assert(!/gammel@|nej@|ny@example|tidligere@/.test(owner.text), 'only requests not yet reported');
  assert(!/Allerede meldt/.test(owner.text));
  assert(/Kim Bcc: spam@evil\.dk Hansen/.test(owner.text), 'newlines, NUL and bidi control characters in the name become spaces: ' + owner.text);
  assert(!/[\u0000-\u0009\u000b-\u001f\u202e]/.test(owner.text) && !/\r/.test(owner.text) && !/^Bcc:/m.test(owner.text), 'no injected line');
  assert(!/<html|<a /i.test(owner.text) && owner.subject.indexOf('Kim') < 0, 'plain text, nothing untrusted in the subject');
  assert.deepStrictEqual(req.to, ['ny@example.dk']); assert.strictEqual(req.subject, 'Du har fået adgang til Prisvagten');
  assert(req.text.includes('https://example.github.io/prisvagten/') && /Send login-link/.test(req.text) && /mail/.test(req.text));
  assert.strictEqual(arq(db, 'kim@example.dk').owner_notified_at, '2026-11-16T10:00:00Z');
  assert.strictEqual(arq(db, 'lis@example.dk').owner_notified_at, '2026-11-16T10:00:00Z');
  assert.strictEqual(arq(db, 'ny@example.dk').requester_notified_at, '2026-11-16T10:00:00Z');
  assert.strictEqual(arq(db, 'nej@example.dk').requester_notified_at, null, 'a rejected requester is never mailed');
  assert(!db.sent.some((m) => m.to.indexOf('nej@example.dk') >= 0 || m.to.indexOf('kim@example.dk') >= 0 || m.to.indexOf('lis@example.dk') >= 0), 'pending and rejected requesters get nothing');

  // second run: nothing more
  await R.run(ctxFor(db, {}));
  assert.strictEqual(db.sent.length, 2, 'a second run sends nothing more');

  // a late approval is mailed once, next run
  arq(db, 'kim@example.dk').status = 'approved'; db.allowed_emails.push({ email: 'kim@example.dk' });
  await R.run(ctxFor(db, {})); assert.strictEqual(db.sent.length, 3); assert.deepStrictEqual(db.sent[2].to, ['kim@example.dk']);
  await R.run(ctxFor(db, {})); assert.strictEqual(db.sent.length, 3);

  // Resend failing: not marked, retried next run
  const dbf = mk(); dbf.resendFail = true;
  await R.run(ctxFor(dbf, {}));
  assert.strictEqual(arq(dbf, 'kim@example.dk').owner_notified_at, null); assert.strictEqual(arq(dbf, 'ny@example.dk').requester_notified_at, null);
  dbf.resendFail = false; await R.run(ctxFor(dbf, {})); assert.strictEqual(dbf.sent.length, 2);

  // approved but access removed again: no "you have access" mail
  const dbr = mk(); dbr.allowed_emails = dbr.allowed_emails.filter((a) => a.email !== 'ny@example.dk');
  await R.run(ctxFor(dbr, {})); assert(!dbr.sent.some((m) => m.to.indexOf('ny@example.dk') >= 0));

  // counts towards the cap of 20; the rest waits for the next run
  const dbc = newDb();
  for (let i = 0; i < 25; i++) { dbc.allowed_emails.push({ email: 'g' + i + '@example.dk' }); dbc.access_requests.push({ email: 'g' + i + '@example.dk', name: 'G' + i, status: 'approved', decided_at: '2026-11-15T10:00:00Z', owner_notified_at: null, requester_notified_at: null }); }
  const rc = await R.run(ctxFor(dbc, {}));
  assert.strictEqual(dbc.sent.length, 20, 'one owner mail (pending ones: none here) + approved up to the cap'); assert.strictEqual(rc.stats.sent, 20);
  assert.strictEqual(dbc.access_requests.filter((r) => r.requester_notified_at).length, 20);
  await R.run(ctxFor(dbc, {})); assert.strictEqual(dbc.sent.length, 25);

  // one failing step does not stop the other: marking fails -> logged, run still completes
  const dbm = mk(); dbm.accessPatchFail = true;
  const rm = await R.run(ctxFor(dbm, {}));
  assert.strictEqual(rm.summary.length, 5); assert.strictEqual(dbm.sent.length, 2);
});

// ---------------------------------------------------------------- Internet Archive backfill (hand-written fixtures: web.archive.org was not reachable when this was written)

const CDX_FIX = fs.readFileSync(path.join(FIX, 'wayback-cdx.json'), 'utf8');
// capture html: the saved single-shop page with another price / currency
function capHtml(price, cur) { return shopHtml('shop-jsonld-single').replace('"579.00"', '"' + price + '"').replace('"DKK"', '"' + (cur || 'DKK') + '"'); }
// what the fake archive answers per timestamp: html string, a number (status), or a function
function archiveCaptures(priceOf) {
  const p = priceOf || ((x) => x);
  return {
    '20251014101500': () => resp(200, capHtml(p(649))), '20251120083000': () => resp(200, capHtml(p(629))),
    '20251218120000': () => resp(200, shopHtml('shop-noprice')), '20260110121212': () => resp(200, capHtml(p(79), 'EUR')),
    '20260215093000': () => resp(200, capHtml(p(599))), '20260312101010': () => resp(404, 'not found'),
    '20260421120000': () => resp(302, '', { location: '/web/20260421121530id_/' + BED_URL }), '20260421121530': () => resp(200, capHtml(p(589))),
    '20260915130000': () => resp(200, capHtml(p(560))),
  };
}
// a fake fetch for web.archive.org; calls collects {u, o}; cdx = body for the CDX request (string or function)
function archiveFake(caps, calls, cdx) {
  return async (u, o) => {
    calls.push({ u, o });
    const x = new URL(u);
    assert.strictEqual(x.hostname, 'web.archive.org', 'only web.archive.org is contacted: ' + u); assert.strictEqual(x.protocol, 'https:');
    if (x.pathname === '/cdx/search/cdx') return typeof cdx === 'function' ? cdx(u) : resp(200, cdx === undefined ? CDX_FIX : cdx);
    const m = /^\/web\/(\d{14})id_\/(.+)$/.exec(x.pathname + x.search);
    assert(m, 'unexpected archive path ' + u);
    const f = caps[m[1]]; if (!f) return resp(404, '');
    return typeof f === 'function' ? f() : resp(200, f);
  };
}
const wbSleeps = () => { const a = []; a.fn = async (ms) => { a.push(ms); }; return a; };

test('wayback: CDX query, header row, empty results, spreading, month window', () => {
  const u = new URL(WB.cdxUrl(BED_URL, '2026-11-16'));
  assert.strictEqual(u.origin + u.pathname, 'https://web.archive.org/cdx/search/cdx');
  assert.strictEqual(u.searchParams.get('url'), BED_URL); assert.strictEqual(u.searchParams.get('output'), 'json');
  assert.deepStrictEqual(u.searchParams.getAll('filter'), ['statuscode:200', 'mimetype:text/html']);
  assert.strictEqual(u.searchParams.get('collapse'), 'timestamp:6'); assert.strictEqual(u.searchParams.get('from'), '202510'); assert.strictEqual(u.searchParams.get('limit'), '40');
  assert(WB.cdxUrl(BED_URL, '2026-11-16').includes('url=' + encodeURIComponent(BED_URL)));
  assert.strictEqual(WB.fromMonth('2026-01-05'), '202412'); assert.strictEqual(WB.fromMonth('2026-02-28'), '202501'); assert.strictEqual(WB.fromMonth('2026-12-01'), '202511');
  assert.strictEqual(WB.captureUrl('20251014101500', BED_URL), 'https://web.archive.org/web/20251014101500id_/' + BED_URL);
  const ts = WB.parseCdx(CDX_FIX); assert.strictEqual(ts.length, 8); assert.strictEqual(ts[0], '20251014101500'); assert(!ts.includes('urlkey') && !ts.includes('timestamp'));
  assert.deepStrictEqual(WB.parseCdx('[]'), []); assert.deepStrictEqual(WB.parseCdx(''), []); assert.deepStrictEqual(WB.parseCdx('[["urlkey","timestamp","original","mimetype","statuscode","digest","length"]]'), []);
  assert.strictEqual(WB.parseCdx('<html>nope</html>'), null); assert.strictEqual(WB.parseCdx('{"a":1}'), null);
  const many = []; for (let i = 0; i < 30; i++) many.push(String(i));
  const sp = WB.spread(many, 14); assert.strictEqual(sp.length, 14); assert.strictEqual(sp[0], '0'); assert.strictEqual(sp[13], '29'); assert.deepStrictEqual(sp.slice().sort((a, b) => a - b), sp);
  assert.deepStrictEqual(WB.spread(['a', 'b', 'c'], 14), ['a', 'b', 'c']);
});

test('wayback: captures are parsed; no price, EUR, 404 are dropped; a redirect inside web.archive.org is followed', async () => {
  const calls = [], sl = wbSleeps();
  const r = await WB.backfill(BED_URL, { fetch: archiveFake(archiveCaptures(), calls), sleep: sl.fn, today: '2026-11-16' });
  assert.strictEqual(r.status, 'ok'); assert.strictEqual(r.captures, 8);
  assert.deepStrictEqual(r.points, [
    { d: '2025-10-14', p: 649, s: 'Bedre Nætter', src: 'backfill' }, { d: '2025-11-20', p: 629, s: 'Bedre Nætter', src: 'backfill' },
    { d: '2026-02-15', p: 599, s: 'Bedre Nætter', src: 'backfill' }, { d: '2026-04-21', p: 589, s: 'Bedre Nætter', src: 'backfill' }, { d: '2026-09-15', p: 560, s: 'Bedre Nætter', src: 'backfill' }]);
  // 1 CDX + 8 captures + 1 redirect hop; sequential, honest, GET only, pause before every request but the first
  assert.strictEqual(calls.length, 10); assert.strictEqual(sl.length, 9); assert(sl.every((ms) => ms >= 1000 && ms <= 1500), JSON.stringify(sl));
  calls.forEach((c) => { assert(c.o.headers['User-Agent'] === PJ.UA); assert(!c.o.method || c.o.method === 'GET'); assert(c.o.signal && c.o.redirect === 'manual'); assert(!('Cookie' in c.o.headers)); });
  assert(calls[1].u === 'https://web.archive.org/web/20251014101500id_/' + BED_URL);
  // a redirect to another host is never followed
  const c2 = [];
  const r2 = await WB.backfill(BED_URL, { fetch: async (u, o) => { c2.push(u); if (/cdx/.test(u)) return resp(200, CDX_FIX); return resp(302, '', { location: 'https://evil.example.com/x' }); }, sleep: async () => {}, today: '2026-11-16' });
  assert.deepStrictEqual(r2.points, []); assert(c2.every((u) => /^https:\/\/web\.archive\.org\//.test(u)), 'the foreign location is never requested');
  // unusable links are not even asked about
  const c3 = []; const r3 = await WB.backfill('http://127.0.0.1/x', { fetch: async (u) => { c3.push(u); return resp(200, '[]'); }, today: '2026-11-16' }); assert.strictEqual(c3.length, 0); assert.deepStrictEqual(r3.points, []);
  // empty CDX answer: finished, nothing found, no capture requests
  const c4 = []; const r4 = await WB.backfill(BED_URL, { fetch: archiveFake({}, c4, '[]'), sleep: async () => {}, today: '2026-11-16' });
  assert.strictEqual(r4.status, 'ok'); assert.strictEqual(c4.length, 1); assert.deepStrictEqual(r4.points, []);
});

test('wayback: at most 14 captures; 429 or 5xx stops everything; timeouts and the time budget end it', async () => {
  // 30 captures in the CDX answer -> 14 fetched, oldest and newest among them
  const rows = [['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length']]; const caps = {};
  for (let i = 0; i < 30; i++) { const ts = '2026' + String(1 + (i % 10)).padStart(2, '0') + String(1 + Math.floor(i / 10)).padStart(2, '0') + '120000'; rows.push(['k', ts, BED_URL, 'text/html', '200', 'x', '1']); caps[ts] = () => resp(200, capHtml(500 + i)); }
  const c1 = []; const r1 = await WB.backfill(BED_URL, { fetch: archiveFake(caps, c1, JSON.stringify(rows)), sleep: async () => {}, today: '2026-11-16' });
  assert.strictEqual(r1.captures, 14); assert.strictEqual(c1.length, 15);
  // 429 in the middle: what was found stays, nothing more is requested, no retry
  for (const st of [429, 500, 503]) {
    const c = []; const caps2 = archiveCaptures(); caps2['20260215093000'] = () => resp(st, 'slow down');
    const r = await WB.backfill(BED_URL, { fetch: archiveFake(caps2, c), sleep: async () => {}, today: '2026-11-16' });
    assert.strictEqual(r.status, 'stopped', 'HTTP ' + st); assert.deepStrictEqual(r.points.map((x) => x.d), ['2025-10-14', '2025-11-20']);
    assert.strictEqual(c.filter((x) => /20260215093000/.test(x.u)).length, 1, 'no retry'); assert(!c.some((x) => /20260421|20260915/.test(x.u)), 'stopped for good');
  }
  // the CDX request itself refused / unreachable / not json / timing out
  for (const cdx of [() => resp(429, ''), () => resp(503, ''), () => { throw new Error('ECONNRESET'); }, () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }, () => resp(200, '<html>maintenance</html>')]) {
    const c = []; const r = await WB.backfill(BED_URL, { fetch: archiveFake({}, c, cdx), sleep: async () => {}, today: '2026-11-16' });
    assert.strictEqual(r.status, 'stopped'); assert.strictEqual(c.length, 1); assert.deepStrictEqual(r.points, []);
  }
  // one capture timing out is only skipped
  const caps3 = archiveCaptures(); caps3['20251120083000'] = () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
  const r3 = await WB.backfill(BED_URL, { fetch: archiveFake(caps3, []), sleep: async () => {}, today: '2026-11-16' });
  assert.strictEqual(r3.status, 'ok'); assert.strictEqual(r3.points.length, 4);
  // time budget (fake clock: every request takes 25 s)
  let t = 0; const c5 = [];
  const slow = archiveFake(archiveCaptures(), c5); const r5 = await WB.backfill(BED_URL, { fetch: async (u, o) => { t += 25000; return slow(u, o); }, sleep: async (ms) => { t += ms; }, now: () => t, today: '2026-11-16' });
  assert.strictEqual(r5.status, 'stopped'); assert(c5.length <= 4, 'about 60 s: ' + c5.length);
  // a per-request timeout is set (20 s)
  assert.strictEqual(WB.TIMEOUT_MS, 20000); assert.strictEqual(WB.BUDGET_MS, 60000); assert.strictEqual(WB.PAUSE_MS, 1500); assert.strictEqual(WB.MAX_CAPTURES, 14);
});

test('pricing: archive points merge without overwriting; the first price seen ignores them', () => {
  const hist = [{ d: '2026-02-15', p: 700, s: 'X', src: 'check' }, { d: '2026-11-16', p: 579, s: 'X', src: 'check' }];
  const pts = [{ d: '2025-10-14', p: 649, s: 'X' }, { d: '2026-02-15', p: 599, s: 'X' }, { d: '2026-11-16', p: 1, s: 'X' }, { d: '2026-12-01', p: 1, s: 'X' }, { d: '2020-01-01', p: 5, s: 'X' }, { d: '2026-03-01', p: -3, s: 'X' }];
  const m = P.mergeBackfill(hist, pts, '2026-11-16');
  assert.deepStrictEqual(m, [{ d: '2025-10-14', p: 649, s: 'X', src: 'backfill' }, { d: '2026-02-15', p: 700, s: 'X', src: 'check' }, { d: '2026-11-16', p: 579, s: 'X', src: 'check' }]);
  assert.deepStrictEqual(hist.length, 2, 'input untouched');
  assert.strictEqual(P.autoReason({ price: 570 }, { level: 'unknown' }, [{ d: '2026-01-01', p: 900, s: 'X', src: 'backfill' }, { d: '2026-11-16', p: 579, s: 'X', src: 'check' }]), null, 'archive point is no first price seen');
  assert(P.autoReason({ price: 570 }, { level: 'unknown' }, [{ d: '2026-11-01', p: 900, s: 'X', src: 'check' }]));
  // without page points (single shops) existing archive points survive mergePageHistory; real page points replace them
  assert.strictEqual(P.mergePageHistory(m, [], '2026-11-16').length, 3);
  assert.strictEqual(P.mergePageHistory(m, [{ d: '2026-11-16', p: 1, s: 'Y' }], '2026-11-16').some((x) => x.src === 'backfill'), false);
});

// run-level helper: shop products with the new marker column
function wbProduct(id, url, extra) { return shopProduct(id, 'u1', url, Object.assign({ status: 'tracking', tracked_variants: ['shop'], backfill_state: null, target_value: 1 }, extra || {})); }
function wbCtx(db, map, wbFetch, extra) { const sl = wbSleeps(); return shopCtx(db, map, Object.assign({ waybackFetch: wbFetch, waybackSleep: sl.fn, wbSleeps: sl }, extra || {})); }

test('run: backfill merges archive points, keeps existing points, marks them, records the attempt once', async () => {
  const db = newDb();
  db.products.push(wbProduct('B1', BED_URL, { history: [{ d: '2026-02-15', p: 700, s: 'Bedre Nætter', src: 'check' }, { d: '2026-11-15', p: 579, s: 'Bedre Nætter', src: 'check' }] }));
  const map = { [BED_URL]: shopHtml('shop-jsonld-single') }, calls = [];
  let res = await R.run(wbCtx(db, map, archiveFake(archiveCaptures(), calls)));
  const B = () => db.products[0];
  assert.strictEqual(res.stats.backfilled, 1); assert.strictEqual(res.stats.backfillPoints, 5); assert(res.summary.length === 5 && /Internet Archive: 5 for 1/.test(res.summary[2]), res.summary[2]);
  assert.deepStrictEqual(B().history.map((x) => x.d + ':' + x.p + ':' + x.src), ['2025-10-14:649:backfill', '2025-11-20:629:backfill', '2026-02-15:700:check', '2026-04-21:589:backfill', '2026-09-15:560:backfill', '2026-11-15:579:check', '2026-11-16:579:check']);
  assert.strictEqual(B().backfill_state.result, 'done'); assert.strictEqual(B().backfill_state.found, 5); assert.strictEqual(B().backfill_state.at, '2026-11-16T10:00:00Z');
  assert.strictEqual(B().normal_price, 560); assert.strictEqual(B().verdict.level, 'poor', 'normal price and verdict are recomputed from the longer history');
  assert.strictEqual(B().status, 'tracking'); assert.deepStrictEqual(B().tracked_variants, ['shop']); assert.strictEqual(B().offers[0].price, 579);
  assert(calls.length > 0 && calls.every((c) => new URL(c.u).hostname === 'web.archive.org'));
  // the attempt is recorded: the next runs never ask the archive again
  const calls2 = [];
  await R.run(wbCtx(db, map, archiveFake(archiveCaptures(), calls2))); await R.run(wbCtx(db, map, archiveFake(archiveCaptures(), calls2)));
  assert.strictEqual(calls2.length, 0); assert.strictEqual(B().history.filter((x) => x.src === 'backfill').length, 4, 'points are still there');
  // nothing found: also recorded, also never repeated
  const db2 = newDb(); db2.products.push(wbProduct('B2', BED_URL));
  const c3 = []; const res2 = await R.run(wbCtx(db2, map, archiveFake({}, c3, '[]')));
  assert.strictEqual(db2.products[0].backfill_state.result, 'done'); assert.strictEqual(db2.products[0].backfill_state.found, 0); assert.strictEqual(c3.length, 1);
  await R.run(wbCtx(db2, map, archiveFake({}, c3, '[]'))); assert.strictEqual(c3.length, 1, 'not repeated after an empty result');
  assert.strictEqual(res2.stats.hits, 0);
  // a brand-new product goes pending -> tracking and gets its backfill in the same run; the user-owned columns stay untouched
  const db3 = newDb(); db3.products.push(wbProduct('B3', BED_URL, { status: 'pending', tracked_variants: null }));
  await R.run(wbCtx(db3, map, archiveFake(archiveCaptures(), [])));
  assert.strictEqual(db3.products[0].status, 'tracking'); assert.deepStrictEqual(db3.products[0].tracked_variants, ['shop']); assert.strictEqual(db3.products[0].history.length, 6); assert.strictEqual(db3.products[0].backfill_state.result, 'done');
});

test('run: archive points alone never send a mail; a hit that only the archive creates is recorded silently', async () => {
  // auto goal, no history yet, archive says it used to cost about 900: the long history makes 579 a good deal, but no mail on this run or the next
  const db = newDb(); db.products.push(wbProduct('G1', BED_URL, { name: 'Mayan', target_type: 'auto', target_value: null, status: 'pending', tracked_variants: null }));
  const map = { [BED_URL]: shopHtml('shop-jsonld-single') };
  const wb = () => archiveFake(archiveCaptures((x) => x + 300), []);
  await R.run(wbCtx(db, map, wb()));
  const G = () => db.products[0];
  assert.strictEqual(G().verdict.level, 'good', 'the verdict uses the archive data'); assert.strictEqual(db.sent.length, 0, 'no mail from archive data');
  assert.strictEqual(G().notified_price, 579, 'recorded silently'); assert(!G().notified_at);
  await R.run(wbCtx(db, map, wb())); assert.strictEqual(db.sent.length, 0, 'next run, same price: still no mail');
  // a real further drop is announced as usual
  map[BED_URL] = shopHtml('shop-jsonld-single').replace('"579.00"', '"499.00"');
  await R.run(wbCtx(db, map, wb())); assert.strictEqual(db.sent.length, 1); assert.strictEqual(G().notified_price, 499);
  // a pct goal: the normal price now exists only thanks to the archive; the goal would be met, but not by archive data alone
  const db2 = newDb(); db2.products.push(wbProduct('G2', BED_URL, { target_type: 'pct', target_value: 20, status: 'pending', tracked_variants: null }));
  await R.run(wbCtx(db2, { [BED_URL]: shopHtml('shop-jsonld-single') }, wb()));
  assert.strictEqual(db2.sent.length, 0); assert.strictEqual(db2.products[0].notified_price, 579);
  // a hit that the real data already makes (price goal) still mails on the backfill run
  const db3 = newDb(); db3.products.push(wbProduct('G3', BED_URL, { target_type: 'price', target_value: 600, status: 'pending', tracked_variants: null }));
  await R.run(wbCtx(db3, { [BED_URL]: shopHtml('shop-jsonld-single') }, wb()));
  assert.strictEqual(db3.sent.length, 1); assert.strictEqual(db3.products[0].notified_price, 579); assert(db3.products[0].notified_at);
  // auto with a real earlier price of ours: unchanged behaviour (10 % under the first price WE saw), archive points do not move that first price
  const db4 = newDb(); db4.products.push(wbProduct('G4', BED_URL, { target_type: 'auto', target_value: null, history: [{ d: '2026-11-01', p: 700, s: 'x', src: 'check' }] }));
  await R.run(wbCtx(db4, { [BED_URL]: shopHtml('shop-jsonld-single') }, wb()));
  assert.strictEqual(db4.sent.length, 1, 'real data (700 -> 579) still mails once'); assert(db4.sent[0].text.includes('(700 kr.)'), db4.sent[0].text);
});

test('run: at most 2 products per run; archive trouble allows one later retry, never more', async () => {
  const U = ['https://www.butik-a.dk/a', 'https://www.butik-b.dk/b', 'https://www.butik-c.dk/c'];
  const db = newDb(); U.forEach((u, i) => db.products.push(wbProduct('C' + i, u)));
  const map = {}; U.forEach((u) => { map[u] = shopHtml('shop-jsonld-single').replace('bedrenaetter', 'x').replace('MAY', 'M'); });
  const state = () => db.products.map((p) => p.backfill_state && p.backfill_state.result);
  const calls = [];
  let res = await R.run(wbCtx(db, map, archiveFake({}, calls, '[]')));
  assert.strictEqual(res.stats.backfilled, 2); assert.deepStrictEqual(state(), ['done', 'done', null]); assert.strictEqual(calls.length, 2, 'one CDX request per product');
  await R.run(wbCtx(db, map, archiveFake({}, calls, '[]'))); assert.deepStrictEqual(state(), ['done', 'done', 'done']); assert.strictEqual(calls.length, 3);

  // 429: the first product gets a retry marker, the second is not even tried in this run
  const db2 = newDb(); U.slice(0, 2).forEach((u, i) => db2.products.push(wbProduct('D' + i, u, { history: null })));
  const c2 = [];
  res = await R.run(wbCtx(db2, map, archiveFake({}, c2, () => resp(429, ''))));
  assert.strictEqual(c2.length, 1, 'stopped for the whole run'); assert.strictEqual(db2.products[0].backfill_state.result, 'retry'); assert.strictEqual(db2.products[0].backfill_state.tries, 1); assert.strictEqual(db2.products[1].backfill_state, null);
  assert.strictEqual(db2.products[0].status, 'tracking'); assert.strictEqual(db2.products[0].history.length, 1, 'normal check is written regardless');
  // too soon: no new attempt; after 6 hours: one retry; a second refusal gives up for good
  await R.run(wbCtx(db2, map, archiveFake({}, c2, () => resp(429, '')))); assert.strictEqual(c2.length, 2, 'only product 2 is tried (its first time), product 1 waits');
  db2.products[0].backfill_state.at = '2026-11-16T03:00:00Z';
  const c3 = []; await R.run(wbCtx(db2, map, archiveFake({}, c3, () => resp(503, ''))));
  assert.strictEqual(db2.products[0].backfill_state.result, 'done'); assert.strictEqual(db2.products[0].backfill_state.tries, 2); assert.strictEqual(c3.length, 1);
  db2.products[0].backfill_state.at = '2026-11-01T03:00:00Z'; db2.products[1].backfill_state = { at: '2026-11-01T03:00:00Z', result: 'done', found: 0, tries: 1 };
  const c4 = []; await R.run(wbCtx(db2, map, archiveFake({}, c4, '[]'))); assert.strictEqual(c4.length, 0, 'given up: never again');
  // a retry that works fills in the points
  const db5 = newDb(); db5.products.push(wbProduct('E', BED_URL, { backfill_state: { at: '2026-11-15T10:00:00Z', result: 'retry', found: 0, tries: 1 } }));
  await R.run(wbCtx(db5, { [BED_URL]: shopHtml('shop-jsonld-single') }, archiveFake(archiveCaptures(), [])));
  assert.strictEqual(db5.products[0].backfill_state.result, 'done'); assert.strictEqual(db5.products[0].history.filter((x) => x.src === 'backfill').length, 5);
});

test('run: no backfill for prisjagt products, failed checks, missing column, name-only products; the failing archive never breaks the run', async () => {
  const wbCalls = [];
  const db = newDb();
  db.products.push(product('P', 'u1', 'dyson', { status: 'tracking', tracked_variants: [String(fixturePage('dyson').variants[0].id)], backfill_state: null }));
  db.products.push(wbProduct('N', BED_URL, { status: 'error', tracked_variants: null, last_checked: '2026-11-16T09:59:00Z' }));          // error, retry only after 6 h
  db.products.push(wbProduct('M', 'https://www.mangler.dk/x', { backfill_state: undefined })); delete db.products[2].backfill_state;      // column not in the database yet
  db.products.push(wbProduct('F', 'https://www.fejl.dk/y'));                                                                                  // the shop page fails
  const ctx = wbCtx(db, { [BED_URL]: shopHtml('shop-jsonld-single'), 'https://www.mangler.dk/x': shopHtml('shop-jsonld-single') }, archiveFake({}, wbCalls, '[]'), {});
  const pages = { [urlOf('dyson')]: pageFor('dyson') }; const gp = ctx.getPage;
  ctx.getPage = async (u) => (pages[u] ? (ctx.fetched.push(u), pages[u]) : gp(u));
  await R.run(ctx);
  assert.strictEqual(wbCalls.length, 0); assert.strictEqual(db.products[0].backfill_state, null); assert(!('backfill_state' in db.products[2]), 'the missing column is never written'); assert.strictEqual(db.products[3].backfill_state, null);
  // the archive throwing something odd does not stop the normal write
  const db2 = newDb(); db2.products.push(wbProduct('X', BED_URL));
  const res = await R.run(wbCtx(db2, { [BED_URL]: shopHtml('shop-jsonld-single') }, async () => { throw new TypeError('boom'); }));
  assert.strictEqual(res.stats.written, 1); assert.strictEqual(db2.products[0].history.length, 1); assert.strictEqual(db2.products[0].backfill_state.result, 'retry');
  assert(R.backfillDue({ backfill_state: null }, NOW) && !R.backfillDue({}, NOW) && !R.backfillDue({ backfill_state: { result: 'done' } }, NOW) && R.MAX_BACKFILL === 2);
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
