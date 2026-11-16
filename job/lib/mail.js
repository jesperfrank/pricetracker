'use strict';
// Plain-text Danish e-mail. Product names and shop names are untrusted text: no HTML is built from them.

const { fmtKr } = require('./pricing');

function clean(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 160);
}

// hits: [{name, price, store, url, verdict (text|null), warning (text|null), reason (text|null)}]
// reason is set for products without a goal of their own (goal "godt tilbud"): one sentence on why the mail is sent.
function composeMail(hits, siteUrl) {
  const n = hits.length;
  const withReason = hits.filter((h) => h.reason).length;
  let subject = n === 1 ? 'Prisvagten: 1 pris har ramt dit mål' : 'Prisvagten: ' + n + ' priser har ramt dit mål';
  let intro = n === 1 ? 'Et produkt er nået ned til din målpris:' : n + ' produkter er nået ned til din målpris:';
  if (withReason === n) {
    subject = n === 1 ? 'Prisvagten: 1 godt tilbud' : 'Prisvagten: ' + n + ' gode tilbud';
    intro = n === 1 ? 'Et produkt har fået en god pris:' : n + ' produkter har fået en god pris:';
  } else if (withReason) {
    subject = 'Prisvagten: ' + n + ' priser at kigge på';
    intro = n + ' produkter har fået en pris, du skal kende til:';
  }
  const lines = [intro, ''];
  hits.forEach((h, i) => {
    lines.push((i + 1) + '. ' + clean(h.name, 140));
    lines.push('   Pris: ' + fmtKr(h.price) + ' hos ' + clean(h.store, 80));
    lines.push('   Link til butikken: ' + clean(h.url, 500));
    if (h.reason) lines.push('   Derfor får du besked: ' + clean(h.reason, 300));
    else if (h.verdict) lines.push('   ' + clean(h.verdict, 300));
    if (h.warning) lines.push('   OBS: ' + clean(h.warning, 300));
    lines.push('');
  });
  if (siteUrl) lines.push('Se alle dine produkter: ' + clean(siteUrl, 300), '');
  lines.push('Vil du ikke have e-mails? Slå "Send e-mail" fra under dine indstillinger på siden.');
  return { subject, text: lines.join('\n') + '\n' };
}

// requests: [{email, name}] (untrusted text: plain text only, line breaks and control characters removed, lengths capped)
function composeOwnerMail(requests, siteUrl) {
  const n = requests.length;
  const subject = n === 1 ? 'Prisvagten: 1 ny anmodning om adgang' : 'Prisvagten: ' + n + ' nye anmodninger om adgang';
  const lines = [n === 1 ? 'En person har bedt om adgang til Prisvagten:' : n + ' personer har bedt om adgang til Prisvagten:', ''];
  requests.forEach((r) => {
    const name = clean(r.name, 80);
    lines.push('- ' + (name ? name + ' ' : '') + '<' + clean(r.email, 200) + '>');
  });
  lines.push('');
  if (siteUrl) lines.push('Åbn Prisvagten: ' + clean(siteUrl, 300), '');
  lines.push('Log ind og tryk "Godkend" eller "Afvis" under "Adgang" nederst på siden.');
  return { subject, text: lines.join('\n') + '\n' };
}

function composeApprovedMail(siteUrl) {
  const lines = ['Din anmodning er godkendt. Du kan nu bruge Prisvagten.', ''];
  if (siteUrl) lines.push('Åbn siden: ' + clean(siteUrl, 300), '');
  lines.push('Sådan logger du ind: skriv din e-mailadresse på siden, og tryk "Send login-link". Så får du et link på mail. Åbn det, så er du inde.');
  return { subject: 'Du har fået adgang til Prisvagten', text: lines.join('\n') + '\n' };
}

async function sendResend(fetchImpl, apiKey, from, to, mail) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject: mail.subject, text: mail.text }),
      signal: ctl.signal,
    });
    if (!r.ok) {
      let body = ''; try { body = (await r.text()).slice(0, 200); } catch (e) { /* ignore */ }
      throw new Error('Resend HTTP ' + r.status + ' ' + body);
    }
  } finally { clearTimeout(t); }
}

module.exports = { composeMail, composeOwnerMail, composeApprovedMail, sendResend, clean };
