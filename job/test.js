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
    if (db.web && /(^|\.)(onskeskyen\.dk|gowish\.com)$/.test(u.hostname)) return db.web(url, opts);   // the wish-list site: its own fake
    assert.strictEqual(u.hostname, 'x.supabase.test', 'only the configured Supabase host is called: ' + url);
    if (db.urls) db.urls.push(url);
    assert.strictEqual(h.apikey, SERVICE_KEY); assert.strictEqual(h.Authorization, 'Bearer ' + SERVICE_KEY);
    let mm;
    if ((mm = /^\/auth\/v1\/admin\/users\/(.+)$/.exec(u.pathname))) {
      const usr = db.users[decodeURIComponent(mm[1])]; return usr ? reply(200, { id: mm[1], email: usr }) : reply(404, { msg: 'not found' });
    }
    if ((mm = /^\/rest\/v1\/(\w+)$/.exec(u.pathname))) {
      const t = db[mm[1]];
      if (!t) return reply(404, { code: 'PGRST205', message: "Could not find the table 'public." + mm[1] + "' in the schema cache" });   // a table the database does not have (yet)
      const q = u.searchParams;
      const ownerEq = /^eq\.(.+)$/.exec(q.get('user_id') || '');
      if (m === 'GET') {
        let rows = t.slice();
        if (mm[1] === 'imports') {
          rows = rows.filter((r) => !q.get('status') || r.status === q.get('status').slice(3));
          if (/^synced_at\.asc/.test(q.get('order') || '')) rows.sort((a, b) => (a.synced_at ? Date.parse(a.synced_at) : -Infinity) - (b.synced_at ? Date.parse(b.synced_at) : -Infinity) || String(a.created_at).localeCompare(String(b.created_at)));
          else rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
          if (q.get('limit')) rows = rows.slice(0, Number(q.get('limit')));
          db.importReads = (db.importReads || 0) + 1;
        } else if (ownerEq && (mm[1] === 'products' || mm[1] === 'lists')) rows = rows.filter((r) => r.user_id === ownerEq[1]);   // one person's rows (the import step)
        else if (mm[1] === 'products') {
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
      if (m === 'POST') {   // inserts, with the database's own rules for the columns the import step writes
        const body = JSON.parse(opts.body), list = Array.isArray(body) ? body : [body], out = [];
        if (db.insertFail === mm[1]) return reply(500, { message: 'db error' });
        for (const r of list) {
          if (mm[1] === 'products') {
            assert.strictEqual(h.Prefer, 'return=minimal');
            const mine = t.filter((x) => x.user_id === r.user_id).length;
            if (mine >= 40) return reply(400, { code: '23514', message: 'Du kan højst følge 40 produkter. Slet et produkt først.' });
            if (db.noCompareColumn && 'compare_state' in r) return reply(400, { code: 'PGRST204', message: "Could not find the 'compare_state' column of 'products' in the schema cache" });   // the database has not got the column yet
            if (typeof r.name !== 'string' || r.name.trim() === '' || Array.from(r.name).length > 140) return reply(400, { code: '23514', message: 'name check' });
            if (r.source_url != null && !(r.source_url.length <= 500 && /^https:\/\/[^/?#@:\s]+\.[^/?#@:\s]+([/?#][^\s]*)?$/.test(r.source_url))) return reply(400, { code: '23514', message: 'source_url check' });
            if (r.list_id && !(db.lists || []).some((l) => l.id === r.list_id && l.user_id === r.user_id)) return reply(409, { code: '23503', message: 'Listen findes ikke.' });
            t.push(Object.assign({ id: 'np' + (db.seq = (db.seq || 0) + 1), status: 'pending', active: true, tracked_variants: null, history: null, source_url: null, list_id: null, created_at: NOW.toISOString() }, r));
          } else if (mm[1] === 'lists') {
            assert.strictEqual(h.Prefer, 'return=representation');
            const nm = String(r.name || '').trim();
            if (!nm || nm.length > 40 || t.filter((x) => x.user_id === r.user_id).length >= 30) return reply(400, { code: '23514', message: 'list check' });
            if (t.some((x) => x.user_id === r.user_id && x.name.toLowerCase() === nm.toLowerCase())) return reply(409, { code: '23505', message: 'duplicate key' });
            const row = { id: 'nl' + (db.seq = (db.seq || 0) + 1), user_id: r.user_id, name: nm }; t.push(row); out.push(row);
          } else return reply(404, { message: 'no insert route ' + mm[1] });
          (db.inserted = db.inserted || []).push({ table: mm[1], row: r });
        }
        return reply(201, h.Prefer === 'return=representation' ? out : undefined);
      }
      if (m === 'PATCH') {
        if (mm[1] === 'profiles') {   // the morning mail's claim: only digest_sent_at, only where it still has the value the job read
          const body = JSON.parse(opts.body);
          assert.deepStrictEqual(Object.keys(body), ['digest_sent_at'], 'the job writes digest_sent_at on profiles, nothing else');
          if (db.beforeClaim) db.beforeClaim();
          const uid = /^eq\.(.+)$/.exec(q.get('user_id'))[1], cond = q.get('digest_sent_at');
          db.profilePatches = (db.profilePatches || []).concat([{ uid, cond, body }]);
          if (db.profilePatchFail && body.digest_sent_at !== null && !db.profilePatchFailOnlyRollback) return reply(500, { message: 'db error' });
          if (db.profileRollbackFail && body.digest_sent_at === (db.profileRollbackFailTo === undefined ? null : db.profileRollbackFailTo) && cond && /^eq\./.test(cond)) return reply(500, { message: 'db error' });
          const row = t.find((r) => r.user_id === uid);
          const cur = row ? row.digest_sent_at : undefined;
          const ok = row && (cond === 'is.null' ? cur == null : (cond && /^eq\./.test(cond) && Date.parse(decodeURIComponent(cond.slice(3))) === Date.parse(cur)));
          if (!ok) return reply(200, []);
          row.digest_sent_at = body.digest_sent_at;
          return reply(200, h.Prefer === 'return=representation' ? [JSON.parse(JSON.stringify(row))] : undefined);
        }
        assert.strictEqual(h.Prefer, 'return=minimal');
        if (mm[1] === 'imports') {
          const id = /^eq\.(.+)$/.exec(q.get('id'))[1], body = JSON.parse(opts.body);
          const OWN = ['added', 'done_at', 'found', 'list_id', 'note', 'seen', 'status', 'sync_fails', 'synced_at', 'title'];
          Object.keys(body).forEach((k) => assert(OWN.indexOf(k) !== -1, 'the job writes job columns only: ' + k));
          assert(q.get('status') === 'eq.pending' || q.get('status') === 'eq.done', 'only a still-pending (or still-done) import is written');
          db.importPatches = (db.importPatches || []).concat([{ id, filter: q.get('status'), body }]);
          const row = t.find((r) => r.id === id && r.status === q.get('status').slice(3)); if (!row) return reply(204);
          if (db.importPatchFail && (q.get('status') === 'eq.pending' || db.importPatchFail === 'all')) return reply(500, { message: 'db error' });
          if (db.importNoSyncColumns && Object.keys(body).some((k) => ['seen', 'sync_fails', 'synced_at', 'title', 'list_id'].indexOf(k) !== -1)) return reply(400, { code: '42703', message: 'column imports.synced_at does not exist' });
          Object.assign(row, body); return reply(204);
        }
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
        Object.keys(body).forEach((k) => assert(!/^alt/.test(k) && k !== 'alternatives', 'job must not write the alternatives columns: ' + k));
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
    compare_state: null, compare_at: null, shop_url: null,
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

test('alternatives columns (select=*) are carried by the rows and never written by the job', async () => {
  const alt = { alt_requested_at: '2026-11-16T09:00:00Z', alternatives: [{ kind: 'deal', name: 'X', url: 'https://x.dk/a', store: 'X', price: 1, why: 'y' }], alt_done_at: '2026-11-16T09:30:00Z', alt_note: null };
  const db = newDb(); db.products.push(product('Z', 'u1', 'sony', alt), product('Y', 'u1', 'lego', { alt_requested_at: '2026-11-16T09:00:00Z', alt_done_at: null }));
  const r = await R.run(ctxFor(db, { [urlOf('sony')]: pageFor('sony'), [urlOf('lego')]: pageFor('lego') }));   // the fake refuses any alt column in a PATCH
  assert(db.patches.length === 2 && r.stats.writeFail === 0);
  assert.deepStrictEqual({ a: db.products[0].alt_requested_at, b: db.products[0].alternatives, c: db.products[0].alt_done_at, d: db.products[0].alt_note }, { a: alt.alt_requested_at, b: alt.alternatives, c: alt.alt_done_at, d: null });
  assert(db.products[1].alt_requested_at === '2026-11-16T09:00:00Z' && db.products[1].alt_done_at === null && !('alternatives' in db.products[1]));
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

// ---------------------------------------------------------------- Onskeskyen: import of a shared wish list

const ONSKE = require('./lib/onskeskyen');
const { makeClient } = require('./lib/supabase');
// the real answer of the public page for the test list (12 wishes); our own smaller query returns the same wish fields
const WISHES = JSON.parse(fs.readFileSync(path.join(FIX, 'onskeskyen-wishes.json'), 'utf8')).data.wishlist.wishes.data
  .map((w) => ({ id: w.id, title: w.title, price: w.price, currency: w.currency, url: w.url, photos: w.photos }));
const LIST_ID = '4seSLtIddxXUVB2Z';
const HASH_URL = 'https://api.gowish.com/graphql/aa669a674603b59c80ba4bf22e4c64db';
const jsonResp = (status, obj) => resp(status, typeof obj === 'string' ? obj : JSON.stringify(obj));
const ALLOWED_HOST = /^((www\.)?(onskeskyen\.dk|gowish\.com)|api\.gowish\.com)$/;

// The wish-list site. /s/<code> redirects (onskeskyen.dk -> gowish.com -> /wishlists/<id>); the API answers 308 to /graphql/<hash>
// and then JSON by cursor and limit. Every request is recorded; a request to any other host is recorded in .foreign and refused.
function onskeWeb(o) {
  o = o || {};
  const lists = o.lists || { [LIST_ID]: { title: 'Fødselsdagsønsker', accessLevel: 'Public', wishes: WISHES } };
  const shorts = o.shorts || { e0mfx8: LIST_ID };
  const calls = [], foreign = [];
  const fn = async (url, init) => {
    init = init || {};
    const u = new URL(url), method = init.method || 'GET';
    calls.push({ url, method, body: init.body, headers: init.headers || {}, signal: init.signal, redirect: init.redirect });
    if (!ALLOWED_HOST.test(u.hostname)) { foreign.push(url); return resp(500, ''); }
    if (o.throws) throw new Error('ECONNRESET');
    if (o.hang) return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }));
    if (u.hostname === 'api.gowish.com') {
      if (method !== 'POST') return resp(405, '');
      if (o.apiStatus) return resp(o.apiStatus, o.apiBody || 'nej');
      if (u.pathname === '/graphql' && !o.noRedirect) return resp(308, '', { location: o.apiLocation || HASH_URL });
      if (!/^\/graphql(\/[0-9a-f]+)?$/.test(u.pathname)) return resp(404, '');
      if (o.apiHtml) return resp(200, '<html><title>Just a moment...</title></html>');
      if (o.apiErrors) return jsonResp(200, { errors: o.apiErrors, data: null });
      const b = JSON.parse(init.body), L = lists[b.variables.id];
      if (!L) return jsonResp(200, { errors: [{ message: 'Wishlist with id "{id}" does not exists', path: ['wishlist'], extensions: { code: 404, serviceName: 'wishlists' } }], data: null });
      if (o.nullList) return jsonResp(200, { data: { wishlist: null } });
      const c = b.variables.input.cursor, n = b.variables.input.limit, data = L.wishes.slice(c, c + n);
      return jsonResp(200, { data: { wishlist: { id: b.variables.id, title: L.title, accessLevel: L.accessLevel, wishes: { data, totalCount: L.wishes.length, nextCursor: c + n < L.wishes.length ? c + n : 0 } } } });
    }
    if (o.shortStatus) return resp(o.shortStatus, '');
    const m = /^\/s\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
    if (!m || !(m[1] in shorts)) return resp(404, '');
    if (o.shortLocation) return resp(307, '', { location: o.shortLocation });
    if (o.shortOk) return resp(200, '<html>en side</html>');
    if (u.hostname.replace(/^www\./, '') === 'onskeskyen.dk') return resp(307, '', { location: o.loop ? 'https://onskeskyen.dk/s/' + m[1] : 'https://gowish.com/s/' + m[1] });
    return resp(307, '', { location: o.loop ? 'https://onskeskyen.dk/s/' + m[1] : 'https://onskeskyen.dk/wishlists/' + shorts[m[1]] + '?sharedBy=9lflg7q4Ybu7D4cx&utm_source=shortlink&utm_id=' + m[1] });
  };
  fn.calls = calls; fn.foreign = foreign;
  fn.posts = () => calls.filter((c) => c.method === 'POST');
  fn.gets = () => calls.filter((c) => c.method === 'GET');
  return fn;
}

let impSeq = 0;
function importsDb(web, extra) {
  const db = newDb();
  db.imports = []; db.lists = []; db.web = web; db.urls = [];
  return Object.assign(db, extra || {});
}
function impRow(db, url, extra) {
  const r = Object.assign({ id: 'i' + (++impSeq), user_id: 'u1', list_id: null, url, status: 'pending', note: null, found: null, added: null, created_at: '2026-11-16T09:' + String(impSeq).padStart(2, '0') + ':00Z', done_at: null }, extra || {});
  db.imports.push(r); return r;
}
async function runImp(db, extra) {
  const pauses = [], logs = [];
  const stats = await ONSKE.runImports(Object.assign({
    sb: makeClient('https://x.supabase.test', SERVICE_KEY, makeFake(db)), fetch: makeFake(db), now: () => NOW,
    sleep: async (ms) => { pauses.push(ms); }, log: (l) => logs.push(l),
  }, extra || {}));
  return { stats, pauses, logs };
}
const SHARE = 'https://onskeskyen.dk/s/e0mfx8';
const mine = (db, u) => db.products.filter((p) => p.user_id === (u || 'u1'));

test('onskeskyen: only wish-list links are recognised', () => {
  const P = ONSKE.parseListUrl;
  assert.deepStrictEqual(P(SHARE), { short: SHARE });
  assert.deepStrictEqual(P('https://www.gowish.com/s/e0mfx8?x=1#y'), { short: 'https://www.gowish.com/s/e0mfx8' });
  assert.deepStrictEqual(P('https://ONSKESKYEN.dk/s/abc_DEF-1/'), { short: 'https://onskeskyen.dk/s/abc_DEF-1/' });
  for (const u of ['https://onskeskyen.dk/wishlists/' + LIST_ID, 'https://onskeskyen.dk/wishlists/' + LIST_ID + '?sharedBy=9lflg7q4Ybu7D4cx&utm_source=shortlink',
    'https://onskeskyen.dk/da/wishlists/' + LIST_ID, 'https://www.onskeskyen.dk/da-DK/wishlists/' + LIST_ID + '/', 'https://gowish.com/en/wishlists/' + LIST_ID, 'https://www.gowish.com/wishlists/' + LIST_ID]) {
    assert.deepStrictEqual(P(u), { id: LIST_ID }, u);
  }
  for (const u of ['http://onskeskyen.dk/s/e0mfx8', 'https://onskeskyen.dk.evil.com/s/e0mfx8', 'https://evil.com/onskeskyen.dk/s/e0mfx8', 'https://onskeskyen.dk@evil.com/s/e0mfx8',
    'https://user:pw@onskeskyen.dk/s/e0mfx8', 'https://onskeskyen.dk:8443/s/e0mfx8', 'https://api.gowish.com/graphql', 'https://shop.onskeskyen.dk/s/e0mfx8', 'https://onskeskyen.dk/',
    'https://onskeskyen.dk/s/', 'https://onskeskyen.dk/wishlists/', 'https://onskeskyen.dk/profile/abc', 'https://onskeskyen.dk/s/a/b', 'https://onskeskyen.dk/x/y/wishlists/abc',
    'https://prisjagt.dk/s/e0mfx8', 'https://bedrenaetter.dk/wishlists/abc', 'ftp://onskeskyen.dk/s/abc', 'onskeskyen.dk/s/abc', '', null, undefined, 42]) {
    assert.strictEqual(P(u), null, String(u));
  }
});

test('onskeskyen: wish links, names and the comparison key', () => {
  const C = ONSKE.cleanWishUrl;
  assert.strictEqual(C('https://www.toejeksperten.dk/p/x/30-305044lt#queryId=f823ce'), 'https://www.toejeksperten.dk/p/x/30-305044lt', 'fragment removed');
  assert.strictEqual(C('https://spilforsyningen.dk/products/dice?gad_campaignid=1987&variant=5536&utm_source=a&utm_medium=b&gclid=1&fbclid=2'), 'https://spilforsyningen.dk/products/dice?variant=5536', 'tracking removed, variant kept');
  assert.strictEqual(C('  https://shop.dk/a b '), 'https://shop.dk/a%20b');
  for (const u of ['http://shop.dk/x', 'javascript:alert(1)', 'data:text/html,x', 'https://127.0.0.1/x', 'https://10.0.0.1/x', 'https://shop/x', 'https://localhost/x', 'https://user:pw@shop.dk/x', 'https://shop.dk:8080/x',
    'https://shop.dk/' + 'x'.repeat(500), '', '   ', null, undefined, 5, {}]) assert.strictEqual(C(u), null, String(u).slice(0, 40));
  assert.strictEqual(C('https://www.prisjagt.dk/produkt/x?utm_source=y'), 'https://prisjagt.dk/produkt/x', 'a prisjagt.dk page is fine, written without www.');
  assert.strictEqual(C('https://prisjagt.dk/'), null);
  const K = ONSKE.urlKey;
  assert.strictEqual(K('https://www.shop.dk/p/1/?utm_source=x#a'), K('https://shop.dk/p/1'));
  assert.strictEqual(K('https://shop.dk/p?a=1&b=2'), K('https://SHOP.dk/p?b=2&a=1&gclid=9'));
  assert.notStrictEqual(K('https://shop.dk/p?variant=1'), K('https://shop.dk/p?variant=2'));
  assert.notStrictEqual(K('https://shop.dk/p/1'), K('https://shop.dk/p/2'));
  assert.strictEqual(K('not a url'), null);
  const N = ONSKE.cleanName;
  assert.strictEqual(N('  <script>alert(1)</script>\n x\t'), '<script>alert(1)</script> x');
  assert.strictEqual(N('a\u0000b\u0007c d'), 'a b c d');
  assert.strictEqual(Array.from(N('é'.repeat(200))).length, 140);
  assert.strictEqual(Array.from(N('😀'.repeat(200))).length, 140, 'counted in characters, not code units');
  assert.strictEqual(N('x'.repeat(60), 40).length, 40);
  assert.strictEqual(N(null), ''); assert.strictEqual(N(7), ''); assert.strictEqual(N('   '), '');
});

test('onskeskyen: a share link becomes products on a new list named after the wish list', async () => {
  const web = onskeWeb(), db = importsDb(web);
  const imp = impRow(db, SHARE);
  db.products.push(product('old', 'u1', 'dyson'), product('other', 'u2', 'dyson'));
  const { stats, pauses } = await runImp(db);
  assert.deepStrictEqual(web.calls.map((c) => c.method + ' ' + c.url), ['GET ' + SHARE, 'GET https://gowish.com/s/e0mfx8', 'POST https://api.gowish.com/graphql', 'POST ' + HASH_URL], 'resolve (2 redirects), then the API (308, then the same POST again)');
  assert.deepStrictEqual(web.foreign, []);
  web.calls.forEach((c) => { assert.strictEqual(c.redirect, 'manual'); assert(c.signal, 'every request has a timeout'); assert.strictEqual(c.headers['User-Agent'], PJ.UA); assert(!('Cookie' in c.headers) && !('Authorization' in c.headers)); });
  const body = JSON.parse(web.posts()[1].body);
  assert.strictEqual(body.operationName, 'getWishlistWishes'); assert.strictEqual(body.variables.id, LIST_ID); assert.deepStrictEqual(body.variables.input, { cursor: 0, limit: 30 });
  assert.strictEqual(body.query, ONSKE.QUERY); assert(!/u1|supabase|anna/i.test(web.posts()[1].body), 'nothing about the user is sent');
  assert.deepStrictEqual(pauses, [1000, 1000, 1000], 'a pause before every request but the first');
  assert.deepStrictEqual(stats, { pending: 1, done: 1, error: 0, added: 12, missing: false, synced: 0, syncAdded: 0, syncFailed: 0 }, 'the import just finished is not read again in the same run');
  const made = db.lists.filter((l) => l.user_id === 'u1');
  assert.strictEqual(made.length, 1); assert.strictEqual(made[0].name, 'Fødselsdagsønsker');
  const added = mine(db).filter((p) => p.id !== 'old');
  assert.strictEqual(added.length, 12); assert.strictEqual(mine(db, 'u2').length, 1);
  added.forEach((p, i) => {
    assert.strictEqual(p.name, WISHES[i].title); assert.strictEqual(p.status, 'pending'); assert.strictEqual(p.target_type, 'auto'); assert.strictEqual(p.target_value, null);
    assert.strictEqual(p.active, true); assert.strictEqual(p.list_id, made[0].id); assert.strictEqual(p.user_id, 'u1');
  });
  assert.strictEqual(added[0].source_url, 'https://www.boozt.com/dk/da/bruun-stengade/bs-izaro-regular-fit-jacket_33035506/231902220');
  assert.strictEqual(added[1].source_url, 'https://www.toejeksperten.dk/p/lindbergh-overshirt/30-305044/30-305044lt-grey-mix', 'fragment removed');
  assert.strictEqual(added[4].source_url, 'https://www.toejeksperten.dk/p/lindbergh-chinos/30-005044/30-005044dk-blue', 'gad_campaignid removed');
  assert.strictEqual(added[7].source_url, 'https://spilforsyningen.dk/products/warhammer-40k-world-eaters-dice?variant=55362212036991', 'the variant stays');
  assert(added.every((p) => !/#|gad_|utm_|gclid|fbclid/.test(p.source_url)));
  const r = db.imports[0];
  assert.strictEqual(r.status, 'done'); assert.strictEqual(r.found, 12); assert.strictEqual(r.added, 12); assert(r.done_at);
  assert.strictEqual(r.note, 'De er lagt på en ny liste, Fødselsdagsønsker.'); assert.strictEqual(imp.id, r.id);
});

test('onskeskyen: a /wishlists/<id> link needs no lookup of the id; the API may answer 200 straight away', async () => {
  for (const u of ['https://onskeskyen.dk/wishlists/' + LIST_ID, 'https://onskeskyen.dk/da/wishlists/' + LIST_ID + '?sharedBy=9lf&utm_source=shortlink', 'https://www.gowish.com/en/wishlists/' + LIST_ID]) {
    const web = onskeWeb(), db = importsDb(web); impRow(db, u);
    const { pauses } = await runImp(db);
    assert.deepStrictEqual(web.gets(), [], 'no page request: ' + u); assert.strictEqual(web.posts().length, 2);
    assert.deepStrictEqual(pauses, [1000]); assert.strictEqual(db.imports[0].status, 'done'); assert.strictEqual(mine(db).length, 12);
  }
  const web = onskeWeb({ noRedirect: true }), db = importsDb(web); impRow(db, 'https://onskeskyen.dk/wishlists/' + LIST_ID);
  await runImp(db);
  assert.strictEqual(web.calls.length, 1); assert.strictEqual(web.calls[0].url, 'https://api.gowish.com/graphql'); assert.strictEqual(db.imports[0].added, 12);
});

test('onskeskyen: redirects are followed only inside the allowed hosts, at most 5, and never to another host', async () => {
  const bad = async (o, expectNote, expectCalls) => {
    const web = onskeWeb(o), db = importsDb(web); impRow(db, o.url || SHARE);
    await runImp(db);
    assert.deepStrictEqual(web.foreign, [], 'no request to a foreign host: ' + JSON.stringify(Object.keys(o)));
    assert.strictEqual(db.imports[0].status, 'error'); assert.strictEqual(db.imports[0].note, expectNote); assert.strictEqual(mine(db).length, 0);
    if (expectCalls != null) assert.strictEqual(web.calls.length, expectCalls);
    return web;
  };
  await bad({ shortLocation: 'https://evil.example.com/wishlists/' + LIST_ID }, ONSKE.NOTE.unavailable, 1);
  await bad({ shortLocation: 'https://onskeskyen.dk.evil.com/wishlists/' + LIST_ID }, ONSKE.NOTE.unavailable, 1);
  await bad({ shortLocation: 'http://onskeskyen.dk/wishlists/' + LIST_ID }, ONSKE.NOTE.unavailable, 1);
  await bad({ shortLocation: 'https://api.gowish.com/graphql' }, ONSKE.NOTE.unavailable, 1);
  await bad({ shortLocation: 'https://user:pw@onskeskyen.dk/wishlists/' + LIST_ID }, ONSKE.NOTE.unavailable, 1);
  await bad({ loop: true }, ONSKE.NOTE.unavailable, 6);                           // the first request and 5 redirects, then it gives up
  await bad({ apiLocation: 'https://evil.example.com/graphql/abc' , url: 'https://onskeskyen.dk/wishlists/' + LIST_ID }, ONSKE.NOTE.unavailable, 1);
  await bad({ apiLocation: 'https://api.gowish.com.evil.com/graphql/abc', url: 'https://onskeskyen.dk/wishlists/' + LIST_ID }, ONSKE.NOTE.unavailable, 1);
  await bad({ apiLocation: 'https://onskeskyen.dk/graphql/abc', url: 'https://onskeskyen.dk/wishlists/' + LIST_ID }, ONSKE.NOTE.unavailable, 1);
  await bad({ shortOk: true }, ONSKE.NOTE.private, 1);                             // a page, no wish list behind it
  await bad({ shorts: {} }, ONSKE.NOTE.private, 1);                                // 404
  // a relative Location is resolved against the current page and accepted when it stays on the list hosts
  const web = onskeWeb({ shortLocation: '/wishlists/' + LIST_ID + '?x=1' }), db = importsDb(web); impRow(db, SHARE);
  await runImp(db); assert.strictEqual(db.imports[0].status, 'done'); assert.deepStrictEqual(web.foreign, []);
});

test('onskeskyen: pagination by nextCursor (page size 30), the endpoint from the 308 is reused, at most 60 wishes', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: 'w' + i, title: 'Ønske ' + i, price: 100 + i, currency: 'DKK', url: 'https://www.butik' + (i % 7) + '.dk/vare-' + i }));
  let web = onskeWeb({ lists: { [LIST_ID]: { title: 'Mange', accessLevel: 'Public', wishes: many(35) } } }), db = importsDb(web); impRow(db, 'https://onskeskyen.dk/wishlists/' + LIST_ID);
  await runImp(db);
  assert.deepStrictEqual(web.posts().map((c) => [c.url, JSON.parse(c.body).variables.input.cursor]), [['https://api.gowish.com/graphql', 0], [HASH_URL, 0], [HASH_URL, 30]]);
  assert.strictEqual(db.imports[0].found, 35); assert.strictEqual(db.imports[0].added, 35); assert.strictEqual(mine(db).length, 35);
  // 70 wishes: only the first 60 are read (two pages), the rest is said in the note; the cap of 40 products then applies
  web = onskeWeb({ lists: { [LIST_ID]: { title: 'Mange', accessLevel: 'Public', wishes: many(70) } } }); db = importsDb(web); impRow(db, 'https://onskeskyen.dk/wishlists/' + LIST_ID);
  await runImp(db);
  assert.deepStrictEqual(web.posts().map((c) => JSON.parse(c.body).variables.input.cursor), [0, 0, 30], 'no third page');
  assert.strictEqual(db.imports[0].found, 60); assert.strictEqual(db.imports[0].added, 40);
  assert(/^Der var kun plads til 40 af 60 ønsker\. Du kan højst følge 40 varer\. Kun de første 60 ønsker blev hentet\./.test(db.imports[0].note), db.imports[0].note);
  // a server that keeps answering the same cursor does not loop
  web = onskeWeb({ lists: { [LIST_ID]: { title: 'X', accessLevel: 'Public', wishes: many(3) } } });
  const orig = web; const looping = async (url, init) => { const r = await orig(url, init); return r.status === 200 && init.method === 'POST' ? jsonResp(200, JSON.parse(await r.text(), (k, v) => (k === 'nextCursor' ? 0 : v))) : r; };
  looping.calls = orig.calls; db = importsDb(looping); impRow(db, 'https://onskeskyen.dk/wishlists/' + LIST_ID);
  await runImp(db); assert.strictEqual(db.imports[0].added, 3);
});

test('onskeskyen: wishes already followed, or listed twice, are skipped (links compared without tracking, www and fragment)', async () => {
  const web = onskeWeb({ lists: { [LIST_ID]: { title: 'Dubletter', accessLevel: 'Public', wishes: WISHES.concat([Object.assign({}, WISHES[0], { id: 'again', url: WISHES[0].url + '?utm_medium=mail#x' })]) } } });
  const db = importsDb(web); impRow(db, 'https://onskeskyen.dk/wishlists/' + LIST_ID);
  db.products.push(product('a', 'u1', 'dyson', { source_url: 'https://proshop.dk/Klimaventilator/Xiaomi-Mi-Air-Purifier-4/3064179?utm_source=x' }));
  db.products.push(product('b', 'u1', 'dyson', { source_url: 'https://adidas.dk/stan-smith-sko/M20325.html/' }));
  db.products.push(product('c', 'u2', 'dyson', { source_url: WISHES[2].url }));            // someone else's product does not count
  db.products.push(product('d', 'u1', 'dyson', { source_url: null, name: 'kun navn', status: 'pending' }));
  await runImp(db);
  assert.strictEqual(db.imports[0].status, 'done'); assert.strictEqual(db.imports[0].found, 13); assert.strictEqual(db.imports[0].added, 10);
  assert(/^3 ønsker fandtes allerede\./.test(db.imports[0].note), db.imports[0].note);
  const urls = db.inserted.filter((x) => x.table === 'products').map((x) => x.row.source_url);
  assert.strictEqual(new Set(urls).size, urls.length, 'no link twice'); assert.strictEqual(urls.filter((u) => /boozt/.test(u)).length, 1);
  assert(!urls.some((u) => /adidas|Xiaomi/.test(u)));
  // run again: everything is already followed
  impRow(db, 'https://onskeskyen.dk/wishlists/' + LIST_ID);
  await runImp(db);
  const second = db.imports[1]; assert.strictEqual(second.status, 'done'); assert.strictEqual(second.added, 0); assert(/^13 ønsker fandtes allerede\./.test(second.note), second.note);
  assert.strictEqual(mine(db).length, 3 + 10);
});

test('onskeskyen: at most 40 products per person; the note says how many fitted', async () => {
  const web = onskeWeb(), db = importsDb(web); impRow(db, SHARE);
  for (let i = 0; i < 33; i++) db.products.push(product('m' + i, 'u1', 'dyson', { source_url: i % 3 ? 'https://shop.dk/x' + i : null, active: i % 5 !== 0 }));   // name-only and inactive ones count too
  for (let i = 0; i < 40; i++) db.products.push(product('o' + i, 'u2', 'dyson'));          // another person at the cap does not matter
  await runImp(db);
  assert.strictEqual(db.imports[0].status, 'done'); assert.strictEqual(db.imports[0].found, 12); assert.strictEqual(db.imports[0].added, 7);
  assert(db.imports[0].note.indexOf('Der var kun plads til 7 af 12 ønsker. Du kan højst følge 40 varer.') === 0, db.imports[0].note);
  assert.strictEqual(mine(db).length, 40); assert.strictEqual(db.inserted.filter((x) => x.table === 'products').length, 7);
  assert.strictEqual(db.inserted.filter((x) => x.table === 'products')[0].row.name, WISHES[0].title, 'the first wishes are the ones added');
  // one request for all rows
  // at the cap: an error, nothing added
  const other = { 'ZZZ': { title: 'En anden', accessLevel: 'Public', wishes: [{ id: 'z', title: 'Noget andet', url: 'https://nyt.dk/a' }] } };
  const web2 = onskeWeb({ lists: other }); db.web = web2; impRow(db, 'https://onskeskyen.dk/wishlists/ZZZ');
  await runImp(db);
  assert.strictEqual(db.imports[1].status, 'error'); assert.strictEqual(db.imports[1].note, ONSKE.NOTE.full); assert.strictEqual(db.imports[1].added, 0); assert.strictEqual(mine(db).length, 40);
});

test('onskeskyen: the rows are inserted in one request, as a browser would have added them', async () => {
  const web = onskeWeb(), db = importsDb(web); impRow(db, SHARE);
  const bodies = []; const f = makeFake(db);
  await ONSKE.runImports({ sb: makeClient('https://x.supabase.test', SERVICE_KEY, async (u, o) => { if (o && o.method === 'POST' && /\/products$/.test(u)) bodies.push(JSON.parse(o.body)); return f(u, o); }), fetch: f, now: () => NOW, sleep: async () => {}, log: () => {} });
  assert.strictEqual(bodies.length, 1); assert.strictEqual(bodies[0].length, 12);
  assert.deepStrictEqual(Object.keys(bodies[0][0]).sort(), ['active', 'compare_state', 'image_url', 'list_id', 'name', 'source_url', 'status', 'target_type', 'target_value', 'user_id']);
});

test('onskeskyen: the query asks for photos; the first https photo of each wish becomes image_url, nothing else is fetched', async () => {
  const web = onskeWeb(), db = importsDb(web); impRow(db, SHARE);
  await runImp(db);
  const q = JSON.parse(web.posts()[0].body).query;
  assert(/data \{[^}]*\bphotos\b[^}]*\}/.test(q), 'photos is part of the wish fields: ' + q);
  const rows = db.inserted.filter((x) => x.table === 'products').map((x) => x.row);
  assert.strictEqual(rows.length, 12);
  const first = WISHES[0];
  assert(Array.isArray(first.photos) && /^https:\/\//.test(first.photos[0]));
  assert.strictEqual(rows[0].image_url, first.photos[0], 'the first photo of the first wish');
  WISHES.forEach((w, i) => {
    const want = (w.photos || []).filter((x) => /^https:\/\//.test(x))[0] || null;
    assert.strictEqual(rows[i].image_url, want, 'wish ' + i);
  });
  assert.deepStrictEqual(web.gets().map((c) => new URL(c.url).hostname).filter((h) => /^img\./.test(h)), [], 'no picture is downloaded');
  assert.deepStrictEqual(web.foreign, []);
});

test('onskeskyen: only https photos are kept (http, other schemes, relative, spaces, a port, over 500 characters, no list, a bare string)', async () => {
  const bad = ['http://img.example.dk/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '/a.jpg', 'https://img.example.dk:8443/a.jpg', 'https://u:p@img.example.dk/a.jpg', 'https://img.example.dk/a b.jpg', 'https://img.example.dk/' + 'a'.repeat(500), 'https://localhost/a.jpg', 42, null];
  const wishes = bad.map((p, i) => ({ id: 'b' + i, title: 'Vare ' + i, url: 'https://shop' + i + '.dk/x', photos: [p] }));
  wishes.push({ id: 'ok1', title: 'Andet valg', url: 'https://shopx.dk/x', photos: ['http://img.example.dk/a.jpg', 'https://img.example.dk/ok.jpg?w=200', 'https://img.example.dk/two.jpg'] });
  wishes.push({ id: 'ok2', title: 'Uden billeder', url: 'https://shopy.dk/x' });
  wishes.push({ id: 'ok3', title: 'Streng', url: 'https://shopz.dk/x', photos: 'https://img.example.dk/s.jpg' });
  const web = onskeWeb({ lists: { [LIST_ID]: { title: 'Billeder', accessLevel: 'Public', wishes } } }), db = importsDb(web); impRow(db, SHARE);
  await runImp(db);
  const rows = db.inserted.filter((x) => x.table === 'products').map((x) => x.row);
  assert.deepStrictEqual(rows.slice(0, bad.length).map((r) => r.image_url), bad.map(() => null));
  assert.strictEqual(rows[bad.length].image_url, 'https://img.example.dk/ok.jpg?w=200', 'the first usable one, not the first one');
  assert.strictEqual(rows[bad.length + 1].image_url, null);
  assert.strictEqual(rows[bad.length + 2].image_url, 'https://img.example.dk/s.jpg');
});

test('onskeskyen: a database without image_url still gets the products (the column is left out and the insert is repeated)', async () => {
  const web = onskeWeb(), db = importsDb(web); impRow(db, SHARE);
  const f = makeFake(db), seen = [];
  const sb = makeClient('https://x.supabase.test', SERVICE_KEY, async (u, o) => {
    if (o && o.method === 'POST' && /\/products$/.test(u)) {
      const b = JSON.parse(o.body); seen.push(Object.keys(b[0]));
      if (b.some((r) => 'image_url' in r)) return resp(400, JSON.stringify({ code: 'PGRST204', message: "Could not find the 'image_url' column of 'products' in the schema cache" }));
    }
    return f(u, o);
  });
  await ONSKE.runImports({ sb, fetch: f, now: () => NOW, sleep: async () => {}, log: () => {} });
  assert.strictEqual(seen.length, 2); assert(seen[0].indexOf('image_url') >= 0 && seen[1].indexOf('image_url') < 0 && seen[1].indexOf('compare_state') >= 0);
  assert.strictEqual(db.imports[0].status, 'done'); assert.strictEqual(mine(db).length, 12);
});

// ---------------------------------------------------------------- product pictures (only the address, from pages the job reads anyway)

test('images: every saved Prisjagt page gives its og:image as an https address', () => {
  const want = { dyson: 'https://cdn.pji.nu/product/standard/800/5745115.jpg', lego: 'https://cdn.pji.nu/product/standard/800/13113529.jpg', ps5: 'https://cdn.pji.nu/product/standard/800/13395263.jpg',
    roborock: 'https://cdn.pji.nu/product/standard/800/16373878.jpg', sonicare: 'https://cdn.pji.nu/product/standard/800/7253209.jpg', sony: 'https://cdn.pji.nu/product/standard/800/6219512.jpg' };
  Object.keys(want).forEach((n) => assert.strictEqual(fixturePage(n).image, want[n], n));
  assert.strictEqual(PJ.parsePage(fixtureHtml('sony').replace(/<meta property="og:image"[^>]*>/, '')).image, 'https://cdn.pji.nu/product/standard/800/6219512.jpg', 'twitter:image or nothing; the payload copy is not a meta tag of the page head');
});

test('images: cleanImageUrl keeps only https pictures that the database would accept', () => {
  const c = PJ.cleanImageUrl;
  assert.strictEqual(c('https://img.example.dk/a.jpg'), 'https://img.example.dk/a.jpg');
  assert.strictEqual(c('  https://img.example.dk/a.jpg?w=1#x '), 'https://img.example.dk/a.jpg?w=1', 'fragment dropped, nothing added');
  assert.strictEqual(c('//cdn.example.dk/a.jpg', 'https://shop.dk/p'), 'https://cdn.example.dk/a.jpg');
  assert.strictEqual(c('/img/a.jpg', 'https://shop.dk/p/1'), 'https://shop.dk/img/a.jpg');
  assert.strictEqual(c('/img/a.jpg'), null, 'relative without a page');
  assert.strictEqual(c('/img/a.jpg', 'http://shop.dk/p'), null, 'a page that is not https');
  [null, undefined, 3, '', 'http://img.example.dk/a.jpg', 'ftp://img.example.dk/a.jpg', 'data:image/gif;base64,R0lG', 'javascript:alert(1)', 'https://img.example.dk:444/a.jpg', 'https://a:b@img.example.dk/a.jpg', 'https://img.example.dk/a b.jpg',
    'https://localhost/a.jpg', 'https://127.0.0.1/a.jpg', 'https://[::1]/a.jpg', 'https://img.example.dk/' + 'a'.repeat(490)].forEach((u) => assert.strictEqual(c(u, 'https://shop.dk/p'), null, String(u)));
});

test('images: a single-shop page gives its JSON-LD image (string, list, ImageObject, relative) or else og:image', () => {
  const base = shopHtml('shop-jsonld-single');
  assert.strictEqual(shopParse('shop-jsonld-single', BED_URL).image, null, 'the saved page has no picture');
  const withLd = (img) => base.replace(/"@type"\s*:\s*"Product"/, '"@type":"Product","image":' + JSON.stringify(img));
  assert(/"image":/.test(withLd('x')), 'the fixture has a Product node to put it in');
  const img = (h) => SHOP.parseShopPage(h, BED_URL).image;
  assert.strictEqual(img(withLd('https://cdn.example.dk/a.jpg')), 'https://cdn.example.dk/a.jpg');
  assert.strictEqual(img(withLd(['http://cdn.example.dk/no.jpg', 'https://cdn.example.dk/b.jpg'])), 'https://cdn.example.dk/b.jpg');
  assert.strictEqual(img(withLd({ '@type': 'ImageObject', url: 'https://cdn.example.dk/c.jpg' })), 'https://cdn.example.dk/c.jpg');
  assert.strictEqual(img(withLd([{ '@type': 'ImageObject', contentUrl: 'https://cdn.example.dk/d.jpg' }])), 'https://cdn.example.dk/d.jpg');
  assert.strictEqual(img(withLd('/media/e.jpg')), 'https://www.bedrenaetter.dk/media/e.jpg');
  assert.strictEqual(img(withLd('http://cdn.example.dk/f.jpg')), null);
  // og:image when the JSON-LD has none, and when the JSON-LD one is unusable
  const og = base.replace('</head>', '<meta property="og:image" content="https://cdn.example.dk/og.jpg?a=1&amp;b=2"></head>');
  assert.strictEqual(img(og), 'https://cdn.example.dk/og.jpg?a=1&b=2');
  assert.strictEqual(img(og.replace(/"@type"\s*:\s*"Product"/, '"@type":"Product","image":"http://cdn.example.dk/x.jpg"')), 'https://cdn.example.dk/og.jpg?a=1&b=2');
  assert.strictEqual(img(withLd('https://cdn.example.dk/ld.jpg').replace('</head>', '<meta property="og:image" content="https://cdn.example.dk/og.jpg"></head>')), 'https://cdn.example.dk/ld.jpg', 'the product\'s own image first');
  // microdata and meta-tag pages
  const meta = shopHtml('shop-meta').replace('</head>', '<meta property="og:image" content="//cdn.example.dk/m.jpg"></head>');
  assert.strictEqual(SHOP.parseShopPage(meta, 'https://www.example.dk/x').image, 'https://cdn.example.dk/m.jpg');
  assert.strictEqual(shopParse('shop-meta').image, null);
  assert.strictEqual(shopParse('shop-microdata').image, null);
});

test('images: the run stores the address from the page it reads (first fetch and tracking), only when it is new, and only where the column exists', async () => {
  const URL1 = urlOf('sony');
  const db = newDb();
  db.products.push(product('I1', 'u1', 'sony', { image_url: null, target_type: 'auto', target_value: null }), product('I2', 'u1', 'sony', { source_url: urlOf('dyson'), image_url: null }), product('I3', 'u1', 'sony', { source_url: urlOf('lego') }));
  const pages = { [URL1]: pageFor('sony'), [urlOf('dyson')]: pageFor('dyson'), [urlOf('lego')]: pageFor('lego') };
  await R.run(ctxFor(db, pages));
  const by = (id) => db.products.find((p) => p.id === id);
  assert.strictEqual(by('I1').image_url, 'https://cdn.pji.nu/product/standard/800/6219512.jpg');
  assert.strictEqual(by('I2').image_url, 'https://cdn.pji.nu/product/standard/800/5745115.jpg');
  assert(!('image_url' in by('I3')), 'a database without the column is left alone');
  // already stored: not written again; a changed address is replaced
  const before = db.patches.length;
  db.products.forEach((p) => { if (p.id === 'I1' || p.id === 'I2') { p.status = 'tracking'; } });
  await R.run(ctxFor(db, pages));
  assert(db.patches.length > before && db.patches.slice(before).every((x) => !('image_url' in x.body)), 'no second write of the same address');
  by('I1').image_url = 'https://old.example.dk/x.jpg'; by('I1').status = 'tracking';
  await R.run(ctxFor(db, pages));
  assert.strictEqual(by('I1').image_url, 'https://cdn.pji.nu/product/standard/800/6219512.jpg');
});

test('images: a single-shop product gets its picture from the shop page, and no request is made for it', async () => {
  const withImg = shopHtml('shop-jsonld-single').replace('</head>', '<meta property="og:image" content="https://cdn.example.dk/shop.jpg"></head>');
  const db = newDb();
  db.products.push(shopProduct('S1', 'u1', BED_URL, { image_url: null }));
  const ctx = shopCtx(db, { [BED_URL]: withImg });
  await R.run(ctx);
  assert.strictEqual(db.products[0].image_url, 'https://cdn.example.dk/shop.jpg');
  assert.deepStrictEqual(ctx.fetched, [BED_URL], 'only the product page was fetched');
});


test('onskeskyen: list choice (given list, reuse by name, 30-list cap, other people\'s lists, long and empty titles)', async () => {
  const one = (title) => ({ [LIST_ID]: { title, accessLevel: 'Public', wishes: WISHES.slice(0, 2) } });
  const go = async (o, setup, imp) => { const web = onskeWeb(o), db = importsDb(web); setup && setup(db); impRow(db, 'https://onskeskyen.dk/wishlists/' + LIST_ID, imp); await runImp(db); return db; };
  // the import has a list: used as it is, no list is created
  let db = await go({ lists: one('Egen titel') }, (d) => d.lists.push({ id: 'L9', user_id: 'u1', name: 'Julegaver' }), { list_id: 'L9' });
  assert.deepStrictEqual(mine(db).map((p) => p.list_id), ['L9', 'L9']); assert.strictEqual(db.lists.length, 1); assert.strictEqual(db.imports[0].note, null);
  // none: a list with the title's name, reused regardless of case
  db = await go({ lists: one('Fødselsdagsønsker') }, (d) => d.lists.push({ id: 'L1', user_id: 'u1', name: 'FØDSELSDAGSØNSKER' }, { id: 'L2', user_id: 'u1', name: 'Andet' }));
  assert.deepStrictEqual(mine(db).map((p) => p.list_id), ['L1', 'L1']); assert.strictEqual(db.lists.length, 2);
  assert.strictEqual(db.imports[0].note, 'De er lagt på listen FØDSELSDAGSØNSKER.');
  // someone else's list of the same name is not used
  db = await go({ lists: one('Fødselsdagsønsker') }, (d) => d.lists.push({ id: 'LX', user_id: 'u2', name: 'Fødselsdagsønsker' }));
  assert.strictEqual(db.lists.length, 2); assert(mine(db).every((p) => /^nl/.test(p.list_id)));
  // the title is trimmed to 40 characters
  db = await go({ lists: one('  ' + 'æ'.repeat(60) + '  ') });
  assert.strictEqual(db.lists[0].name, 'æ'.repeat(40));
  // an empty title: no list
  db = await go({ lists: one('   ') });
  assert.strictEqual(db.lists.length, 0); assert.deepStrictEqual(mine(db).map((p) => p.list_id), [null, null]); assert.strictEqual(db.imports[0].status, 'done');
  // 30 lists already: the products are added without a list
  db = await go({ lists: one('Ny titel') }, (d) => { for (let i = 0; i < 30; i++) d.lists.push({ id: 'X' + i, user_id: 'u1', name: 'Liste ' + i }); });
  assert.strictEqual(db.lists.length, 30); assert.deepStrictEqual(mine(db).map((p) => p.list_id), [null, null]); assert.strictEqual(db.imports[0].added, 2);
  assert(/30 lister/.test(db.imports[0].note), db.imports[0].note);
  // nothing to add: no empty list is created
  db = await go({ lists: one('Tom nu') }, (d) => { d.products.push(product('a', 'u1', 'dyson', { source_url: WISHES[0].url }), product('b', 'u1', 'dyson', { source_url: WISHES[1].url })); });
  assert.strictEqual(db.lists.length, 0); assert.strictEqual(db.imports[0].added, 0);
  // creating the list fails: the products are still added, without a list
  db = await go({ lists: one('Ny') }, (d) => { d.insertFail = 'lists'; });
  assert.strictEqual(db.imports[0].status, 'done'); assert.deepStrictEqual(mine(db).map((p) => p.list_id), [null, null]);
});

test('onskeskyen: private, missing, blocked and broken answers become Danish notes; nothing is retried or worked around', async () => {
  const cases = [
    ['not found (API error 404)', { lists: {} }, ONSKE.NOTE.private, 2],
    ['wishlist null', { nullList: true }, ONSKE.NOTE.private, 2],
    ['not public', { lists: { [LIST_ID]: { title: 'Privat', accessLevel: 'Private', wishes: WISHES } } }, ONSKE.NOTE.private, 2],
    ['accessLevel LinkOnly', { lists: { [LIST_ID]: { title: 'Privat', accessLevel: 'LinkOnly', wishes: WISHES } } }, ONSKE.NOTE.private, 2],
    ['API error 403', { apiErrors: [{ message: 'Forbidden', extensions: { code: 403 } }] }, ONSKE.NOTE.private, 2],
    ['API error 500', { apiErrors: [{ message: 'Internal server error', extensions: { code: 500 } }] }, ONSKE.NOTE.unavailable, 2],
    ['429', { apiStatus: 429 }, ONSKE.NOTE.unavailable, 1], ['403', { apiStatus: 403 }, ONSKE.NOTE.unavailable, 1], ['401', { apiStatus: 401 }, ONSKE.NOTE.unavailable, 1],
    ['500', { apiStatus: 500 }, ONSKE.NOTE.unavailable, 1], ['503', { apiStatus: 503, apiBody: 'Vedligehold' }, ONSKE.NOTE.unavailable, 1], ['404 from the API itself', { apiStatus: 404 }, ONSKE.NOTE.unavailable, 1],
    ['challenge page', { apiHtml: true }, ONSKE.NOTE.unavailable, 2],
    ['connection error', { throws: true }, ONSKE.NOTE.unavailable, 1],
  ];
  for (const [name, o, note, posts] of cases) {
    const web = onskeWeb(o), db = importsDb(web); impRow(db, 'https://onskeskyen.dk/wishlists/' + LIST_ID);
    await runImp(db);
    const r = db.imports[0];
    assert.strictEqual(r.status, 'error', name); assert.strictEqual(r.note, note, name); assert.strictEqual(r.added, null, name); assert.strictEqual(r.found, null, name); assert(r.done_at, name);
    assert.strictEqual(web.calls.length, posts, name + ': no retry, no other request'); assert.deepStrictEqual(web.foreign, []);
    assert.strictEqual(db.products.length, 0, name); assert.strictEqual(db.lists.length, 0, name);
  }
  // the share link itself: 429/403/5xx on the page, 404
  for (const [st, note] of [[429, ONSKE.NOTE.unavailable], [403, ONSKE.NOTE.unavailable], [503, ONSKE.NOTE.unavailable], [404, ONSKE.NOTE.private], [410, ONSKE.NOTE.private]]) {
    const web = onskeWeb({ shortStatus: st }), db = importsDb(web); impRow(db, SHARE);
    await runImp(db); assert.strictEqual(db.imports[0].note, note, 'share link ' + st); assert.strictEqual(web.calls.length, 1);
  }
  // a request that takes too long is cut off
  const web = onskeWeb({ hang: true }), db = importsDb(web); impRow(db, SHARE);
  await runImp(db, { timeoutMs: 20 }); assert.strictEqual(db.imports[0].status, 'error'); assert.strictEqual(db.imports[0].note, ONSKE.NOTE.unavailable); assert.strictEqual(web.calls.length, 1);
  // an empty wish list
  const w3 = onskeWeb({ lists: { [LIST_ID]: { title: 'Tom', accessLevel: 'Public', wishes: [] } } }), d3 = importsDb(w3); impRow(d3, 'https://onskeskyen.dk/wishlists/' + LIST_ID);
  await runImp(d3); assert.strictEqual(d3.imports[0].status, 'error'); assert.strictEqual(d3.imports[0].note, ONSKE.NOTE.empty); assert.strictEqual(d3.imports[0].found, 0); assert.strictEqual(d3.lists.length, 0);
  // saving the products fails: an error note, the person can try again
  const w4 = onskeWeb(), d4 = importsDb(w4, { insertFail: 'products' }); impRow(d4, SHARE);
  await runImp(d4); assert.strictEqual(d4.imports[0].status, 'error'); assert.strictEqual(d4.imports[0].note, ONSKE.NOTE.saveFail);
});

test('onskeskyen: titles and links from the wish list are untrusted: only stored as JSON values, cleaned, never in a URL', async () => {
  const wishes = [
    { id: '1', title: '<script>alert(1)</script> & "x" \'y\'', url: 'https://shop.dk/p?a=1' },
    { id: '2', title: 'Uden link', url: 'javascript:alert(1)' },
    { id: '3', title: 'Http link', url: 'http://shop.dk/x' },
    { id: '4', title: '   ', url: 'https://shop.dk/skip' },
    { id: '5', title: null, url: 'https://shop.dk/skip2' },
    { id: '6', title: 'IP-adresse', url: 'https://10.0.0.1/x' },
    { id: '7', title: 'Linjeskift\n\u0007og styretegn', url: 'https://shop.dk/q?x=1&utm_source=a' },
    { id: '8', title: 'L'.repeat(300), url: 'https://shop.dk/' + 'l'.repeat(600) },
    { id: '9', title: '=1+1', url: { evil: true } },
    { id: '10', title: 'Rest' },
    null, 'tekst', 42,
  ];
  const web = onskeWeb({ lists: { [LIST_ID]: { title: '<img src=x onerror=alert(1)>', accessLevel: 'Public', wishes } } }), db = importsDb(web); impRow(db, 'https://onskeskyen.dk/wishlists/' + LIST_ID);
  await runImp(db);
  const rows = db.inserted.filter((x) => x.table === 'products').map((x) => x.row);
  assert.deepStrictEqual(rows.map((r) => r.name), ['<script>alert(1)</script> & "x" \'y\'', 'Uden link', 'Http link', 'IP-adresse', 'Linjeskift og styretegn', 'L'.repeat(140), '=1+1', 'Rest']);
  assert.deepStrictEqual(rows.map((r) => r.source_url), ['https://shop.dk/p?a=1', null, null, null, 'https://shop.dk/q?x=1', null, null, null], 'unusable links: the product is added by name only');
  assert.strictEqual(db.lists[0].name, '<img src=x onerror=alert(1)>'.slice(0, 40), 'the list name is stored as text too');
  assert.strictEqual(db.imports[0].status, 'done'); assert.strictEqual(db.imports[0].added, 8);
  assert(/2 ønsker uden navn blev sprunget over\./.test(db.imports[0].note), db.imports[0].note);
  assert(!db.urls.some((u) => /script|alert|onerror/i.test(decodeURIComponent(u))), 'no request URL carries wish-list text');
  assert.deepStrictEqual(web.foreign, []);
});

test('onskeskyen: at most 3 imports per run, oldest first; out of time leaves them pending', async () => {
  const web = onskeWeb(), db = importsDb(web);
  for (let i = 0; i < 5; i++) impRow(db, 'https://onskeskyen.dk/wishlists/' + LIST_ID, { user_id: 'u' + (i + 1) });
  db.imports.reverse();                                                                  // stored in another order than created_at
  const { stats } = await runImp(db);
  assert.strictEqual(stats.pending, 3); assert.strictEqual(stats.done, 3);
  assert.deepStrictEqual(db.imports.filter((r) => r.status === 'pending').map((r) => r.user_id).sort(), ['u4', 'u5']);
  assert.strictEqual(ONSKE.MAX_PER_RUN, 3);
  // no time left: nothing is fetched, the import stays pending
  const w2 = onskeWeb(), d2 = importsDb(w2); impRow(d2, SHARE);
  const r2 = await runImp(d2, { deadlineAt: Date.now() - 1 });
  assert.strictEqual(w2.calls.length, 0); assert.strictEqual(d2.imports[0].status, 'pending'); assert.strictEqual(r2.stats.done, 0);
  // the result could not be written: it stays pending and is tried again (the products are not added twice: same links)
  const w3 = onskeWeb(), d3 = importsDb(w3, { importPatchFail: true }); impRow(d3, 'https://onskeskyen.dk/wishlists/' + LIST_ID);
  await runImp(d3); assert.strictEqual(d3.imports[0].status, 'pending'); assert.strictEqual(mine(d3).length, 12);
  d3.importPatchFail = false; await runImp(d3);
  assert.strictEqual(d3.imports[0].status, 'done'); assert.strictEqual(mine(d3).length, 12, 'no link twice'); assert.strictEqual(d3.imports[0].added, 0);
});

test('onskeskyen: an import that is not a wish-list link is an error; a user hiding a row while it runs is harmless', async () => {
  const web = onskeWeb(), db = importsDb(web); impRow(db, 'https://evil.example.com/s/abc');
  await runImp(db); assert.strictEqual(db.imports[0].status, 'error'); assert.strictEqual(db.imports[0].note, ONSKE.NOTE.badUrl); assert.strictEqual(web.calls.length, 0);
  const w2 = onskeWeb(), d2 = importsDb(w2); impRow(d2, SHARE); d2.imports[0].status = 'done'; d2.imports[0].synced_at = NOW.toISOString();
  const r = await runImp(d2); assert.strictEqual(r.stats.pending, 0); assert.strictEqual(w2.calls.length, 0);
});

test('run: without the imports table the job runs as before, quietly', async () => {
  const web = onskeWeb(), db = newDb(); db.web = web;           // no db.imports: PostgREST answers PGRST205
  db.products.push(product('A', 'u1', 'dyson'));
  const logs = [];
  const ctx = ctxFor(db, { [urlOf('dyson')]: pageFor('dyson') }, { log: (l) => logs.push(l) });
  const res = await R.run(ctx);
  assert.strictEqual(res.summary.length, 5); assert.strictEqual(res.stats.written, 1); assert.strictEqual(res.stats.imports.missing, true);
  assert.strictEqual(web.calls.length, 0); assert(!logs.some((l) => /Ønskeliste|import/i.test(l)), logs.join('\n'));
  // any other trouble reading the imports does not fail the run either
  const db2 = newDb(); db2.imports = []; db2.products.push(product('A', 'u1', 'dyson'));
  const f = makeFake(db2);
  const ctx2 = ctxFor(db2, { [urlOf('dyson')]: pageFor('dyson') }, { fetch: async (u, o) => (/\/imports\?/.test(u) ? resp(500, '{"message":"boom"}') : f(u, o)), log: (l) => logs.push(l) });
  const r2 = await R.run(ctx2);
  assert.strictEqual(r2.stats.written, 1); assert(logs.some((l) => /kunne ikke læse importer/.test(l)));
  assert.strictEqual(ONSKE.isMissingTable(Object.assign(new Error('x'), { status: 404 })), true);
  assert.strictEqual(ONSKE.isMissingTable(new Error('GET /rest/v1/imports -> HTTP 400 {"code":"42P01"}')), true);
  assert.strictEqual(ONSKE.isMissingTable(new Error('GET -> HTTP 500 boom')), false);
});

test('run: imports come first, so the new products get their first price in the same run', async () => {
  const web = onskeWeb({ lists: { [LIST_ID]: { title: 'Nyt', accessLevel: 'Public', wishes: WISHES.slice(0, 3).concat([{ id: 'n', title: 'Kun navn', url: null }]) } } });
  const db = importsDb(web); impRow(db, SHARE);
  const pages = {};
  WISHES.slice(0, 3).forEach((w) => { pages[ONSKE.cleanWishUrl(w.url)] = pageFor('dyson'); });
  const ctx = ctxFor(db, pages);
  const res = await R.run(ctx);
  assert.strictEqual(res.stats.imports.done, 1); assert.strictEqual(res.stats.imports.added, 4); assert.strictEqual(db.imports[0].status, 'done');
  assert.strictEqual(res.summary.length, 5);
  assert.strictEqual(ctx.fetched.length, 3, 'the three new products with a link were fetched in this run: ' + ctx.fetched.join(' '));
  const withLink = db.products.filter((p) => p.source_url);
  assert.strictEqual(withLink.length, 3); assert(withLink.every((p) => p.status !== 'pending' && p.last_checked), 'first price fetched');
  const nameOnly = db.products.filter((p) => !p.source_url);
  assert.strictEqual(nameOnly.length, 1); assert.strictEqual(nameOnly[0].status, 'pending', 'a name-only product waits for the name lookup');
  assert(db.products.every((p) => p.target_type === 'auto'));
});


// ---------------------------------------------------------------- Onskeskyen: the import stays in sync (once a day)

const at = (iso) => () => new Date(iso);
const D1 = '2026-11-17T10:00:00Z', D2 = '2026-11-18T10:00:00Z';
const dayN = (n) => '2026-11-' + String(16 + n) + 'T10:00:00Z';
const idsOf = (ws) => ws.map((w) => w.id);
const mutableWeb = (wishes, extra) => { const lists = { [LIST_ID]: { title: 'Fødselsdagsønsker', accessLevel: 'Public', wishes: wishes.slice() } }; const web = onskeWeb(Object.assign({ lists }, extra || {})); web.lists = lists; return web; };
const WL = 'https://onskeskyen.dk/wishlists/' + LIST_ID;

test('sync: a finished import becomes a standing link (title, seen ids, list, synced_at) and is read again at most once a day', async () => {
  const web = mutableWeb(WISHES), db = importsDb(web);
  impRow(db, SHARE);
  await runImp(db);
  const imp = db.imports[0];
  assert.strictEqual(imp.status, 'done');
  assert.deepStrictEqual(imp.seen, idsOf(WISHES)); assert.strictEqual(imp.title, 'Fødselsdagsønsker'); assert.strictEqual(imp.sync_fails, 0);
  assert.strictEqual(imp.synced_at, '2026-11-16T10:00:00Z'); assert.strictEqual(imp.list_id, db.lists[0].id, 'the list the products went into is remembered');
  // later the same day: nothing is fetched
  web.calls.length = 0;
  let r = await runImp(db, { now: at('2026-11-17T07:59:00Z') });                // 21 h 59 min later
  assert.strictEqual(r.stats.synced, 0); assert.strictEqual(web.calls.length, 0);
  r = await runImp(db, { now: at('2026-11-17T08:00:00Z') });                    // 22 h later: due
  assert.strictEqual(r.stats.synced, 1); assert(web.calls.length > 0);
  assert.strictEqual(db.imports[0].synced_at, '2026-11-17T08:00:00Z');
  web.calls.length = 0;
  r = await runImp(db, { now: at('2026-11-17T08:15:00Z') }); assert.strictEqual(web.calls.length, 0, 'not again 15 minutes later');
});

test('sync: only wishes that are new since last time are added (same dedupe, name cleaning and tracking removal); nothing existing is touched', async () => {
  const web = mutableWeb(WISHES), db = importsDb(web);
  impRow(db, SHARE); await runImp(db);
  const before = clone(mine(db)), listId = db.imports[0].list_id;
  web.lists[LIST_ID].wishes = WISHES.concat([
    { id: 'n1', title: '  Ny cykel\n', url: 'https://www.cykler.dk/p/1?utm_source=a&gclid=2&size=m#x' },
    { id: 'n2', title: 'Samme vare igen', url: WISHES[0].url },                    // a link the person already follows
    { id: 'n3', title: 'Kun et navn', url: null },
    { id: null, title: 'Uden id', url: 'https://shop.dk/uden-id' },               // cannot be remembered: never added by a sync
    { id: 'n4', title: '   ', url: 'https://shop.dk/uden-navn' },                 // no usable name
  ]);
  web.calls.length = 0;
  const { stats, pauses, logs } = await runImp(db, { now: at(D1) });
  assert.strictEqual(stats.synced, 1); assert.strictEqual(stats.syncAdded, 2); assert.strictEqual(stats.syncFailed, 0);
  assert.deepStrictEqual(web.foreign, []); assert.deepStrictEqual(pauses, [1000, 1000, 1000], 'the same pauses as for an import');
  web.calls.forEach((c) => { assert.strictEqual(c.redirect, 'manual'); assert(c.signal); assert.strictEqual(c.headers['User-Agent'], PJ.UA); });
  const now = mine(db);
  assert.strictEqual(now.length, 14);
  assert.deepStrictEqual(now.slice(0, 12), before, 'the 12 products the person already has are untouched');
  const [cykel, navn] = now.slice(12);
  assert.strictEqual(cykel.name, 'Ny cykel'); assert.strictEqual(cykel.source_url, 'https://www.cykler.dk/p/1?size=m', 'tracking parameters and fragment removed');
  assert.strictEqual(navn.name, 'Kun et navn'); assert.strictEqual(navn.source_url, null);
  [cykel, navn].forEach((p) => { assert.strictEqual(p.status, 'pending'); assert.strictEqual(p.target_type, 'auto'); assert.strictEqual(p.target_value, null); assert.strictEqual(p.list_id, listId); assert.strictEqual(p.user_id, 'u1'); });
  const imp = db.imports[0];
  assert.strictEqual(imp.added, 14); assert.strictEqual(imp.found, 17); assert.strictEqual(imp.note, null); assert.strictEqual(imp.status, 'done'); assert.strictEqual(imp.sync_fails, 0);
  assert.deepStrictEqual(imp.seen, idsOf(WISHES).concat(['n1', 'n2', 'n3', 'n4']), 'handled wishes are remembered (also the duplicate and the one without a name), the one without an id cannot be');
  assert(logs.some((l) => /fulgt: 2 nye/.test(l)));
  // another day, nothing new: nothing added
  const r2 = await runImp(db, { now: at(D2) }); assert.strictEqual(r2.stats.syncAdded, 0); assert.strictEqual(mine(db).length, 14);
});

test('sync: a product the person removed is never added again, a wish removed from the list changes nothing', async () => {
  const web = mutableWeb(WISHES), db = importsDb(web);
  impRow(db, SHARE); await runImp(db);
  const gone = mine(db).slice(0, 3).map((p) => p.id);
  db.products = db.products.filter((p) => gone.indexOf(p.id) === -1);              // the person removed three products in the app
  const keep = mine(db).length;
  let r = await runImp(db, { now: at(D1) });
  assert.strictEqual(r.stats.synced, 1); assert.strictEqual(r.stats.syncAdded, 0); assert.strictEqual(mine(db).length, keep, 'removed products are not added again');
  web.lists[LIST_ID].wishes = WISHES.slice(3, 8);                                    // wishes were taken off the list on the wish-list site
  r = await runImp(db, { now: at(D2) }); assert.strictEqual(mine(db).length, keep, 'products stay when a wish disappears');
  web.lists[LIST_ID].wishes = WISHES.slice(0, 12).concat([{ id: 'late', title: 'Sent ønske', url: 'https://shop.dk/sent' }]);   // all back, plus one new
  r = await runImp(db, { now: at(dayN(3)) });
  assert.strictEqual(r.stats.syncAdded, 1); assert.deepStrictEqual(mine(db).slice(-1).map((p) => p.name), ['Sent ønske']); assert.strictEqual(mine(db).length, keep + 1);
  assert(!mine(db).some((p) => p.name === WISHES[0].title), 'the removed ones are still gone');
});

test('sync: an import from before this feature (no seen list) is only memorised the first time, nothing is added', async () => {
  const web = mutableWeb(WISHES), db = importsDb(web);
  impRow(db, SHARE, { status: 'done', found: 12, added: 12, done_at: '2026-11-01T10:00:00Z', list_id: null });
  assert(!('seen' in db.imports[0]));
  const r = await runImp(db);
  assert.strictEqual(r.stats.synced, 1); assert.strictEqual(r.stats.syncAdded, 0); assert.strictEqual(mine(db).length, 0, 'the person has removed everything: nothing comes back');
  assert.deepStrictEqual(db.imports[0].seen, idsOf(WISHES)); assert.strictEqual(db.imports[0].title, 'Fødselsdagsønsker'); assert.strictEqual(db.imports[0].found, 12); assert.strictEqual(db.imports[0].added, 12);
  web.lists[LIST_ID].wishes = WISHES.concat([{ id: 'new1', title: 'Nyt', url: null }]);
  await runImp(db, { now: at(D1) });
  assert.deepStrictEqual(mine(db).map((p) => p.name), ['Nyt']);
  assert(db.imports[0].list_id && db.lists.some((l) => l.id === db.imports[0].list_id && l.name === 'Fødselsdagsønsker'), 'no list known: found or made by the wish list title, and remembered');
  assert.strictEqual(mine(db)[0].list_id, db.imports[0].list_id);
});

test('sync: at most 3 per run on top of the 3 new imports, the longest-unread first; imports done less than a day ago wait', async () => {
  const web = mutableWeb(WISHES), db = importsDb(web);
  const seen = idsOf(WISHES);
  for (let i = 1; i <= 5; i++) impRow(db, WL, { user_id: 'p' + i });                       // five new imports (only 3 are taken)
  const times = ['2026-11-10T08:00:00Z', '2026-11-12T08:00:00Z', '2026-11-11T08:00:00Z', '2026-11-14T08:00:00Z', '2026-11-13T08:00:00Z', '2026-11-16T09:00:00Z', null];
  times.forEach((t, i) => impRow(db, WL, { user_id: 's' + i, status: 'done', seen, synced_at: t, found: 12, added: 12, sync_fails: 0 }));
  const r = await runImp(db);
  assert.strictEqual(r.stats.pending, 3); assert.strictEqual(r.stats.done, 3); assert.strictEqual(ONSKE.MAX_SYNCS_PER_RUN, 3); assert.strictEqual(r.stats.synced, 3);
  const synced = db.imports.filter((x) => x.user_id[0] === 's' && x.synced_at === '2026-11-16T10:00:00Z').map((x) => x.user_id).sort();
  assert.deepStrictEqual(synced, ['s0', 's2', 's6'], 'never-synced first, then the oldest');   // s6 never (null), s0 10 Nov, s2 11 Nov
  assert.strictEqual(db.imports.find((x) => x.user_id === 's5').synced_at, '2026-11-16T09:00:00Z', 'one hour ago: left alone');
  assert.deepStrictEqual(web.foreign, []);
  // the next run takes the next three (s1, s4, s3), the rest of the pending ones come too
  const r2 = await runImp(db, { now: at('2026-11-16T10:15:00Z') });
  assert.strictEqual(r2.stats.pending, 2); assert.strictEqual(r2.stats.synced, 3);
  assert.deepStrictEqual(db.imports.filter((x) => x.user_id[0] === 's' && x.synced_at === '2026-11-16T10:15:00Z').map((x) => x.user_id).sort(), ['s1', 's3', 's4']);
  // out of time: nothing is read
  const w2 = mutableWeb(WISHES), d2 = importsDb(w2); impRow(d2, WL, { status: 'done', seen, synced_at: null });
  const r3 = await runImp(d2, { deadlineAt: Date.now() - 1 }); assert.strictEqual(w2.calls.length, 0); assert.strictEqual(r3.stats.synced, 0);
});

test('sync: a list that is private or gone keeps the products, gets a short note, is tried once a day, and is given up after 7 days', async () => {
  const web = mutableWeb(WISHES), db = importsDb(web);
  impRow(db, WL); await runImp(db);
  const products = mine(db).length;
  web.lists[LIST_ID].accessLevel = 'Private';
  for (let d = 1; d <= 6; d++) {
    web.calls.length = 0;
    const r = await runImp(db, { now: at(dayN(d)) });
    const imp = db.imports[0];
    assert.strictEqual(r.stats.synced, 1, 'day ' + d); assert.strictEqual(r.stats.syncFailed, 1);
    assert.strictEqual(imp.status, 'done', 'day ' + d); assert.strictEqual(imp.sync_fails, d); assert.strictEqual(imp.note, ONSKE.NOTE.retryPrivate); assert.strictEqual(imp.synced_at, dayN(d));
    assert.strictEqual(mine(db).length, products, 'the products stay');
    const again = await runImp(db, { now: at(dayN(d).replace('T10', 'T18')) }); assert.strictEqual(again.stats.synced, 0, 'only once a day');
  }
  assert.strictEqual(ONSKE.NOTE.retryPrivate, 'Ønskelisten er ikke offentlig lige nu. Prøver igen i morgen.');
  web.calls.length = 0;
  await runImp(db, { now: at(dayN(7)) });
  assert.strictEqual(db.imports[0].status, 'error'); assert.strictEqual(db.imports[0].sync_fails, 7); assert.strictEqual(db.imports[0].note, ONSKE.NOTE.private); assert.strictEqual(mine(db).length, products);
  web.calls.length = 0;
  const r = await runImp(db, { now: at(dayN(9)) }); assert.strictEqual(web.calls.length, 0, 'after the 7th failure nothing more is fetched'); assert.strictEqual(r.stats.synced, 0);
  assert.strictEqual(ONSKE.MAX_SYNC_FAILS, 7);
  // the list disappears entirely
  const w2 = mutableWeb(WISHES), d2 = importsDb(w2); impRow(d2, WL); await runImp(d2);
  delete w2.lists[LIST_ID]; await runImp(d2, { now: at(D1) });
  assert.strictEqual(d2.imports[0].status, 'done'); assert.strictEqual(d2.imports[0].sync_fails, 1); assert.strictEqual(d2.imports[0].note, ONSKE.NOTE.retryPrivate);
  // it comes back: the counter and the note are cleared, new wishes are picked up
  w2.lists[LIST_ID] = { title: 'Fødselsdagsønsker', accessLevel: 'Public', wishes: WISHES.concat([{ id: 'back', title: 'Tilbage', url: null }]) };
  await runImp(d2, { now: at(D2) });
  assert.strictEqual(d2.imports[0].sync_fails, 0); assert.strictEqual(d2.imports[0].note, null); assert.strictEqual(mine(d2).length, 13);
});

test('sync: a site that does not answer counts as a failed day too, with its own note; our own database trouble does not count against the list', async () => {
  const web = mutableWeb(WISHES), db = importsDb(web);
  impRow(db, WL); await runImp(db);
  web.calls.length = 0;
  const w2 = mutableWeb(WISHES, { apiStatus: 503 }); db.web = w2;
  await runImp(db, { now: at(D1) });
  assert.strictEqual(db.imports[0].sync_fails, 1); assert.strictEqual(db.imports[0].note, ONSKE.NOTE.retryUnavailable); assert.strictEqual(db.imports[0].status, 'done');
  db.imports[0].sync_fails = 6;
  await runImp(db, { now: at(D2) });
  assert.strictEqual(db.imports[0].status, 'error'); assert.strictEqual(db.imports[0].note, ONSKE.NOTE.unavailable);
  // inserting the new products fails: tried again tomorrow, no failure counted, the wish is not marked as handled
  const w3 = mutableWeb(WISHES), d3 = importsDb(w3); impRow(d3, WL); await runImp(d3);
  w3.lists[LIST_ID].wishes = WISHES.concat([{ id: 'x1', title: 'Ny', url: null }]); d3.insertFail = 'products';
  await runImp(d3, { now: at(D1) });
  assert.strictEqual(d3.imports[0].sync_fails, 0); assert.strictEqual(d3.imports[0].synced_at, D1); assert(!d3.imports[0].seen.includes('x1'));
  d3.insertFail = null; await runImp(d3, { now: at(D2) });
  assert.strictEqual(mine(d3).filter((p) => p.name === 'Ny').length, 1);
  // the finished import was saved while the result could not be written: sync did not touch a row that is no longer done
  const d4 = importsDb(mutableWeb(WISHES)); impRow(d4, WL, { status: 'done', seen: idsOf(WISHES), synced_at: null });
  d4.imports[0].status = 'error';
  assert.strictEqual((await runImp(d4)).stats.synced, 0);
});

test('sync: the 40-product cap holds; wishes that did not fit are looked at again once there is room', async () => {
  const web = mutableWeb(WISHES), db = importsDb(web);
  impRow(db, WL); await runImp(db);
  for (let i = 0; i < 27; i++) db.products.push(product('f' + i, 'u1', 'dyson', { source_url: 'https://fyld.dk/' + i }));     // 12 + 27 = 39
  web.lists[LIST_ID].wishes = WISHES.concat([{ id: 'c1', title: 'Et', url: null }, { id: 'c2', title: 'To', url: null }, { id: 'c3', title: 'Tre', url: null }]);
  await runImp(db, { now: at(D1) });
  assert.strictEqual(mine(db).length, 40); assert.deepStrictEqual(db.imports[0].seen.slice(-1), ['c1']);
  assert(db.imports[0].seen.includes('c1') && !db.imports[0].seen.includes('c2') && !db.imports[0].seen.includes('c3'), 'only the one that fitted is handled');
  assert.strictEqual(db.imports[0].status, 'done'); assert.strictEqual(db.imports[0].sync_fails, 0);
  db.products = db.products.filter((p) => !/^f\d+$/.test(p.id));                          // the person makes room
  await runImp(db, { now: at(D2) });
  assert.deepStrictEqual(mine(db).slice(-2).map((p) => p.name), ['To', 'Tre']);
});

test('sync: a database without the new columns still saves a first import (plain result), and a sync that cannot be saved is logged', async () => {
  const web = mutableWeb(WISHES), db = importsDb(web, { importNoSyncColumns: true }); impRow(db, WL);
  const r = await runImp(db);
  assert.strictEqual(db.imports[0].status, 'done'); assert.strictEqual(db.imports[0].added, 12); assert.strictEqual(mine(db).length, 12);
  assert(r.logs.some((l) => /kunne ikke gemme/.test(l)), 'the sync of the same run could not be saved and says so: ' + r.logs.join(' | '));
  assert.strictEqual(r.stats.done, 1);
});

test('run: a standing import is read as part of the run; the new product is fetched in the same run; the summary stays 5 lines', async () => {
  const wishes = WISHES.slice(0, 3);
  const web = mutableWeb(wishes), db = importsDb(web);
  impRow(db, WL, { status: 'done', seen: idsOf(wishes), synced_at: '2026-11-15T09:00:00Z', found: 3, added: 3, list_id: null });
  web.lists[LIST_ID].wishes = wishes.concat([{ id: 'nyt', title: 'Nyt ønske', url: 'https://www.shop-nyt.dk/vare?utm_source=x' }]);
  const logs = [];
  const ctx = ctxFor(db, {}, { log: (l) => logs.push(l) });
  ctx.getPage = async (u) => { ctx.fetched.push(u); return pageFor('dyson'); };
  const res = await R.run(ctx);
  assert.strictEqual(res.stats.imports.synced, 1); assert.strictEqual(res.stats.imports.syncAdded, 1); assert.strictEqual(res.summary.length, 5);
  assert.deepStrictEqual(ctx.fetched, ['https://www.shop-nyt.dk/vare']);
  assert.strictEqual(db.products.length, 1); assert(db.products[0].last_checked, 'got its first price in the same run');
  assert(logs.some((l) => /Ønskelister fulgt: 1 læst igen, 1 nye varer/.test(l)));
});

// ---------------------------------------------------------------- bought products never notify

const dprod = (id, extra) => product(id, 'u1', 'dyson', Object.assign({ name: 'Dyson ' + id, target_value: 4000, digest_price: null, digest_at: null, bought_at: null, bought_price: null }, extra || {}));
const dprofile = (extra) => Object.assign({ user_id: 'u1', notify_email: true, mail_digest: false, digest_sent_at: null, shops_always: [], shops_exclude: [], shops_only: false }, extra || {});
const dpages = (add) => ({ [urlOf('dyson')]: pageFor('dyson', add ? (r) => r.price + add : null) });
const runAt = (db, iso, pages, extra) => R.run(ctxFor(db, pages || dpages(0), Object.assign({ now: at(iso) }, extra || {})));
const byIdIn = (db, id) => db.products.find((p) => p.id === id);

test('bought: a bought product is still checked and its price kept up to date, but never mails, also not at a new low; "Fortryd" lets it notify again', async () => {
  const db = newDb();
  db.products.push(dprod('K', { bought_at: '2026-11-10T12:00:00Z', bought_price: 4500 }), dprod('N'));
  db.profiles.push(dprofile());
  let res = await runAt(db, '2026-11-16T10:00:00Z');
  const K = byIdIn(db, 'K');
  assert.strictEqual(K.status, 'tracking'); assert.strictEqual(K.offers[0].price, 3999, 'the price is still checked'); assert.strictEqual(K.last_checked, '2026-11-16T10:00:00Z');
  assert(K.history.some((x) => x.src === 'check' && x.p === 3999)); assert(K.verdict);
  assert.strictEqual(K.notified_price, null, 'no hit recorded'); assert.strictEqual(res.stats.hits, 1, 'only the product that was not bought');
  assert.strictEqual(db.sent.length, 1); assert(db.sent[0].text.includes('Dyson N') && !db.sent[0].text.includes('Dyson K'));
  const kPatch = db.patches.find((p) => p.id === 'K').body;
  assert(!('notified_price' in kPatch) && !('notified_at' in kPatch) && !('bought_at' in kPatch) && !('bought_price' in kPatch), 'the job never writes the bought columns: ' + Object.keys(kPatch));
  // a lower price later: still silent
  await runAt(db, '2026-11-17T10:00:00Z', dpages(-500));
  assert.strictEqual(byIdIn(db, 'K').offers[0].price, 3499); assert.strictEqual(db.sent.length, 2, 'N hits again at the lower price');
  assert(!db.sent[1].text.includes('Dyson K'), 'K, the bought one, is not in it');
  // undone: the next check is a normal one (and mails)
  K.bought_at = null; K.bought_price = null;
  await runAt(db, '2026-11-17T10:15:00Z', dpages(-500));
  assert.strictEqual(db.sent.length, 3); assert(db.sent[2].text.includes('Dyson K') && db.sent[2].text.includes('3.499 kr.') && !db.sent[2].text.includes('Dyson N'));
  assert.strictEqual(K.notified_price, 3499);
});

test('bought: a product bought while its hit waits for the morning mail drops out of it', async () => {
  const db = newDb();
  db.products.push(dprod('K'), dprod('L'));
  db.profiles.push(dprofile({ mail_digest: true }));
  await runAt(db, '2026-11-16T05:00:00Z');                                            // collected (04:00... 06:00 CET: before 07:00)
  assert.strictEqual(byIdIn(db, 'K').digest_price, 3999);
  byIdIn(db, 'K').bought_at = '2026-11-16T05:30:00Z'; byIdIn(db, 'K').bought_price = 3999;
  await runAt(db, '2026-11-16T06:00:00Z');
  assert.strictEqual(db.sent.length, 1); assert.strictEqual(db.sent[0].subject, 'Prisvagten: 1 tilbud i dag'); assert(db.sent[0].text.includes('Dyson L') && !db.sent[0].text.includes('Dyson K'));
  assert.strictEqual(byIdIn(db, 'K').digest_price, null, 'and is forgotten');
});

// ---------------------------------------------------------------- shared lists: the job does not care who else sees a product

test('shared list: a bought mark set by another member stops the notification exactly like the owner\'s own mark; undone, only the adder is mailed', async () => {
  const db = newDb();
  // anna (u1) added K to a list she shares with bo (u3); bo marked it as bought (bought_by = u3). N is a normal product of anna's in the same list.
  db.products.push(dprod('K', { list_id: 'LS', bought_at: '2026-11-10T12:00:00Z', bought_price: 4500, bought_by: 'u3' }), dprod('N', { list_id: 'LS' }));
  db.profiles.push(dprofile(), dprofile({ user_id: 'u3' }));
  const res = await runAt(db, '2026-11-16T10:00:00Z');
  const K = byIdIn(db, 'K');
  assert.strictEqual(K.status, 'tracking'); assert.strictEqual(K.offers[0].price, 3999, 'still checked'); assert.strictEqual(K.notified_price, null, 'no hit recorded');
  assert.strictEqual(res.stats.hits, 1); assert.strictEqual(db.sent.length, 1); assert(db.sent[0].text.includes('Dyson N') && !db.sent[0].text.includes('Dyson K'));
  assert.strictEqual(K.bought_by, 'u3', 'the job leaves bought_by alone'); assert.strictEqual(K.list_id, 'LS', 'and the list');
  const kPatch = db.patches.find((p) => p.id === 'K').body;
  assert(!('bought_by' in kPatch) && !('bought_at' in kPatch) && !('list_id' in kPatch) && !('notified_price' in kPatch), Object.keys(kPatch).join());
  // bo undoes the mark: the next check notifies, and the mail goes to anna only (the person who added it), never to bo
  K.bought_at = null; K.bought_price = null; K.bought_by = null;
  await runAt(db, '2026-11-17T10:15:00Z', dpages(-500));
  assert.strictEqual(K.notified_price, 3499);
  const last = db.sent.slice(1);
  assert(last.length >= 1 && last.every((m) => /anna@example\.dk/i.test(JSON.stringify(m.to))), JSON.stringify(last.map((m) => m.to)));
  assert(last.some((m) => m.text.includes('Dyson K')));
});

test('shared list: products of several people in one list are each processed once, and every deal mail goes to the person who added the product', async () => {
  const db = newDb();
  db.products.push(dprod('S1', { list_id: 'LS' }), product('S2', 'u3', 'dyson', { name: 'Dyson S2', target_value: 4000, list_id: 'LS' }), product('S3', 'u3', 'dyson', { name: 'Dyson S3', target_value: 4000 }));
  db.profiles.push(dprofile(), dprofile({ user_id: 'u3' }));
  const res = await runAt(db, '2026-11-16T10:00:00Z');
  ['S1', 'S2', 'S3'].forEach((id) => { assert.strictEqual(db.patches.filter((p) => p.id === id).length, 1, id + ' is written once'); assert.strictEqual(byIdIn(db, id).status, 'tracking'); });
  assert.strictEqual(res.stats.hits, 3);
  assert.strictEqual(db.sent.length, 2, 'one mail per person');
  const to = (m) => JSON.stringify(m.to).toLowerCase();
  const anna = db.sent.find((m) => /anna@example/.test(to(m))), bo = db.sent.find((m) => /bo@example/.test(to(m)));
  assert(anna && bo && anna !== bo);
  assert(anna.text.includes('Dyson S1') && !anna.text.includes('Dyson S2') && !anna.text.includes('Dyson S3'), 'anna gets only her own product, not bo\'s in the shared list');
  assert(bo.text.includes('Dyson S2') && bo.text.includes('Dyson S3') && !bo.text.includes('Dyson S1'), 'bo gets only his own');
  // the same prices again: nothing is mailed twice
  await runAt(db, '2026-11-16T10:30:00Z'); assert.strictEqual(db.sent.length, 2);
  // the products stay where they were put
  assert.strictEqual(byIdIn(db, 'S1').list_id, 'LS'); assert.strictEqual(byIdIn(db, 'S2').list_id, 'LS'); assert.strictEqual(byIdIn(db, 'S2').user_id, 'u3');
});

test('shared list: a member\'s bought mark also drops the hit out of the waiting morning mail', async () => {
  const db = newDb();
  db.products.push(dprod('K', { list_id: 'LS' }), dprod('L', { list_id: 'LS' }));
  db.profiles.push(dprofile({ mail_digest: true }));
  await runAt(db, '2026-11-16T05:00:00Z');
  assert.strictEqual(byIdIn(db, 'K').digest_price, 3999);
  Object.assign(byIdIn(db, 'K'), { bought_at: '2026-11-16T05:30:00Z', bought_price: 3999, bought_by: 'u3' });
  await runAt(db, '2026-11-16T06:00:00Z');
  assert.strictEqual(db.sent.length, 1); assert(db.sent[0].text.includes('Dyson L') && !db.sent[0].text.includes('Dyson K'));
  assert.strictEqual(byIdIn(db, 'K').digest_price, null);
});

// ---------------------------------------------------------------- the one morning mail

test('digest: copenhagenHour and the 07:00 window follow Copenhagen time, also on the days the clock changes', () => {
  const D = require('./lib/digest');
  const w = (iso, sent) => D.digestWindow(new Date(iso), sent || null);
  assert.strictEqual(D.copenhagenHour(new Date('2026-11-16T05:59:00Z')), 6); assert.strictEqual(D.copenhagenHour(new Date('2026-11-16T06:00:00Z')), 7);
  // winter (UTC+1): 07:00 is 06:00Z
  assert(!w('2026-11-16T05:59:59Z') && w('2026-11-16T06:00:00Z'));
  // summer (UTC+2): 07:00 is 05:00Z
  assert(!w('2026-07-01T04:59:59Z') && w('2026-07-01T05:00:00Z'));
  // spring forward, Sunday 29 March 2026 (01:00Z): before it 07:00 was 06:00Z, after it 05:00Z
  assert(!w('2026-03-28T05:59:00Z') && w('2026-03-28T06:00:00Z'));
  assert(!w('2026-03-29T04:59:00Z') && w('2026-03-29T05:00:00Z'));
  assert.strictEqual(D.copenhagenHour(new Date('2026-03-29T00:59:00Z')), 1); assert.strictEqual(D.copenhagenHour(new Date('2026-03-29T01:00:00Z')), 3, '02:xx does not exist that night');
  // fall back, Sunday 25 October 2026 (01:00Z): before it 07:00 was 05:00Z, after it 06:00Z
  assert(!w('2026-10-24T04:59:00Z') && w('2026-10-24T05:00:00Z'));
  assert(!w('2026-10-25T05:59:00Z') && w('2026-10-25T06:00:00Z'));
  assert.strictEqual(D.copenhagenHour(new Date('2026-10-25T00:30:00Z')), 2); assert.strictEqual(D.copenhagenHour(new Date('2026-10-25T01:30:00Z')), 2, '02:30 happens twice');
  assert.strictEqual(D.copenhagenHour(new Date('2026-10-24T22:00:00Z')), 0, 'midnight');
  // once per Copenhagen date (not UTC date), also over the changes
  assert(!w('2026-11-16T10:00:00Z', '2026-11-15T23:30:00Z'), '00:30 on the 16th in Copenhagen is the same day as 10:00Z');
  assert(w('2026-11-16T10:00:00Z', '2026-11-15T22:59:00Z'), '23:59 on the 15th is yesterday');
  assert(!w('2026-10-25T06:00:00Z', '2026-10-24T22:30:00Z') && w('2026-10-25T06:00:00Z', '2026-10-24T21:59:00Z'), 'fall-back day');
  assert(!w('2026-03-29T05:00:00Z', '2026-03-28T23:30:00Z') && w('2026-03-29T05:00:00Z', '2026-03-28T22:59:00Z'), 'spring-forward day');
  assert(w('2026-11-16T10:00:00Z', 'not a date') && w('2026-11-16T10:00:00Z', undefined));
  assert.strictEqual(D.digestSubject(1), 'Prisvagten: 1 tilbud i dag'); assert.strictEqual(D.digestSubject(3), 'Prisvagten: 3 tilbud i dag');
  assert(D.isDigestUser({ mail_digest: true }) && !D.isDigestUser({ mail_digest: true, notify_email: false }) && !D.isDigestUser({ mail_digest: false }) && !D.isDigestUser({}) && !D.isDigestUser(null));
});

test('digest: hits are collected, one mail goes out at the first run from 07:00 Copenhagen time, and not again that day', async () => {
  const db = newDb();
  db.products.push(dprod('A'), dprod('B'), dprod('C', { target_value: 100 }));            // C never hits
  db.profiles.push(dprofile({ mail_digest: true }));
  let res = await runAt(db, '2026-11-16T05:30:00Z');                                      // 06:30 in Copenhagen
  assert.strictEqual(db.sent.length, 0, 'collected, not mailed'); assert.strictEqual(res.stats.hits, 2);
  ['A', 'B'].forEach((id) => { const p = byIdIn(db, id); assert.strictEqual(p.notified_price, 3999); assert.strictEqual(p.digest_price, 3999); assert.strictEqual(p.digest_at, '2026-11-16T05:30:00Z'); });
  assert.strictEqual(byIdIn(db, 'C').digest_price, null); assert.strictEqual(db.profiles[0].digest_sent_at, null);
  await runAt(db, '2026-11-16T05:59:00Z'); assert.strictEqual(db.sent.length, 0, '06:59');
  res = await runAt(db, '2026-11-16T06:00:00Z');                                          // 07:00
  assert.strictEqual(db.sent.length, 1); assert.strictEqual(res.stats.digests, 1);
  const m = db.sent[0];
  assert.deepStrictEqual(m.to, ['anna@example.dk']); assert.strictEqual(m.subject, 'Prisvagten: 2 tilbud i dag');
  assert(m.text.includes('Dyson A') && m.text.includes('Dyson B') && !m.text.includes('Dyson C') && m.text.includes('3.999 kr.') && m.text.includes('Link til butikken: https://'), m.text);
  assert.strictEqual(db.profiles[0].digest_sent_at, '2026-11-16T06:00:00Z');
  assert(/morgenmails: 1/.test(res.summary.join(' ')));
  await runAt(db, '2026-11-16T06:15:00Z'); await runAt(db, '2026-11-16T14:00:00Z');
  assert.strictEqual(db.sent.length, 1, 'one mail a day');
  // the next morning, same prices: nothing new, no mail (the same rule as without the morning mail)
  await runAt(db, '2026-11-17T06:00:00Z'); assert.strictEqual(db.sent.length, 1);
  // no hits at all: no mail (and the day is not used up)
  const d2 = newDb(); d2.products.push(dprod('Z', { target_value: 100 })); d2.profiles.push(dprofile({ mail_digest: true }));
  await runAt(d2, '2026-11-16T06:00:00Z'); assert.strictEqual(d2.sent.length, 0); assert.strictEqual(d2.profiles[0].digest_sent_at, null);
});

test('digest: a hit that comes in after the morning mail waits for the next morning; a further price drop is mailed again, the same price is not', async () => {
  const db = newDb();
  db.products.push(dprod('A'));
  db.profiles.push(dprofile({ mail_digest: true }));
  await runAt(db, '2026-11-16T06:00:00Z');                                                // collected at 07:00 and mailed in the same run
  assert.strictEqual(db.sent.length, 1); assert.strictEqual(db.sent[0].subject, 'Prisvagten: 1 tilbud i dag');
  db.products.push(dprod('B'));                                                           // a second product hits at 11:00
  await runAt(db, '2026-11-16T10:00:00Z'); assert.strictEqual(db.sent.length, 1, 'waits'); assert.strictEqual(byIdIn(db, 'B').digest_price, 3999);
  await runAt(db, '2026-11-17T05:59:00Z'); assert.strictEqual(db.sent.length, 1);
  await runAt(db, '2026-11-17T06:00:00Z');
  assert.strictEqual(db.sent.length, 2); assert(db.sent[1].text.includes('Dyson B') && !db.sent[1].text.includes('Dyson A'), 'A was in yesterday\'s mail and is not mailed again');
  // A drops further: collected at once, mailed the next morning
  await runAt(db, '2026-11-17T12:00:00Z', dpages(-100));
  assert.strictEqual(byIdIn(db, 'A').digest_price, 3899); assert.strictEqual(db.sent.length, 2, 'collected, not mailed (the 07:00 mail of the day has gone)');
  await runAt(db, '2026-11-18T06:00:00Z', dpages(-100));
  assert.strictEqual(db.sent.length, 3); assert(db.sent[2].text.includes('3.899 kr.') && db.sent[2].text.includes('Dyson A') && db.sent[2].text.includes('Dyson B'), 'B fell too (same page)');
  assert.strictEqual(db.sent[2].subject, 'Prisvagten: 2 tilbud i dag');
  await runAt(db, '2026-11-19T06:00:00Z', dpages(-100)); assert.strictEqual(db.sent.length, 3);
});

test('digest: only hits that still stand are mailed (price still at or below the one that triggered it)', async () => {
  const db = newDb();
  db.products.push(dprod('A', { target_value: 4200 }), dprod('B'), dprod('C'));
  db.profiles.push(dprofile({ mail_digest: true }));
  await runAt(db, '2026-11-16T05:00:00Z');                                                // all three collected at 3999
  assert.strictEqual(db.products.filter((p) => p.digest_price === 3999).length, 3);
  // 07:00: the price has gone up to 4100. A (goal 4200) is still a hit but above its collected price; B and C (goal 4000) are no hits any more
  await runAt(db, '2026-11-16T06:00:00Z', dpages(101));
  assert.strictEqual(db.sent.length, 0, 'nothing valid to mail'); assert.strictEqual(db.profiles[0].digest_sent_at, null, 'and the day is not used up');
  assert.strictEqual(byIdIn(db, 'B').digest_price, null, 'a hit that is gone is forgotten'); assert.strictEqual(byIdIn(db, 'B').notified_price, null);
  assert.strictEqual(byIdIn(db, 'A').digest_price, 3999); assert.strictEqual(byIdIn(db, 'A').notified_price, 3999);
  // later that day the price is back below: A is valid again and goes out
  await runAt(db, '2026-11-16T09:00:00Z', dpages(-49));
  assert.strictEqual(db.sent.length, 1); assert(db.sent[0].text.includes('Dyson A') && db.sent[0].text.includes('3.950 kr.') && !db.sent[0].text.includes('3.999'), 'the price now, not the old one');
  assert.strictEqual(db.sent[0].subject, 'Prisvagten: 3 tilbud i dag', 'A is valid again, B and C hit again');
});

test('digest: a failed send gives the day back and is tried again at the next run; a mail is never sent twice for a day', async () => {
  const db = newDb();
  db.products.push(dprod('A'));
  db.profiles.push(dprofile({ mail_digest: true }));
  await runAt(db, '2026-11-16T05:00:00Z');
  db.resendFail = true;
  const r = await runAt(db, '2026-11-16T06:00:00Z');
  assert.strictEqual(db.sent.length, 0); assert.strictEqual(db.profiles[0].digest_sent_at, null, 'claim given back');
  assert.deepStrictEqual(db.profilePatches.map((x) => [x.cond, x.body.digest_sent_at]), [['is.null', '2026-11-16T06:00:00Z'], ['eq.2026-11-16T06:00:00Z', null]], 'claim, then roll back to what it was');
  assert.strictEqual(r.stats.mailSkipped, 1); assert.strictEqual(byIdIn(db, 'A').digest_price, 3999, 'the hit is still waiting');
  db.resendFail = false;
  await runAt(db, '2026-11-16T06:15:00Z');
  assert.strictEqual(db.sent.length, 1); assert.strictEqual(db.profiles[0].digest_sent_at, '2026-11-16T06:15:00Z');
  await runAt(db, '2026-11-16T06:30:00Z'); await runAt(db, '2026-11-16T06:30:00Z'); assert.strictEqual(db.sent.length, 1);
  // the claim is lost to another run that was faster: no mail from this one
  const d2 = newDb(); d2.products.push(dprod('A')); d2.profiles.push(dprofile({ mail_digest: true }));
  await runAt(d2, '2026-11-16T05:00:00Z');
  d2.beforeClaim = () => { d2.profiles[0].digest_sent_at = '2026-11-16T06:00:00Z'; };
  await runAt(d2, '2026-11-16T06:00:30Z'); assert.strictEqual(d2.sent.length, 0, 'the other run sends it');
  // a crashed run (the product writes of its run are gone, the claim is not): the hit is found as new again, but the day is used up
  const d3 = newDb(); d3.products.push(dprod('A')); d3.profiles.push(dprofile({ mail_digest: true, digest_sent_at: '2026-11-16T06:00:00Z' }));
  await runAt(d3, '2026-11-16T06:30:00Z'); assert.strictEqual(d3.sent.length, 0);
  await runAt(d3, '2026-11-17T06:00:00Z'); assert.strictEqual(d3.sent.length, 1, 'next morning it goes out, once');
  await runAt(d3, '2026-11-17T06:15:00Z'); assert.strictEqual(d3.sent.length, 1);
  // the claim itself cannot be written: no mail
  const d4 = newDb(); d4.products.push(dprod('A')); d4.profiles.push(dprofile({ mail_digest: true })); d4.profilePatchFail = true;
  await runAt(d4, '2026-11-16T05:00:00Z'); const r4 = await runAt(d4, '2026-11-16T06:00:00Z'); assert.strictEqual(d4.sent.length, 0); assert.strictEqual(r4.stats.mailSkipped, 1);
  d4.profilePatchFail = false; await runAt(d4, '2026-11-16T06:15:00Z'); assert.strictEqual(d4.sent.length, 1);
});

test('digest: hits found in this run are saved before the mail; a product that cannot be saved is left out and found again next run', async () => {
  const db = newDb();
  db.products.push(dprod('A'), dprod('B'));
  db.profiles.push(dprofile({ mail_digest: true }));
  db.patchFail = 'B';
  const r = await runAt(db, '2026-11-16T06:00:00Z');                                      // both hit for the first time, at 07:00
  assert.strictEqual(db.sent.length, 1); assert(db.sent[0].text.includes('Dyson A') && !db.sent[0].text.includes('Dyson B'));
  assert.strictEqual(db.sent[0].subject, 'Prisvagten: 1 tilbud i dag'); assert.strictEqual(r.stats.writeFail >= 1, true);
  assert.strictEqual(byIdIn(db, 'A').digest_price, 3999, 'A was saved before the claim');
  assert.strictEqual(byIdIn(db, 'B').notified_price, null, 'B is still a new hit next time');
  db.patchFail = null;
  await runAt(db, '2026-11-17T06:00:00Z');
  assert.strictEqual(db.sent.length, 2); assert(db.sent[1].text.includes('Dyson B') && !db.sent[1].text.includes('Dyson A'));
});

test('digest: the e-mail switch decides first (off means no mail at all); no key, no mail and no claim; switched off again, waiting hits go out as normal mail', async () => {
  // "Send e-mail" off: nothing collected, nothing mailed, ever
  const db = newDb(); db.products.push(dprod('A')); db.profiles.push(dprofile({ mail_digest: true, notify_email: false }));
  await runAt(db, '2026-11-16T05:00:00Z'); await runAt(db, '2026-11-16T06:00:00Z'); await runAt(db, '2026-11-17T06:00:00Z');
  assert.strictEqual(db.sent.length, 0); assert.strictEqual(byIdIn(db, 'A').digest_price, null); assert.strictEqual(db.profiles[0].digest_sent_at, null); assert.strictEqual(byIdIn(db, 'A').notified_price, 3999, 'the hit is recorded, as for any opted-out person');
  // no Resend key: nothing claimed, the hit waits and goes out once mail works
  const d2 = newDb(); d2.products.push(dprod('A')); d2.profiles.push(dprofile({ mail_digest: true }));
  await runAt(d2, '2026-11-16T05:00:00Z', null, { resendKey: '' }); const r2 = await runAt(d2, '2026-11-16T06:00:00Z', null, { resendKey: '' });
  assert.strictEqual(d2.sent.length, 0); assert.strictEqual(d2.profiles[0].digest_sent_at, null); assert(/RESEND_API_KEY/.test(r2.summary.join('\n')));
  await runAt(d2, '2026-11-16T06:15:00Z'); assert.strictEqual(d2.sent.length, 1);
  // the person is not on the allow-list: no mail, no claim
  const d3 = newDb(); d3.allowed_emails = []; d3.products.push(dprod('A')); d3.profiles.push(dprofile({ mail_digest: true }));
  await runAt(d3, '2026-11-16T05:00:00Z'); await runAt(d3, '2026-11-16T06:00:00Z'); assert.strictEqual(d3.sent.length, 0); assert.strictEqual(d3.profiles[0].digest_sent_at, null);
  // switched off while a hit was waiting: it goes out with the next run as a normal mail and is no longer waiting
  const d4 = newDb(); d4.products.push(dprod('A')); d4.profiles.push(dprofile({ mail_digest: true }));
  await runAt(d4, '2026-11-16T05:00:00Z'); assert.strictEqual(d4.sent.length, 0);
  d4.profiles[0].mail_digest = false;
  await runAt(d4, '2026-11-16T05:15:00Z'); assert.strictEqual(d4.sent.length, 1); assert.notStrictEqual(d4.sent[0].subject, 'Prisvagten: 1 tilbud i dag'); assert(d4.sent[0].text.includes('Dyson A'));
  assert.strictEqual(byIdIn(d4, 'A').digest_price, null);
  await runAt(d4, '2026-11-16T05:30:00Z'); assert.strictEqual(d4.sent.length, 1);
  // without the morning mail everything is as before: a mail per run with new hits, nothing is collected
  const d5 = newDb(); d5.products.push(dprod('A')); d5.profiles.push(dprofile());
  await runAt(d5, '2026-11-16T03:00:00Z'); assert.strictEqual(d5.sent.length, 1); assert.strictEqual(byIdIn(d5, 'A').digest_price, null);
  // a person without a profile row, and a database without the new columns, are unchanged too
  const d6 = newDb(); d6.products.push(product('A', 'u1', 'dyson', { target_value: 4000 }));
  await runAt(d6, '2026-11-16T03:00:00Z'); assert.strictEqual(d6.sent.length, 1); assert(!('digest_price' in byIdIn(d6, 'A')));
});

test('digest: DST days in a full run (07:00 is 05:00Z in summer time, 06:00Z in winter time)', async () => {
  for (const [day, early, on] of [['2026-03-28', '05:59', '06:00'], ['2026-03-29', '04:59', '05:00'], ['2026-10-24', '04:59', '05:00'], ['2026-10-25', '05:59', '06:00'], ['2026-07-01', '04:59', '05:00']]) {
    const db = newDb(); db.products.push(dprod('A')); db.profiles.push(dprofile({ mail_digest: true }));
    await runAt(db, day + 'T' + early + ':00Z'); assert.strictEqual(db.sent.length, 0, day + ' ' + early);
    await runAt(db, day + 'T' + on + ':00Z'); assert.strictEqual(db.sent.length, 1, day + ' ' + on);
    await runAt(db, day + 'T' + on.slice(0, 3) + '30:00Z'); assert.strictEqual(db.sent.length, 1, day + ' second run');
  }
  // the person's last digest was claimed just before midnight Copenhagen time, which is still the day before in UTC
  const db = newDb(); db.products.push(dprod('A')); db.profiles.push(dprofile({ mail_digest: true, digest_sent_at: '2026-10-24T21:59:00Z' }));
  await runAt(db, '2026-10-25T05:00:00Z'); assert.strictEqual(db.sent.length, 0, 'before 07:00 CET'); await runAt(db, '2026-10-25T06:00:00Z'); assert.strictEqual(db.sent.length, 1);
});

// ---------------------------------------------------------------- live sanity check (opt-in)

// ---------------------------------------------------------------- compare: find the cheapest shop (switch from one shop to Prisjagt)

const wantedOf = (db, id) => db.products.find((p) => p.id === id).compare_state;

test("compare: a shop that refuses, or has no price we can read, asks for a comparison once (compare_state 'wanted'); nothing else does", async () => {
  const db = newDb();
  const A1 = 'https://www.afvisende.dk/a', A2 = 'https://afvisende.dk/b', NOP = 'https://www.tom.dk/e', EUR = 'https://www.udlandet.dk/d', GONE = 'https://www.vaek.dk/g', SLOW = 'https://www.langsom.dk/h', NET = 'https://www.net.dk/i', OK = 'https://www.fornuftig.dk/c';
  db.products.push(shopProduct('C1', 'u1', A1), shopProduct('C2', 'u1', A2), shopProduct('C3', 'u1', NOP), shopProduct('C4', 'u1', EUR), shopProduct('C5', 'u1', GONE), shopProduct('C6', 'u1', SLOW), shopProduct('C7', 'u1', NET),
    shopProduct('C8', 'u1', OK, { target_value: 1 }), product('C9', 'u1', 'dyson', { target_value: 1 }),
    shopProduct('D1', 'u1', 'https://www.afvisende2.dk/x', { compare_state: 'none', compare_at: '2026-11-01T00:00:00Z' }), shopProduct('D2', 'u1', 'https://www.afvisende3.dk/x', { compare_state: 'done', shop_url: 'https://old.dk/x' }),
    shopProduct('D3', 'u1', 'https://www.afvisende4.dk/x', { compare_state: 'wanted', compare_at: '2026-11-02T00:00:00Z' }));
  const map = { [A1]: () => resp(403, 'Forbidden'), [A2]: shopHtml('shop-jsonld-single'), [NOP]: shopHtml('shop-noprice'), [EUR]: shopHtml('shop-eur'), [GONE]: () => resp(404, ''), [SLOW]: () => { const e = new Error('t'); e.name = 'AbortError'; throw e; },
    [NET]: () => resp(502, 'Bad gateway'), [OK]: shopHtml('shop-jsonld-single'), 'https://www.afvisende2.dk/x': () => resp(429, ''), 'https://www.afvisende3.dk/x': () => resp(403, ''), 'https://www.afvisende4.dk/x': () => resp(403, '') };
  const ctx = shopCtx(db, map, { getPage: undefined }); const dyson = pageFor('dyson');
  ctx.getPage = async (url) => { ctx.fetched.push(url); return url.indexOf('prisjagt.dk') !== -1 ? dyson : fetchShop(url, map, ctx.calls); };
  await R.run(ctx);
  const w = (id) => wantedOf(db, id), by = (id) => db.products.find((p) => p.id === id);
  assert.strictEqual(w('C1'), 'wanted', 'refused (403)'); assert.strictEqual(by('C1').check_note, 'Butikken afviser automatiske opslag.'); assert.strictEqual(by('C1').status, 'error');
  assert.strictEqual(w('C2'), 'wanted', 'same host, skipped after the refusal in this run: asked for as well'); assert.strictEqual(by('C2').status, 'pending', 'but otherwise not touched'); assert(!ctx.fetched.includes(A2));
  assert.strictEqual(w('C3'), 'wanted', 'no price in the structured data'); assert.strictEqual(w('C4'), 'wanted', 'not in kroner');
  assert.strictEqual(w('C5'), null, 'page gone (404)'); assert.strictEqual(w('C6'), null, 'timeout'); assert.strictEqual(w('C7'), null, 'network error / 5xx');
  assert.strictEqual(w('C8'), null, 'a shop that works'); assert.strictEqual(w('C9'), null, 'a prisjagt link');
  assert.strictEqual(w('D1'), 'none', 'looked for and not found: never again'); assert.strictEqual(by('D1').compare_at, '2026-11-01T00:00:00Z');
  assert.strictEqual(w('D2'), 'done'); assert.strictEqual(by('D2').shop_url, 'https://old.dk/x'); assert.strictEqual(w('D3'), 'wanted'); assert.strictEqual(by('D3').compare_at, '2026-11-02T00:00:00Z', 'a request is not stamped again');
  assert.strictEqual(by('C1').compare_at, '2026-11-16T10:00:00Z', 'the time of the request is stored'); assert.strictEqual(by('C2').compare_at, '2026-11-16T10:00:00Z');
  assert(db.sent.length === 0);
  // a tracked product whose shop starts to refuse (error on a normal check) asks as well, once, and keeps its data
  const db2 = newDb();
  db2.products.push(shopProduct('T1', 'u1', A1, { status: 'tracking', tracked_variants: ['shop'], offers: [{ store: 'S', price: 5, inStock: true, url: A1, note: null, variant: 'shop' }], history: [{ d: '2026-11-01', p: 5, s: 'S', src: 'check' }] }));
  await R.run(shopCtx(db2, map));
  assert.strictEqual(db2.products[0].compare_state, 'wanted'); assert.strictEqual(db2.products[0].status, 'tracking'); assert.strictEqual(db2.products[0].history.length, 1); assert.strictEqual(db2.products[0].check_note, 'Butikken afviser automatiske opslag.');
  // a database without the columns (the row has no compare_state key at all): nothing is written
  const db3 = newDb();
  db3.products.push(shopProduct('N1', 'u1', A1)); delete db3.products[0].compare_state; delete db3.products[0].compare_at; delete db3.products[0].shop_url;
  await R.run(shopCtx(db3, map));
  assert(!('compare_state' in db3.products[0]) && !('compare_at' in db3.products[0]), 'the missing column is never written'); assert.strictEqual(db3.products[0].status, 'error');
  assert(R.wantsCompare({ compare_state: null }, { shop: true }, Object.assign(new PJ.PageError('blocked', 'x'), { shop: true })));
  assert(!R.wantsCompare({ compare_state: null }, { shop: false }, Object.assign(new PJ.PageError('blocked', 'x'), { shop: true })), 'never for prisjagt');
  assert(!R.wantsCompare({ compare_state: null }, { shop: true }, new Error('x')));
});

test('compare: an old error row (already waiting out the 6-hour retry) is marked from its stored note, without a fetch', async () => {
  const recent = '2026-11-16T08:00:00Z';
  const err = (id, url, note, extra) => shopProduct(id, 'u1', url, Object.assign({ status: 'error', check_note: note, last_checked: recent }, extra || {}));
  const db = newDb();
  db.products.push(
    err('E1', 'https://www.a1.dk/x', 'Butikken afviser automatiske opslag.'), err('E2', 'https://www.a2.dk/x', 'Kunne ikke finde en pris på siden.'),
    err('E3', 'https://www.a3.dk/x', 'Prisen på siden er ikke i kroner (valuta EUR), så den kan ikke følges.'),
    err('F1', 'https://www.b1.dk/x', 'Siden findes ikke (HTTP 404). Tjek linket.'), err('F2', 'https://www.b2.dk/x', 'Butikken svarede ikke i tide.'), err('F3', 'https://www.b3.dk/x', 'Siden kunne ikke hentes (HTTP 502).'),
    err('G1', 'https://www.c1.dk/x', 'Butikken afviser automatiske opslag.', { compare_state: 'none', compare_at: '2026-11-01T00:00:00Z' }),
    err('G2', 'https://www.c2.dk/x', 'Butikken afviser automatiske opslag.', { compare_state: 'done', shop_url: 'https://old.dk/x' }),
    err('G3', 'https://www.c3.dk/x', 'Butikken afviser automatiske opslag.', { compare_state: 'wanted', compare_at: '2026-11-02T00:00:00Z' }),
    err('H1', 'https://prisjagt.dk/product.php?p=5745115', 'Butikken afviser automatiske opslag.'));
  const ctx = shopCtx(db, {});
  ctx.getPage = async (url) => { ctx.fetched.push(url); throw new Error('no fetch expected: ' + url); };
  const res = await R.run(ctx);
  const by = (id) => db.products.find((p) => p.id === id);
  assert.deepStrictEqual(ctx.fetched, [], 'nothing is fetched'); assert.strictEqual(res.summary.length, 5);
  ['E1', 'E2', 'E3'].forEach((id) => { assert.strictEqual(by(id).compare_state, 'wanted', id); assert.strictEqual(by(id).compare_at, '2026-11-16T10:00:00Z', id); assert.strictEqual(by(id).status, 'error'); assert.strictEqual(by(id).last_checked, recent, id + ' keeps its check time'); });
  ['F1', 'F2', 'F3', 'H1'].forEach((id) => assert.strictEqual(by(id).compare_state, null, id));
  assert.strictEqual(by('G1').compare_state, 'none'); assert.strictEqual(by('G1').compare_at, '2026-11-01T00:00:00Z');
  assert.strictEqual(by('G2').compare_state, 'done'); assert.strictEqual(by('G2').shop_url, 'https://old.dk/x');
  assert.strictEqual(by('G3').compare_state, 'wanted'); assert.strictEqual(by('G3').compare_at, '2026-11-02T00:00:00Z');
  assert.strictEqual(db.sent.length, 0);
  // a database without the column: nothing is written
  const db2 = newDb();
  db2.products.push(err('N1', 'https://www.a1.dk/x', 'Butikken afviser automatiske opslag.')); delete db2.products[0].compare_state; delete db2.products[0].compare_at; delete db2.products[0].shop_url;
  const ctx2 = shopCtx(db2, {}); ctx2.getPage = async (url) => { ctx2.fetched.push(url); throw new Error('no fetch'); };
  await R.run(ctx2);
  assert(!('compare_state' in db2.products[0]) && !('compare_at' in db2.products[0]));
});

test('compare: Onskeskyen wishes with one shop link ask for a comparison; a prisjagt link or no link does not; a missing column does not stop the import', async () => {
  const web = onskeWeb(), db = importsDb(web); impRow(db, SHARE);
  await runImp(db);
  const rows = mine(db);
  assert.strictEqual(rows.length, 12);
  rows.forEach((p) => {
    const host = p.source_url ? new URL(p.source_url).hostname : null;
    assert.strictEqual(p.compare_state, p.source_url && !SHOP.isPrisjagtHost(host) ? 'wanted' : null, p.name + ' ' + p.source_url);
  });
  assert(rows.some((p) => p.compare_state === 'wanted'));
  // synthetic list: shop link, prisjagt link, no link
  const wl = [{ id: 'w1', title: 'Sko', price: 1, currency: 'DKK', url: 'https://www.adidas.dk/sko/x' }, { id: 'w2', title: 'Støvsuger', price: 1, currency: 'DKK', url: 'https://www.prisjagt.dk/product.php?p=5745115' },
    { id: 'w3', title: 'Bare et navn', price: null, currency: null, url: null }, { id: 'w4', title: 'Ugyldigt', price: 1, currency: 'DKK', url: 'http://shop.dk/x' }];
  const db2 = importsDb(onskeWeb({ lists: { [LIST_ID]: { title: 'T', accessLevel: 'Public', wishes: wl } } })); impRow(db2, 'https://onskeskyen.dk/wishlists/' + LIST_ID);
  await runImp(db2);
  assert.deepStrictEqual(mine(db2).map((p) => [p.name, p.source_url, p.compare_state]), [['Sko', 'https://www.adidas.dk/sko/x', 'wanted'], ['Støvsuger', 'https://prisjagt.dk/product.php?p=5745115', null], ['Bare et navn', null, null], ['Ugyldigt', null, null]]);
  // the database has not got the columns yet: the same rows are added without compare_state
  const db3 = importsDb(onskeWeb({ lists: { [LIST_ID]: { title: 'T', accessLevel: 'Public', wishes: wl } } }), { noCompareColumn: true }); impRow(db3, 'https://onskeskyen.dk/wishlists/' + LIST_ID);
  const r3 = await runImp(db3);
  assert.strictEqual(r3.stats.added, 4); assert.strictEqual(mine(db3).length, 4); assert(mine(db3).every((p) => !('compare_state' in p)));
  assert.strictEqual(db3.imports[0].status, 'done');
  // the daily sync adds new wishes the same way
  const web4 = onskeWeb({ lists: { [LIST_ID]: { title: 'T', accessLevel: 'Public', wishes: wl.slice(0, 1) } } }), db4 = importsDb(web4);
  impRow(db4, 'https://onskeskyen.dk/wishlists/' + LIST_ID); await runImp(db4);
  assert.strictEqual(mine(db4).length, 1);
  web4.lists = null;
  const web5 = onskeWeb({ lists: { [LIST_ID]: { title: 'T', accessLevel: 'Public', wishes: wl.slice(0, 2).concat([{ id: 'w9', title: 'Ny ting', price: 1, currency: 'DKK', url: 'https://www.proshop.dk/Mus/x' }]) } } });
  db4.web = web5; db4.imports[0].synced_at = '2026-11-14T10:00:00Z';
  await runImp(db4);
  const added = mine(db4).filter((p) => p.name === 'Ny ting' || p.name === 'Støvsuger');
  assert.deepStrictEqual(added.map((p) => [p.name, p.compare_state]), [['Støvsuger', null], ['Ny ting', 'wanted']]);
});

// What resolver_compare does to a row (supabase/schema.sql), for the fake database: the original link goes to shop_url, the Prisjagt page is the new link, the
// job-written state is reset the way a link change resets it. The person's fields and the alternatives stay.
function switchLikeSql(p, url) {
  Object.assign(p, { shop_url: p.source_url, source_url: url, compare_state: 'done', compare_at: '2026-11-16T09:00:00Z', status: 'pending', tracked_variants: null, title: null, variants: null, offers: null, history: null,
    normal_price: null, verdict: null, warning: null, check_note: null, last_checked: null, notified_price: null, notified_at: null, backfill_state: null, digest_price: null, digest_at: null });
  return p;
}

test("compare: after a switch the job tracks the Prisjagt page as a new product; the first check is silent (no mail, only notified_price), a later real drop mails; no archive lookup", async () => {
  const SHOP_URL = 'https://www.adidas.dk/sko/samba', PJ_URL = urlOf('dyson');
  const db = newDb();
  // a wish followed in one shop: it had history and a price there, auto goal. The shop refuses now, the agent found it on Prisjagt.
  db.products.push(shopProduct('W1', 'u1', SHOP_URL, { name: 'Dyson V15', target_type: 'auto', target_value: null, status: 'error', check_note: 'Butikken afviser automatiske opslag.', history: [{ d: '2026-10-01', p: 5200, s: 'Adidas', src: 'check' }],
    offers: [{ store: 'Adidas', price: 5200, inStock: true, url: SHOP_URL, note: null, variant: 'shop' }], tracked_variants: ['shop'], notified_price: 5200, backfill_state: { at: '2026-11-01T00:00:00Z', result: 'done', found: 0, tries: 1 }, compare_state: 'wanted', compare_at: '2026-11-15T00:00:00Z',
    alternatives: [{ kind: 'deal', name: 'x' }], list_id: 'L1', bought_at: null }));
  switchLikeSql(db.products[0], PJ_URL);
  const wb = [], dyson = pageFor('dyson');
  const mk = (page) => { const ctx = wbCtx(db, {}, archiveFake({}, wb, '[]'), {}); ctx.getPage = async (u) => { ctx.fetched.push(u); if (u === PJ_URL) return page; throw new Error('the shop must not be fetched: ' + u); }; return ctx; };
  let ctx = mk(dyson), res = await R.run(ctx);
  const W = () => db.products[0];
  assert.deepStrictEqual(ctx.fetched, [PJ_URL], 'the Prisjagt page is fetched, the shop page is not');
  assert.strictEqual(W().status, 'tracking'); assert.deepStrictEqual(W().tracked_variants, ['none']); assert.strictEqual(W().title, 'Dyson V15 Detect Absolute Ledningsfri');
  assert.strictEqual(W().offers[0].price, 3999); assert(W().history.some((x) => x.src === 'page') && W().history.some((x) => x.src === 'check' && x.p === 3999));
  assert.strictEqual(W().verdict.level, 'good', 'the Prisjagt history makes 3.999 kr. a good price: this would mail for a new product');
  assert.strictEqual(res.stats.hits, 0); assert.strictEqual(db.sent.length, 0, 'but the first check after a switch is silent');
  assert.strictEqual(W().notified_price, 3999, 'remembered as already announced'); assert.strictEqual(W().notified_at, null);
  assert.strictEqual(W().compare_state, 'done'); assert.strictEqual(W().shop_url, SHOP_URL); assert.strictEqual(W().source_url, PJ_URL, 'the job never writes the compare columns of a switched row');
  assert.strictEqual(W().list_id, 'L1'); assert.strictEqual(W().name, 'Dyson V15'); assert.deepStrictEqual(W().alternatives, [{ kind: 'deal', name: 'x' }]);
  assert.strictEqual(wb.length, 0, 'no archive lookup for a prisjagt product'); assert.strictEqual(W().backfill_state, null, 'and no marker is set');
  assert.strictEqual(res.stats.backfilled, 0);
  // same price again: still nothing
  ctx = mk(dyson); res = await R.run(ctx); assert.strictEqual(db.sent.length, 0); assert.strictEqual(W().notified_price, 3999); assert.strictEqual(wb.length, 0);
  // the price really falls: one mail
  ctx = mk(pageFor('dyson', (r) => r.price - 400)); res = await R.run(ctx);
  assert.strictEqual(res.stats.hits, 1); assert.strictEqual(db.sent.length, 1); assert.strictEqual(W().notified_price, 3599); assert(W().notified_at);
  assert.strictEqual(wb.length, 0);

  // contrast: the same Prisjagt product added as a new product (no switch) mails at its first check
  const dbc = newDb(); dbc.products.push(product('N1', 'u1', 'dyson', { target_type: 'auto', target_value: null }));
  await R.run(ctxFor(dbc, { [PJ_URL]: dyson })); assert.strictEqual(dbc.sent.length, 1, 'a new product with a good price mails at once, as before'); assert.strictEqual(dbc.products[0].notified_price, 3999);
  // going back to the shop link (compare_state none, shop_url null) or any other state is not silent
  const dbu = newDb(); dbu.products.push(product('N2', 'u1', 'dyson', { target_type: 'auto', target_value: null, compare_state: 'none', compare_at: '2026-11-16T09:00:00Z' }));
  await R.run(ctxFor(dbu, { [PJ_URL]: dyson })); assert.strictEqual(dbu.sent.length, 1);
  // 'done' without shop_url is no switch the job knows of
  const dbd = newDb(); dbd.products.push(product('N3', 'u1', 'dyson', { target_type: 'auto', target_value: null, compare_state: 'done' }));
  await R.run(ctxFor(dbd, { [PJ_URL]: dyson })); assert.strictEqual(dbd.sent.length, 1);
});

test('compare: a price goal and a switch: the first check is silent whether or not the goal is met; a bought product, several variants and the morning mail', async () => {
  const PJ_URL = urlOf('dyson'), dyson = pageFor('dyson');
  // price goal 4000, the price is 3999: a hit for a new product, silent here
  const db = newDb();
  db.products.push(switchLikeSql(shopProduct('G1', 'u1', 'https://www.proshop.dk/x', { target_type: 'price', target_value: 4000, compare_state: 'wanted' }), PJ_URL));
  db.products.push(switchLikeSql(shopProduct('G2', 'u1', 'https://www.proshop.dk/y', { target_type: 'price', target_value: 3000, compare_state: 'wanted' }), PJ_URL));
  await R.run(ctxFor(db, { [PJ_URL]: dyson }));
  assert.strictEqual(db.sent.length, 0); assert.strictEqual(db.products[0].notified_price, 3999); assert.strictEqual(db.products[1].notified_price, null, 'no hit: nothing remembered');
  assert.strictEqual(db.products[0].status, 'tracking');
  // a later check at a price under the goal of G2 mails
  await R.run(ctxFor(db, { [PJ_URL]: pageFor('dyson', (r) => r.price - 1500) }));
  assert.strictEqual(db.sent.length, 1); assert.strictEqual(db.products[1].notified_price, 2499);
  assert.strictEqual(db.products[0].notified_price, 2499, 'G1 fell further under its goal: a real drop');
  // several variants: the product waits for a choice; once the person has chosen, the first tracking check is still silent
  const rob = pageFor('roborock'), RU = urlOf('roborock'), db2 = newDb();
  db2.products.push(switchLikeSql(shopProduct('V1', 'u1', 'https://www.proshop.dk/r', { target_type: 'auto', target_value: null, compare_state: 'wanted' }), RU));
  await R.run(ctxFor(db2, { [RU]: rob }));
  assert.strictEqual(db2.products[0].status, 'choose'); assert.strictEqual(db2.sent.length, 0); assert.strictEqual(db2.products[0].compare_state, 'done');
  db2.products[0].tracked_variants = [rob.variants[0].id];
  await R.run(ctxFor(db2, { [RU]: rob }));
  assert.strictEqual(db2.products[0].status, 'tracking'); assert.strictEqual(db2.sent.length, 0, 'the first tracking check after the choice is silent too');
  assert(db2.products[0].history.some((x) => x.src === 'check'));
  // a bought product stays quiet and keeps its fields
  const db3 = newDb();
  db3.products.push(switchLikeSql(shopProduct('B1', 'u1', 'https://www.proshop.dk/b', { target_type: 'auto', target_value: null, compare_state: 'wanted', bought_at: '2026-11-10T00:00:00Z', bought_price: 4500 }), PJ_URL));
  await R.run(ctxFor(db3, { [PJ_URL]: dyson })); assert.strictEqual(db3.sent.length, 0); assert.strictEqual(db3.products[0].status, 'tracking'); assert.strictEqual(db3.products[0].bought_price, 4500);
  // morning mail: nothing is collected for the silent check
  const db4 = newDb();
  db4.profiles.push({ user_id: 'u1', notify_email: true, mail_digest: true, digest_sent_at: null, shops_always: [], shops_exclude: [], shops_only: false });
  db4.products.push(switchLikeSql(shopProduct('M1', 'u1', 'https://www.proshop.dk/m', { target_type: 'auto', target_value: null, compare_state: 'wanted', digest_price: null }), PJ_URL));
  await R.run(ctxFor(db4, { [PJ_URL]: dyson })); assert.strictEqual(db4.sent.length, 0); assert.strictEqual(db4.products[0].digest_price, null);
});

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
