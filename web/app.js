(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var nf = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 });
  var kr = function (n) { return (typeof n === "number" && isFinite(n)) ? nf.format(Math.round(n)) + " kr." : "–"; };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var safeUrl = function (u) { return (typeof u === "string" && /^https?:\/\//i.test(u)) ? u : null; };
  // a product picture: https only (the address comes from the database, which holds the same rule), never proxied or tracked
  var safeImg = function (u) { return (typeof u === "string" && u.length <= 500 && /^https:\/\/[^\s\/?#@:]+\.[^\s\/?#@:]+/i.test(u)) ? u : null; };
  var badImg = {};
  function initialOf(name) {
    var cs = Array.from(String(name || "").trim()), i, c;
    for (i = 0; i < cs.length; i++) { c = cs[i]; if (c.toLowerCase() !== c.toUpperCase() || /[0-9]/.test(c)) return c.toUpperCase(); }
    return "?";
  }
  var reduceMotion = function () { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); };
  var dFmt = new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "short" });
  var dtFmt = new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  var DAY = 864e5;
  var bfDays = Math.ceil((new Date(2026, 10, 27).getTime() - Date.now()) / DAY); // Black Friday 2026: 27 Nov
  var PLACEHOLDER = "Nyt produkt";

  // The one place the Supabase client is created; the tests replace it with window.PV_CREATE_CLIENT.
  function createClient(url, key) {
    if (typeof window.PV_CREATE_CLIENT === "function") return window.PV_CREATE_CLIENT(url, key);
    if (!window.supabase || !window.supabase.createClient) throw new Error("supabase-js not loaded");
    return window.supabase.createClient(url, key);
  }

  var state = { goalOpen: {}, manage: {}, allShops: {}, pshops: {}, errOpen: false, ord: null, share: null, confirmMember: null, confirmLeave: null, memCount: {}, people: {}, imports: [], importsOk: false, importMsg: "", confirmImport: null, lists: [], listsOk: false, listSel: "all", listForm: null, confirmList: null, products: [], loaded: false, canWrite: true, open: {}, range: {}, confirmDel: null, pick: {}, change: {}, note: {}, rowMsg: {},
    prefs: { always: [], exclude: [], only: false, notify: false, digest: false, asked: true }, profileSound: null };
  var access = { admin: false, requests: [], allowed: [], confirm: null, msg: "", busy: false, seq: 0 };
  var noacc = { on: false, state: "", timer: null, busy: false, msg: "" };
  var sb = null, user = null, channel = null, pollTimer = null, fetching = false, again = false, lastFetch = 0, fetchSeq = 0;

  // ---- sound: recorded clips (public domain / CC0, Wikimedia Commons), confetti and a price count-down ----
  var ac = null, interacted = false, muted = false, heard = {}, bufs = {};
  try { muted = localStorage.getItem("pv-muted") === "1"; heard = JSON.parse(localStorage.getItem("pv-heard") || "{}") || {}; } catch (e) {}
  function loadSounds() {
    ["kasse", "klap", "jubel"].forEach(function (name) {
      if (bufs[name]) return;
      fetch("sounds/" + name + ".mp3").then(function (r) { if (!r.ok) throw new Error("missing"); return r.arrayBuffer(); })
        .then(function (ab) { return new OfflineAudioContext(2, 44100, 44100).decodeAudioData(ab); })
        .then(function (buf) { bufs[name] = buf; })
        .catch(function () {});
    });
  }
  // tier 1: goal reached (cash register + applause). tier 2: a genuinely good deal (register + cheering crowd).
  // tier 3: also the lowest price in the whole history (as 2, plus applause at the end).
  function jingle(tier) {
    try {
      tier = tier || 2;
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      ac.resume();
      var tk = ac.currentTime + 0.06;
      var comp = ac.createDynamicsCompressor();
      comp.connect(ac.destination);
      var play = function (buf, at, gain) {
        var s = ac.createBufferSource(), g = ac.createGain();
        s.buffer = buf; g.gain.value = gain; s.connect(g); g.connect(comp); s.start(at);
      };
      if (bufs.kasse) play(bufs.kasse, tk, 0.9);
      else { // the recording is missing: a short synthesised ring instead
        [1318.5, 1975.5, 2637, 3951].forEach(function (f, k) {
          var o = ac.createOscillator(), g = ac.createGain();
          o.type = "sine"; o.frequency.value = f; g.gain.value = 0.2 - k * 0.04; o.connect(g); g.connect(comp);
          o.start(tk + 0.07); o.stop(tk + 0.7 - k * 0.1);
        });
      }
      var cheerAt = bufs.kasse ? tk + 1.4 : tk + 0.8;
      if (tier === 1 && bufs.klap) { play(bufs.klap, cheerAt, 0.9); return; }
      if (bufs.jubel) { play(bufs.jubel, cheerAt, 1); if (tier === 3 && bufs.klap) play(bufs.klap, cheerAt + 9.5, 0.9); return; }
      if (bufs.klap) play(bufs.klap, cheerAt, 0.9);
    } catch (e) {}
  }
  function isMega(p) { return isHit(p) && p.verdict && p.verdict.level === "good"; }
  function tierOf(p) {
    if (!isHit(p)) return 0;
    if (!isMega(p)) return 1;
    var h = histOf(p), b = bestOf(p);
    return (h.length > 5 && b.price <= Math.min.apply(null, h.map(function (x) { return x.p; }))) ? 3 : 2;
  }
  function topTier(ps) { return ps.reduce(function (m, p) { return Math.max(m, tierOf(p)); }, 1); }
  // Confetti, and the row's price counting down from the normal price to the deal.
  function celebrate(ps, tier) {
    (window.__pvCelebrations = window.__pvCelebrations || []).push({ tier: tier, ids: ps.map(function (p) { return p._id; }) });
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    ps.forEach(function (p) {
      var b = bestOf(p), el = document.querySelector('.head[data-id="' + CSS.escape(p._id) + '"] .price b');
      if (!el || !b || !(typeof p.normalPrice === "number" && p.normalPrice > b.price)) return;
      var from = p.normalPrice, st = performance.now();
      (function step(now) {
        if (!el.isConnected) return;
        var k = Math.min(1, (now - st) / 1600), e = 1 - Math.pow(1 - k, 3);
        el.textContent = kr(from + (b.price - from) * e);
        if (k < 1) requestAnimationFrame(step);
      })(st);
    });
    var cv = document.createElement("canvas");
    cv.className = "confetti";
    cv.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:50";
    document.body.appendChild(cv);
    var dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.width = window.innerWidth * dpr, H = cv.height = window.innerHeight * dpr;
    var cx = cv.getContext("2d"), cols = ["#ffd60a", "#2a78d6", "#e34948", "#1baf7a", "#e87ba4", "#6250d6"], parts = [];
    for (var i = 0; i < 50 * tier; i++) parts.push({ x: Math.random() * W, y: -Math.random() * H * 0.5, vx: (Math.random() - 0.5) * 4 * dpr,
      vy: (2 + Math.random() * 4) * dpr, s: (6 + Math.random() * 6) * dpr, r: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3, c: cols[i % cols.length] });
    var start = performance.now(), life = 3000 + tier * 700;
    (function frame(now) {
      var t = now - start;
      cx.clearRect(0, 0, W, H);
      cx.globalAlpha = t > life - 600 ? Math.max(0, (life - t) / 600) : 1;
      parts.forEach(function (p) {
        p.x += p.vx; p.y += p.vy; p.vy += 0.05 * dpr; p.r += p.vr;
        cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r); cx.fillStyle = p.c; cx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); cx.restore();
      });
      if (t < life) requestAnimationFrame(frame); else cv.remove();
    })(start);
  }
  function checkSound() {
    if (muted || !interacted) return;
    var cleared = false;
    state.products.forEach(function (p) { if (!isHit(p) && p._id in heard) { delete heard[p._id]; cleared = true; } });
    if (cleared) { try { localStorage.setItem("pv-heard", JSON.stringify(heard)); } catch (e) {} }
    var fresh = state.products.filter(function (p) { var b = bestOf(p); return isHit(p) && heard[p._id] !== b.price; });
    if (!fresh.length) return;
    fresh.forEach(function (p) { heard[p._id] = bestOf(p).price; });
    try { localStorage.setItem("pv-heard", JSON.stringify(heard)); } catch (e) {}
    var tier = topTier(fresh);
    jingle(tier); celebrate(fresh, tier);
  }
  function syncSound() { $("soundBtn").textContent = muted ? "Lyd fra" : "Lyd til"; }
  syncSound();
  $("soundBtn").addEventListener("click", function () {
    muted = !muted; interacted = true;
    try { localStorage.setItem("pv-muted", muted ? "1" : "0"); } catch (e) {}
    syncSound(); saveSoundPref();
    if (muted) { if (ac) { try { ac.close(); } catch (e) {} ac = null; } }
    else {
      var megas = state.products.filter(isHit), tier = megas.length ? topTier(megas) : 2;
      jingle(tier); celebrate(megas, tier);
    }
  });
  $("tryBtn").addEventListener("click", function () { interacted = true; jingle(2); });
  ["pointerdown", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      if (interacted || (e.target && e.target.id === "soundBtn")) return;
      interacted = true; checkSound();
    });
  });
  function saveSoundPref() {
    if (!sb || !user) return;
    sb.from("profiles").upsert({ user_id: user.id, sound: muted ? "off" : "on" }).then(function () {}, function () {});
  }

  // ---- derived values (the product rows are mapped to the field names used throughout) ----
  function shopKey(s) {
    return String(s || "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/\/.*$/, "")
      .replace(/\.(dk|com|se|no|de|eu|net)$/, "").replace(/[^a-z0-9æøå]/g, "");
  }
  function shopIn(store, list) {
    var a = shopKey(store);
    return !!a && list.some(function (x) { var b = shopKey(x);
      if (!b) return false;
      if (a === b) return true;
      var sh = a.length < b.length ? a : b, lo = a.length < b.length ? b : a;
      return sh.length >= 5 && lo.indexOf(sh) >= 0;
    });
  }
  function shopList(v) {
    return (Array.isArray(v) ? v : String(v || "").split(/[,\n;]/)).map(function (x) { return String(x).trim().slice(0, 80); })
      .filter(Boolean).slice(0, 20);
  }
  var num = function (v) { if (v == null || v === "") return null; var n = Number(v); return isFinite(n) ? n : null; };
  function norm(r) {
    var nm = (r.name && r.name !== PLACEHOLDER) ? r.name : (r.title || r.name || PLACEHOLDER);
    return {
      _id: r.id, name: String(nm), status: r.status || "pending", title: r.title || null,
      variants: Array.isArray(r.variants) ? r.variants.filter(function (v) { return v && v.id != null; }) : [],
      tracked: Array.isArray(r.tracked_variants) ? r.tracked_variants.map(String) : null,
      offers: (Array.isArray(r.offers) ? r.offers : []).filter(function (o) { return o && num(o.price) != null; })
        .map(function (o) { return Object.assign({}, o, { price: num(o.price) }); }),
      history: Array.isArray(r.history) ? r.history : [],
      normalPrice: num(r.normal_price), verdict: r.verdict && typeof r.verdict === "object" ? r.verdict : null,
      warning: r.warning || "", checkNote: r.check_note || "", lastChecked: r.last_checked || null,
      targetType: r.target_type === "pct" ? "pct" : r.target_type === "auto" ? "auto" : "price", targetValue: num(r.target_value),
      shopsAlways: r.shops_always, shopsExclude: r.shops_exclude, shopsOnly: !!r.shops_only,
      url: r.source_url || null, image: safeImg(r.image_url), createdAt: r.created_at || "", listId: r.list_id || null,
      boughtAt: r.bought_at || null, boughtPrice: num(r.bought_price),
      userId: r.user_id || null, boughtBy: r.bought_by || null,
      // alternatives: altOk = the database has the columns (an older database does not send them, and the feature stays hidden)
      altOk: "alt_requested_at" in r, altReq: r.alt_requested_at || null, altDone: r.alt_done_at || null,
      alts: Array.isArray(r.alternatives) ? r.alternatives : null, altNote: typeof r.alt_note === "string" ? r.alt_note : "",
      // compare ("find the cheapest shop"): cmpOk = the database has the columns. cmp: 'wanted' | 'done' | 'none' | null; shopUrl = the original shop link after a switch
      cmpOk: "compare_state" in r, cmp: r.compare_state || null, cmpAt: r.compare_at || null, shopUrl: r.shop_url || null,
      // extra shops: extraOk = the database has the column (an older one does not send it, and the feature stays hidden); extraRaw = the
      // stored array as it is (a removal sends it back minus one entry), shown through xList (checked again)
      extraOk: "extra_urls" in r, extraRaw: Array.isArray(r.extra_urls) ? r.extra_urls.filter(function (u) { return typeof u === "string"; }) : [],
      // details ("Detaljer", products.requirements): the person's own free words. reqOk = the database has the column (else everything about it stays hidden);
      // reqState = what the AI agent answered for them (only its "for" is read here)
      reqOk: "requirements" in r, req: typeof r.requirements === "string" ? r.requirements.slice(0, 120) : "",
      reqStateOk: "req_state" in r, reqState: r.req_state && typeof r.req_state === "object" ? r.req_state : null
    };
  }
  function offersOf(p) {
    var os = p.offers, pr = state.prefs;
    // the product's own shop choices are added on top of the general ones
    var ex = pr.exclude.concat(shopList(p.shopsExclude)), al = pr.always.concat(shopList(p.shopsAlways)), only = pr.only || !!p.shopsOnly;
    if (ex.length) os = os.filter(function (o) { return !shopIn(o.store, ex); });
    if (only && al.length) os = os.filter(function (o) { return shopIn(o.store, al); });
    return os;
  }
  function bestOf(p) {
    var os = offersOf(p), inStock = os.filter(function (o) { return o.inStock !== false; });
    var pool = inStock.length ? inStock : os;
    return pool.slice().sort(function (a, b) { return a.price - b.price; })[0] || null;
  }
  // the lowest in-stock price now (own shop choices applied), or null
  function inStockLow(p) {
    var ps = offersOf(p).filter(function (o) { return o.inStock !== false; }).map(function (o) { return o.price; });
    return ps.length ? Math.min.apply(null, ps) : null;
  }
  function targetKr(p) {
    if (p.targetType === "auto") return null;
    var v = p.targetValue;
    if (typeof v !== "number" || !isFinite(v) || !(v > 0)) return null;
    if (p.targetType === "pct") return typeof p.normalPrice === "number" ? p.normalPrice * (1 - v / 100) : null;
    return v;
  }
  function histOf(p) {
    return (Array.isArray(p.history) ? p.history : []).filter(function (h) { return h && typeof h === "object"; }).map(function (h) {
      return { t: Date.parse(h.d + "T12:00:00"), p: h.p, s: h.s, src: h.src };
    }).filter(function (h) { return isFinite(h.t) && typeof h.p === "number"; }).sort(function (a, b) { return a.t - b.t; });
  }
  // Goal "auto" (no goal of the user's own): one short sentence on why this is a good deal, or null. The same rule as the job:
  // the verdict says "good", or there is too little history for a verdict (no normal price) and the price is at least 10 % under
  // the first price seen.
  function autoReason(p) {
    var b = bestOf(p);
    if (p.status !== "tracking" || !b || b.inStock === false) return null;
    var v = p.verdict;
    if (v && v.level === "good" && v.text) return v.text;
    if (v && v.level === "unknown" && p.normalPrice == null) {
      var h = histOf(p).filter(function (x) { return x.p > 0; });
      if (h.length && b.price * 10 <= h[0].p * 9) return kr(b.price) + " er " + Math.round((1 - b.price / h[0].p) * 100) + " % under første pris (" + kr(h[0].p) + ").";
    }
    return null;
  }
  function isHit(p) {
    if (p.boughtAt) return false;                               // bought: no goal, no highlight, no sound
    if (p.targetType === "auto") return autoReason(p) !== null;
    var b = bestOf(p), t = targetKr(p); return p.status === "tracking" && !!(b && t != null && b.inStock !== false && b.price <= t);
  }
  function targetText(p) {
    if (p.targetType === "auto") return null;         // an "auto" goal has no label of its own: the row shows the saving when it is a hit, and nothing otherwise
    var t = targetKr(p);
    if (p.targetType === "pct") return "mål " + nf.format(p.targetValue) + " %" + (t != null ? " · " + kr(t) : "");
    return "mål " + kr(t);
  }
  // A product link: any https page (prisjagt.dk lists many shops; any other host is one single shop).
  // The database accepts the same: https, a host with a dot, no user:password@ or port, at most 500 characters.
  function parseLink(u) {
    var x;
    try { x = new URL(String(u || "").trim()); } catch (e) { return null; }
    if (x.protocol !== "https:" || x.username || x.password || x.port) return null;
    var h = x.hostname.toLowerCase();
    if (h.indexOf(".") < 1 || /^[\d.]+$/.test(h) || h.charAt(0) === "[" || h.slice(-1) === "." || h.indexOf("..") >= 0) return null;
    if (h === "prisjagt.dk" || h === "www.prisjagt.dk") {
      if (x.pathname.length < 2) return null;
      x.hostname = "prisjagt.dk";
    }
    x.hash = "";
    var out = x.toString();
    return out.length <= 500 ? out : null;
  }
  function isShopUrl(u) {
    try { var h = new URL(String(u || "")).hostname.toLowerCase(); return h !== "prisjagt.dk" && h !== "www.prisjagt.dk"; } catch (e) { return false; }
  }
  var LINK_HELP = "Linket skal være en https-adresse til en produktside, fra prisjagt.dk eller fra en enkelt butik.";
  function isOpen(p) { return state.open[p._id] !== undefined ? !!state.open[p._id] : p.status === "choose"; }
  function awaitingFetch(p) { return p.status === "choose" && p.tracked && p.tracked.length && !state.change[p._id]; }
  function variantLabels(p) {
    var ids = p.tracked || [];
    var ls = p.variants.filter(function (v) { return ids.indexOf(String(v.id)) >= 0; }).map(function (v) { return v.label; }).filter(Boolean);
    return ls.length ? ls.join(", ") : (p.title || "");
  }

  // ---- shared lists: who is who ----
  // A product is "mine" when I added it. In a list shared with me, the products of others can be read and marked as bought, nothing else
  // (the database enforces it; the controls are only hidden here). A row without user_id (never from the database) counts as mine.
  function isMine(p) { return !user || !p.userId || p.userId === user.id; }
  function mayEdit(p) { return state.canWrite && isMine(p); }
  function listById(id) { return state.lists.filter(function (l) { return l.id === id; })[0]; }
  function listShared(id) { var l = listById(id); return !!l && (!l.own || (state.memCount[id] || 0) > 0); }
  function personName(listId, uid) {
    var ps = state.people[listId] || [];
    for (var i = 0; i < ps.length; i++) if (ps[i].id === uid) return ps[i].name;
    return "";
  }
  // the name of the person who added the product, only for someone else's product in a shared list
  function addedBy(p) { return !isMine(p) && p.listId && listShared(p.listId) ? personName(p.listId, p.userId) : ""; }
  // the name of the person who marked it as bought, only when that is someone else than me
  function boughtByName(p) { return p.boughtBy && user && p.boughtBy !== user.id && p.listId ? personName(p.listId, p.boughtBy) : ""; }
  // may undo a bought mark or change its price: the product's owner, the person who marked it, the list's owner
  function mayUnbuy(p) {
    var l = p.listId ? listById(p.listId) : null;
    return state.canWrite && (isMine(p) || (!!p.boughtBy && !!user && p.boughtBy === user.id) || !!(l && l.own));
  }

  // ---- rendering ----
  function renderStatus() {
    if (!user) return;
    if (!state.loaded) { $("status").textContent = "Henter listen …"; return; }
    var newest = 0;
    state.products.forEach(function (p) { var t = Date.parse(p.lastChecked); if (isFinite(t) && t > newest) newest = t; });
    var parts = [newest ? "Opdateret " + dtFmt.format(new Date(newest)) : "Ingen priser endnu"];
    if (bfDays > 0) parts.push(bfDays + (bfDays === 1 ? " dag" : " dage") + " til Black Friday");
    $("status").textContent = parts.join(" · ");
  }

  function sparkHtml(p) {
    var h = histOf(p), now = Date.now(), t0 = now - 90 * DAY, pts = [], carry = null;
    h.forEach(function (x) { if (x.t < t0) carry = x; else pts.push(x); });
    if (carry) pts.unshift({ t: t0, p: carry.p });
    if (pts.length < 2) return '<span class="spark"></span>';
    var lo = Math.min.apply(null, pts.map(function (x) { return x.p; })), hi = Math.max.apply(null, pts.map(function (x) { return x.p; }));
    var a = pts[0].t, W = 96, H = 30;
    var X = function (t) { return 2 + (t - a) / (now - a || 1) * (W - 6); };
    var Y = function (v) { return hi === lo ? H / 2 : 4 + (1 - (v - lo) / (hi - lo)) * (H - 8); };
    var d = "M" + X(pts[0].t).toFixed(1) + "," + Y(pts[0].p).toFixed(1);
    for (var i = 1; i < pts.length; i++) d += "H" + X(pts[i].t).toFixed(1) + "V" + Y(pts[i].p).toFixed(1);
    d += "H" + X(now).toFixed(1);
    var last = pts[pts.length - 1];
    return '<svg class="spark" viewBox="0 0 96 30" aria-hidden="true"><path d="' + d + '" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-linejoin="round"/>' +
      '<circle cx="' + X(now).toFixed(1) + '" cy="' + Y(last.p).toFixed(1) + '" r="2.5" fill="var(--ink)"/></svg>';
  }

  function thumbHtml(p) {
    var u = p.image && !badImg[p.image] ? p.image : null, ch = esc(initialOf(p.name));
    return '<span class="thumb' + (u ? "" : " ph") + '" data-ch="' + ch + '" aria-hidden="true">' +
      (u ? '<img src="' + esc(u) + '" alt="" width="48" height="48" loading="lazy" decoding="async" referrerpolicy="no-referrer">' : ch) + '</span>';
  }
  // Short muted status under the name. Red is only for a real warning ("Oppustet førpris"); a product that cannot be fetched is quiet.
  function headHtml(p) {
    var b = bestOf(p), t = targetKr(p), os = offersOf(p), st;
    var anyStock = os.some(function (o) { return o.inStock !== false; });
    if (p.status === "pending") st = p.url ? "Henter produktet …" : "Finder produktet …";
    else if (p.status === "error") st = esc(cmpErrText(p) || "Produktet kunne ikke hentes");
    else if (awaitingFetch(p)) st = "Henter priser for den valgte variant …";
    else if (p.status === "choose") st = isMine(p) ? '<span class="out">Vælg variant</span>' : '<span class="out">Variant ikke valgt</span>';
    else if (p.boughtAt && p.status === "tracking") {
      var bw = boughtByName(p);
      st = esc("Købt" + (bw ? " af " + bw : "") + (p.boughtPrice != null ? " for " + kr(p.boughtPrice) : ""));
      if (b && p.boughtPrice != null && Math.round(b.price) !== Math.round(p.boughtPrice)) st += " · nu " + esc(kr(b.price));
    }
    else if (isHit(p)) st = '<span class="ok">' + (p.targetType === "auto" ? "Godt tilbud" : "Mål nået") + '</span> · på lager hos ' + esc(b.store || "en butik");
    else if (!p.lastChecked) st = "Venter på første tjek";
    else if (!b) st = esc(p.checkNote || "Ingen pris fundet");
    else if (!anyStock) st = '<span class="out">Udsolgt alle steder</span> · senest hos ' + esc(b.store || "en butik");
    else st = t != null ? '<span class="m1">' + esc(kr(b.price - t)) + " over målet</span> · billigst hos " + esc(b.store || "en butik") : '<span class="m1">billigst hos ' + esc(b.store || "en butik") + '</span>';
    if (p.status === "tracking" && p.warning && !p.boughtAt) st += ' · <span class="warn">Oppustet førpris</span>';
    var ab = addedBy(p);
    if (ab) st += " · af " + esc(ab);
    var showPrice = p.status === "tracking" && b, sub = "";
    if (!p.boughtAt && showPrice) {
      var off = typeof p.normalPrice === "number" && p.normalPrice > 0 ? Math.round((1 - b.price / p.normalPrice) * 100) : 0;
      sub = isHit(p) && p.targetType === "auto" && off >= 1 ? '<span class="off">−' + off + ' %</span>' : (targetText(p) ? '<span>' + esc(targetText(p)) + '</span>' : "");
    }
    return thumbHtml(p) + '<div class="info"><h2>' + esc(p.name) + '</h2><div class="meta">' + st + '</div></div>' + (p.status === "tracking" ? sparkHtml(p) : "") +
      (showPrice ? '<div class="price n"><b>' + esc(kr(b.price)) + '</b>' + sub + '</div>' : "");
  }

  function chooserHtml(p) {
    var id = p._id, sel = state.pick[id];
    if (!sel) sel = p.tracked && p.tracked.length ? p.tracked : (p.variants.length === 1 ? [String(p.variants[0].id)] : []);
    if (!p.variants.length) return '<p class="verdict">Ingen varianter endnu.</p>';
    return '<form class="choose" data-choose="' + esc(id) + '"><fieldset class="variants"><legend class="vh">Hvilke varianter vil du følge?</legend>' +
      p.variants.map(function (v, i) {
        var vid = String(v.id), n = Array.isArray(v.offers) ? v.offers.length : num(v.offers);
        return '<label class="var"><input type="checkbox" data-var="' + esc(vid) + '"' + (sel.indexOf(vid) >= 0 ? " checked" : "") + '>' +
          '<span>' + esc(v.label || ("Variant " + (i + 1))) + '</span>' +
          '<span class="vp n">' + (num(v.lowest) != null ? "fra " + esc(kr(num(v.lowest))) : "") + '</span>' +
          '<span class="meta">' + (n != null ? esc(n + " tilbud") : "") + '</span></label>';
      }).join("") + '</fieldset><div class="choose-act"><button class="btn small" type="submit">Følg valgte</button>' +
      (p.status === "tracking" ? '<button type="button" class="link" data-act="change-no" data-id="' + esc(id) + '">Fortryd</button>' : '') +
      '<span class="meta" data-rowmsg="' + esc(id) + '">' + esc(state.rowMsg[id] || "") + '</span></div></form>';
  }

  function listPickHtml(p) {
    var id = p._id;
    if (!mayEdit(p) || !state.listsOk || !state.lists.length) return "";
    var known = state.lists.some(function (l) { return l.id === p.listId; });
    return '<div class="listpick"><label for="lp-' + esc(id) + '">Liste</label><select id="lp-' + esc(id) + '" data-listpick="' + esc(id) + '">' +
      '<option value="">Ingen liste</option>' + state.lists.map(function (l) {
        return '<option value="' + esc(l.id) + '"' + (known && p.listId === l.id ? " selected" : "") + '>' + esc(l.name) + '</option>';
      }).join("") + '</select></div>';
  }
  // "Købt": one click, no question. Then the price paid can be corrected, or the click undone.
  function boughtHtml(p) {
    var id = p._id;
    if (!state.canWrite || p.status === "pending" || p.status === "error") return "";
    if (!p.boughtAt) return '<div class="foot"><span></span><button type="button" class="link" data-act="buy" data-id="' + esc(id) + '">Købt</button></div>';
    if (!mayUnbuy(p)) return "";                                  // someone else's mark: the head says who bought it
    return '<form class="edit bought-row" data-bought="' + esc(id) + '" novalidate><label for="bp-' + esc(id) + '">Købt for</label>' +
      '<input class="n" type="number" id="bp-' + esc(id) + '" min="1" max="10000000" step="any" inputmode="decimal" value="' + esc(p.boughtPrice != null ? p.boughtPrice : "") + '"> <span>kr.</span>' +
      '<button class="link" type="submit">Gem</button><button type="button" class="link" data-act="unbuy" data-id="' + esc(id) + '">Fortryd</button>' +
      '<span class="meta" data-rowmsg="b-' + esc(id) + '">' + esc(state.rowMsg["b-" + id] || "") + '</span></form>';
  }
  function footHtml(p, fixLink) {
    var id = p._id, link = safeUrl(p.url), html = reqEditHtml(p) + listPickHtml(p) + boughtHtml(p);
    html += '<div class="foot"><span>' + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + (isMine(p) ? "Dit link" : "Link") + '</a>' : '') + '</span>';
    if (mayEdit(p)) {
      if (state.confirmDel === id) {
        html += '<span class="edit"><span>Fjern produktet og dets historik?</span>' +
          '<button type="button" class="link warn" data-act="del-yes" data-id="' + esc(id) + '">Ja, fjern</button>' +
          '<button type="button" class="link" data-act="del-no">Behold</button></span>';
      } else {
        var auto = p.targetType === "auto";
        html += '<form class="edit" data-edit="' + esc(id) + '"><label class="vh" for="et-' + esc(id) + '">Mål</label>' +
          '<select id="et-' + esc(id) + '" data-etype>' +
          [["auto", "Godt tilbud"], ["price", "Højst, kr."], ["pct", "Rabat i %"]].map(function (o) {
            return '<option value="' + o[0] + '"' + (p.targetType === o[0] ? " selected" : "") + '>' + o[1] + '</option>';
          }).join("") + '</select>' +
          '<input class="n" type="number" id="e-' + esc(id) + '" min="1" step="1" value="' + esc(auto ? "" : p.targetValue) + '" aria-label="Målets værdi"' + (auto ? " hidden" : " required") + '>' +
          '<button class="link" type="submit">Gem</button>' +
          '<button type="button" class="link warn" data-act="del" data-id="' + esc(id) + '">Fjern</button></form>';
      }
    }
    return html + '</div>';
  }

  // Name-only product: link to prisjagt.dk's own search (opens in a new tab) and a form to paste the link found there.
  function findHtml(p, afterError) {
    var id = p._id, a = '<a href="https://prisjagt.dk/search?search=' + esc(encodeURIComponent(p.name)) + '" target="_blank" rel="noopener noreferrer">Søg selv på Prisjagt</a>';
    var f = mayEdit(p) ? '<form class="edit" data-fixurl="' + esc(id) + '" novalidate><label for="u-' + esc(id) + '">Indsæt linket her</label>' +
      '<input class="wide" type="url" id="u-' + esc(id) + '" maxlength="500" required placeholder="https://…">' +
      '<button class="link" type="submit">Gem linket</button><span class="meta" data-rowmsg="' + esc(id) + '">' + esc(state.rowMsg[id] || "") + '</span></form>' : "";
    return '<p class="verdict">' + a + '</p>' + f;
  }

  // One-click goals from the product's own history: a price in whole kroner each (shown value = saved value).
  function suggestions(p, b, low30, lowAll) {
    var list = [];
    if (lowAll != null) list.push({ label: "Laveste set", v: Math.round(lowAll) });
    if (typeof p.normalPrice === "number") list.push({ label: "10 % under normalpris", v: Math.floor(p.normalPrice * 0.9) });
    else if (b) list.push({ label: "10 % under prisen nu", v: Math.floor(b.price * 0.9) });
    if (low30 != null) list.push({ label: "Laveste 30 dage", v: Math.round(low30) });
    var seen = {};
    return list.filter(function (x) { if (!(x.v > 0) || seen[x.v]) return false; seen[x.v] = true; return true; }).slice(0, 3);
  }
  function suggestHtml(p, b, h, low30, lowAll) {
    if (!mayEdit(p) || !h.length) return "";
    var l = suggestions(p, b, low30, lowAll);
    if (!l.length) return "";
    return '<div class="sugg" role="group" aria-label="Sæt mål">' + l.map(function (x) {
      var on = p.targetType === "price" && p.targetValue === x.v;
      return '<button type="button" class="chip" data-act="goal" data-id="' + esc(p._id) + '" data-v="' + x.v + '" aria-pressed="' + on + '">' + esc(x.label + ": " + kr(x.v)) + '</button>';
    }).join("") + '</div>';
  }

  // "Indstil vare": everything about managing a tracked product, in one collapsed section (the open state is kept between renders).
  function linkHtml(p) {
    var link = safeUrl(p.url);
    return link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + (isMine(p) ? "Dit link" : "Link") + '</a>' : "";
  }
  function goalEditHtml(p) {
    var id = p._id, auto = p.targetType === "auto";
    return '<form class="edit" data-edit="' + esc(id) + '"><label class="vh" for="et-' + esc(id) + '">Mål</label>' +
      '<select id="et-' + esc(id) + '" data-etype>' +
      [["auto", "Godt tilbud"], ["price", "Højst, kr."], ["pct", "Rabat i %"]].map(function (o) {
        return '<option value="' + o[0] + '"' + (p.targetType === o[0] ? " selected" : "") + '>' + o[1] + '</option>';
      }).join("") + '</select>' +
      '<input class="n" type="number" id="e-' + esc(id) + '" min="1" step="1" value="' + esc(auto ? "" : p.targetValue) + '" aria-label="Målets værdi"' + (auto ? " hidden" : " required") + '>' +
      '<button class="link gsave" type="submit">Gem</button><button type="button" class="link gclose" data-act="goal-close" data-id="' + esc(id) + '">Luk</button></form>';
  }
  // The goal, in one line at the top of the open card. "Ændr" (own products only) opens the editor and the suggestions right below it.
  function goalLabel(p) {
    if (p.targetType === "price") return "Mål: under " + kr(p.targetValue);
    if (p.targetType === "pct") return "Mål: " + nf.format(p.targetValue) + " % rabat";
    return "Mål: godt tilbud";
  }
  function lowsOf(p) {
    var h = histOf(p), now = Date.now(), last30 = h.filter(function (x) { return x.t >= now - 30 * DAY; });
    return { h: h, low30: last30.length ? Math.min.apply(null, last30.map(function (x) { return x.p; })) : null,
      lowAll: h.length ? Math.min.apply(null, h.map(function (x) { return x.p; })) : null };
  }
  function goalHtml(p) {
    if (p.status !== "tracking" || p.boughtAt) return "";
    var id = p._id, ed = mayEdit(p), open = ed && !!state.goalOpen[id];
    var html = '<div class="goalwrap"><div class="goalline"><span class="gt">' + esc(goalLabel(p)) + '</span>' +
      (ed ? '<button type="button" class="gact" data-act="goal-open" data-id="' + esc(id) + '" aria-expanded="' + open + '"' + (open ? ' aria-controls="gp-' + esc(id) + '"' : '') + '>Ændr</button>' : '') + '</div>';
    if (open) {
      var l = lowsOf(p);
      html += '<div class="goalpanel" id="gp-' + esc(id) + '">' + suggestHtml(p, bestOf(p), l.h, l.low30, l.lowAll) + goalEditHtml(p) + '</div>';
    }
    return html + '</div>';
  }
  // "Indstil vare" and "Vis alle butikker": a real button (aria-expanded) and a panel; the state is kept between renders
  function discHtml(cls, act, id, label, open, inner) {
    return '<div class="' + cls + '" data-' + cls + '="' + esc(id) + '"><button type="button" class="disc" data-act="' + act + '" data-id="' + esc(id) + '" aria-expanded="' + open + '">' + label + '</button>' +
      '<div class="' + cls + '-in"' + (open ? "" : " hidden") + '>' + inner + '</div></div>';
  }
  function removeHtml(p) {
    var id = p._id;
    if (!mayEdit(p)) return "";
    if (state.confirmDel === id)
      return '<span class="edit"><span>Fjern produktet og dets historik?</span>' +
        '<button type="button" class="link warn" data-act="del-yes" data-id="' + esc(id) + '">Ja, fjern</button>' +
        '<button type="button" class="link" data-act="del-no">Behold</button></span>';
    return '<button type="button" class="link warn" data-act="del" data-id="' + esc(id) + '">Fjern</button>';
  }
  function shopPrefsHtml(p) {
    var id = p._id;
    return '<details class="pshops" data-pshops="' + esc(id) + '"' + (state.pshops[id] ? " open" : "") + '><summary>Butiksvalg</summary><form class="pshop" data-shops="' + esc(id) + '">' +
      '<label for="sa-' + esc(id) + '">Tjek altid</label>' +
      '<input type="text" id="sa-' + esc(id) + '" maxlength="600" value="' + esc(shopList(p.shopsAlways).join(", ")) + '" placeholder="fx Proshop, hifiklubben.dk">' +
      '<label for="se-' + esc(id) + '">Udelad</label>' +
      '<input type="text" id="se-' + esc(id) + '" maxlength="600" value="' + esc(shopList(p.shopsExclude).join(", ")) + '">' +
      '<label class="chk"><input type="checkbox" id="so-' + esc(id) + '"' + (p.shopsOnly ? ' checked' : '') + '> Kun butikker fra “tjek altid”</label>' +
      '<span><button class="link" type="submit">Gem</button></span></form></details>';
  }
  function manageHtml(p, single) {
    var id = p._id, parts = [];
    var rq = reqEditHtml(p);
    if (rq) parts.push(rq);
    var lp = listPickHtml(p);
    if (lp) parts.push(lp);
    var v = "";
    if (state.change[id]) v = chooserHtml(p);
    else if (!single && p.variants.length) {
      v = '<div class="foot"><span>' + (p.variants.length > 1 ? "Variant: " + esc(variantLabels(p) || "alle") : "") + '</span>' +
        (mayEdit(p) ? '<button type="button" class="link" data-act="change" data-id="' + esc(id) + '">Skift variant</button>' : '') + '</div>';
    }
    if (v) parts.push(v);
    if (mayEdit(p)) parts.push(shopPrefsHtml(p));
    var xs = xHtml(p);
    if (xs) parts.push(xs);
    var bo = boughtHtml(p);
    if (bo) parts.push(bo);
    var lk = linkHtml(p), rm = removeHtml(p), end = "";
    if (lk || rm) end = '<div class="foot"><span>' + lk + '</span>' + rm + '</div>';
    if (!parts.length && !end) return "";
    return discHtml("manage", "manage", id, "Indstil vare", !!(state.manage[id] || state.change[id] || state.confirmDel === id),
      parts.map(function (x) { return '<div class="mrow">' + x + '</div>'; }).join("") + (end ? '<div class="mrow end">' + end + '</div>' : ""));
  }
  function shopTable(list, best) {
    return '<div class="tablewrap"><table><tbody>' + list.map(function (o) {
      var u = safeUrl(o.url), out = o.inStock === false;
      return '<tr class="' + (o === best ? "best" : "") + (out ? " soldout" : "") + '"><td>' + esc(o.store || "") +
        ((o.note || out) ? '<div class="meta">' + esc([out ? "Ikke på lager" : "", o.note || ""].filter(Boolean).join(" · ")) + '</div>' : '') +
        '</td><td class="num n">' + esc(kr(o.price)) + '</td><td>' +
        (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">Se varen</a>' : '') + '</td></tr>';
    }).join("") + '</tbody></table></div>';
  }

  // The same section for rows that are not tracking yet (fetching, choose variant, cannot be fetched): the foot actions behind "Indstil vare".
  function looseManage(p) {
    var f = footHtml(p);
    if (!f) return "";
    return discHtml("manage", "manage", p._id, "Indstil vare", !!(state.manage[p._id] || state.confirmDel === p._id), '<div class="mrow">' + f + '</div>');
  }

  // Details: the person's own words (escaped like every user string). One quiet line at the top; the input is in "Indstil vare" (own products only).
  function cleanReq(t) {
    return String(t == null ? "" : t).replace(/[\u0000-\u001f\u007f-\u009f<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120).trim();
  }
  function reqLineHtml(p) {
    return p.reqOk && p.req ? '<p class="note req">Detaljer: ' + esc(p.req) + '</p>' : "";
  }
  // "Finder den rigtige variant": details given, at "Vælg variant", the agent has not answered for these words yet (the person can choose at any time)
  function reqFindingHtml(p) {
    if (!p.reqOk || !p.reqStateOk || !p.req || p.status !== "choose" || !isMine(p) || p.variants.length < 2 || awaitingFetch(p) || state.change[p._id]) return "";
    if (p.reqState && p.reqState["for"] === p.req) return "";
    return '<p class="note req-find">Finder den rigtige variant</p>';
  }
  function reqEditHtml(p) {
    var id = p._id;
    if (!p.reqOk || !mayEdit(p)) return "";
    return '<form class="edit" data-req="' + esc(id) + '" novalidate><label for="rq-' + esc(id) + '">Detaljer</label>' +
      '<input type="text" id="rq-' + esc(id) + '" maxlength="120" value="' + esc(p.req) + '" placeholder="Farve, størrelse m.m.">' +
      '<button class="link" type="submit">Gem</button><span class="meta" data-rowmsg="rq-' + esc(id) + '">' + esc(state.rowMsg["rq-" + id] || "") + '</span></form>';
  }
  function bodyHtml(p) { return goalHtml(p) + reqLineHtml(p) + reqFindingHtml(p) + bodyHtml0(p); }
  function bodyHtml0(p) {
    var id = p._id;
    if (p.status === "pending" && !p.url) return findHtml(p) + looseManage(p);
    if (p.status === "pending") return cmpHtml(p) + looseManage(p);
    if (p.status === "error" && !p.url)
      return '<p class="verdict"><b>Produktet blev ikke fundet.</b> ' + esc(p.checkNote || "Find det selv på Prisjagt, og indsæt linket her.") + '</p>' + findHtml(p, true) + looseManage(p);
    if (p.status === "error") {
      var f = mayEdit(p) ? '<form class="edit" data-fixurl="' + esc(id) + '" novalidate><label class="vh" for="u-' + esc(id) + '">Link til produktet</label>' +
        '<input class="wide" type="url" id="u-' + esc(id) + '" maxlength="500" required value="' + esc(p.url || "") + '" placeholder="Link fra prisjagt.dk eller en butik">' +
        '<button class="link" type="submit">Gem linket og prøv igen</button><span class="meta" data-rowmsg="' + esc(id) + '">' + esc(state.rowMsg[id] || "") + '</span></form>' : "";
      return '<p class="verdict"><b>Produktet kunne ikke hentes.</b> ' + esc(cmpErrText(p) || "Tjek, at linket er en produktside.") + '</p>' + cmpHtml(p) + f + looseManage(p);
    }
    if (awaitingFetch(p))
      return '<div class="foot"><span>Variant: ' + esc(variantLabels(p)) + '</span>' + (mayEdit(p) && !isShopUrl(p.url) ? '<button type="button" class="link" data-act="change" data-id="' + esc(id) + '">Skift variant</button>' : '') + '</div>' + cmpHtml(p) + looseManage(p);
    if (p.status === "choose") return (isMine(p) ? chooserHtml(p) : '<p class="note">Variant ikke valgt endnu.</p>') + cmpHtml(p) + looseManage(p);

    var b = bestOf(p), h = histOf(p), now = Date.now(), html = "";
    if (state.note[id]) html += '<p class="note">' + esc(state.note[id]) + '</p>';
    var single = isShopUrl(p.url);
    if (single && p.checkNote) html += '<p class="note">' + esc(cmpErrText(p)) + '</p>';
    var v = p.verdict;
    if (v && v.text) {
      var lab = { good: "Godt tilbud.", ok: "Almindelig pris.", poor: "Ikke et godt tilbud.", unknown: "For tidligt at sige." }[v.level] || "";
      html += '<p class="verdict ' + esc(v.level || "") + '"><b>' + lab + '</b> ' + esc(v.text) + '</p>';
    }
    if (p.targetType === "auto" && autoReason(p) && !(v && v.text === autoReason(p))) html += '<p class="note">' + esc(autoReason(p)) + '</p>';
    if (p.warning) html += '<p class="verdict warn"><b>Pas på førprisen.</b> ' + esc(p.warning) + '</p>';

    var lw = lowsOf(p), low30 = lw.low30, lowAll = lw.lowAll;
    html += '<dl class="stats n">' +
      '<div><dt>Laveste 30 dage</dt><dd>' + esc(kr(low30)) + '</dd></div>' +
      '<div><dt>Laveste set</dt><dd>' + esc(kr(lowAll)) + '</dd></div>' +
      '<div><dt>Normalpris</dt><dd>' + esc(kr(p.normalPrice)) + '</dd></div></dl>';

    if (h.length) {
      var r = state.range[id] || 365;
      html += '<div class="sect"><div class="sec-h"><h3>Prisen dag for dag</h3><div class="ranges" role="group" aria-label="Periode">' +
        [[30, "1 md."], [90, "3 mdr."], [365, "1 år"]].map(function (x) {
          return '<button type="button" data-act="range" data-id="' + esc(id) + '" data-r="' + x[0] + '" aria-pressed="' + (r === x[0]) + '">' + x[1] + '</button>';
        }).join("") + '</div></div><div class="chart" data-chart="' + esc(id) + '"></div>';
      if (h.length < 2) html += '<p class="note">Første måling er gemt.</p>';
      else if (h.some(function (x) { return x.src === "backfill"; })) html += '<p class="note">Ældre priser kan være upræcise og have huller.</p>';
      if (h.length > 1 && h[0].t > now - r * DAY) html += '<p class="note">Historik fra ' + esc(dFmt.format(new Date(h[0].t))) + ' ' + new Date(h[0].t).getFullYear() + '.</p>';
      if (h.length > 1) {
        html += '<details><summary>Vis som tabel</summary><div class="tablewrap"><table class="n"><tbody>' +
          h.slice().reverse().map(function (x) {
            return '<tr><td>' + esc(dFmt.format(new Date(x.t))) + ' ' + new Date(x.t).getFullYear() + '</td><td class="num">' + esc(kr(x.p)) + '</td><td>' + esc(x.s || "") + '</td></tr>';
          }).join("") + '</tbody></table></div></details>';
      }
      html += '</div>';
    }

    // the three cheapest shops with the item in stock; everything else (sold out included) behind "Vis alle butikker"
    var os = offersOf(p).slice().sort(function (a, c) { return ((a.inStock === false) - (c.inStock === false)) || (a.price - c.price); });
    if (os.length) {
      var inS = os.filter(function (o) { return o.inStock !== false; }), top = (inS.length ? inS : os).slice(0, 3);
      var more = os.filter(function (o) { return top.indexOf(o) < 0; });
      html += '<div class="shops sect"><div class="sec-h"><h3>Butikker</h3></div>' + shopTable(top, b) +
        (more.length ? discHtml("allshops", "allshops", id, "Vis alle butikker", !!state.allShops[id], shopTable(more, b)) : '') + '</div>';
    }
    if (single && !xList(p).length) html += '<p class="note">Kun denne butik. Et link fra prisjagt.dk sammenligner flere.</p>';
    html += cmpHtml(p);
    html += altHtml(p);
    return html + manageHtml(p, single);
  }

  // ---- alternatives: similar products and deals, answered by the AI agent within the hour ----
  // Everything in an alternative comes from the AI agent and is untrusted: text goes through esc(), a link only when it passes
  // parseLink (https, same rule as the database), and nothing is ever put into the page without escaping.
  var ALT_STALE = 6 * 36e5, ALT_LIMIT = "Du kan bede om alternativer 5 gange i døgnet.";
  function altTime(v) { var t = Date.parse(v); return isFinite(t) ? t : null; }
  function altPending(p) { var r = altTime(p.altReq), d = altTime(p.altDone); return r !== null && (d === null || d < r); }
  function altOver(p) { var r = altTime(p.altReq); return altPending(p) && r !== null && Date.now() - r > ALT_STALE; }
  function altAnswered(p) { var r = altTime(p.altReq), d = altTime(p.altDone); return r !== null && d !== null && d >= r; }
  function altClean(p) {
    var ok = (p.alts || []).filter(function (a) {
      return a && typeof a === "object" && (a.kind === "deal" || a.kind === "similar") && typeof a.name === "string" && a.name.trim() &&
        typeof a.store === "string" && typeof a.price === "number" && isFinite(a.price) && a.price > 0;
    });
    return ok.filter(function (a) { return a.kind === "deal"; }).concat(ok.filter(function (a) { return a.kind !== "deal"; })).slice(0, 6);
  }
  // "-18 %": only for a deal that has a normal price at least 5 % above the price
  function altTag(a) {
    if (a.kind !== "deal" || typeof a.was !== "number" || !isFinite(a.was) || !(a.was > a.price)) return "";
    var pc = Math.round((1 - a.price / a.was) * 100);
    return pc >= 5 ? "\u2212" + pc + " %" : "";
  }
  function altTracked(u) {
    return !!u && state.products.some(function (x) { return x.url && parseLink(x.url) === u; });
  }
  function altItemHtml(p, a, i) {
    var u = typeof a.url === "string" ? parseLink(a.url) : null, tag = altTag(a), id = p._id;
    var name = u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(a.name) + '</a>' : esc(a.name);
    var act = "";
    if (u && state.canWrite) {
      var has = altTracked(u);
      act = '<button type="button" class="link" data-act="alt-follow" data-id="' + esc(id) + '" data-i="' + i + '"' + (has ? " disabled" : "") + '>' + (has ? "Følges" : "Følg") + '</button>';
    }
    return '<li><div class="alt-row"><span class="alt-name">' + name + '</span><span class="alt-price n">' + esc(kr(a.price)) + '</span></div>' +
      '<div class="meta">' + esc(a.store) + (tag ? ' · <span class="alt-tag">' + esc(tag) + '</span>' : '') + '</div>' +
      (typeof a.why === "string" && a.why ? '<div class="meta alt-why">' + esc(a.why) + '</div>' : '') +
      (act ? '<div class="alt-act">' + act + '</div>' : '') + '</li>';
  }
  function altHtml(p) {
    if (!p.altOk || p.status !== "tracking") return "";
    var id = p._id, ask = mayEdit(p) && !p.boughtAt, msg = '<span class="meta" data-rowmsg="alt-' + esc(id) + '">' + esc(state.rowMsg["alt-" + id] || "") + '</span>';
    var btn = function (label) { return '<button type="button" class="link" data-act="alt-find" data-id="' + esc(id) + '">' + label + '</button>'; };
    if (altPending(p) && !altOver(p)) return '<p class="note alts">Søger alternativer. Svar inden for en time.</p>';
    if (altOver(p)) return '<p class="note alts">Ingen svar.' + (ask ? " " + btn("Prøv igen") + "." + " " + msg : "") + '</p>';
    if (altAnswered(p)) {
      var list = altClean(p);
      if (!list.length) return '<p class="note alts">' + esc(p.altNote || "Ingen alternativer fundet.") + (ask ? " " + btn("Prøv igen") + " " + msg : "") + '</p>';
      return '<div class="alts sect"><div class="sec-h"><h3>Alternativer</h3>' + (ask ? '<span>' + btn("Søg igen") + ' ' + msg + '</span>' : '') + '</div><ul class="alt-list">' +
        list.map(function (a, i) { return altItemHtml(p, a, i); }).join("") + '</ul></div>';
    }
    return ask ? '<div class="alts">' + btn("Find alternativer") + ' ' + msg + '</div>' : "";
  }
  // the alternatives the page shows, in the order it shows them (what "Følg" points at)
  function altShown(p) { return altClean(p); }
  function altError(e) {
    var m = String((e && e.message) || "");
    if (m === ALT_LIMIT) return ALT_LIMIT;
    if (/^Der er allerede bedt om alternativer/.test(m)) return "Der er allerede bedt om alternativer.";
    return "Kunne ikke gemme lige nu. Prøv igen om lidt.";
  }

  // ---- compare: a product that follows one shop can be switched to Prisjagt (the AI agent finds the page), and switched back ----
  // The state is the server's (compare_state, written by the job and the AI agent); the person can only ask ('wanted') and go back
  // (source_url = the original shop link). A quiet line each, nothing in the product row.
  var CMP_WAIT = 36e5, CMP_REFUSED = "Butikken afviser automatiske opslag.";
  function cmpSingle(p) { return !!p.url && isShopUrl(p.url); }
  function cmpTime(v) { var t = Date.parse(v); return isFinite(t) ? t : null; }
  // the original shop link of a switched product, only when it is an https link to one shop (it came from the database: checked again)
  function cmpShopLink(p) {
    var u = p.shopUrl;
    return typeof u === "string" && /^https:\/\//i.test(u) && parseLink(u) && isShopUrl(u) ? u : null;
  }
  // may the person ask? A shop link, not asked before (or asked and not found more than 1 hour ago); their own product, not bought
  function cmpMayAsk(p) {
    if (!p.cmpOk || !mayEdit(p) || p.boughtAt || !cmpSingle(p) || (p.status !== "tracking" && p.status !== "error")) return false;
    if (p.cmp === null) return true;
    var t = cmpTime(p.cmpAt);
    return p.cmp === "none" && (t === null || Date.now() - t > CMP_WAIT);
  }
  // the error text of a shop that refuses, when a comparison is being looked for: the one line says both
  function cmpErrText(p) {
    if (p.cmpOk && p.cmp === "wanted" && cmpSingle(p) && p.checkNote === CMP_REFUSED) return "Butikken afviser opslag. Leder efter andre butikker.";
    return p.checkNote;
  }
  // ---- extra shops: other shops that sell the same product (found by the AI agent); the person may only drop one ----
  // The links come from the database and are checked again: https, one shop each (not prisjagt.dk). Only the host is shown.
  function xList(p) {
    if (!p.extraOk) return [];
    var out = [];
    p.extraRaw.forEach(function (raw, i) {
      var u = parseLink(raw);
      if (!u || !isShopUrl(u) || out.length >= 5) return;
      var h = "";
      try { h = new URL(u).hostname.toLowerCase().replace(/^www\./, ""); } catch (e) { return; }
      out.push({ i: i, url: u, host: h });
    });
    return out;
  }
  function xHtml(p) {
    var l = xList(p);
    if (!l.length) return "";
    var id = p._id, ed = mayEdit(p);
    return '<div class="xshops"><div class="meta">Butikker, vi følger</div>' + l.map(function (x) {
      return '<div class="foot"><span><a href="' + esc(x.url) + '" target="_blank" rel="noopener noreferrer">' + esc(x.host) + '</a></span>' +
        (ed ? '<button type="button" class="link warn" data-act="x-rm" data-id="' + esc(id) + '" data-i="' + x.i + '">Fjern</button>' : '') + '</div>';
    }).join("") + '<span class="meta" data-rowmsg="x-' + esc(id) + '">' + esc(state.rowMsg["x-" + id] || "") + '</span></div>';
  }
  function cmpHtml(p) {
    if (!p.cmpOk) return "";
    var id = p._id, msg = '<span class="meta" data-rowmsg="cmp-' + esc(id) + '">' + esc(state.rowMsg["cmp-" + id] || "") + '</span>';
    if (p.cmp === "done" && !cmpSingle(p)) {
      var u = cmpShopLink(p);
      if (!u) return "";
      return '<p class="note cmp">Skiftet til Prisjagt for at sammenligne butikker. <a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">Oprindelig butik</a>' +
        (mayEdit(p) ? ' <button type="button" class="link" data-act="cmp-undo" data-id="' + esc(id) + '">Fortryd</button> ' + msg : '') + '</p>';
    }
    if (!cmpSingle(p)) return "";
    if (p.cmp === "done" && xList(p).length) return '<p class="note cmp">Følger ' + (1 + xList(p).length) + ' butikker.</p>';
    if (p.cmp === "wanted") return p.checkNote === CMP_REFUSED ? "" : '<p class="note cmp">Leder efter flere butikker.</p>';
    if (cmpMayAsk(p)) return '<p class="note cmp"><button type="button" class="link" data-act="cmp-find" data-id="' + esc(id) + '">Find flere butikker</button> ' + msg + '</p>';
    if (p.cmp === "none") return '<p class="note cmp">Fandt ikke varen hos andre butikker.</p>';
    return "";
  }

  // ---- lists: chips above the product list ----
  // The selection is remembered per browser: "all", "none" (no list) or a list id.
  try { var savedSel = localStorage.getItem("pv-list"); if (savedSel) state.listSel = savedSel; } catch (e) {}
  function saveSel() { try { localStorage.setItem("pv-list", state.listSel); } catch (e) {} }
  function hasUnlisted() { return state.products.some(function (p) { return !listKnown(p.listId); }); }
  function listKnown(id) { return !!id && state.lists.some(function (l) { return l.id === id; }); }
  // What is really shown: falls back to "all" when the remembered list is gone or "none" has nothing to show.
  function curSel() {
    if (!state.listsOk) return "all";
    var s = state.listSel;
    if (s === "none") return (state.lists.length && hasUnlisted()) ? "none" : "all";
    return listKnown(s) ? s : "all";
  }
  function inSel(p, sel) { return sel === "all" || (sel === "none" ? !listKnown(p.listId) : p.listId === sel); }
  function listCount(sel) { return state.products.filter(function (p) { return inSel(p, sel); }).length; }
  function sortLists() { state.lists.sort(function (a, b) { return a.name.localeCompare(b.name, "da") || (a.id < b.id ? -1 : 1); }); }
  function chipHtml(key, label, n, shared) {
    return '<button type="button" class="lchip" data-lsel="' + esc(key) + '" aria-pressed="' + (curSel() === key) + '">' + esc(label) +
      (shared ? ' <span class="shr">delt</span>' : '') + (n != null ? ' <span class="cnt n">' + n + '</span>' : '') + '</button>';
  }
  function ownLists() { return state.lists.filter(function (l) { return l.own; }); }
  function renderLists() {
    var box = $("listsBox");
    var show = !!(user && state.listsOk && (state.lists.length || state.canWrite));
    box.hidden = !show;
    if (!show) return;
    var sel = curSel(), html = chipHtml("all", "Alle", state.products.length);
    state.lists.forEach(function (l) { html += chipHtml(l.id, l.name, listCount(l.id), listShared(l.id)); });
    if (state.lists.length && hasUnlisted()) html += chipHtml("none", "Uden liste", listCount("none"));
    if (state.canWrite) html += '<button type="button" class="lchip plus" data-lact="new" aria-expanded="' + (state.listForm === "new") + '">+ Ny liste</button>';
    $("chips").innerHTML = html;
    var cur = listById(sel), act = "";
    if (state.listForm) act = "";
    else if (cur && state.canWrite && !cur.own) {
      if (state.confirmLeave === cur.id) {
        act = '<span class="edit"><span>Forlad listen ' + esc(cur.name) + '? Dine egne produkter beholdes uden liste.</span>' +
          '<button type="button" class="link warn" data-lact="leave-yes">Ja, forlad listen</button>' +
          '<button type="button" class="link" data-lact="leave-no">Behold</button></span>';
      } else act = '<button type="button" class="link warn" data-lact="leave">Forlad liste</button>';
    }
    else if (cur && state.canWrite) {
      if (state.confirmList === cur.id) {
        act = '<span class="edit"><span>Slet listen ' + esc(cur.name) + '? Produkterne beholdes og flyttes til Uden liste.' + (listShared(cur.id) ? ' De andre mister adgangen.' : '') + '</span>' +
          '<button type="button" class="link warn" data-lact="del-yes">Ja, slet listen</button>' +
          '<button type="button" class="link" data-lact="del-no">Behold</button></span>';
      } else {
        act = '<button type="button" class="link" data-lact="rename">Omdøb</button>' +
          '<button type="button" class="link" data-lact="share" aria-expanded="' + (state.share === cur.id) + '">Del</button>' +
          '<button type="button" class="link warn" data-lact="del">Slet liste</button>';
      }
    }
    $("listAct").innerHTML = act; $("listAct").hidden = !act;
    var f = $("listForm"); f.hidden = !state.listForm;
    renderShare(cur);
  }
  // The share panel of an owned list: who is in it ("Fjern" asks first) and a field to invite one more person.
  function renderShare(cur) {
    var open = !!(cur && cur.own && state.canWrite && state.share === cur.id && !state.listForm);
    $("shareBox").hidden = !open;
    if (!open) { $("shPeople").innerHTML = ""; return; }
    var ms = (state.people[cur.id] || []).filter(function (x) { return x.role === "member"; });
    ms.sort(function (a, b) { return a.name.localeCompare(b.name, "da"); });
    $("shPeople").innerHTML = ms.map(function (m) {
      var who = esc(m.name || "Ukendt");
      if (state.confirmMember === m.id)
        return '<li><span>Fjern ' + who + '? ' + who + 's egne produkter beholdes uden liste.</span><button type="button" class="link warn" data-sact="rm-yes" data-uid="' + esc(m.id) + '">Ja, fjern</button>' +
          '<button type="button" class="link" data-sact="rm-no">Behold</button></li>';
      return '<li><span>' + who + '</span>' + (m.email ? '<span class="meta">' + esc(m.email) + '</span>' : '') +
        '<button type="button" class="link" data-sact="rm" data-uid="' + esc(m.id) + '">Fjern</button></li>';
    }).join("");
  }
  function listMsg(t) { var m = $("listMsg"); m.textContent = t || ""; m.hidden = !t; }
  function selectList(key) { state.listSel = key; state.confirmList = null; state.confirmLeave = null; state.share = null; state.confirmMember = null; state.listForm = null; listMsg(""); saveSel(); render(); }
  function openListForm(mode) {
    var cur = listById(curSel());
    state.listForm = mode; state.confirmList = null; state.confirmLeave = null; state.share = null; listMsg("");
    $("lfName").value = mode === "rename" && cur ? cur.name : "";
    $("lfSave").textContent = mode === "rename" ? "Gem navn" : "Opret liste";
    $("lfLabel").textContent = mode === "rename" ? "Nyt navn til listen" : "Navn på den nye liste";
    render(); $("lfName").focus();
  }
  function closeListForm() { state.listForm = null; listMsg(""); render(); }
  function listError(e) {
    if (isDenied(e)) { onWriteError(e); return "Du har ikke adgang til at gemme."; }
    if (e && e.code === "23505") return "Du har allerede en liste med det navn.";
    if (e && e.code === "23514") return "Navnet skal være mellem 1 og 40 tegn, og du kan højst have 30 lister.";
    return "Kunne ikke gemme lige nu. Prøv igen om lidt.";
  }
  $("chips").addEventListener("click", function (ev) {
    var c = ev.target.closest("[data-lsel]");
    if (c) { selectList(c.dataset.lsel); return; }
    if (ev.target.closest('[data-lact="new"]')) { if (state.listForm === "new") closeListForm(); else openListForm("new"); }
  });
  $("listAct").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-lact]"); if (!b) return;
    var act = b.dataset.lact, cur = listById(curSel());
    if (!cur) return;
    if (act === "leave") { state.confirmLeave = cur.id; render(); return; }
    if (act === "leave-no") { state.confirmLeave = null; render(); return; }
    if (act === "leave-yes" && sb && !cur.own) {
      b.disabled = true;
      sb.rpc("leave_list", { p_list: cur.id }).then(function (r) {
        if (r && r.error) { b.disabled = false; listMsg(listError(r.error)); return; }
        // the database moves my own products out of the list; the others' products are no longer mine to see
        state.products = state.products.filter(function (p) { return p.listId !== cur.id || isMine(p); });
        state.products.forEach(function (p) { if (p.listId === cur.id) p.listId = null; });
        state.lists = state.lists.filter(function (l) { return l.id !== cur.id; });
        state.confirmLeave = null; state.listSel = "all"; saveSel(); listMsg(""); render(); fetchProducts();
      }, function () { b.disabled = false; listMsg("Kunne ikke gemme lige nu. Prøv igen om lidt."); });
      return;
    }
    if (!cur.own) return;
    if (act === "rename") openListForm("rename");
    else if (act === "share") { state.share = state.share === cur.id ? null : cur.id; state.confirmMember = null; listMsg(""); render(); if (state.share) $("shEmail").focus(); }
    else if (act === "del") { state.confirmList = cur.id; render(); }
    else if (act === "del-no") { state.confirmList = null; render(); }
    else if (act === "del-yes" && sb) {
      b.disabled = true;
      sb.from("lists").delete().eq("id", cur.id).then(function (r) {
        if (r && r.error) { b.disabled = false; listMsg(listError(r.error)); return; }
        // the database moves the products out of the list (on delete set null); show that at once
        state.products.forEach(function (p) { if (p.listId === cur.id) p.listId = null; });
        state.lists = state.lists.filter(function (l) { return l.id !== cur.id; });
        state.confirmList = null; state.listSel = "all"; saveSel(); listMsg(""); render(); fetchProducts();
      }, function () { b.disabled = false; listMsg("Kunne ikke gemme lige nu. Prøv igen om lidt."); });
    }
  });
  $("listForm").addEventListener("keydown", function (ev) { if (ev.key === "Escape") { closeListForm(); } });
  $("lfCancel").addEventListener("click", closeListForm);
  $("listForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!sb || !state.listForm) return;
    var name = $("lfName").value.replace(/\s+/g, " ").trim(), mode = state.listForm, cur = listById(curSel());
    if (!name || name.length > 40) { listMsg("Skriv et navn på mellem 1 og 40 tegn."); return; }
    var dup = ownLists().some(function (l) { return l.name.toLowerCase() === name.toLowerCase() && !(mode === "rename" && cur && l.id === cur.id); });
    if (dup) { listMsg("Du har allerede en liste med det navn."); return; }
    if (mode === "new" && ownLists().length >= 30) { listMsg("Du kan højst have 30 lister. Slet en liste først."); return; }
    var btn = $("lfSave"); btn.disabled = true;
    var q = mode === "rename" && cur ? sb.from("lists").update({ name: name }).eq("id", cur.id) : sb.from("lists").insert({ name: name });
    if (mode === "new") q = q.select().single();
    q.then(function (r) {
      btn.disabled = false;
      if (r && r.error) { listMsg(listError(r.error)); return; }
      if (mode === "rename" && cur) { cur.name = name; sortLists(); }
      else if (r && r.data && r.data.id) { state.lists.push({ id: r.data.id, name: r.data.name || name, own: true }); sortLists(); state.listSel = r.data.id; saveSel(); }
      state.listForm = null; listMsg(""); render(); fetchLists();
    }, function () { btn.disabled = false; listMsg("Kunne ikke gemme lige nu. Prøv igen om lidt."); });
  });

  // ---- sharing: invite by e-mail, remove a person ----
  var SHARE_ANSWER = {
    unknown: "Personen skal have adgang til Prisvagten først.", already: "Listen er allerede delt med personen.", self: "Det er din egen adresse.",
    full: "En liste kan højst deles med 10 personer.", invalid: "Skriv en gyldig e-mailadresse.", slow: "Prøv igen om lidt."
  };
  $("shClose").addEventListener("click", function () { state.share = null; state.confirmMember = null; listMsg(""); render(); });
  $("shareForm").addEventListener("keydown", function (ev) { if (ev.key === "Escape") { state.share = null; state.confirmMember = null; listMsg(""); render(); } });
  $("shareForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var cur = listById(curSel()), addr = $("shEmail").value.trim();
    if (!sb || !cur || !cur.own || state.share !== cur.id) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr) || addr.length > 200) { listMsg(SHARE_ANSWER.invalid); return; }
    var btn = $("shSave"); btn.disabled = true; listMsg("");
    sb.rpc("share_list", { p_list: cur.id, p_email: addr }).then(function (r) {
      btn.disabled = false;
      if (r && r.error) { listMsg(schemaOld(r.error) ? SCHEMA_OLD : listError(r.error)); return; }
      var a = r && r.data;
      if (a === "ok") { $("shEmail").value = ""; listMsg(""); fetchMembers(); return; }
      listMsg(SHARE_ANSWER[a] || "Kunne ikke gemme lige nu. Prøv igen om lidt.");
    }, function () { btn.disabled = false; listMsg("Kunne ikke gemme lige nu. Prøv igen om lidt."); });
  });
  $("shPeople").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-sact]"), cur = listById(curSel()); if (!b || !cur || !cur.own || !sb) return;
    var act = b.dataset.sact, uid = b.dataset.uid;
    if (act === "rm") { state.confirmMember = uid; render(); return; }
    if (act === "rm-no") { state.confirmMember = null; render(); return; }
    if (act !== "rm-yes") return;
    b.disabled = true;
    sb.rpc("unshare_list", { p_list: cur.id, p_user: uid }).then(function (r) {
      if (r && r.error) { b.disabled = false; listMsg(listError(r.error)); return; }
      state.confirmMember = null; listMsg("");
      state.people[cur.id] = (state.people[cur.id] || []).filter(function (x) { return x.id !== uid; });
      state.memCount[cur.id] = Math.max(0, (state.memCount[cur.id] || 1) - 1);
      render(); fetchProducts();
    }, function () { b.disabled = false; listMsg("Kunne ikke gemme lige nu. Prøv igen om lidt."); });
  });

  // ---- imports: a shared wish list from Ønskeskyen is read by the price job; a quiet status line per import ----
  // The imports table only exists once schema.sql has been run again. Until then nothing is shown and nothing breaks.
  var IMPORT_PENDING = "Henter ønsker fra Ønskeskyen …";
  function dayWord(iso) {
    var t = Date.parse(iso); if (!isFinite(t)) return "";
    var d = new Date(t), n = new Date(), y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
    if (d.toDateString() === n.toDateString()) return "i dag";
    if (d.toDateString() === y.toDateString()) return "i går";
    return dFmt.format(d);
  }
  // A finished import is a standing link between a list and the wish list: one quiet line, "Stop" ends it (the products stay).
  function importLine(im) {
    var txt, id = esc(im.id), act = "";
    if (im.status === "pending") txt = IMPORT_PENDING;
    else if (im.status === "done") {
      var n = im.found != null ? im.found : im.added, parts = ["Følger " + (im.title || "ønskelisten")];
      if (n != null) parts.push(nf.format(n) + (n === 1 ? " ønske" : " ønsker"));
      var when = im.syncedAt ? dayWord(im.syncedAt) : "";
      if (when) parts.push("opdateret " + when);
      txt = parts.join(" · ");
      if (im.fails > 0 && im.note) txt += " · " + im.note;
    }
    else txt = im.note || "Ønskelisten kunne ikke hentes.";
    if (im.status !== "pending" && state.canWrite) {
      if (im.status === "done" && state.confirmImport === im.id)
        act = ' <span>Stop? Varerne beholdes.</span> <button type="button" class="link warn" data-iact="stop-yes" data-id="' + id + '">Ja, stop</button>' +
          '<button type="button" class="link" data-iact="stop-no" data-id="' + id + '">Behold</button>';
      else if (im.status === "done") act = ' <button type="button" class="link" data-iact="stop" data-id="' + id + '">Stop</button>';
      else act = ' <button type="button" class="link" data-iact="hide" data-id="' + id + '">Skjul</button>';
    }
    return '<p class="impl' + (im.status === "error" || im.fails > 0 ? " bad" : "") + '" data-istatus="' + esc(im.status) + '"><span>' + esc(txt) + '</span>' + act + '</p>';
  }
  function renderImports() {
    var box = $("importBox"), sel = curSel();
    // an import shows with its list (or with "Alle"); one without a known list shows under "Alle" and "Uden liste"
    var list = state.imports.filter(function (im) { return inSel({ listId: im.listId }, sel); });
    var show = !!(user && state.importsOk && list.length);
    box.hidden = !show;
    if (!show) { box.innerHTML = ""; return; }
    list.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
    box.innerHTML = list.map(importLine).join("") + (state.importMsg ? '<p class="msg">' + esc(state.importMsg) + '</p>' : "");
  }
  function fetchImports() {
    if (!sb || !user) return;
    var uid = user.id;
    sb.from("imports").select("*").order("created_at", { ascending: true }).then(function (r) {
      if (!user || user.id !== uid) return;
      if (r.error) return;                                   // no table yet, or a hiccup: keep what is shown, say nothing
      state.imports = (r.data || []).map(function (x) {
        return { id: x.id, status: x.status === "done" || x.status === "error" ? x.status : "pending", note: x.note || "", added: num(x.added), found: num(x.found), createdAt: x.created_at || "",
          title: x.title ? String(x.title) : "", syncedAt: x.synced_at || null, fails: num(x.sync_fails) || 0, listId: x.list_id || null };
      });
      state.importsOk = true; render();
    }, function () {});
  }
  $("importBox").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-iact]"); if (!b || !sb) return;
    var act = b.dataset.iact, id = b.dataset.id; state.importMsg = "";
    if (act === "stop") { state.confirmImport = id; renderImports(); return; }
    if (act === "stop-no") { state.confirmImport = null; renderImports(); return; }
    if (act !== "hide" && act !== "stop-yes") return;
    b.disabled = true;
    sb.from("imports").delete().eq("id", id).then(function (r) {
      if (r && r.error) { b.disabled = false; state.importMsg = isDenied(r.error) ? "Du har ikke adgang til at gemme." : "Kunne ikke gemme lige nu. Prøv igen om lidt."; onWriteError(r.error); renderImports(); return; }
      state.confirmImport = null; state.imports = state.imports.filter(function (x) { return x.id !== id; }); render(); fetchImports();
    }, function () { b.disabled = false; state.importMsg = "Kunne ikke gemme lige nu. Prøv igen om lidt."; renderImports(); });
  });

  var renderPending = false;
  function render() {
    renderStatus();
    if (!user || !state.loaded) return;
    var list = $("list"), a = document.activeElement;
    if (a && list.contains(a) && a.tagName === "INPUT" &&
      (a.type === "checkbox" || a.type === "radio" ? a.checked !== a.defaultChecked : a.value !== a.defaultValue)) { renderPending = true; return; }
    renderPending = false;
    renderLists(); renderImports();
    var sel = curSel();
    var ps = state.products.filter(function (p) { return inSel(p, sel); });
    if (!state.products.length) {
      list.innerHTML = '<div class="empty"><b>Ingen produkter endnu</b>' +
        (state.canWrite ? "Skriv et navn eller indsæt et link ovenfor."
          : "Når der er tilføjet produkter, ser du dem her.") + '</div>';
      return;
    }
    if (!ps.length) {
      list.innerHTML = '<div class="empty"><b>' + (sel === "none" ? "Alle produkter er på en liste" : "Ingen produkter på denne liste endnu") + '</b>' +
        "" + '</div>';
      return;
    }
    var by = groupProducts(ps, sel);
    var rowHtml = function (p) {
      var open = isOpen(p);
      return '<article class="item' + (isHit(p) ? " hit" : "") + (open ? " open" : "") + (p.boughtAt ? " bought" : "") + '" data-status="' + esc(p.status) + '">' +
        '<button type="button" class="head" data-act="toggle" data-id="' + esc(p._id) + '" aria-expanded="' + open + '">' + headHtml(p) + '</button>' +
        (open ? '<div class="body">' + bodyHtml(p) + '</div>' : '') + '</article>';
    };
    var html = "";
    if (by.hit.length) html += '<div class="grp grp-hit"><h3 class="grp-h">Tilbud nu</h3>' + by.hit.map(rowHtml).join("") + '</div>';
    html += by.choose.concat(by.wait, by.rest).map(rowHtml).join("");
    // products that cannot be fetched: quiet, collapsed, after the live ones
    if (by.error.length) {
      var n = by.error.length;
      html += '<details class="errs" id="errGroup"' + (state.errOpen ? " open" : "") + '><summary>' + n + (n === 1 ? " vare kan ikke hentes" : " varer kan ikke hentes") + '</summary>' + by.error.map(rowHtml).join("") + '</details>';
    }
    html += by.bought.map(rowHtml).join("");
    list.innerHTML = html;
    ps.forEach(function (p) { if (isOpen(p) && p.status === "tracking") drawChart(p); });
  }

  // ---- order and groups ----
  // Groups: hit (a good deal now), choose (needs the person), wait (fetching), rest (the others, closest to the goal first), error
  // (cannot be fetched, collapsed), bought (dimmed, last). The order is kept between renders: a full sort only on load and when another
  // list is selected. Otherwise a row keeps its place, and only a row that is new or has changed group is put into its group (by
  // closeness), so nothing moves under someone who is reading, and an open row stays where it is.
  var GROUPS = ["hit", "choose", "wait", "rest", "error", "bought"];
  function groupOf(p) {
    if (p.boughtAt) return "bought";
    if (p.status === "error") return "error";
    if (isHit(p)) return "hit";
    if (p.status === "choose" && !awaitingFetch(p)) return "choose";
    if (p.status === "pending" || awaitingFetch(p)) return "wait";
    return "rest";
  }
  // How far from the goal, as a share of the price: below 0 is past the goal. A price or % goal: price against the goal price. Goal
  // "auto": how far the price is from 10 % under the normal price. null = unknown (sorted last). A sold-out best price counts as far away.
  function gapOf(p) {
    var b = bestOf(p), g, t;
    if (p.status !== "tracking" || !b) return null;
    if (p.targetType === "auto") {
      if (!(typeof p.normalPrice === "number" && p.normalPrice > 0)) return null;
      g = 0.1 - (1 - b.price / p.normalPrice);
    } else {
      t = targetKr(p);
      if (t == null || !(t > 0)) return null;
      g = (b.price - t) / t;
    }
    return b.inStock === false ? g + 10 : g;
  }
  function byGap(a, b) {
    var x = gapOf(a), y = gapOf(b);
    if ((x === null) !== (y === null)) return x === null ? 1 : -1;
    if (x !== null && x !== y) return x - y;
    return String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0);
  }
  function groupProducts(ps, sel) {
    var prev = state.ord, force = !prev || prev.sel !== sel, grp = {}, out = {}, idx = {}, n = 0;
    GROUPS.forEach(function (g) { out[g] = []; });
    ps.forEach(function (p) { grp[p._id] = groupOf(p); out[grp[p._id]].push(p); });
    GROUPS.forEach(function (g) {
      var list = out[g], res;
      if (force) res = list.slice().sort(byGap);
      else {
        res = list.filter(function (p) { return prev.grp[p._id] === g; }).sort(function (a, b) { return prev.idx[a._id] - prev.idx[b._id]; });
        list.filter(function (p) { return prev.grp[p._id] !== g; }).sort(byGap).forEach(function (p) {
          var i = 0; while (i < res.length && byGap(res[i], p) <= 0) i++;
          res.splice(i, 0, p);
        });
      }
      out[g] = res;
      res.forEach(function (p) { idx[p._id] = n++; });
    });
    state.ord = { sel: sel, grp: grp, idx: idx };
    return out;
  }

  // ---- chart ----
  function niceStep(span, n) {
    var raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  }
  function drawChart(p) {
    var host = document.querySelector('[data-chart="' + CSS.escape(p._id) + '"]');
    if (!host) return;
    var h = histOf(p), now = Date.now(), range = state.range[p._id] || 365;
    if (!h.length) { host.innerHTML = ""; return; }
    var t0 = Math.max(now - range * DAY, Math.min(h[0].t, now - 13 * DAY)), t1 = Math.max(now, h[h.length - 1].t);
    var pts = [], carry = null;
    h.forEach(function (x) { if (x.t < t0) carry = x; else pts.push(x); });
    if (carry) pts.unshift({ t: t0, p: carry.p, s: carry.s, src: carry.src });
    if (!pts.length) { host.innerHTML = ""; return; }
    var tgt = targetKr(p), norm = typeof p.normalPrice === "number" ? p.normalPrice : null;
    var vals = pts.map(function (x) { return x.p; });
    var hi0 = Math.max.apply(null, vals), lo0 = Math.min.apply(null, vals);
    if (tgt != null && tgt >= lo0 * 0.5) vals.push(tgt);
    if (norm != null && norm <= hi0 * 1.6) vals.push(norm);
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var pad = Math.max((hi - lo) * 0.15, hi * 0.04, 1);
    var step = niceStep((hi - lo) + 2 * pad, 4);
    var y0 = Math.max(0, Math.floor((lo - pad) / step) * step), y1 = Math.ceil((hi + pad) / step) * step;
    var W = Math.max(280, host.clientWidth), H = 220, ml = 46, mr = 10, mt = 18, mb = 26;
    var X = function (t) { return ml + (t - t0) / (t1 - t0 || 1) * (W - ml - mr); };
    var Y = function (v) { return mt + (1 - (v - y0) / (y1 - y0 || 1)) * (H - mt - mb); };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Laveste pris over tid for ' + esc(p.name) + '">';
    for (var v = y0; v <= y1 + 1e-6; v += step) {
      s += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + Y(v) + '" y2="' + Y(v) + '" stroke="var(--grid)" stroke-width="1"/>' +
        '<text x="' + (ml - 10) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + nf.format(v) + '</text>';
    }
    var nt = W < 420 ? 3 : 5;
    for (var i = 0; i < nt; i++) {
      var tt = t0 + (t1 - t0) * i / (nt - 1);
      s += '<text x="' + X(tt) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? "start" : i === nt - 1 ? "end" : "middle") + '">' + esc(dFmt.format(new Date(tt))) + '</text>';
    }
    var d = "M" + X(pts[0].t) + "," + Y(pts[0].p);
    for (var k = 1; k < pts.length; k++) d += "H" + X(pts[k].t) + "V" + Y(pts[k].p);
    d += "H" + X(t1);
    var lastP = pts[pts.length - 1];
    s += '<path d="' + d + 'V' + Y(y0) + 'H' + X(pts[0].t) + 'Z" fill="var(--series-fill)" stroke="none"/>';
    if (norm != null && norm <= y1 && norm >= y0) {
      s += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + Y(norm) + '" y2="' + Y(norm) + '" stroke="var(--muted)" stroke-width="1" stroke-dasharray="1 4" stroke-linecap="round"/>' +
        '<text class="lbl" x="' + (ml + 6) + '" y="' + (Y(norm) - 6) + '">Normalpris</text>';
    }
    if (tgt != null && tgt >= y0 && tgt <= y1) {
      s += '<line x1="' + ml + '" x2="' + (W - mr) + '" y1="' + Y(tgt) + '" y2="' + Y(tgt) + '" stroke="var(--good)" stroke-width="1.5" stroke-dasharray="5 4"/>' +
        '<text class="lbl" x="' + (ml + 6) + '" y="' + (Y(tgt) + (lastP.p <= tgt ? -7 : 15)) + '">Dit mål ' + esc(kr(tgt)) + '</text>';
    }
    s += '<path d="' + d + '" fill="none" stroke="var(--series)" stroke-width="2" stroke-linejoin="round"/>' +
      '<circle cx="' + X(t1) + '" cy="' + Y(lastP.p) + '" r="4.5" fill="var(--series)" stroke="var(--surface)" stroke-width="2"/>' +
      '<text class="now" x="' + (X(t1) - 9) + '" y="' + (Y(lastP.p) + (tgt != null && lastP.p <= tgt ? 19 : -10)) + '" text-anchor="end">' + esc(kr(lastP.p)) + '</text>' +
      '<g class="hov" visibility="hidden"><line y1="' + mt + '" y2="' + (H - mb) + '" stroke="var(--muted)" stroke-width="1"/>' +
      '<circle r="4.5" fill="var(--series)" stroke="var(--surface)" stroke-width="2"/></g>' +
      '<rect x="' + ml + '" y="' + mt + '" width="' + (W - ml - mr) + '" height="' + (H - mt - mb) + '" fill="transparent"/></svg><div class="tip" hidden></div>';
    host.innerHTML = s;
    var svg = host.querySelector("svg"), hov = host.querySelector(".hov"), tip = host.querySelector(".tip");
    function move(ev) {
      var r = svg.getBoundingClientRect(), cx = (ev.touches ? ev.touches[0].clientX : ev.clientX);
      var x = (cx - r.left) / r.width * W, t = t0 + (x - ml) / (W - ml - mr) * (t1 - t0);
      var cur = pts[0];
      pts.forEach(function (q) { if (q.t <= t) cur = q; });
      var px = Math.min(Math.max(x, X(pts[0].t)), X(t1));
      hov.setAttribute("visibility", "visible");
      hov.querySelector("line").setAttribute("x1", px); hov.querySelector("line").setAttribute("x2", px);
      hov.querySelector("circle").setAttribute("cx", px); hov.querySelector("circle").setAttribute("cy", Y(cur.p));
      var when = new Date(Math.min(Math.max(t, pts[0].t), now));
      tip.innerHTML = '<b>' + esc(kr(cur.p)) + '</b>' + (cur.s ? ' · ' + esc(cur.s) : '') + '<br>' + esc(dFmt.format(when)) + ' ' + when.getFullYear() +
        (cur.src === "backfill" ? ' · ældre kilde' : '');
      tip.hidden = false;
      var half = tip.offsetWidth / 2, left = px / W * r.width;
      tip.style.left = Math.min(Math.max(left, half), r.width - half) + "px";
    }
    function out() { hov.setAttribute("visibility", "hidden"); tip.hidden = true; }
    svg.addEventListener("mousemove", move); svg.addEventListener("mouseleave", out);
    svg.addEventListener("touchstart", move, { passive: true }); svg.addEventListener("touchmove", move, { passive: true });
    svg.addEventListener("touchend", out);
  }
  var rz; window.addEventListener("resize", function () { clearTimeout(rz); rz = setTimeout(function () {
    state.products.forEach(function (p) { if (isOpen(p) && p.status === "tracking") drawChart(p); }); }, 150); });

  // ---- data ----
  function isDenied(e) { return !!e && (e.code === "42501" || /row-level security|permission denied|not allowed/i.test(String(e.message || ""))); }
  function applyAccess() {
    $("readonly").hidden = state.canWrite; showMailAsk();
    $("addForm").hidden = !state.canWrite; $("fHint").hidden = !state.canWrite || $("fTypeAuto").checked;
    render();
  }
  function onWriteError(e) { if (isDenied(e)) { state.canWrite = false; applyAccess(); } }
  function fetchProducts() {
    if (!sb || !user || noacc.on) return;
    if (fetching) { again = true; return; }
    fetching = true; lastFetch = Date.now();
    var uid = user.id;
    sb.from("products").select("*").order("created_at", { ascending: false }).then(function (r) {
      fetching = false;
      if (!user || user.id !== uid) return;
      if (r.error) {
        if (!state.loaded) $("status").textContent = "Listen kan ikke hentes lige nu. Den prøves igen om lidt.";
      } else {
        state.products = (r.data || []).map(norm);
        state.loaded = true;
        render(); checkSound(); fetchLists(); fetchImports();
      }
      if (again) { again = false; fetchProducts(); }
    }, function () {
      fetching = false;
      if (!state.loaded) $("status").textContent = "Listen kan ikke hentes lige nu. Den prøves igen om lidt.";
    });
  }
  // The lists table only exists once schema.sql has been run again. Until then the list row stays hidden and nothing breaks.
  function fetchLists() {
    if (!sb || !user) return;
    var uid = user.id;
    sb.from("lists").select("*").order("name", { ascending: true }).then(function (r) {
      if (!user || user.id !== uid) return;
      if (r.error) { if (!state.listsOk) { state.lists = []; render(); } return; }
      state.lists = (r.data || []).map(function (l) { return { id: l.id, name: String(l.name || ""), own: !l.user_id || l.user_id === uid }; });
      sortLists(); state.listsOk = true; render(); fetchMembers();
    }, function () {});
  }
  // Who is in the shared lists. The owner sees the memberships of their lists, a member sees the co-members of the list they are in.
  // list_members does not exist before schema.sql has been run again: then nothing is shared and nothing is shown.
  function fetchMembers() {
    if (!sb || !user) return;
    var uid = user.id;
    sb.from("list_members").select("list_id,user_id").then(function (r) {
      if (!user || user.id !== uid || r.error) return;
      var cnt = {}; (r.data || []).forEach(function (m) { cnt[m.list_id] = (cnt[m.list_id] || 0) + 1; });
      state.memCount = cnt;
      var shared = state.lists.filter(function (l) { return listShared(l.id); });
      Object.keys(state.people).forEach(function (k) { if (!shared.some(function (l) { return l.id === k; })) delete state.people[k]; });
      render();
      shared.forEach(function (l) {
        sb.rpc("list_members_named", { p_list: l.id }).then(function (x) {
          if (!user || user.id !== uid || !x || x.error || !Array.isArray(x.data)) return;
          state.people[l.id] = x.data.map(function (m) { return { id: m.user_id, name: String(m.name || ""), role: m.role, email: m.email ? String(m.email) : "" }; });
          render();
        }, function () {});
      });
    }, function () {});
  }
  function refreshSoon() { if (Date.now() - lastFetch > 2500) fetchProducts(); else { again = true; setTimeout(function () { if (again && !fetching) { again = false; fetchProducts(); } }, 2600); } }
  function setPrefs(d) {
    // asked: has the person answered "Vil du have mail ved nye tilbud?" (profiles.mail_asked_at). Without the column (an older database) nobody is asked.
    var asked = "mail_asked_at" in d ? !!d.mail_asked_at : state.prefs.asked;
    state.prefs = { always: shopList(d.shops_always), exclude: shopList(d.shops_exclude), only: !!d.shops_only, notify: d.notify_email !== false, digest: d.mail_digest === true, asked: asked };
    $("shAlways").value = state.prefs.always.join(", "); $("shExclude").value = state.prefs.exclude.join(", ");
    $("shOnly").checked = state.prefs.only; $("shNotify").checked = state.prefs.notify;
    $("shDigest").checked = state.prefs.digest; $("shDigest").disabled = !state.prefs.notify;
    showMailAsk();
    render();
  }
  // The one small question to a person who has never chosen: shown once, only with write access, gone after either answer.
  function showMailAsk() { $("mailAsk").hidden = !(user && state.canWrite && !noacc.on && !state.prefs.asked && !state.prefs.notify); }
  function answerMail(yes) {
    if (!sb || !user) return;
    var btns = [$("mailYes"), $("mailNo")]; btns.forEach(function (b) { b.disabled = true; });
    sb.from("profiles").upsert({ user_id: user.id, notify_email: yes, mail_asked_at: new Date().toISOString() }).then(function (r) {
      btns.forEach(function (b) { b.disabled = false; });
      if (r && r.error) { onWriteError(r.error); return; }
      state.prefs.asked = true; state.prefs.notify = yes; $("shNotify").checked = yes; $("shDigest").disabled = !yes; showMailAsk();
    }, function () { btns.forEach(function (b) { b.disabled = false; }); });
  }
  $("mailYes").addEventListener("click", function () { answerMail(true); });
  $("mailNo").addEventListener("click", function () { answerMail(false); });
  function ensureProfile(created) {
    var uid = user.id;
    sb.from("profiles").select("*").eq("user_id", uid).maybeSingle().then(function (r) {
      if (!user || user.id !== uid) return;
      if (r.data) {
        setPrefs(r.data);
        if (r.data.sound === "off" || r.data.sound === "on") {
          var has = null; try { has = localStorage.getItem("pv-muted"); } catch (e) {}
          if (has == null) { muted = r.data.sound === "off"; syncSound(); }
        }
        return;
      }
      if (created) return;
      // a new person: mail is off until they say yes (the database default says the same)
      return sb.from("profiles").upsert({ user_id: uid, notify_email: false }).then(function (u) { if (u && u.error) onWriteError(u.error); else ensureProfile(true); });
    }, function () {});
  }
  function startSession() {
    state.prefs.asked = true; state.prefs.notify = false; $("mailAsk").hidden = true;
    state.loaded = false; state.products = []; state.canWrite = true; state.ord = null; state.errOpen = false;
    state.lists = []; state.listsOk = false; state.listForm = null; state.confirmList = null; state.share = null; state.confirmMember = null; state.confirmLeave = null; state.memCount = {}; state.people = {}; state.imports = []; state.importsOk = false; state.importMsg = ""; state.confirmImport = null;
    $("status").textContent = "Henter listen …";
    loadSounds();
    ensureProfile(); fetchProducts(); fetchAccess();
    try {
      channel = sb.channel("pv-products").on("postgres_changes", { event: "*", schema: "public", table: "products" }, function () { refreshSoon(); }).subscribe();
    } catch (e) { channel = null; }
    pollTimer = setInterval(function () { if (document.visibilityState === "visible") { fetchProducts(); fetchAccess(); } }, 60000);
  }
  function stopSession() {
    clearInterval(pollTimer); pollTimer = null;
    try { if (channel) sb.removeChannel(channel); } catch (e) {}
    channel = null; state.products = []; state.loaded = false; state.ord = null; state.lists = []; state.listsOk = false; state.listForm = null; state.confirmList = null; state.share = null; state.confirmMember = null; state.confirmLeave = null; state.memCount = {}; state.people = {}; state.imports = []; state.importsOk = false; state.importMsg = ""; state.confirmImport = null; renderImports();
    access.admin = false; access.requests = []; access.allowed = []; access.confirm = null; access.seq++; accMsg(""); renderAccess();
  }
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && user) { if (noacc.on) recheckAccess(); else fetchProducts(); } });
  window.addEventListener("focus", function () { if (user && noacc.on) recheckAccess(); else if (user && Date.now() - lastFetch > 3000) fetchProducts(); });

  // ---- list interactions ----
  function prod(id) { return state.products.filter(function (x) { return x._id === id; })[0]; }
  // focus follows the goal editor: into it when it opens, back on "Ændr" when it closes
  function focusGoal(id, inEditor) {
    var q = inEditor ? "#gp-" + CSS.escape(id) + " select" : '[data-act="goal-open"][data-id="' + CSS.escape(id) + '"]', el = document.querySelector(q);
    if (el) try { el.focus(); } catch (e) {}
  }
  $("list").addEventListener("keydown", function (ev) {
    if (ev.key !== "Escape") return;
    var gp = ev.target.closest && ev.target.closest(".goalpanel"); if (!gp) return;
    var f = gp.querySelector("[data-edit]"); if (!f) return;
    ev.preventDefault(); state.goalOpen[f.dataset.edit] = false; render(); focusGoal(f.dataset.edit, false);
  });
  $("list").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-act]"); if (!b) return;
    var act = b.dataset.act, id = b.dataset.id, p = prod(id);
    if (act === "toggle") { state.open[id] = !(p ? isOpen(p) : state.open[id]); state.confirmDel = null; render(); }
    else if (act === "manage" || act === "allshops") {
      var xo = b.getAttribute("aria-expanded") !== "true", panel = b.nextElementSibling;
      b.setAttribute("aria-expanded", String(xo)); if (panel) panel.hidden = !xo;
      (act === "manage" ? state.manage : state.allShops)[id] = xo;
    }
    else if (act === "goal-open" || act === "goal-close") {
      state.goalOpen[id] = act === "goal-open" && !state.goalOpen[id]; render(); focusGoal(id, state.goalOpen[id]);
    }
    else if (act === "range") { state.range[id] = +b.dataset.r; render(); }
    else if (act === "goal" && sb && p) {
      var gv = Number(b.dataset.v);
      if (!(gv > 0) || (p.targetType === "price" && p.targetValue === gv)) return;
      b.disabled = true;
      sb.from("products").update({ target_type: "price", target_value: gv }).eq("id", id).then(function (r) {
        if (r && r.error) { b.disabled = false; onWriteError(r.error); return; }
        p.targetType = "price"; p.targetValue = gv; render(); fetchProducts();
      }, function () { b.disabled = false; });
    }
    else if (act === "buy" && sb && p && !p.boughtAt) {
      var paid = inStockLow(p);                                   // the lowest price in stock now, if there is one; the price can be edited afterwards
      b.disabled = true;
      sb.from("products").update({ bought_at: new Date().toISOString(), bought_price: paid }).eq("id", id).then(function (r) {
        if (r && r.error) { b.disabled = false; state.rowMsg["b-" + id] = ""; onWriteError(r.error); if (schemaOld(r.error)) { state.note[id] = SCHEMA_OLD; render(); } return; }
        p.boughtAt = new Date().toISOString(); p.boughtPrice = paid; render(); fetchProducts();
      }, function () { b.disabled = false; });
    }
    else if (act === "unbuy" && sb && p) {
      b.disabled = true;
      sb.from("products").update({ bought_at: null, bought_price: null }).eq("id", id).then(function (r) {
        if (r && r.error) { b.disabled = false; onWriteError(r.error); return; }
        p.boughtAt = null; p.boughtPrice = null; render(); fetchProducts();
      }, function () { b.disabled = false; });
    }
    else if (act === "alt-find" && sb && p) {
      b.disabled = true; setRowMsg("alt-" + id, "");
      sb.from("products").update({ alt_requested_at: new Date().toISOString() }).eq("id", id).then(function (r) {
        if (r && r.error) { b.disabled = false; setRowMsg("alt-" + id, altError(r.error)); onWriteError(r.error); return; }
        p.altReq = new Date().toISOString(); p.alts = null; p.altNote = ""; state.rowMsg["alt-" + id] = ""; render(); fetchProducts();
      }, function () { b.disabled = false; setRowMsg("alt-" + id, altError(null)); });
    }
    else if (act === "cmp-find" && sb && p && cmpMayAsk(p)) {
      b.disabled = true; setRowMsg("cmp-" + id, "");
      sb.from("products").update({ compare_state: "wanted" }).eq("id", id).then(function (r) {
        if (r && r.error) { b.disabled = false; setRowMsg("cmp-" + id, "Kunne ikke gemme lige nu. Prøv igen om lidt."); onWriteError(r.error); return; }
        p.cmp = "wanted"; p.cmpAt = new Date().toISOString(); state.rowMsg["cmp-" + id] = ""; render(); fetchProducts();
      }, function () { b.disabled = false; setRowMsg("cmp-" + id, "Kunne ikke gemme lige nu. Prøv igen om lidt."); });
    }
    else if (act === "cmp-undo" && sb && p && p.cmp === "done" && mayEdit(p) && cmpShopLink(p)) {
      // back to the original shop link, exactly as it is stored (the database tells a way back from a new link by comparing the two)
      var back = cmpShopLink(p);
      b.disabled = true; setRowMsg("cmp-" + id, "");
      sb.from("products").update({ source_url: back }).eq("id", id).then(function (r) {
        if (r && r.error) { b.disabled = false; setRowMsg("cmp-" + id, "Kunne ikke gemme lige nu. Prøv igen om lidt."); onWriteError(r.error); return; }
        // the database starts the product over on a new link and will not look for other shops again
        p.url = back; p.status = "pending"; p.checkNote = ""; p.cmp = "none"; p.cmpAt = new Date().toISOString(); p.shopUrl = null; state.rowMsg["cmp-" + id] = "";
        render(); fetchProducts();
      }, function () { b.disabled = false; setRowMsg("cmp-" + id, "Kunne ikke gemme lige nu. Prøv igen om lidt."); });
    }
    else if (act === "x-rm" && sb && p && mayEdit(p) && p.extraOk) {
      // the same array minus this one entry (the database accepts nothing else from the browser); the last one is removed with null
      var xi = +b.dataset.i, raw = p.extraRaw.slice();
      if (!(xi >= 0 && xi < raw.length)) return;
      raw.splice(xi, 1);
      b.disabled = true; setRowMsg("x-" + id, "");
      sb.from("products").update({ extra_urls: raw.length ? raw : null }).eq("id", id).then(function (r) {
        if (r && r.error) { b.disabled = false; setRowMsg("x-" + id, "Kunne ikke gemme lige nu. Prøv igen om lidt."); onWriteError(r.error); return; }
        p.extraRaw = raw; state.rowMsg["x-" + id] = "";
        if (!raw.length && p.cmp === "done") { p.cmp = "none"; p.cmpAt = new Date().toISOString(); }
        render(); fetchProducts();
      }, function () { b.disabled = false; setRowMsg("x-" + id, "Kunne ikke gemme lige nu. Prøv igen om lidt."); });
    }
    else if (act === "alt-follow" && sb && p) {
      var alt = altShown(p)[+b.dataset.i], au = alt && typeof alt.url === "string" ? parseLink(alt.url) : null;
      if (!au || altTracked(au)) return;
      var arow = { name: PLACEHOLDER, source_url: au, target_type: "auto", target_value: null, active: true };
      if (listKnown(p.listId)) arow.list_id = p.listId;       // the same list as this product
      b.disabled = true; setRowMsg("alt-" + id, "");
      sb.from("products").insert(arow).then(function (r) {
        if (r && r.error) {
          var m = String(r.error.message || "");
          setRowMsg("alt-" + id, r.error.code === "23514" && /^Du kan højst/.test(m) ? m : "Kunne ikke følge den lige nu. Prøv igen om lidt.");
          b.disabled = false; onWriteError(r.error); return;
        }
        b.textContent = "Følges"; fetchProducts();           // the next render finds the link among the products
      }, function () { b.disabled = false; setRowMsg("alt-" + id, "Kunne ikke følge den lige nu. Prøv igen om lidt."); });
    }
    else if (act === "del") { state.confirmDel = id; render(); }
    else if (act === "del-no") { state.confirmDel = null; render(); }
    else if (act === "change") { state.change[id] = true; delete state.pick[id]; delete state.note[id]; render(); }
    else if (act === "change-no") { delete state.change[id]; delete state.pick[id]; render(); }
    else if (act === "del-yes" && sb) {
      b.disabled = true;
      sb.from("products").delete().eq("id", id).then(function (r) {
        if (r && r.error) { b.disabled = false; onWriteError(r.error); return; }
        state.products = state.products.filter(function (x) { return x._id !== id; });
        state.confirmDel = null; render(); fetchProducts();
      }, function () { b.disabled = false; });
    }
  });
  $("list").addEventListener("change", function (ev) {
    var lp = ev.target.closest("[data-listpick]");
    if (lp) {
      var lid = lp.dataset.listpick, lp0 = prod(lid), to = lp.value || null;
      if (!lp0 || !sb || lp0.listId === to) return;
      lp.disabled = true;
      sb.from("products").update({ list_id: to }).eq("id", lid).then(function (r) {
        if (r && r.error) { onWriteError(r.error); render(); fetchProducts(); return; }
        lp0.listId = to; render(); fetchProducts();
      }, function () { render(); });
      return;
    }
    var sel = ev.target.closest("[data-etype]");
    if (sel) {
      var inp = sel.form.querySelector("input"), auto = sel.value === "auto";
      inp.hidden = auto; inp.required = !auto;
      if (sel.value === "pct") inp.max = "95"; else inp.removeAttribute("max");
      return;
    }
    var cb = ev.target.closest("[data-var]"); if (!cb) return;
    var form = cb.closest("[data-choose]"), id = form.dataset.choose;
    state.pick[id] = Array.prototype.map.call(form.querySelectorAll("[data-var]:checked"), function (x) { return x.dataset.var; });
  });
  function setRowMsg(id, text) {
    state.rowMsg[id] = text;
    var el = document.querySelector('[data-rowmsg="' + CSS.escape(id) + '"]'); if (el) el.textContent = text;
  }
  $("list").addEventListener("submit", function (ev) {
    var chF = ev.target.closest("[data-choose]");
    if (chF) {
      ev.preventDefault();
      var cid = chF.dataset.choose;
      var ids = Array.prototype.map.call(chF.querySelectorAll("[data-var]:checked"), function (x) { return x.dataset.var; });
      if (!ids.length) { setRowMsg(cid, "Vælg mindst én variant."); return; }
      setRowMsg(cid, "Gemmer …");
      sb.from("products").update({ tracked_variants: ids }).eq("id", cid).then(function (r) {
        if (r && r.error) { setRowMsg(cid, isDenied(r.error) ? "Du har ikke adgang til at gemme." : "Kunne ikke gemme lige nu. Prøv igen om lidt."); onWriteError(r.error); return; }
        var p = prod(cid); if (p) p.tracked = ids;
        var wasTracking = p && p.status === "tracking";
        delete state.change[cid]; delete state.pick[cid]; state.rowMsg[cid] = "";
        if (wasTracking) state.note[cid] = "Gemt. Priserne opdateres inden for et kvarter.";
        render(); fetchProducts();
      }, function () { setRowMsg(cid, "Kunne ikke gemme lige nu. Prøv igen om lidt."); });
      return;
    }
    var boF = ev.target.closest("[data-bought]");
    if (boF) {
      ev.preventDefault();
      var bid = boF.dataset.bought, bp = prod(bid), raw = boF.querySelector("input").value.trim().replace(",", "."), bv = raw === "" ? null : Number(raw);
      if (!bp) return;
      if (bv !== null && !(bv > 0 && bv <= 10000000)) { setRowMsg("b-" + bid, "Skriv en pris."); return; }
      setRowMsg("b-" + bid, "");
      sb.from("products").update({ bought_price: bv }).eq("id", bid).then(function (r) {
        if (r && r.error) { setRowMsg("b-" + bid, "Kunne ikke gemme."); onWriteError(r.error); return; }
        bp.boughtPrice = bv; document.activeElement && document.activeElement.blur && document.activeElement.blur(); render(); fetchProducts();
      }, function () { setRowMsg("b-" + bid, "Kunne ikke gemme."); });
      return;
    }
    var rqF = ev.target.closest("[data-req]");
    if (rqF) {
      ev.preventDefault();
      var rid = rqF.dataset.req, rp = prod(rid);
      if (!rp || !mayEdit(rp)) return;
      var rv = cleanReq(rqF.querySelector("input").value);
      if (rv === rp.req) { setRowMsg("rq-" + rid, ""); return; }
      setRowMsg("rq-" + rid, "Gemmer …");
      sb.from("products").update({ requirements: rv || null }).eq("id", rid).then(function (r) {
        if (r && r.error) { setRowMsg("rq-" + rid, "Kunne ikke gemme lige nu. Prøv igen om lidt."); onWriteError(r.error); return; }
        rp.req = rv; rp.reqState = null; state.rowMsg["rq-" + rid] = "";
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        render(); fetchProducts();
      }, function () { setRowMsg("rq-" + rid, "Kunne ikke gemme lige nu. Prøv igen om lidt."); });
      return;
    }
    var shF = ev.target.closest("[data-shops]");
    if (shF) {
      ev.preventDefault();
      var sid = shF.dataset.shops, sAlways = shopList($("sa-" + sid).value), sOnly = $("so-" + sid).checked;
      if (sOnly && !sAlways.length && !state.prefs.always.length) return;
      var sEx = shopList($("se-" + sid).value);
      document.activeElement && document.activeElement.blur();
      sb.from("products").update({ shops_always: sAlways, shops_exclude: sEx, shops_only: sOnly }).eq("id", sid).then(function (r) {
        if (r && r.error) { onWriteError(r.error); return; }
        var p = prod(sid); if (p) { p.shopsAlways = sAlways; p.shopsExclude = sEx; p.shopsOnly = sOnly; }
        render(); fetchProducts();
      }, function () {});
      return;
    }
    var fxF = ev.target.closest("[data-fixurl]");
    if (fxF) {
      ev.preventDefault();
      var fid = fxF.dataset.fixurl, nu = parseLink(fxF.querySelector("input").value);
      if (!nu) { setRowMsg(fid, LINK_HELP); return; }
      setRowMsg(fid, "Gemmer …");
      sb.from("products").update({ source_url: nu }).eq("id", fid).then(function (r) {
        if (r && r.error) { setRowMsg(fid, "Kunne ikke gemme lige nu. Prøv igen om lidt."); onWriteError(r.error); return; }
        // the database starts the product over on a new link (status 'pending'); show that straight away
        var p = prod(fid); if (p) { p.url = nu; p.status = "pending"; p.checkNote = ""; }
        state.rowMsg[fid] = "";
        if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        render(); fetchProducts();
      }, function () { setRowMsg(fid, "Kunne ikke gemme lige nu. Prøv igen om lidt."); });
      return;
    }
    var f = ev.target.closest("[data-edit]"); if (!f) return;
    ev.preventDefault();
    var ty = f.querySelector("select").value, v = ty === "auto" ? null : Number(f.querySelector("input").value), id = f.dataset.edit, p = prod(id), patch;
    if (!p || (ty !== "auto" && (!(v > 0) || (ty === "pct" && v > 95)))) return;
    f.querySelector("input").blur();
    state.goalOpen[id] = false;
    if (ty === p.targetType && v === p.targetValue) { render(); focusGoal(id, false); return; }
    // the goal type is only written when it changes
    patch = ty === p.targetType ? { target_value: v } : { target_type: ty, target_value: v };
    sb.from("products").update(patch).eq("id", id).then(function (r) {
      if (r && r.error) { onWriteError(r.error); return; }
      p.targetType = ty; p.targetValue = v; render(); focusGoal(id, false); fetchProducts();
    }, function () {});
  });
  $("list").addEventListener("focusout", function () { setTimeout(function () { if (renderPending) render(); }, 0); });
  // the open/closed state of the sections inside the list survives the next render (toggle does not bubble: captured)
  $("list").addEventListener("toggle", function (ev) {
    var d = ev.target; if (!d || !d.matches) return;
    if (d.id === "errGroup") state.errOpen = d.open;
    else if (d.dataset.pshops) state.pshops[d.dataset.pshops] = d.open;
  }, true);
  // a picture that does not load (error does not bubble: captured) falls back to the letter and is not tried again
  $("list").addEventListener("error", function (ev) {
    var im = ev.target; if (!im || im.tagName !== "IMG") return;
    var box = im.parentNode, src = im.getAttribute("src");
    if (src) badImg[src] = true;
    if (box && box.classList.contains("thumb")) { box.classList.add("ph"); box.textContent = box.getAttribute("data-ch") || "?"; }
  }, true);

  // ---- access section for the owner (admin): requests waiting, and who has access ----
  // admin_list_requests only succeeds for an admin. For everybody else it fails and nothing is shown, and nothing is said.
  function accMsg(t) { access.msg = t || ""; var el = $("accMsg"); el.textContent = access.msg; el.hidden = !access.msg; }
  function renderAccess() {
    var box = $("accessBox"), badge = $("reqBadge"), n = access.requests.length;
    box.hidden = !(user && access.admin);
    $("accessBtn").hidden = box.hidden;
    badge.hidden = box.hidden || !n;
    badge.textContent = n + " venter på adgang";
    if (box.hidden) return;
    var conf = access.confirm;
    $("reqList").innerHTML = n ? access.requests.map(function (r) {
      var e = esc(r.email), act;
      if (conf && conf.kind === "reject" && conf.email === r.email)
        act = '<span>Afvis ' + e + '?</span><button type="button" class="link warn" data-aact="reject-yes" data-email="' + e + '">Ja, afvis</button>' +
          '<button type="button" class="link" data-aact="cancel">Behold</button>';
      else
        act = '<button type="button" class="link" data-aact="approve" data-email="' + e + '">Godkend</button>' +
          '<button type="button" class="link warn" data-aact="reject" data-email="' + e + '">Afvis</button>';
      var when = Date.parse(r.created_at);
      return '<div class="req"><div><b>' + esc(r.name || "Uden navn") + '</b><div class="meta">' + e +
        (isFinite(when) ? " · " + esc(dtFmt.format(new Date(when))) : "") + '</div></div><div class="acts2">' + act + '</div></div>';
    }).join("") : '<p class="meta">Ingen anmodninger.</p>';
    $("allowedSum").textContent = "Hvem har adgang" + (access.allowed.length ? " (" + access.allowed.length + ")" : "");
    $("allowedList").innerHTML = access.allowed.map(function (a) {
      var e = esc(a.email), act = "";
      if (a.is_admin) act = '<span class="meta">Ejer</span>';
      else if (conf && conf.kind === "remove" && conf.email === a.email)
        act = '<span>Fjern adgang for ' + e + '?</span><button type="button" class="link warn" data-aact="remove-yes" data-email="' + e + '">Ja, fjern adgang</button>' +
          '<button type="button" class="link" data-aact="cancel">Behold</button>';
      else act = '<button type="button" class="link warn" data-aact="remove" data-email="' + e + '">Fjern adgang</button>';
      return '<div class="req"><div>' + e + (a.note ? '<div class="meta">' + esc(a.note) + '</div>' : '') + '</div><div class="acts2">' + act + '</div></div>';
    }).join("");
  }
  function fetchAccess() {
    if (!sb || !user) return;
    var uid = user.id, seq = ++access.seq;
    sb.rpc("admin_list_requests").then(function (r) {
      if (!user || user.id !== uid || seq !== access.seq) return;
      if (r.error) {
        if (isDenied(r.error)) { access.admin = false; access.requests = []; access.allowed = []; access.confirm = null; renderAccess(); }
        return;                                                         // any other failure: keep what is shown, say nothing
      }
      access.admin = true;
      access.requests = Array.isArray(r.data) ? r.data : [];
      if (access.confirm && access.confirm.kind === "reject" && !access.requests.some(function (x) { return x.email === access.confirm.email; })) access.confirm = null;
      renderAccess();
      sb.rpc("admin_list_allowed").then(function (a) {
        if (!user || user.id !== uid || seq !== access.seq || a.error) return;
        access.allowed = Array.isArray(a.data) ? a.data : [];
        if (access.confirm && access.confirm.kind === "remove" && !access.allowed.some(function (x) { return x.email === access.confirm.email; })) access.confirm = null;
        renderAccess();
      }, function () {});
    }, function () {});
  }
  function gotoAccess() { try { $("accessBox").scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "center" }); $("accessH").focus({ preventScroll: true }); } catch (e) {} }
  $("reqBadge").addEventListener("click", gotoAccess);
  $("accessBox").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-aact]"); if (!b || !sb || !user) return;
    var act = b.dataset.aact, email = b.dataset.email;
    if (act === "reject") { access.confirm = { kind: "reject", email: email }; renderAccess(); return; }
    if (act === "remove") { access.confirm = { kind: "remove", email: email }; renderAccess(); return; }
    if (act === "cancel") { access.confirm = null; renderAccess(); return; }
    var rpcName, args, okText;
    if (act === "approve") { rpcName = "admin_decide"; args = { p_email: email, p_approve: true }; okText = "Godkendt. " + email + " får en mail."; }
    else if (act === "reject-yes") { rpcName = "admin_decide"; args = { p_email: email, p_approve: false }; okText = "Afvist. " + email + " får ingen besked."; }
    else if (act === "remove-yes") { rpcName = "admin_remove_allowed"; args = { p_email: email }; okText = "Adgang fjernet for " + email + "."; }
    else return;
    b.disabled = true;
    sb.rpc(rpcName, args).then(function (r) {
      b.disabled = false;
      if (r && r.error) { accMsg(isDenied(r.error) ? "Du har ikke ret til det her." : "Kunne ikke gemme lige nu. Prøv igen om lidt."); return; }
      access.confirm = null;
      if (rpcName === "admin_decide") access.requests = access.requests.filter(function (x) { return x.email !== email; });
      else access.allowed = access.allowed.filter(function (x) { return x.email !== email; });
      accMsg(r && r.data === false ? "Den ændring var allerede foretaget." : okText);
      renderAccess(); fetchAccess();
    }, function () { b.disabled = false; accMsg("Kunne ikke gemme lige nu. Prøv igen om lidt."); });
  });

  // ---- add form ----
  function syncType() {
    var pct = $("fTypePct").checked, auto = $("fTypeAuto").checked;
    $("fAmount").hidden = auto; $("addForm").className = "add" + (auto ? " auto" : "");
    syncAdd();
    $("fValLabel").textContent = pct ? "Mindste rabat i procent" : "Højeste pris i kroner";
    $("fVal").placeholder = pct ? "Mindst" : "Højst";
    $("fVal").max = pct ? "95" : "";
    $("fHint").textContent = pct ? "Regnes fra normalprisen." : "Varen skal være på lager.";
    $("fHint").hidden = auto || !state.canWrite;
  }
  // One line: the field and the button. The goal choices ("Godt tilbud" is the default) are always there on a wide screen. On a phone they show
  // while the field has focus or text, or a choice other than the default is made, while a pointer is down inside the form (so a tap on a
  // choice is not lost to the blur), and when "Mål" is tapped. "Detaljer" (and the amount) come with the choices.
  var addPress = false, addReveal = false, wideMq = window.matchMedia ? window.matchMedia("(min-width: 700px)") : null;
  function syncAdd() {
    var f = $("addForm"), on = !!$("fMain").value || !$("fTypeAuto").checked || (f.contains(document.activeElement) && document.activeElement !== $("goalBtn")) || addPress || addReveal;
    var wide = !!(wideMq && wideMq.matches);
    $("addGoal").hidden = !(on || wide);
    $("addMore").hidden = !on;
    $("goalBtn").setAttribute("aria-expanded", String(on));
  }
  $("goalBtn").addEventListener("click", function () { addReveal = $("goalBtn").getAttribute("aria-expanded") !== "true"; syncAdd(); });
  if (wideMq && wideMq.addEventListener) wideMq.addEventListener("change", syncAdd);
  $("addForm").addEventListener("focusin", syncAdd);
  $("addForm").addEventListener("focusout", function () { setTimeout(syncAdd, 0); });
  $("fMain").addEventListener("input", syncAdd);
  $("addForm").addEventListener("pointerdown", function (ev) { if (!ev.target.closest("#goalBtn")) addPress = true; });
  ["pointerup", "pointercancel"].forEach(function (ev) { document.addEventListener(ev, function () { if (addPress) { addPress = false; setTimeout(syncAdd, 0); } }); });
  // A value that looks like an address (scheme, www., or a single word with a path) is a link; anything else is a name.
  function looksLikeLink(t) { return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(javascript|data|vbscript|file|mailto):/i.test(t) || /^www\./i.test(t) || /^\S+\.\S+\/\S*$/.test(t) || /prisjagt\.dk/i.test(t) && !/\s/.test(t); }
  // A shared wish list from Ønskeskyen (onskeskyen.dk, internationally gowish.com): /s/<code> or /wishlists/<id>, optional locale prefix.
  // Returns the clean https address (no query, no fragment), or null. A shop link or a prisjagt.dk link is never one.
  var WISH_HOST = /^(www\.)?(onskeskyen\.dk|gowish\.com)$/;
  function wishHost(t) { try { var x = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : "https://" + t); return WISH_HOST.test(x.hostname.toLowerCase()) ? x : null; } catch (e) { return null; } }
  function parseWishlistLink(raw) {
    var t = String(raw || "").trim();
    if (!t || /\s/.test(t) || !/^(https?:\/\/)?(www\.)?(onskeskyen\.dk|gowish\.com)(\/|$)/i.test(t)) return null;
    var x = wishHost(t);
    if (!x || (x.protocol !== "https:" && x.protocol !== "http:") || x.username || x.password || x.port) return null;
    if (!/^\/s\/[A-Za-z0-9_-]{1,64}\/?$/.test(x.pathname) && !/^\/([A-Za-z]{2}(-[A-Za-z]{2})?\/)?wishlists\/[A-Za-z0-9_-]{1,64}\/?$/.test(x.pathname)) return null;
    return "https://" + x.hostname.toLowerCase() + x.pathname;
  }
  function isWishHost(raw) { return !/\s/.test(raw) && !!wishHost(raw); }
  var WISH_HELP = "Brug det delte link til ønskelisten fra Ønskeskyen, fx https://onskeskyen.dk/s/abc123.";
  // The database is older than the site (schema.sql not run again since the last update): said plainly, with the fix for the owner.
  var SCHEMA_OLD = "Siden er blevet opdateret, men databasen mangler den nyeste opdatering.";
  function schemaOld(e, shopLink) {
    if (!e) return false;
    var c = String(e.code || ""), m = String(e.message || "") + " " + String(e.details || "");
    if (c === "42703" || c === "PGRST204" || c === "42P01" || c === "PGRST205" || c === "42883" || c === "PGRST202") return true;      // missing column, table or function
    if (c === "23514" && /target_type/.test(m)) return true;                                       // the goal 'auto' is not allowed yet
    if (c === "23502" && /target_value/.test(m)) return true;                                      // a goal without a value is not allowed yet
    if (c === "23514" && shopLink && /source_url/.test(m)) return true;                            // only prisjagt.dk links are allowed yet
    return false;
  }
  function saveError(e, shopLink) {
    return schemaOld(e, shopLink) ? SCHEMA_OLD + (access.admin ? " Kør supabase/schema.sql igen i Supabase." : "") : null;
  }
  $("fTypePrice").addEventListener("change", syncType); $("fTypePct").addEventListener("change", syncType); $("fTypeAuto").addEventListener("change", syncType);
  $("addForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var msg = $("fMsg"); msg.hidden = true;
    var fail = function (t) { msg.textContent = t; msg.hidden = false; };
    var raw = $("fMain").value.trim().replace(/\s+/g, " "), v = Number($("fVal").value), pct = $("fTypePct").checked, auto = $("fTypeAuto").checked, url = null, name = null;
    if (!raw) { fail("Skriv navnet på varen, eller indsæt et link til den."); return; }
    var wish = parseWishlistLink(raw);
    if (!wish && isWishHost(raw)) { fail(WISH_HELP); return; }
    if (wish) { addImport(wish, fail); return; }
    if (looksLikeLink(raw)) {
      url = parseLink(raw);
      if (!url) { fail(LINK_HELP + " Åbn varen i din browser, og kopier adressen."); return; }
    } else {
      if (raw.length < 2 || raw.length > 140) { fail("Navnet skal være mellem 2 og 140 tegn."); return; }
      name = raw;
    }
    if (!auto && (!(v > 0) || (pct && v > 95))) { fail(pct ? "Skriv en rabat mellem 1 og 95 %." : "Skriv en pris i hele kroner."); return; }
    if (!sb) return;
    var btn = $("fSubmit"); btn.disabled = true;
    var goal = auto ? { target_type: "auto", target_value: null } : { target_type: pct ? "pct" : "price", target_value: v };
    var row = url ? Object.assign({ name: PLACEHOLDER, source_url: url }, goal, { active: true }) : Object.assign({ name: name }, goal);
    var into = curSel(), rq = cleanReq($("fReq").value);
    if (listKnown(into)) row.list_id = into;   // a selected list: the new product goes straight into it
    if (rq) row.requirements = rq;             // optional details ("Detaljer"); an older database without the column gets the product without them
    var insertRow = function (again) { sb.from("products").insert(row).then(function (r) {
      if (r && r.error && !again && row.requirements && schemaOld(r.error, false)) { delete row.requirements; insertRow(true); return; }
      btn.disabled = false;
      if (r && r.error) {
        if (isDenied(r.error)) { onWriteError(r.error); return; }
        var old = saveError(r.error, !!url && isShopUrl(url));
        if (old) { fail(old); return; }
        fail(r.error.code === "23514" ? (url ? "Databasen afviste linket eller målet. Tjek, at linket starter med https:// og er en produktside." : "Databasen afviste navnet eller målet. Tjek dem, og prøv igen.") : "Kunne ikke gemme lige nu. Prøv igen om lidt.");
        return;
      }
      $("fMain").value = ""; $("fVal").value = ""; $("fReq").value = ""; addReveal = false; syncAdd();
      fetchProducts();
    }, function () { btn.disabled = false; fail("Kunne ikke gemme lige nu. Prøv igen om lidt."); }); };
    insertRow(false);
  });

  function addImport(url, fail) {
    if (!sb) return;
    var pend = state.imports.filter(function (x) { return x.status === "pending"; }).length;
    if (pend >= 5) { fail("Du har allerede 5 ønskelister i gang. Vent, til de er hentet."); return; }
    if (state.imports.length >= 20) { fail("Du følger 20 ønskelister. Stop eller skjul en først."); return; }
    var into = curSel();
    if (listKnown(into) && !listById(into).own) { fail("Kun listens ejer kan tilføje en ønskeliste."); return; }
    var btn = $("fSubmit"); btn.disabled = true;
    var row = { url: url };
    if (listKnown(into)) row.list_id = into;
    sb.from("imports").insert(row).then(function (r) {
      btn.disabled = false;
      if (r && r.error) {
        if (isDenied(r.error)) { onWriteError(r.error); return; }
        var old = saveError(r.error, false);
        if (old) { fail(old); return; }
        fail(r.error.code === "23514" ? (/højst/.test(String(r.error.message || "")) ? String(r.error.message) : "Databasen afviste linket. Brug det delte link til ønskelisten fra Ønskeskyen.") : "Kunne ikke gemme lige nu. Prøv igen om lidt.");
        return;
      }
      $("fMain").value = ""; $("fVal").value = ""; $("fReq").value = ""; state.importMsg = ""; addReveal = false; syncAdd();
      fetchImports();
    }, function () { btn.disabled = false; fail("Kunne ikke gemme lige nu. Prøv igen om lidt."); });
  }

  // ---- account menu: one small button in the header (the initial in a circle) ----
  var acctBtn = $("acctBtn"), acctPop = $("acctPop");
  function menuItems() { return Array.prototype.filter.call($("acctMenu").querySelectorAll('[role="menuitem"]'), function (x) { return !x.hidden; }); }
  function openMenu(which) {
    acctPop.hidden = false; acctBtn.setAttribute("aria-expanded", "true");
    var it = menuItems(); if (it.length) it[which === "last" ? it.length - 1 : 0].focus();
  }
  function closeMenu(back) {
    if (acctPop.hidden) return;
    acctPop.hidden = true; acctBtn.setAttribute("aria-expanded", "false");
    if (back) acctBtn.focus();
  }
  acctBtn.addEventListener("click", function () { if (acctPop.hidden) openMenu(); else closeMenu(true); });
  acctBtn.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowDown") { ev.preventDefault(); openMenu(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); openMenu("last"); }
  });
  acctPop.addEventListener("keydown", function (ev) {
    var it = menuItems(), i = it.indexOf(document.activeElement);
    if (ev.key === "Escape") { ev.preventDefault(); ev.stopPropagation(); closeMenu(true); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); it[(i + 1) % it.length].focus(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); it[(i - 1 + it.length) % it.length].focus(); }
    else if (ev.key === "Home") { ev.preventDefault(); it[0].focus(); }
    else if (ev.key === "End") { ev.preventDefault(); it[it.length - 1].focus(); }
    else if (ev.key === "Tab") closeMenu(true);          // focus goes on from the button: nothing is trapped
  });
  document.addEventListener("click", function (ev) { if (!acctPop.hidden && !$("acts").contains(ev.target)) closeMenu(false); });
  $("acctMenu").addEventListener("click", function (ev) {
    var b = ev.target.closest('[role="menuitem"]'); if (!b) return;
    if (b.id === "logoutBtn") return;                     // its own handler closes the menu and signs out
    closeMenu(b.id !== "settingsBtn" && b.id !== "accessBtn");
  });
  $("settingsBtn").addEventListener("click", function () {
    var box = $("settingsBox"); box.hidden = false;
    try { box.scrollIntoView({ behavior: reduceMotion() ? "auto" : "smooth", block: "nearest" }); } catch (e) {}
    $("shAlways").focus({ preventScroll: true });
  });
  $("setClose").addEventListener("click", function () { $("settingsBox").hidden = true; acctBtn.focus(); });
  $("settingsBox").addEventListener("keydown", function (ev) { if (ev.key === "Escape") { $("settingsBox").hidden = true; acctBtn.focus(); } });
  $("accessBtn").addEventListener("click", gotoAccess);

  // ---- settings ----
  $("shNotify").addEventListener("change", function () { $("shDigest").disabled = !$("shNotify").checked; });
  $("shopForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!sb || !user) return;
    var data = { user_id: user.id, shops_always: shopList($("shAlways").value), shops_exclude: shopList($("shExclude").value), shops_only: $("shOnly").checked,
      notify_email: $("shNotify").checked, mail_digest: $("shDigest").checked, sound: muted ? "off" : "on" };
    var msg = $("shMsg");
    if (data.shops_only && !data.shops_always.length) { msg.textContent = "Skriv mindst én butik på “tjek altid”-listen først."; return; }
    msg.textContent = "Gemmer …";
    sb.from("profiles").upsert(data).then(function (r) {
      if (r && r.error) { msg.textContent = isDenied(r.error) ? "Din adresse har ikke adgang til at gemme endnu." : "Kunne ikke gemme lige nu. Prøv igen om lidt."; onWriteError(r.error); return; }
      setPrefs({ shops_always: data.shops_always, shops_exclude: data.shops_exclude, shops_only: data.shops_only, notify_email: data.notify_email, mail_digest: data.mail_digest });
      msg.textContent = "Gemt.";
    }, function () { msg.textContent = "Kunne ikke gemme lige nu. Prøv igen om lidt."; });
  });

  // ---- sign-in ----
  function otpNotAllowed(e) {
    var m = String(e && e.message || "").toLowerCase(), c = e && e.status, code = String(e && e.code || "").toLowerCase(), all = m + " " + code;
    if (c === 429 || /rate.?limit|too many|only request this after/.test(all)) return false;
    if (/invalid.*e-?mail|e-?mail.*invalid|validation_failed|unable to validate email/.test(all)) return false;
    return /not allowed|signups? (are |is )?(not allowed|disabled)|hook|database error|not (on|in) the|forbidden|unauthori[sz]ed|otp_disabled|user_not_found|not_allowed|ikke inviteret/.test(all) || c === 422 || c === 403;
  }
  function otpMessage(e) {
    var m = String(e && e.message || "").toLowerCase(), c = e && e.status, code = String(e && e.code || "").toLowerCase(), all = m + " " + code;
    if (c === 429 || /rate.?limit|too many|only request this after/.test(all)) return "Der er sendt for mange login-links lige nu. Vent et par minutter, og prøv igen.";
    if (/invalid.*e-?mail|e-?mail.*invalid|validation_failed|unable to validate email/.test(all)) return "Det ligner ikke en gyldig e-mailadresse.";
    if (/not allowed|signups? (are |is )?(not allowed|disabled)|hook|database error|not (on|in) the|forbidden|unauthori[sz]ed|otp_disabled|user_not_found|not_allowed|ikke inviteret/.test(all) || c === 422 || c === 403)
      return "Adressen har ikke adgang endnu. Bed om adgang herunder, så får ejeren besked.";
    if (/failed to fetch|network|retryablefetch/.test(all + " " + String(e && e.name || "").toLowerCase())) return "Kunne ikke nå serveren. Tjek din forbindelse, og prøv igen.";
    return "Kunne ikke sende login-linket lige nu. Prøv igen om lidt.";
  }
  $("loginForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var msg = $("lMsg"); msg.hidden = true;
    var email = $("lEmail").value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { msg.textContent = "Skriv din e-mailadresse, fx navn@eksempel.dk."; msg.hidden = false; return; }
    var btn = $("lSubmit"); btn.disabled = true;
    sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + location.pathname } }).then(function (r) {
      btn.disabled = false;
      if (r && r.error) { msg.textContent = otpMessage(r.error); msg.hidden = false; if (otpNotAllowed(r.error)) openAsk(email, true); return; }
      showSent(email, true);
    }, function (e) { btn.disabled = false; msg.textContent = otpMessage(e); msg.hidden = false; if (otpNotAllowed(e)) openAsk(email, true); });
  });
  // The e-mail also holds a code, for an installed app that has its own storage: the link opens in the browser, so the code is typed here.
  var LOGIN_KEY = "pv_login_email", sentEmail = "", lastSent = 0;
  function loginStore(v) { try { if (v) sessionStorage.setItem(LOGIN_KEY, v); else sessionStorage.removeItem(LOGIN_KEY); } catch (e) {} }
  function loginStored() { try { return sessionStorage.getItem(LOGIN_KEY) || ""; } catch (e) { return ""; } }
  function showSent(email, fresh) {
    sentEmail = email; if (fresh) { lastSent = Date.now(); loginStore(email); }
    $("sentTo").textContent = email; $("sentBox").hidden = false; $("loginForm").hidden = true;
    $("cMsg").hidden = true; $("cCode").value = "";
  }
  function codeMsg(t) { var el = $("cMsg"); el.textContent = t || ""; el.hidden = !t; }
  $("codeForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var code = $("cCode").value.replace(/\s+/g, "");
    if (!/^[0-9]{6,8}$/.test(code)) { codeMsg("Koden passer ikke, eller den er udløbet."); return; }
    if (!sentEmail || !sb) return;
    var btn = $("cSubmit"); btn.disabled = true; codeMsg("");
    sb.auth.verifyOtp({ email: sentEmail, token: code, type: "email" }).then(function (r) {
      btn.disabled = false;
      if (r && r.error) { codeMsg("Koden passer ikke, eller den er udløbet."); return; }
      loginStore("");  // onAuthStateChange takes it from here, as after the link
    }, function () { btn.disabled = false; codeMsg("Koden passer ikke, eller den er udløbet."); });
  });
  $("sentResend").addEventListener("click", function () {
    if (!sentEmail || !sb) return;
    var wait = Math.ceil((lastSent + 30000 - Date.now()) / 1000);
    if (wait > 0) { codeMsg("Vent " + wait + " sekunder, før du sender igen."); return; }
    var btn = $("sentResend"); btn.disabled = true; lastSent = Date.now(); codeMsg("");
    sb.auth.signInWithOtp({ email: sentEmail, options: { emailRedirectTo: location.origin + location.pathname } }).then(function (r) {
      btn.disabled = false;
      codeMsg(r && r.error ? otpMessage(r.error) : "Ny mail sendt.");
    }, function (e) { btn.disabled = false; codeMsg(otpMessage(e)); });
  });
  // ---- ask for access (signed out) ----
  var ASK_TEXT = {
    requested: "Tak. Du får en mail, når du er godkendt.",
    pending: "Du har allerede bedt om adgang. Du får en mail, når du er godkendt.",
    allowed: "Du har allerede adgang. Brug login-formularen ovenfor.",
    full: "Der er for mange anmodninger lige nu. Prøv igen om nogle dage.",
    invalid: "Det ligner ikke en gyldig e-mailadresse. Skriv den som navn@eksempel.dk.",
    rejected: "Adressen fik ikke adgang. Spørg ejeren direkte."
  };
  function askMsg(t) { var el = $("aMsg"); el.textContent = t || ""; el.hidden = !t; }
  function openAsk(email, focusName) {
    $("askBox").hidden = false; $("askToggle").setAttribute("aria-expanded", "true"); $("askForm").hidden = false;
    if (email) $("aEmail").value = email;
    askMsg("");
    if (focusName) { try { $("aName").focus(); } catch (e) {} }
  }
  $("askToggle").addEventListener("click", function () {
    if ($("askBox").hidden) openAsk($("lEmail").value.trim(), false);
    else { $("askBox").hidden = true; $("askToggle").setAttribute("aria-expanded", "false"); }
  });
  $("askForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var email = $("aEmail").value.trim(), name = $("aName").value.trim().replace(/\s+/g, " ");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { askMsg(ASK_TEXT.invalid); return; }
    if (!sb) return;
    var btn = $("aSubmit"); btn.disabled = true; askMsg("Sender …");
    sb.rpc("request_access", { p_email: email, p_name: name }).then(function (r) {
      btn.disabled = false;
      var res = r && !r.error && typeof r.data === "string" ? r.data : null;
      if (!res || !ASK_TEXT[res]) { askMsg("Kunne ikke sende anmodningen lige nu. Prøv igen om lidt."); return; }
      askMsg(ASK_TEXT[res]);
      if (res === "requested" || res === "pending" || res === "allowed") $("askForm").hidden = true;
      if (res === "allowed" && !$("lEmail").value.trim()) $("lEmail").value = email;
    }, function () { btn.disabled = false; askMsg("Kunne ikke sende anmodningen lige nu. Prøv igen om lidt."); });
  });
  $("sentBack").addEventListener("click", function () { loginStore(""); sentEmail = ""; $("sentBox").hidden = true; $("loginForm").hidden = false; $("lEmail").focus(); });
  $("logoutBtn").addEventListener("click", function () {
    closeMenu(false); $("settingsBox").hidden = true;
    sb.auth.signOut().then(function () { handleSession(null); }, function () { handleSession(null); });
  });

  // ---- signed in without access: a dedicated screen (state from the my_access() rpc: allowed | pending | rejected | none) ----
  var NA_LINE = { none: "Du har ikke adgang endnu.", pending: "Din anmodning venter på godkendelse.", rejected: "Adressen fik ikke adgang. Spørg ejeren direkte." };
  var NA_TEXT = { full: "Der er for mange anmodninger lige nu. Prøv igen om nogle dage.", invalid: "Det ligner ikke en gyldig e-mailadresse.", fail: "Kunne ikke sende anmodningen lige nu. Prøv igen om lidt." };
  // Anything but a clear 'none' | 'pending' | 'rejected' counts as allowed: an old schema without my_access() or a failed call must not lock anyone out (RLS still protects the data).
  function myAccess() {
    return sb.rpc("my_access").then(function (r) {
      var d = r && !r.error && typeof r.data === "string" ? r.data : "";
      return d === "none" || d === "pending" || d === "rejected" ? d : "allowed";
    }, function () { return "allowed"; });
  }
  function naMsg(t) { noacc.msg = t || ""; var el = $("naMsg"); el.textContent = noacc.msg; el.hidden = !noacc.msg; }
  function renderNoAccess() {
    var st = noacc.state;
    $("naWho").textContent = user && user.email ? user.email : "";
    $("naLine").textContent = NA_LINE[st] || NA_LINE.none;
    $("naForm").hidden = st !== "none"; $("naCheck").hidden = st === "none";
  }
  function stopNoAccess() {
    clearInterval(noacc.timer); noacc.timer = null; noacc.on = false; noacc.state = ""; noacc.busy = false;
    $("noAccessView").hidden = true; naMsg(""); $("naName").value = "";
  }
  function showNoAccess(st) {
    var first = !noacc.on || noacc.state !== st;
    noacc.on = true; noacc.state = st;
    $("authView").hidden = true; $("appView").hidden = true; $("acts").hidden = true; $("reqBadge").hidden = true; $("status").textContent = "";
    $("noAccessView").hidden = false;
    if (first) { naMsg(""); renderNoAccess(); }
    if (!noacc.timer) noacc.timer = setInterval(function () { if (document.visibilityState === "visible") recheckAccess(); }, 60000);
  }
  function enterApp() { stopNoAccess(); showApp(); startSession(); }
  function recheckAccess() {
    if (!sb || !user || !noacc.on || noacc.busy) return;
    var uid = user.id; noacc.busy = true;
    myAccess().then(function (st) {
      noacc.busy = false;
      if (!user || user.id !== uid || !noacc.on) return;
      if (noacc.msg === "Tjekker …") naMsg("");
      if (st === "allowed") enterApp(); else showNoAccess(st);
    });
  }
  $("naCheck").addEventListener("click", function () { if (noacc.busy) return; naMsg("Tjekker …"); recheckAccess(); });
  $("naLogout").addEventListener("click", function () { sb.auth.signOut().then(function () { handleSession(null); }, function () { handleSession(null); }); });
  $("naForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!sb || !user || !user.email) return;
    var name = $("naName").value.trim().replace(/\s+/g, " "), btn = $("naSubmit"), uid = user.id;
    btn.disabled = true; naMsg("Sender …");
    sb.rpc("request_access", { p_email: user.email, p_name: name }).then(function (r) {
      btn.disabled = false;
      if (!user || user.id !== uid || !noacc.on) return;
      var res = r && !r.error && typeof r.data === "string" ? r.data : null;
      if (res === "requested" || res === "pending") { naMsg(""); showNoAccess("pending"); }
      else if (res === "rejected") { naMsg(""); showNoAccess("rejected"); }
      else if (res === "allowed") { noacc.busy = false; recheckAccess(); }
      else naMsg(res && NA_TEXT[res] ? NA_TEXT[res] : NA_TEXT.fail);
    }, function () { btn.disabled = false; naMsg(NA_TEXT.fail); });
  });

  function showAuth(errText) {
    stopNoAccess();
    $("authView").hidden = false; $("appView").hidden = true; $("acts").hidden = true; $("reqBadge").hidden = true; closeMenu(false);
    $("status").textContent = "";
    if (errText) { $("lMsg").textContent = errText; $("lMsg").hidden = false; }
    var kept = loginStored(); if (kept && $("sentBox").hidden) showSent(kept, false);
  }
  function showApp() {
    $("authView").hidden = true; $("noAccessView").hidden = true; $("appView").hidden = false; $("acts").hidden = false;
    $("who").textContent = user.email || ""; $("acctInitial").textContent = initialOf(user.email || "");
    syncSound(); syncType();
  }
  function handleSession(session) {
    if (!session || !session.user) {
      if (user) stopSession();
      user = null; showAuth();
      return;
    }
    loginStore("");
    if (user && user.id === session.user.id) return;
    if (user) stopSession();
    stopNoAccess();
    user = session.user;
    // find out first whether this person is allowed: the list is only fetched for them, others land on the no-access screen
    var uid = user.id;
    $("authView").hidden = true; $("appView").hidden = true; $("acts").hidden = true; $("status").textContent = "Henter …";
    myAccess().then(function (st) {
      if (!user || user.id !== uid) return;
      if (st === "allowed") enterApp(); else showNoAccess(st);
    });
  }
  function hashError() {
    var raw = (location.hash || "").replace(/^#/, "") + "&" + (location.search || "").replace(/^\?/, "");
    var q = {}; raw.split("&").forEach(function (kv) { var i = kv.indexOf("="); if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, " ")); });
    if (!q.error && !q.error_code) return null;
    try { history.replaceState(null, "", location.pathname); } catch (e) {}
    return /expired|otp_expired|access_denied/.test((q.error_code || "") + " " + (q.error || ""))
      ? "Login-linket er udløbet eller er brugt allerede. Send et nyt." : "Login mislykkedes. Send et nyt login-link.";
  }

  // ---- installable app: home-screen item and offline shell (must never affect the page) ----
  try {
    var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent || "") || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var installEv = null;
    if (!standalone) {
      window.addEventListener("beforeinstallprompt", function (ev) {
        ev.preventDefault(); installEv = ev; $("installBtn").hidden = false; $("installBox").hidden = false;
      });
      $("installBtn").addEventListener("click", function () {
        if (!installEv) return;
        var e2 = installEv; installEv = null; $("installBox").hidden = true;
        try { e2.prompt(); } catch (e) {}
      });
      if (ios) { $("installIos").hidden = false; $("installBox").hidden = false; }
    }
    if ("serviceWorker" in navigator && (location.protocol === "https:" || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname))) {
      navigator.serviceWorker.register("sw.js").catch(function () {});
    }
  } catch (e) {}

  // ---- boot ----
  var cfg = window.PV_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) { $("setupMsg").hidden = false; return; }
  try { sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey); }
  catch (e) { $("setupMsg").hidden = false; $("setupMsg").textContent = "Kunne ikke forbinde til databasen. Genindlæs siden, og prøv igen."; return; }
  var urlErr = hashError();
  sb.auth.onAuthStateChange(function (ev, session) { setTimeout(function () { handleSession(session); }, 0); });
  sb.auth.getSession().then(function (r) {
    var s = r && r.data && r.data.session;
    if (s) handleSession(s); else if (!user) showAuth(urlErr);
  }, function () { showAuth(urlErr); });
})();
