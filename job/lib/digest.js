'use strict';
// The one morning mail (profiles.mail_digest). Pure helpers: when a digest may go out, and which collected hits belong in it.
// State (written by the job only): products.digest_price / digest_at = the hit that was collected and when; profiles.digest_sent_at =
// when a morning mail was last claimed for the person. A collected hit belongs in the next mail when digest_at is after digest_sent_at.

const P = require('./pricing');

const HOUR = 7;              // first run at or after 07:00 Europe/Copenhagen
const TZ = 'Europe/Copenhagen';

// Copenhagen wall-clock hour (0-23) of an instant. Intl, never a fixed UTC offset: summer and winter time differ.
function copenhagenHour(d) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).formatToParts(d || new Date());
  const h = parts.filter((x) => x.type === 'hour')[0];
  return h ? Number(h.value) % 24 : 0;
}

const ms = (v) => { const t = v ? Date.parse(v) : NaN; return isFinite(t) ? t : null; };

// True when a morning mail may be claimed now: it is 07:00 or later in Copenhagen and none was claimed on today's Copenhagen date.
function digestWindow(now, sentAt) {
  if (copenhagenHour(now) < HOUR) return false;
  const t = ms(sentAt);
  return t === null || P.copenhagenDate(new Date(t)) !== P.copenhagenDate(now);
}

function isDigestUser(profile) { return !!profile && profile.mail_digest === true && profile.notify_email !== false; }

// state: the product as it is after this run's check (row + patch). Returns the lowest in-stock offer when the collected hit
// still stands and has not been mailed yet, else null. Still valid = not bought, still a hit (notified_price kept), and the
// price is still at or below the price that triggered the hit.
function pendingLow(state, sentAt) {
  if (!state || state.active === false || state.bought_at) return null;
  if (typeof state.digest_price !== 'number' || typeof state.notified_price !== 'number') return null;
  const at = ms(state.digest_at), sent = ms(sentAt);
  if (at === null || (sent !== null && at <= sent)) return null;
  const low = P.lowestInStock(Array.isArray(state.offers) ? state.offers : []);
  return low && low.price <= state.digest_price ? low : null;
}

// The hit as composeMail wants it, built from the product's stored state (used for hits collected in an earlier run).
function hitFromState(state, low) {
  const v = state.verdict && typeof state.verdict === 'object' ? state.verdict : null;
  return {
    productId: state.id, userId: state.user_id, name: state.name, price: low.price, store: low.store, url: low.url,
    verdict: v && v.text || null, warning: state.warning || null,
    reason: state.target_type === 'auto' ? P.autoReason(low, v, state.history) : null,
  };
}

// Subject for a digest: "Prisvagten: 3 tilbud i dag". The body is composeMail's.
function digestSubject(n) { return 'Prisvagten: ' + (n === 1 ? '1 tilbud' : n + ' tilbud') + ' i dag'; }

module.exports = { HOUR, copenhagenHour, digestWindow, isDigestUser, pendingLow, hitFromState, digestSubject };
