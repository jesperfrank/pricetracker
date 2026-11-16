'use strict';
// Plain-text Danish e-mail. Product names and shop names are untrusted text: no HTML is built from them.

const { fmtKr } = require('./pricing');

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 160);
}

// hits: [{name, price, store, url, verdict (text|null), warning (text|null)}]
function composeMail(hits, siteUrl) {
  const n = hits.length;
  const subject = n === 1 ? 'Prisvagten: 1 pris har ramt dit mål' : 'Prisvagten: ' + n + ' priser har ramt dit mål';
  const lines = [n === 1 ? 'Et produkt er nået ned til din målpris:' : n + ' produkter er nået ned til din målpris:', ''];
  hits.forEach((h, i) => {
    lines.push((i + 1) + '. ' + clean(h.name, 140));
    lines.push('   Pris: ' + fmtKr(h.price) + ' hos ' + clean(h.store, 80));
    lines.push('   Link til butikken: ' + clean(h.url, 500));
    if (h.verdict) lines.push('   ' + clean(h.verdict, 300));
    if (h.warning) lines.push('   OBS: ' + clean(h.warning, 300));
    lines.push('');
  });
  if (siteUrl) lines.push('Se alle dine produkter: ' + clean(siteUrl, 300), '');
  lines.push('Vil du ikke have e-mails? Slå "Send e-mail" fra under dine indstillinger på siden.');
  return { subject, text: lines.join('\n') + '\n' };
}

async function sendResend(fetchImpl, apiKey, from, to, mail) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject: mail.subject, text: mail.text }),
      signal: ctl.signal,
    });
    if (!r.ok) {
      let body = ''; try { body = (await r.text()).slice(0, 200); } catch (e) { /* ignore */ }
      throw new Error('Resend HTTP ' + r.status + ' ' + body);
    }
  } finally { clearTimeout(t); }
}

module.exports = { composeMail, sendResend, clean };
