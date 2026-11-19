'use strict';
// One decoder for text taken out of web pages (product names, titles, shop names, notes). Shops publish names with HTML entities in them
// ("Tilbeh&oslash;r", "&#216;rerenser", "&amp;"), also inside JSON-LD strings and meta tags, where nothing decodes them for us.
// The text stays plain text everywhere it goes: the site escapes it when it shows it and the mails are plain text. Decoded angle brackets are
// therefore not markup anywhere (see the tests), and are kept as they are.

// Latin-1 names, in the order of code points 160 to 255
const LATIN1 = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm ' +
  'raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde ' +
  'Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave ' +
  'eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ensp: ' ', emsp: ' ', thinsp: ' ', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', sbquo: '‚',
  ldquo: '“', rdquo: '”', bdquo: '„', dagger: '†', Dagger: '‡', bull: '•', hellip: '…', permil: '‰',
  lsaquo: '‹', rsaquo: '›', euro: '€', trade: '™', larr: '←', rarr: '→', minus: '−', le: '≤', ge: '≥',
  OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', fnof: 'ƒ' };
LATIN1.forEach((n, i) => { NAMED[n] = String.fromCharCode(160 + i); });
const CI = { amp: 1, lt: 1, gt: 1, quot: 1, nbsp: 1, apos: 1 };      // these are also valid in capitals (&AMP;), not in mixed case

function codePoint(n) {
  if (!isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return ' ';
  return String.fromCodePoint(n);
}

// Numeric (decimal and hex) and named entities, in ONE pass: what an entity decodes to is never decoded again ("&amp;Oslash;" is "&Oslash;").
// An unknown name or a malformed entity stays as it is.
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(?:#[xX]([0-9a-fA-F]{1,8})|#(\d{1,8})|([A-Za-z][A-Za-z0-9]{1,9}));/g, (m, hex, dec, name) => {
    if (hex !== undefined) return codePoint(parseInt(hex, 16));
    if (dec !== undefined) return codePoint(parseInt(dec, 10));
    if (Object.prototype.hasOwnProperty.call(NAMED, name)) return NAMED[name];
    const low = name.toLowerCase();
    return CI[low] && name === name.toUpperCase() ? NAMED[low] : m;
  });
}

// Control characters to a space, whitespace collapsed, trimmed, cut at max (default 200). For text that was decoded already (an attribute value
// from parseAttrs): decoding it again would turn "&amp;Oslash;" into "Ø".
function squeeze(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 200);
}

// Decoded once, then squeezed. For raw text (the inside of a tag, a JSON string, a search result).
function cleanText(s, max) { return squeeze(decodeEntities(s), max); }

module.exports = { decodeEntities, cleanText, squeeze, NAMED };
