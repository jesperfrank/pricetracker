'use strict';
// Shop discovery ("Butikssøgning"): the job searches the web from Denmark for a product and finds Danish shops that Prisjagt does not list
// (campaign pages, the shop's own web shop, small shops). No AI: the Brave Search API with country DK, a strict filter on the results, and
// a check of each page the same way as for an extra shop (a price in kroner, the page's own product name, the outlier rule, in stock).
// A shop is only added when its verified price is below every current offer of the product (see planChange).
//
// Everything about the search API lives in BRAVE just below: if the endpoint, the header or a parameter name is wrong, change it there.
// The rest of this file is pure functions (tested without a network) and the search client with an injected fetch and sleep.

const SHOP = require('./shop');
const { decodeEntities } = require('./text');
const X = require('./extras');

// ---------------------------------------------------------------- the API (Brave Search, web search): the one place to correct
const BRAVE = {
  url: 'https://api.search.brave.com/res/v1/web/search',
  keyHeader: 'X-Subscription-Token',        // the API key goes here, never anywhere else and never in a log
  accept: 'application/json',
  queryParam: 'q',
  pageParam: 'offset',                      // Brave: the index of the result page (0 = results 1 to 20, 1 = 21 to 40 ...), at most 9
  fixed: { country: 'DK', search_lang: 'da', count: 20 },   // country: two-letter code in capitals; count: at most 20 per request
  results: function (json) { return json && json.web && Array.isArray(json.web.results) ? json.web.results : []; },
};

// ---------------------------------------------------------------- budget and limits (constants: easy to change)
const MIN_GAP_MS = 1100;               // the low tier allows about 1 request per second
const TIMEOUT_MS = 15000;
const CALLS_PER_PRODUCT = 3;           // 2 pages of the "pris" query and 1 page of the "køb" query
const PLAN = [{ q: 0, page: 0 }, { q: 0, page: 1 }, { q: 1, page: 0 }];
const MAX_PRODUCTS_PER_RUN = 4;        // 12 calls per run
const MONTHLY_CAP = 800;               // calls per calendar month over all products
const RESPACE_MS = 7 * 24 * 3600 * 1000;
const MAX_CANDIDATES = 6;              // pages read per product
const MAX_ADD = 2;                     // new shops per product per search
const MAX_EXTRAS = 5;                  // the cap of extra_urls, shared with the AI agent and the person
const MAX_PAGES_PER_RUN = 24;          // pages read for the check per run (4 products x 6)

// ---------------------------------------------------------------- text helpers

function cleanResultText(s, max) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, ' ')
    .replace(/&[#A-Za-z0-9]+;/g, (m) => decodeEntities(m))
    .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max || 300);
}

