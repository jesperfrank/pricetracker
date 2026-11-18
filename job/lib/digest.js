'use strict';
// The daily overview (profiles.mail_digest, "Daglig oversigt om morgenen"). Pure helpers: when it may go out and what is in it.
// It is built from the products as they are after this run's checks; nothing is collected or remembered per product. The only state is
// profiles.digest_sent_at (written by the job only) = when the overview of a day was last claimed for the person.
// It has nothing to do with the mail for a new deal (profiles.notify_email, trackingPatch): that one is never held back by it.
// (products.digest_price / digest_at are not used any more.)

const P = require('./pricing');

const HOUR = 7;              // first run at or after 07:00 Europe/Copenhagen
const TZ = 'Europe/Copenhagen';
const MAX_CHANGES = 10;      // "Ændret siden i går": at most this many products
const MIN_CHANGE = 0.05;     // a lowest price that moved at least 5 % since yesterday's history point

// Copenhagen wall-clock hour (0-23) of an instant. Intl, never a fixed UTC offset: summer and winter time differ.
function copenhagenHour(d) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).formatToParts(d || new Date());
  const h = parts.filter((x) => x.type === 'hour')[0];
  return h ? Number(h.value) % 24 : 0;
}

const ms = (v) => { const t = v ? Date.parse(v) : NaN; return isFinite(t) ? t : null; };

// True when the overview may be claimed now: it is 07:00 or later in Copenhagen and none was claimed on today's Copenhagen date.
function digestWindow(now, sentAt) {
  if (copenhagenHour(now) < HOUR) return false;
  const t = ms(sentAt);
  return t === null || P.copenhagenDate(new Date(t)) !== P.copenhagenDate(now);
}

// "Send e-mail" is the master switch: off means no mail at all, the overview included.
function isDigestUser(profile) { return !!profile && profile.mail_digest === true && profile.notify_email !== false; }

// One short Danish line on why a product is on offer: the goal.
function goalText(state, low, reason) {
  if (reason) return reason;
  if (state.target_type === 'price') return 'Dit mål: ' + P.fmtKr(Number(state.target_value)) + '.';
  if (state.target_type === 'pct') {
    const tgt = P.targetPrice(state, state.normal_price);
    return 'Dit mål: ' + Number(state.target_value) + ' % under normalprisen' + (tgt !== null ? ' (højst ' + P.fmtKr(tgt) + ')' : '') + '.';
  }
  return null;
}

// The overview of one person. products: that person's products as they are after this run (row + patch); now: the run's clock.
// Bought and inactive products and products that are not being followed are left out.
//   hits:    [{name, price, store, url, goal}] every product that is a hit right now (the same rule as the mail for a new deal), by name
//   changes: [{name, from, to, pct, store}] up to 10 products not in hits whose lowest price moved at least 5 % since yesterday's history
//            point (the last point on or before yesterday, as the daily series carries it forward), the biggest change first
function overview(products, now) {
  const iso = now.toISOString().replace(/\.\d+Z$/, 'Z'), today = P.copenhagenDate(now), yesterday = P.numDay(P.dayNum(today) - 1);
  const hits = [], changes = [];
  products.forEach((st) => {
    if (!st || st.active === false || st.bought_at || st.status !== 'tracking') return;
    const offers = Array.isArray(st.offers) ? st.offers : [];
    const low = P.lowestInStock(offers);
    if (!low) return;
    const goal = P.goalOutcome(st, low, st.normal_price, iso, { verdict: st.verdict && typeof st.verdict === 'object' ? st.verdict : null, history: st.history });
    if (goal.hit) { hits.push({ name: st.name, price: low.price, store: low.store, url: low.url, goal: goalText(st, low, goal.reason) }); return; }
    const before = P.dailySeries(st.history, yesterday).filter((x) => x.d === yesterday).map((x) => x.p)[0];
    if (typeof before !== 'number' || !(before > 0)) return;
    const pct = (low.price - before) / before;
    if (Math.abs(pct) + 1e-9 >= MIN_CHANGE) changes.push({ name: st.name, from: before, to: low.price, pct, store: low.store });
  });
  const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'da');
  hits.sort(byName);
  changes.sort((a, b) => (Math.abs(b.pct) - Math.abs(a.pct)) || byName(a, b));
  return { hits, changes: changes.slice(0, MAX_CHANGES) };
}

// "Prisvagten: 2 tilbud og 3 prisændringer", "Prisvagten: 1 tilbud", "Prisvagten: 1 prisændring"
function digestSubject(nHits, nChanges) {
  const parts = [];
  if (nHits) parts.push(nHits + ' tilbud');
  if (nChanges) parts.push(nChanges + (nChanges === 1 ? ' prisændring' : ' prisændringer'));
  return 'Prisvagten: ' + parts.join(' og ');
}

module.exports = { HOUR, MAX_CHANGES, MIN_CHANGE, copenhagenHour, digestWindow, isDigestUser, overview, digestSubject };
