'use strict';
// What may be written to the job's log. The log of GitHub Actions is PUBLIC, so it never holds what the family wants to buy or who they are:
// no product names, titles, requirements, questions, e-mail addresses, user ids or source links with a path. Shop host names and prices are fine.

// A short label for a product that says nothing about it: the first 8 characters of its id.
function tag(prod) { return String(prod && prod.id != null ? prod.id : '?').slice(0, 8); }

// An error text that is safe to log: e-mail addresses are removed (a mail service may repeat the address in its error) and the length is capped.
function safe(e, max) {
  const s = String(e && e.message !== undefined ? e.message : e);
  return s.replace(/[^\s@<>"',;()]+@[^\s@<>"',;()]+/g, '[adresse]').replace(/\s+/g, ' ').slice(0, max || 160);
}

// An unexpected error: the safe message and where it happened (the first frame of the stack: a file and a line of OUR code, no data).
function brief(e) {
  const frame = e && typeof e.stack === 'string' ? (e.stack.split('\n').filter((l) => /^\s+at /.test(l))[0] || '').trim().replace(/\(?\/[^)]*\/(job\/[^)]*)\)?/, '($1)').slice(0, 120) : '';
  return safe(e, 200) + (frame ? ' ' + frame : '');
}

module.exports = { tag, safe, brief };