// "10 R" -> "10R" (a model letter set apart from its number), then split into lower-case words. Apostrophes vanish (Pro's -> Pros is no
// issue, but "Pro's" must not give the word "s").
function words(s) {
  const t = String(s == null ? '' : s).toLowerCase().replace(/['’`´]/g, '')
    .replace(/(\d)[\s-]+([a-zæøå])(?![\p{L}\p{N}])/gu, '$1$2');
  return t.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// ---------------------------------------------------------------- the product's words: queries and key tokens

// Words that are marketing or filler, never part of a model name: left out of the queries and never required in a title.
const FILLER = new Set(['og', 'med', 'til', 'den', 'det', 'de', 'en', 'et', 'i', 'på', 'af', 'for', 'the', 'and', 'with', 'for',
  'ny', 'nye', 'nyhed', 'new', 'original', 'officiel', 'officielle', 'tilbud', 'udsalg', 'bedst', 'bedste', 'gratis', 'fragt', 'pris', 'køb', 'online',
  'lager', 'hurtig', 'levering', 'garanti', 'test', 'mærke', 'kvalitet', 'brand']);
// Colours and sizes: part of the variant, not of the model (the requirements say which one the person wants; a shop page may name it differently).
const COLOURS = new Set(['sort', 'hvid', 'grå', 'blå', 'rød', 'grøn', 'gul', 'lilla', 'pink', 'lyserød', 'orange', 'brun', 'beige', 'sølv', 'guld', 'rosa', 'turkis',
  'black', 'white', 'grey', 'gray', 'blue', 'red', 'green', 'yellow', 'purple', 'silver', 'gold', 'rose', 'natural', 'midnat', 'starlight', 'graphite', 'titanium']);
const EDITION = new Set(['edition', 'udgave', 'limited', 'special', 'collector', 'collectors']);
// Category words: what the thing is, not which one it is ("Roborock Saros 10R Robotstøvsuger"). Compounds are caught by the suffix list.
const CATEGORY = new Set(['støvsuger', 'robotstøvsuger', 'telefon', 'smartphone', 'mobil', 'mobiltelefon', 'sko', 'sneakers', 'sneaker', 'trænere', 'tv', 'fjernsyn', 'skærm', 'monitor',
  'computer', 'pc', 'laptop', 'tablet', 'hovedtelefoner', 'høretelefoner', 'hørebøffer', 'højttaler', 'kaffemaskine', 'espressomaskine', 'blender', 'airfryer', 'vaskemaskine', 'tørretumbler',
  'køleskab', 'fryser', 'ovn', 'sæt', 'byggesæt', 'legetøj', 'klodser', 'spil', 'konsol', 'kamera', 'ur', 'smartwatch', 'cykel', 'klapvogn', 'barnevogn', 'madras', 'dyne', 'pude', 'trådløs', 'trådløse', 'herre', 'dame', 'børn', 'unisex',
  'robot', 'vacuum', 'cleaner', 'shoes', 'phone', 'headphones', 'speaker', 'watch', 'wireless', 'men', 'women', 'kids']);
const CATEGORY_SUFFIX = /(støvsuger|støvsugere|maskine|telefon|computer|højttaler|hovedtelefoner|høretelefoner|fjernsyn|klapvogn|smartphone|sneakers)$/;

function isGeneric(w) {
  return FILLER.has(w) || COLOURS.has(w) || CATEGORY.has(w) || CATEGORY_SUFFIX.test(w);
}

// The part of a title that names the product: the first segment before " | " / " - " / " – " / " : ", without anything in parentheses.
function firstSegment(title) {
  const t = cleanResultText(title, 400).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  const seg = t.split(/\s+[|\-–—:]\s+|\s+[|]\s*/)[0] || t;
  return seg.replace(/\s+/g, ' ').trim();
}

// The title the queries and the key tokens are made from: the first segment, at most 8 words.
function coreTitle(title) {
  const ws = firstSegment(title).split(/\s+/).filter((w) => w && !FILLER.has(w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')));
  return ws.slice(0, 8).join(' ');
}

// The words of the product that every matching title must contain (squashed, lower case): the brand (the first word) and everything up to the
// last word with a digit (model number: V15, 10R, 75375), plus the two words after it (model names: "Detect Absolute", "Millennium Falcon");
// without any digit the first four words ("Stan Smith"). Colours, category words and filler are never required.
const IMPLIED_BRAND = { apple: ['iphone', 'ipad', 'macbook', 'airpods', 'imac', 'ipod'], samsung: ['galaxy'], microsoft: ['xbox', 'surface'], sony: ['playstation'], nintendo: ['switch'] };
function keyTokens(title) {
  const ws = words(coreTitle(title)).slice(0, 8);
  let last = -1;
  ws.forEach((w, i) => { if (/\d/.test(w)) last = i; });
  const end = last === -1 ? Math.min(ws.length, 4) : Math.min(ws.length, last + 3);
  const out = [];
  ws.slice(0, end).forEach((w) => { if (!isGeneric(w) && out.indexOf(w) === -1) out.push(w); });
  // a brand that shops often leave out when the model says it ("iPhone 16 Pro", "Galaxy S24") is not required then
  if (out.length > 1 && IMPLIED_BRAND[out[0]] && out.slice(1).some((w) => IMPLIED_BRAND[out[0]].indexOf(w) !== -1)) out.shift();
  return out;
}

// Model modifiers: a title with one of them that the product's own title lacks is another product (Pro, Max, Ultra, a Lux version ...).
const MODIFIERS = new Set(['pro', 'max', 'ultra', 'plus', 'lite', 'mini', 's', 'se', 'fe', 'xl', 'lux', 'deluxe', 'kids', 'junior', 'jr',
  'refurbished', 'renoveret', 'brugt', 'genbrugt', 'demo', 'udstilling', 'nano',
  'absolute', 'extra', 'complete', 'animal', 'origin', 'fluffy', 'signature', 'premium', 'elite', 'advanced', 'prime']);   // Dyson V15 Detect is not V15 Detect Absolute
// Accessories and spare parts: the main false-positive risk. A word of its own (mop, bag, dock, cover, etui, pose) or the start or end of a
// compound (filtersæt, hepafilter, ladekabel, sidebørste, tilbehørspakke, reservedele).
const ACC_WORDS = new Set(['mop', 'mops', 'bag', 'bags', 'dock', 'cover', 'covers', 'etui', 'pose', 'poser', 'holder', 'beskyttelse', 'panserglas', 'rem', 'skal',
  'accessories', 'accessory', 'zubehor', 'zubehör', 'prislusenstvi', 'příslušenství']);   // the last four: a shop in another language names its accessory pages so
// "Roborock Saros 10R med dock" is the main product sold with its dock; "Dock til Roborock Saros 10R" is the accessory. An accessory word right
// after one of these (at most one word between) is part of what is in the box, not what the page sells.
const INCLUDING = new Set(['med', 'with', 'inkl', 'inklusive', 'incl', 'including', 'm']);
const ACC_AFFIX = ['tilbehør', 'reservedel', 'filter', 'kabel', 'oplader', 'børste', 'batteri'];

// Which conflicting words does this text contain? (a list of the matching words). kind 'variant': model modifiers; kind 'acc': accessories.
function conflictsIn(ws, kind) {
  const out = [];
  ws.forEach((w, i) => {
    if (kind !== 'acc' && MODIFIERS.has(w)) out.push(w);
    else if (kind === 'acc') {
      if (INCLUDING.has(ws[i - 1]) || INCLUDING.has(ws[i - 2])) return;
      if (ACC_WORDS.has(w)) out.push(w);
      else ACC_AFFIX.forEach((a) => { if (w.length >= a.length && (w.indexOf(a) === 0 || w.slice(-a.length) === a)) out.push(w); });
    }
  });
  return out;
}

// A list of words squashed into one string, with the positions where a word starts or ends (also where letters turn into digits: "saros10r").
function squash(cand) {
  let squashed = '';
  const bound = new Set([0]);
  cand.forEach((w) => {
    for (let i = 0; i < w.length; i++) {
      if (i > 0 && /\p{L}/u.test(w[i - 1]) && /\d/.test(w[i])) bound.add(squashed.length);
      squashed += w[i];
    }
    bound.add(squashed.length);
  });
  return { squashed, bound };
}
// Is the key in the squashed words as a whole word? (it must start and end at a boundary: "10" is not in "10r")
function hasKey(sq, k) {
  let at = -1;
  while ((at = sq.squashed.indexOf(k, at + 1)) !== -1) if (sq.bound.has(at) && sq.bound.has(at + k.length)) return true;
  return false;
}

// Does `candidate` (a search result's title, or the page's own product name) name the same product as `productTitle`?
//  * every key token of the product is in it, compared without spaces and hyphens ("Saros 10 R" = "Saros10R"), as a whole word: the token
//    must start and end at a word boundary (a number followed by letters is another model: "10" is not in "10R", "16" is not in "16e");
//  * it has none of the modifiers / accessory words that the product's own title lacks (checked in the first segment of the title, so that
//    an SEO tail such as "| Køb filter og tilbehør" does not count).
// Returns {ok, reason}.
function titleMatch(productTitle, candidate) {
  const keys = keyTokens(productTitle);
  if (!keys.length) return { ok: false, reason: 'ingen nøgleord' };
  const cand = words(cleanResultText(candidate, 400));
  if (!cand.length) return { ok: false, reason: 'ingen titel' };
  const sq = squash(cand);
  for (const k of keys) if (!hasKey(sq, k)) return { ok: false, reason: 'mangler "' + k + '"' };
  const own = words(productTitle);
  const whole = words(cleanResultText(candidate, 400)), seg = words(cleanResultText(firstSegment(candidate), 400));
  // modifiers count anywhere in the title; accessory words only in the first segment (an SEO tail may mention filters and docks)
  const sameKind = (o, w) => ACC_AFFIX.some((a) => (o.indexOf(a) === 0 || o.slice(-a.length) === a) && (w.indexOf(a) === 0 || w.slice(-a.length) === a));
  const bad = conflictsIn(whole, 'variant').concat(conflictsIn(seg, 'acc')).filter((w) => {
    if (own.indexOf(w) !== -1) return false;
    // a word of the same kind in the product's own title allows it (the product is itself a filter set: "filter" is no conflict)
    return !conflictsIn(own, 'acc').some((o) => sameKind(o, w));
  });
  if (bad.length) return { ok: false, reason: 'anden variant eller tilbehør: ' + bad[0] };
  return { ok: true, reason: null };
}

// ---------------------------------------------------------------- identity of an extra shop's page (the AI agent's links)

// Is the page of an extra shop that the AI agent chose (or that has no origin: stored before the origin was recorded) the same product as the
// followed one? A LENIENT rule, separate from titleMatch (which stays strict and decides the discovery paths): shops name the same thing in
// many ways (another language, a missing brand, a missing item number, a colour or size tail, a category word), so what is checked is only what
// makes another product another product. productTitle = the stored title, else the name; pageName = the page's own product name
// (extra_state[link].offer.name). Returns {ok, reason}; ok when there is nothing to compare (no page name, no product words).
//  a. every SHORT model token of the product must be in the page name, as a whole word as titleMatch does it (squashed, "Saros 10 R" =
//     "Saros10R", "WH-1000XM5" = "WH1000XM5"; "10" is not in "10R", "16" not in "16e"). A model token is a word with a digit that is letters+digits
//     (m9, 10r, x50, 1000xm5) or pure digits of at most 6 characters (4, 16, 75375). Longer pure-digit words (item numbers, EAN) are optional.
//     A lone "s" right after a model token belongs to it (M9 S is not M9).
//  b. the page name shares the brand (the product's first key word) or at least half of the product's key words (its non-generic words:
//     colours, category and clothing words, filler and sizes never count). Without any model token this is the whole test.
//  c. a model modifier (MODIFIERS: pro, max, lite, lux, plus, mini ...) in one name and not in the other rejects. Left out: sizes (s, xl)
//     and "complete" (a bundle of the same machine: Dreame X50 Ultra Complete is a Dreame X50 Ultra).
//  d. an accessory word in the page's first segment that the product lacks rejects (titleMatch's accessory rule), and so does a first segment
//     "<something> til <model>" whose words before "til" hold no model token of the product ("Ladestation til Roborock Saros 10R").
const IDENTITY_SIZES = new Set(['s', 'xl']);
const IDENTITY_IGNORED_MODS = new Set(['s', 'xl', 'complete']);
const IDENTITY_GENERIC = new Set(['bukser', 'bukse', 'jakke', 'jacket', 'skjorte', 'trøje', 'kjole', 'shorts', 'tshirt', 'sweater', 'hoodie', 'frakke', 'strik',
  'jeans', 'trousers', 'pants', 'shirt', 'dress', 'coat']);

function identityWords(title) {
  return words(cleanResultText(String(title == null ? '' : title).replace(/\([^)]*\)|\[[^\]]*\]/g, ' '), 400));
}

// The product's key words for the share test: its non-generic words, in order, without sizes and long numbers, at most 10.
function identityKeys(ws) {
  const out = [];
  ws.forEach((w) => {
    if (w.length < 2 || IDENTITY_SIZES.has(w) || isGeneric(w) || IDENTITY_GENERIC.has(w) || /^\d{7,}$/.test(w) || out.indexOf(w) !== -1) return;
    out.push(w);
  });
  return out.slice(0, 10);
}

function identityMatch(productTitle, pageName) {
  const ok = { ok: true, reason: null };
  const own = identityWords(productTitle), pw = identityWords(pageName);
  if (!own.length || !pw.length) return ok;
  const keys = identityKeys(own);
  const models = [];
  own.forEach((w, i) => {
    if (!/\d/.test(w)) return;
    if (/^\d+$/.test(w) ? w.length > 6 : false) return;                      // an item number: optional
    models.push(w + (own[i + 1] === 's' ? 's' : ''));
  });
  if (!keys.length && !models.length) return ok;
  const sq = squash(pw);
  for (const m of models) if (!hasKey(sq, m)) return { ok: false, reason: 'mangler modelnavn' };
  // b. the brand or half of the key words
  if (keys.length) {
    const have = keys.filter((k) => hasKey(sq, k));
    const brand = hasKey(sq, keys[0]) || (IMPLIED_BRAND[keys[0]] || []).some((w) => hasKey(sq, w));
    if (!brand && have.length * 2 < keys.length) return { ok: false, reason: 'andet mærke og andre ord' };
  }
  // c. modifiers
  const modsOf = (ws) => conflictsIn(ws, 'variant').filter((w) => !IDENTITY_IGNORED_MODS.has(w));
  const ownMods = modsOf(own), pageMods = modsOf(pw);
  if (pageMods.some((w) => ownMods.indexOf(w) === -1) || ownMods.some((w) => pageMods.indexOf(w) === -1)) return { ok: false, reason: 'anden variant' };
  // d. accessories (first segment of the page name only)
  const seg = words(cleanResultText(firstSegment(pageName), 400));
  const sameKind = (o, w) => ACC_AFFIX.some((a) => (o.indexOf(a) === 0 || o.slice(-a.length) === a) && (w.indexOf(a) === 0 || w.slice(-a.length) === a));
  const ownAcc = conflictsIn(own, 'acc');
  const acc = conflictsIn(seg, 'acc').filter((w) => own.indexOf(w) === -1 && !ownAcc.some((o) => sameKind(o, w)));
  if (acc.length) return { ok: false, reason: 'tilbehør' };
  const til = seg.indexOf('til');
  if (til > 0 && own.indexOf('til') === -1 && models.length) {
    const before = squash(seg.slice(0, til)), after = squash(seg.slice(til + 1));
    if (models.some((m) => hasKey(after, m)) && !models.some((m) => hasKey(before, m))) return { ok: false, reason: 'tilbehør' };
  }
  return ok;
}

// ---------------------------------------------------------------- queries

// The colour / edition words (and a size like 256gb) of the requirements: at most 4, only those the title does not hold already.
function requirementWords(requirements, title) {
  const have = new Set(words(title));
  const out = [];
  words(requirements).forEach((w) => {
    if (have.has(w) || out.indexOf(w) !== -1) return;
    if (COLOURS.has(w) || EDITION.has(w) || /^\d+(gb|tb|mm|cm|l|w)$/.test(w)) out.push(w);
  });
  return out.slice(0, 4);
}

// ["<title> pris", "<title> køb"] or null when the product has no usable title. The title is the one the job stored, else the name.
function buildQueries(prod) {
  const raw = (prod && typeof prod.title === 'string' && prod.title.trim()) ? prod.title : (prod && prod.name);
  const core = coreTitle(raw || '');
  if (!core || !keyTokens(core).length) return null;
  const extra = requirementWords(prod && prod.requirements, core);
  const base = (core + (extra.length ? ' ' + extra.join(' ') : '')).trim();
  return [base + ' pris', base + ' køb'];
}

// ---------------------------------------------------------------- the candidate filter

// Hosts that are never a shop for the product: comparison sites, classified ads, marketplaces, social media, reviews and media. By registrable
// name (so amazon.de, amazon.co.uk, ebay.com, pricerunner.dk all match).
const DENY_NAMES = new Set(['prisjagt', 'pricerunner', 'kelkoo', 'idealo', 'pricespy', 'prisjakt', 'geizhals', 'shopzilla', 'dba', 'guloggratis', 'facebook', 'instagram', 'youtube', 'reddit',
  'trustpilot', 'wikipedia', 'amazon', 'ebay', 'aliexpress', 'temu', 'wish', 'pinterest', 'tiktok', 'twitter', 'linkedin', 'google', 'bing', 'tripadvisor',
  'techradar', 'gizmodo', 'cnet', 'theverge', 'engadget', 'tomshardware', 'pcmag', 'wired', 'forbes', 'rtings', 'notebookcheck', 'gsmarena', 'tek', 'bt', 'ekstrabladet', 'dr', 'politiken', 'jyllands-posten', 'berlingske',
  'forbrugerraadet', 'taenk', 'trendsales', 'markedet', 'ebay-kleinanzeigen', 'kleinanzeigen']);
// Shops that sell to Denmark in kroner on another top-level domain (a registrable domain; its subdomains count too).
const DK_SHOPS = ['boozt.com', 'whiteaway.com', 'lego.com', 'apple.com', 'samsung.com', 'roborock.com', 'coolshop.com', 'dyson.com', 'nike.com', 'ikea.com', 'hm.com', 'ecco.com',
  'bang-olufsen.com', 'sonos.com', 'philips.com', 'bosch-home.com', 'miele.com', 'electrolux.com', 'ecovacs.com', 'dreame.tech', 'garmin.com', 'jabra.com', 'zalando.com', 'adidas.com', 'newbalance.com',
  'komplett.com', 'power.com', 'elkjop.com', 'proshop.com'];
const LOCALE_SEGMENTS = new Set(['dk', 'da', 'da-dk', 'dk-da', 'dk-dk', 'da_dk']);
// A path segment that says the page is not a product page.
const NOT_PRODUCT_SEGMENTS = new Set(['search', 'soeg', 'søg', 'find', 'kategori', 'kategorier', 'category', 'categories', 'brand', 'brands', 'maerke', 'mærke', 'maerker', 'mærker',
  'blog', 'blogs', 'nyheder', 'nyhed', 'news', 'guide', 'guides', 'artikel', 'artikler', 'article', 'articles', 'test', 'tests', 'anmeldelse', 'anmeldelser', 'review', 'reviews',
  'sammenlign', 'compare', 'tag', 'tags', 'inspiration', 'magasin', 'magazine', 'kundeservice', 'support', 'faq', 'om-os', 'kontakt', 'cart', 'kurv', 'login', 'konto', 'sitemap']);
const SEARCH_PARAMS = ['s', 'q', 'query', 'search', 'soeg', 'søg', 'keyword', 'keywords', 'term', 'text'];

function hostOf(u) { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; } }

function isDenied(host) { const n = SHOP.registrable(host).name; return DENY_NAMES.has(n) || DENY_NAMES.has(host); }

function localeOf(segs) { return segs.length && LOCALE_SEGMENTS.has(segs[0]) ? segs[0] : null; }
function segmentsOf(u) {
  let p = ''; try { p = new URL(u).pathname; } catch (e) { return []; }
  return p.split('/').filter(Boolean).map((s) => { let d = s; try { d = decodeURIComponent(s); } catch (e) { /* keep */ } return d.toLowerCase(); });
}

function isDanishHost(u) {
  const h = hostOf(u);
  if (!h) return false;
  if (/\.dk$/.test(h)) return true;
  if (localeOf(segmentsOf(u))) return true;
  const d = SHOP.registrableDomain(h);
  return DK_SHOPS.indexOf(d) !== -1;
}

// Does the URL look like the page of one product (not a category, a search, a brand, a blog post, a front page)? By the path only.
function looksLikeProduct(u) {
  let x; try { x = new URL(u); } catch (e) { return false; }
  let segs = segmentsOf(u);
  if (localeOf(segs)) segs = segs.slice(1);
  if (!segs.length) return false;                                     // a front page, or only a query
  if (segs.some((s) => NOT_PRODUCT_SEGMENTS.has(s))) return false;
  if (segs.indexOf('collections') !== -1 && segs.indexOf('products') === -1) return false;
  for (const k of SEARCH_PARAMS) if (x.searchParams.has(k)) return false;
  const last = segs[segs.length - 1];
  if (/\.(pdf|jpe?g|png|gif|webp|xml|zip)$/.test(last)) return false;
  if (segs.length >= 2) return true;
  // a single segment must look like a product slug: several words, or a model number in it
  return last.split(/[-_]/).filter(Boolean).length >= 3 || /\d/.test(last);
}

// Why a search result is not a candidate for this product, or null when it is. `rows` = the product's current offers (for the dedupe).
function rejectReason(prod, res, rows) {
  const url = res && typeof res.url === 'string' ? res.url.trim() : '';
  if (!url) return 'ingen adresse';
  if (!/^https:\/\//i.test(url)) return 'ikke https';
  if (!SHOP.validateShopUrl(url)) return 'ugyldigt link';
  const host = hostOf(url);
  if (isDenied(host)) return 'sammenligning, markedsplads eller medie';
  if (!isDanishHost(url)) return 'ikke dansk';
  if (!looksLikeProduct(url)) return 'ikke en produktside';
  const dom = SHOP.registrableDomain(host);
  if (prod.source_url && SHOP.registrableDomain(hostOf(prod.source_url)) === dom) return 'varens egen butik';
  if ((Array.isArray(prod.extra_urls) ? prod.extra_urls : []).some((e) => SHOP.registrableDomain(hostOf(e)) === dom)) return 'følges allerede';
  if (X.covered(rows || [], { url, store: SHOP.registrable(host).name })) return 'med på Prisjagt';
  const m = titleMatch(prod.title || prod.name, res.title);
  if (!m.ok) return m.reason;
  return null;
}

// The candidates, in search order, at most one per host and MAX_CANDIDATES in all. results = [{title, url, description}].
function candidates(prod, results) {
  const rows = Array.isArray(prod.offers) ? prod.offers : [];
  const seenHost = new Set(), out = [];
  for (const r of results) {
    if (out.length >= MAX_CANDIDATES) break;
    if (rejectReason(prod, r, rows)) continue;
    const dom = SHOP.registrableDomain(hostOf(r.url));
    if (seenHost.has(dom)) continue;
    seenHost.add(dom); out.push({ url: r.url.trim(), title: r.title });
  }
  return out;
}

// The same result twice (another utm tag, trailing slash, fragment) counts once. First one wins.
function dedupe(results) {
  const seen = new Set(), out = [];
  results.forEach((r) => {
    let k;
    try {
      const x = new URL(r.url);
      const q = []; x.searchParams.forEach((v, key) => { if (!/^(utm_|fbclid|gclid|mc_|ref$)/i.test(key)) q.push(key + '=' + v); });
      k = x.hostname.toLowerCase().replace(/^www\./, '') + x.pathname.replace(/\/+$/, '').toLowerCase() + '?' + q.sort().join('&');
    } catch (e) { k = String(r.url); }
    if (seen.has(k)) return;
    seen.add(k); out.push(r);
  });
  return out;
}

// ---------------------------------------------------------------- verification of a page, and what to add

// The lowest price a customer can buy the product for now: the cheapest offer in stock, else null (nothing to beat).
function lowestPrice(prod) {
  const o = (Array.isArray(prod && prod.offers) ? prod.offers : []).filter((x) => x && typeof x.price === 'number' && x.price > 0 && x.inStock !== false);
  return o.length ? Math.min.apply(null, o.map((x) => x.price)) : null;
}

// A page that was read (shop.js parseShopPage result) for a candidate: {ok, price, store, reason}. The rules: a price (in kroner: the parser
// refuses other currencies), the page's own product name passes the same title match, the price is no outlier against the product's offers,
// the page is in stock (unknown stock counts as in stock, as everywhere), and the shop is not one the offers cover under its real name.
function verifyPage(prod, cand, page, opts) {
  const row = page && Array.isArray(page.rows) ? page.rows[0] : null;
  if (!row || typeof row.price !== 'number' || !(row.price > 0)) return { ok: false, reason: 'ingen pris' };
  if (!page.title) return { ok: false, reason: 'ingen titel på siden' };
  const m = titleMatch(prod.title || prod.name, page.title);
  if (!m.ok) return { ok: false, reason: 'siden: ' + m.reason };
  const offers = Array.isArray(prod.offers) ? prod.offers : [];
  if (X.isOutlier(row.price, offers.filter((o) => o && typeof o.price === 'number').map((o) => o.price))) return { ok: false, reason: 'pris ligner en anden vare' };
  if (row.inStock === false && !(opts && opts.allowOutOfStock)) return { ok: false, reason: 'ikke på lager' };   // the manufacturer's shop is added even when sold out
  if (X.covered(offers, { url: cand.url, store: row.store })) return { ok: false, reason: 'med på Prisjagt' };
  return { ok: true, price: row.price, store: row.store, url: cand.url, title: page.title, inStock: row.inStock !== false };
}

function originOf(st, url) { return st && st[url] && typeof st[url] === 'object' ? st[url].origin : undefined; }
function priceOfLink(prod, st, url) {
  const so = st && st[url] && st[url].offer;
  if (so && typeof so.price === 'number') return so.price;
  const f = (Array.isArray(prod.offers) ? prod.offers : []).find((o) => o && o.url === url && typeof o.price === 'number');
  return f ? f.price : Infinity;    // a link without a known price does not contribute: it is the first to go
}

// What to change in extra_urls. prod = the product with its current offers; fresh = {extra_urls, extra_state} as they are in the database now;
// verified = [{url, price, store}] (any order). Rules:
//  * only a shop cheaper than the product's lowest price now; nothing when none is (the list is not filled with dearer shops);
//  * at most MAX_ADD, the lowest prices first;
//  * room in the list (cap 5, shared with the AI agent and the person): add;
//  * a full list: the shop replaces the most expensive extra whose origin is 'search' (recorded in extra_state by this job) and that is not
//    the product's cheapest; a link without an origin (the AI agent's or the person's: unknown) is never replaced.
// Returns {add: [{url, price, store}], remove: [url]}; the new list is the old one without `remove`, then `add` at the end.
function planChange(prod, fresh, verified) {
  const lowest = lowestPrice(prod);
  const none = { add: [], remove: [] };
  if (lowest === null) return none;
  const st = fresh && fresh.extra_state && typeof fresh.extra_state === 'object' && !Array.isArray(fresh.extra_state) ? fresh.extra_state : {};
  let list = Array.isArray(fresh && fresh.extra_urls) ? fresh.extra_urls.slice() : [];
  const add = [], remove = [];
  const taken = () => new Set(list.map((u) => SHOP.registrableDomain(hostOf(u))).concat([SHOP.registrableDomain(hostOf(prod.source_url || ''))]));
  const cheaper = verified.filter((v) => v.price < lowest).sort((a, b) => a.price - b.price);
  for (const v of cheaper) {
    if (add.length >= MAX_ADD) break;
    if (taken().has(SHOP.registrableDomain(hostOf(v.url)))) continue;
    if (list.length >= MAX_EXTRAS) {
      let victim = null, vp = -1;
      list.forEach((u) => {
        if (originOf(st, u) !== 'search') return;
        const p = priceOfLink(prod, st, u);
        if (p <= lowest) return;                // the product's cheapest (or as cheap as it) stays
        if (p > vp) { victim = u; vp = p; }
      });
      if (!victim) break;
      list = list.filter((u) => u !== victim); remove.push(victim);
    }
    list.push(v.url); add.push({ url: v.url, price: v.price, store: v.store });
  }
  return { add, remove };
}

// The new extra_state after a change: the removed links are gone, each new link has its origin (the job's first reading comes later:
// seen is absent, so its first price is silent, see extraNew in run.js).
function nextState(fresh, change) {
  const st = Object.assign({}, fresh && fresh.extra_state && typeof fresh.extra_state === 'object' && !Array.isArray(fresh.extra_state) ? fresh.extra_state : {});
  change.remove.forEach((u) => { delete st[u]; });
  change.add.forEach((a) => { st[a.url] = { origin: a.origin || 'search' }; });
  return Object.keys(st).length ? st : null;
}

// ---------------------------------------------------------------- which products, in which order

// Is this product searched for in this run? Active, not bought, status 'tracking', has a title, has a price to beat, has an https shop link
// (the database rule for extra_urls), and was not searched in the last 7 days. A row without the columns (an older database) never is.
// opts.brave: the search API is on in this run; a product that was only looked up in the manufacturer's shop before (discover_state.brave false:
// no key, the monthly cap, a stop) is due again at once then.
function isDue(prod, now, opts) {
  const has = (k) => Object.prototype.hasOwnProperty.call(prod, k);
  if (!has('discover_state') || !has('extra_urls') || !has('extra_state')) return false;
  if (prod.active === false || prod.bought_at || prod.status !== 'tracking') return false;
  if (typeof prod.title !== 'string' || !prod.title.trim() || !buildQueries(prod)) return false;
  if (typeof prod.source_url !== 'string' || !/^https:\/\//i.test(prod.source_url) || prod.source_url.length > 500) return false;
  if (lowestPrice(prod) === null) return false;
  const at = prod.discover_state && typeof prod.discover_state === 'object' ? Date.parse(prod.discover_state.at) : NaN;
  if (opts && opts.brave && prod.discover_state && prod.discover_state.brave === false) return true;
  return !(isFinite(at) && now.getTime() - at < RESPACE_MS);
}

// Never searched first (in the order of the list), then the longest ago.
function order(products, now, opts) {
  const at = (p) => { const t = p.discover_state && typeof p.discover_state === 'object' ? Date.parse(p.discover_state.at) : NaN; return isFinite(t) ? t : -Infinity; };
  return products.filter((p) => isDue(p, now, opts)).map((p, i) => ({ p, i })).sort((a, b) => (at(a.p) - at(b.p)) || (a.i - b.i)).map((x) => x.p);
}

// ---------------------------------------------------------------- the search client

// One client per run: the key, a fetch, a sleep. search(q, page) -> {ok: true, results} or {ok: false, stop, status}; `stop` says why the whole
// discovery of this run must end: 'auth' (401/403: wrong key), 'quota' (402/429), 'server' (5xx), 'error' (anything else unexpected).
// At least MIN_GAP_MS between two requests, 15 s timeout, no retries. calls = requests sent (the monthly counter counts every one).
function makeSearcher(opts) {
  const f = opts.fetch || fetch, sleep = opts.sleep;
  let calls = 0;
  const api = {
    get calls() { return calls; },
    async search(q, page) {
      if (calls > 0) await sleep(MIN_GAP_MS);
      calls++;
      const u = new URL(BRAVE.url);
      u.searchParams.set(BRAVE.queryParam, q);
      Object.keys(BRAVE.fixed).forEach((k) => u.searchParams.set(k, String(BRAVE.fixed[k])));
      if (page > 0) u.searchParams.set(BRAVE.pageParam, String(page));
      const headers = { Accept: BRAVE.accept }; headers[BRAVE.keyHeader] = opts.key;
      const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      let r, text;
      try { r = await f(u.toString(), { method: 'GET', headers, signal: ctl.signal }); text = await r.text(); }
      catch (e) { return { ok: false, stop: 'error', status: 0, reason: e && e.name === 'AbortError' ? 'timeout' : 'netværksfejl' }; }
      finally { clearTimeout(t); }
      const s = r.status;
      if (s === 401 || s === 403) return { ok: false, stop: 'auth', status: s };
      if (s === 402 || s === 429) return { ok: false, stop: 'quota', status: s };
      if (s >= 500) return { ok: false, stop: 'server', status: s };
      if (s !== 200) return { ok: false, stop: 'error', status: s };
      let json; try { json = JSON.parse(text); } catch (e) { return { ok: false, stop: 'error', status: s, reason: 'svaret kunne ikke læses' }; }
      const results = BRAVE.results(json).map((x) => ({ title: cleanResultText(x && x.title, 300), url: x && typeof x.url === 'string' ? x.url.trim() : '', description: cleanResultText(x && x.description, 300) })).filter((x) => x.url);
      return { ok: true, results };
    },
  };
  return api;
}

// ---------------------------------------------------------------- one product

// Search, filter, read, verify. deps = {searcher, read(url) -> {page} | {error} | {skip}}.
// Returns {stop?, status?, found, checked, verified: [...], note}. On a stop nothing else is returned (the product is tried again later).
async function discoverProduct(prod, deps) {
  const queries = buildQueries(prod);
  if (!queries) return { found: 0, checked: 0, verified: [], note: 'ingen titel' };
  let results = [];
  for (const step of PLAN) {
    const r = await deps.searcher.search(queries[step.q], step.page);
    if (!r.ok) return { stop: r.stop, status: r.status, reason: r.reason, found: 0, checked: 0, verified: [], note: 'afbrudt' };
    results = results.concat(r.results);
  }
  results = dedupe(results);
  const cands = candidates(prod, results);
  const verified = [];
  let checked = 0;
  const hosts = new Set();
  for (const c of cands) {
    const got = await deps.read(c.url);
    if (got.skip) continue;
    checked++;
    if (got.error || !got.page) continue;
    const v = verifyPage(prod, c, got.page);
    if (!v.ok) continue;
    const dom = SHOP.registrableDomain(hostOf(c.url));
    if (hosts.has(dom)) continue;
    hosts.add(dom); verified.push(v);
  }
  return { found: results.length, candidates: cands.length, checked, verified, note: verified.length ? 'fundet' : (cands.length ? 'ingen godkendt' : 'ingen kandidater') };
}

module.exports = {
  BRAVE, MIN_GAP_MS, TIMEOUT_MS, CALLS_PER_PRODUCT, PLAN, MAX_PRODUCTS_PER_RUN, MONTHLY_CAP, RESPACE_MS, MAX_CANDIDATES, MAX_ADD, MAX_EXTRAS, MAX_PAGES_PER_RUN,
  DENY_NAMES, DK_SHOPS, MODIFIERS,
  words, isGeneric, firstSegment, squash, hasKey, hostOf, segmentsOf, localeOf, originOf, priceOfLink,
  keyTokens, titleMatch, identityMatch, coreTitle, buildQueries, requirementWords, looksLikeProduct, isDanishHost, isDenied, rejectReason, candidates, dedupe,
  lowestPrice, verifyPage, planChange, nextState, isDue, order, makeSearcher, discoverProduct, cleanResultText,
};
