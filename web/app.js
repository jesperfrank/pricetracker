(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var nf = new Intl.NumberFormat("da-DK", { maximumFractionDigits: 0 });
  var kr = function (n) { return (typeof n === "number" && isFinite(n)) ? nf.format(Math.round(n)) + " kr." : "–"; };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var safeUrl = function (u) { return (typeof u === "string" && /^https?:\/\//i.test(u)) ? u : null; };
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

  var state = { products: [], loaded: false, canWrite: true, open: {}, range: {}, confirmDel: null, pick: {}, change: {}, note: {}, rowMsg: {},
    prefs: { always: [], exclude: [], only: false, notify: true }, profileSound: null };
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
  function syncSound() { var b = $("soundBtn"); b.textContent = muted ? "Lyd fra" : "Lyd til"; b.setAttribute("aria-pressed", String(!muted)); }
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
      targetType: r.target_type === "pct" ? "pct" : "price", targetValue: num(r.target_value),
      shopsAlways: r.shops_always, shopsExclude: r.shops_exclude, shopsOnly: !!r.shops_only,
      url: r.source_url || null, createdAt: r.created_at || ""
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
  function targetKr(p) {
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
  function isHit(p) { var b = bestOf(p), t = targetKr(p); return p.status === "tracking" && !!(b && t != null && b.inStock !== false && b.price <= t); }
  function targetText(p) {
    var t = targetKr(p);
    if (p.targetType === "pct") return "mål " + nf.format(p.targetValue) + " %" + (t != null ? " · " + kr(t) : "");
    return "mål " + kr(t);
  }
  function parsePrisjagt(u) {
    var x;
    try { x = new URL(String(u || "").trim()); } catch (e) { return null; }
    if (x.protocol !== "https:" || x.username || x.password) return null;
    if (x.hostname !== "prisjagt.dk" && x.hostname !== "www.prisjagt.dk") return null;
    if (x.pathname.length < 2) return null;
    x.hostname = "prisjagt.dk";
    return x.toString();
  }
  function isOpen(p) { return state.open[p._id] !== undefined ? !!state.open[p._id] : p.status === "choose"; }
  function awaitingFetch(p) { return p.status === "choose" && p.tracked && p.tracked.length && !state.change[p._id]; }
  function variantLabels(p) {
    var ids = p.tracked || [];
    var ls = p.variants.filter(function (v) { return ids.indexOf(String(v.id)) >= 0; }).map(function (v) { return v.label; }).filter(Boolean);
    return ls.length ? ls.join(", ") : (p.title || "");
  }

  // ---- rendering ----
  function renderStatus() {
    if (!user) return;
    if (!state.loaded) { $("status").textContent = "Henter listen …"; return; }
    var newest = 0;
    state.products.forEach(function (p) { var t = Date.parse(p.lastChecked); if (isFinite(t) && t > newest) newest = t; });
    var parts = [newest ? "Priserne er opdateret " + dtFmt.format(new Date(newest)) : "Ingen priser hentet endnu", "opdateres hvert kvarter"];
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

  function headHtml(p) {
    var b = bestOf(p), t = targetKr(p), os = offersOf(p), st;
    var anyStock = os.some(function (o) { return o.inStock !== false; });
    if (p.status === "pending") st = p.url ? "Henter produktet … klar inden for et kvarter" : "Finder produktet … det kan tage op til en time.";
    else if (p.status === "error") st = '<span class="warn">' + esc(p.checkNote || "Produktet kunne ikke hentes") + '</span>';
    else if (awaitingFetch(p)) st = "Henter priser for den valgte variant …";
    else if (p.status === "choose") st = '<span class="out">Vælg, hvilken variant du vil følge</span>';
    else if (isHit(p)) st = '<span class="ok">Mål nået</span> · på lager hos ' + esc(b.store || "en butik");
    else if (!p.lastChecked) st = "Venter på første tjek";
    else if (!b) st = esc(p.checkNote || "Ingen pris fundet");
    else if (!anyStock) st = '<span class="out">Udsolgt alle steder</span> · senest hos ' + esc(b.store || "en butik");
    else st = (t != null ? esc(kr(b.price - t)) + " over målet · " : "") + "billigst hos " + esc(b.store || "en butik");
    if (p.status === "tracking" && p.warning) st += ' · <span class="warn">Oppustet førpris</span>';
    var showPrice = p.status === "tracking" && b;
    return '<div><h2>' + esc(p.name) + '</h2><div class="meta">' + st + '</div></div>' + (p.status === "tracking" ? sparkHtml(p) : '<span class="spark"></span>') +
      '<div class="price n"><b>' + (showPrice ? esc(kr(b.price)) : "–") + '</b><span>' + esc(targetText(p)) + '</span></div>';
  }

  function chooserHtml(p) {
    var id = p._id, sel = state.pick[id];
    if (!sel) sel = p.tracked && p.tracked.length ? p.tracked : (p.variants.length === 1 ? [String(p.variants[0].id)] : []);
    if (!p.variants.length) return '<p class="verdict">Der er ingen varianter at vælge mellem endnu. Prøv igen om lidt.</p>';
    return '<form class="choose" data-choose="' + esc(id) + '"><fieldset class="variants"><legend>Hvilke varianter vil du følge?</legend>' +
      p.variants.map(function (v, i) {
        var vid = String(v.id), n = Array.isArray(v.offers) ? v.offers.length : num(v.offers);
        return '<label class="var"><input type="checkbox" data-var="' + esc(vid) + '"' + (sel.indexOf(vid) >= 0 ? " checked" : "") + '>' +
          '<span>' + esc(v.label || ("Variant " + (i + 1))) + '</span>' +
          '<span class="vp n">' + (num(v.lowest) != null ? "fra " + esc(kr(num(v.lowest))) : "") + '</span>' +
          '<span class="meta">' + (n != null ? esc(n + (n === 1 ? " tilbud" : " tilbud")) : "") + '</span></label>';
      }).join("") + '</fieldset><div class="choose-act"><button class="btn small" type="submit">Følg valgte</button>' +
      (p.status === "tracking" ? '<button type="button" class="link" data-act="change-no" data-id="' + esc(id) + '">Fortryd</button>' : '') +
      '<span class="meta" data-rowmsg="' + esc(id) + '">' + esc(state.rowMsg[id] || "") + '</span></div></form>';
  }

  function footHtml(p, fixLink) {
    var id = p._id, link = safeUrl(p.url), html = "";
    html += '<div class="foot"><span>' + (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">Dit link</a>' : '') + '</span>';
    if (state.canWrite) {
      if (state.confirmDel === id) {
        html += '<span class="edit"><span>Fjern produktet og dets historik?</span>' +
          '<button type="button" class="link warn" data-act="del-yes" data-id="' + esc(id) + '">Ja, fjern</button>' +
          '<button type="button" class="link" data-act="del-no">Behold</button></span>';
      } else {
        html += '<form class="edit" data-edit="' + esc(id) + '"><label for="e-' + esc(id) + '">' +
          (p.targetType === "pct" ? "Rabat i %" : "Højst, kr.") + '</label>' +
          '<input class="n" type="number" id="e-' + esc(id) + '" min="1" step="1" value="' + esc(p.targetValue) + '" required>' +
          '<button class="link" type="submit">Gem</button>' +
          '<button type="button" class="link warn" data-act="del" data-id="' + esc(id) + '">Fjern</button></form>';
      }
    }
    return html + '</div>';
  }

  // Name-only product: link to prisjagt.dk's own search (opens in a new tab) and a form to paste the link found there.
  function findHtml(p, afterError) {
    var id = p._id, a = '<a href="https://prisjagt.dk/search?search=' + esc(encodeURIComponent(p.name)) + '" target="_blank" rel="noopener noreferrer">Søg på Prisjagt</a>';
    var f = state.canWrite ? '<form class="edit" data-fixurl="' + esc(id) + '" novalidate><label for="u-' + esc(id) + '">Indsæt linket her</label>' +
      '<input class="wide" type="url" id="u-' + esc(id) + '" maxlength="500" required placeholder="https://prisjagt.dk/…">' +
      '<button class="link" type="submit">Gem linket</button><span class="meta" data-rowmsg="' + esc(id) + '">' + esc(state.rowMsg[id] || "") + '</span></form>' : "";
    return '<p class="verdict">' + (afterError ? "Find det selv" : "Har du travlt? Find det selv") + ': ' + a + '</p>' + f;
  }

  function bodyHtml(p) {
    var id = p._id;
    if (p.status === "pending" && !p.url)
      return '<p class="verdict">Finder produktet … det kan tage op til en time.</p>' + findHtml(p) + footHtml(p);
    if (p.status === "pending")
      return '<p class="verdict">Henter produktet fra prisjagt.dk. Det er klar inden for et kvarter, og så kan du vælge variant.</p>' + footHtml(p);
    if (p.status === "error" && !p.url)
      return '<p class="verdict poor"><b>Produktet blev ikke fundet.</b> ' + esc(p.checkNote || "Find det selv på Prisjagt, og indsæt linket her.") + '</p>' + findHtml(p, true) + footHtml(p);
    if (p.status === "error") {
      var f = state.canWrite ? '<form class="edit" data-fixurl="' + esc(id) + '" novalidate><label class="vh" for="u-' + esc(id) + '">Link fra prisjagt.dk</label>' +
        '<input class="wide" type="url" id="u-' + esc(id) + '" maxlength="500" required value="' + esc(p.url || "") + '" placeholder="Link fra prisjagt.dk">' +
        '<button class="link" type="submit">Gem linket og prøv igen</button><span class="meta" data-rowmsg="' + esc(id) + '">' + esc(state.rowMsg[id] || "") + '</span></form>' : "";
      return '<p class="verdict poor"><b>Produktet kunne ikke hentes.</b> ' + esc(p.checkNote || "Tjek, at linket er en produktside på prisjagt.dk.") + '</p>' + f + footHtml(p);
    }
    if (awaitingFetch(p))
      return '<p class="verdict">Varianten er valgt. Priserne hentes ved næste kørsel, inden for et kvarter.</p>' +
        '<div class="foot"><span>Følger: ' + esc(variantLabels(p)) + '</span>' + (state.canWrite ? '<button type="button" class="link" data-act="change" data-id="' + esc(id) + '">Skift variant</button>' : '') + '</div>' + footHtml(p);
    if (p.status === "choose") return chooserHtml(p) + footHtml(p);

    var b = bestOf(p), h = histOf(p), now = Date.now(), html = "";
    if (state.note[id]) html += '<p class="note">' + esc(state.note[id]) + '</p>';
    if (state.change[id]) html += chooserHtml(p);
    var v = p.verdict;
    if (v && v.text) {
      var lab = { good: "Godt tilbud.", ok: "Almindelig pris.", poor: "Ikke et godt tilbud.", unknown: "For tidligt at sige." }[v.level] || "";
      html += '<p class="verdict ' + esc(v.level || "") + '"><b>' + lab + '</b> ' + esc(v.text) + '</p>';
    } else if (!p.lastChecked) {
      html += '<p class="verdict">Ved næste kørsel hentes priserne, butikkerne og normalprisen.</p>';
    }
    if (p.warning) html += '<p class="verdict poor"><b>Pas på førprisen.</b> ' + esc(p.warning) + '</p>';
    if (p.variants.length > 1 || variantLabels(p)) {
      html += '<div class="foot"><span>Følger: ' + esc(variantLabels(p) || "alle varianter") + '</span>';
      if (state.canWrite && p.variants.length && !state.change[id]) html += '<button type="button" class="link" data-act="change" data-id="' + esc(id) + '">Skift variant</button>';
      html += '</div>';
    }

    var last30 = h.filter(function (x) { return x.t >= now - 30 * DAY; });
    var low30 = last30.length ? Math.min.apply(null, last30.map(function (x) { return x.p; })) : null;
    var lowAll = h.length ? Math.min.apply(null, h.map(function (x) { return x.p; })) : null;
    html += '<dl class="stats n">' +
      '<div><dt>Laveste nu</dt><dd>' + esc(b ? kr(b.price) : "–") + '</dd></div>' +
      '<div><dt>Laveste 30 dage</dt><dd>' + esc(kr(low30)) + '</dd></div>' +
      '<div><dt>Laveste set</dt><dd>' + esc(kr(lowAll)) + '</dd></div>' +
      '<div><dt>Normalpris</dt><dd>' + esc(kr(p.normalPrice)) + '</dd></div></dl>';

    if (h.length) {
      var r = state.range[id] || 365;
      html += '<div><div class="sec-h"><h3>Prisen dag for dag</h3><div class="ranges" role="group" aria-label="Periode">' +
        [[30, "1 md."], [90, "3 mdr."], [365, "1 år"]].map(function (x) {
          return '<button type="button" data-act="range" data-id="' + esc(id) + '" data-r="' + x[0] + '" aria-pressed="' + (r === x[0]) + '">' + x[1] + '</button>';
        }).join("") + '</div></div><div class="chart" data-chart="' + esc(id) + '"></div>';
      if (h.length < 2) html += '<p class="note">Første måling er i hus. Grafen fylder sig ud dag for dag.</p>';
      else if (h.some(function (x) { return x.src === "backfill"; })) html += '<p class="note">Priser fra før produktet blev tilføjet stammer fra offentlige prisoversigter og kan være mindre præcise.</p>';
      if (h.length > 1 && h[0].t > now - r * DAY) html += '<p class="note">Historikken begynder ' + esc(dFmt.format(new Date(h[0].t))) + ' ' + new Date(h[0].t).getFullYear() + ', så der er ikke ældre priser at vise.</p>';
      if (h.length > 1) {
        html += '<details><summary>Vis som tabel</summary><div class="tablewrap"><table class="n"><tbody>' +
          h.slice().reverse().map(function (x) {
            return '<tr><td>' + esc(dFmt.format(new Date(x.t))) + ' ' + new Date(x.t).getFullYear() + '</td><td class="num">' + esc(kr(x.p)) + '</td><td>' + esc(x.s || "") + '</td></tr>';
          }).join("") + '</tbody></table></div></details>';
      }
      html += '</div>';
    }

    var os = offersOf(p).slice().sort(function (a, c) { return ((a.inStock === false) - (c.inStock === false)) || (a.price - c.price); });
    if (os.length) {
      html += '<div><div class="sec-h"><h3>Butikker</h3>' +
        (p.lastChecked && isFinite(Date.parse(p.lastChecked)) ? '<span class="meta">tjekket ' + esc(dtFmt.format(new Date(p.lastChecked))) + '</span>' : '') +
        '</div><div class="tablewrap"><table><tbody>' +
        os.map(function (o) {
          var u = safeUrl(o.url), out = o.inStock === false;
          return '<tr class="' + (o === b ? "best" : "") + (out ? " soldout" : "") + '"><td>' + esc(o.store || "") +
            ((o.note || out) ? '<div class="meta">' + esc([out ? "Ikke på lager" : "", o.note || ""].filter(Boolean).join(" · ")) + '</div>' : '') +
            '</td><td class="num n">' + esc(kr(o.price)) + '</td><td>' +
            (u ? '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">Se varen</a>' : '') + '</td></tr>';
        }).join("") + '</tbody></table></div></div>';
    }
    if (state.canWrite) {
      html += '<details class="pshops"><summary>Butikker for dette produkt</summary><form class="pshop" data-shops="' + esc(id) + '">' +
        '<label for="sa-' + esc(id) + '">Tjek altid disse butikker eller sider</label>' +
        '<input type="text" id="sa-' + esc(id) + '" maxlength="600" value="' + esc(shopList(p.shopsAlways).join(", ")) + '" placeholder="fx Proshop, hifiklubben.dk">' +
        '<label for="se-' + esc(id) + '">Udelad disse butikker</label>' +
        '<input type="text" id="se-' + esc(id) + '" maxlength="600" value="' + esc(shopList(p.shopsExclude).join(", ")) + '">' +
        '<label class="chk"><input type="checkbox" id="so-' + esc(id) + '"' + (p.shopsOnly ? ' checked' : '') + '> Kun butikkerne på listen tæller for dette produkt</label>' +
        '<span><button class="link" type="submit">Gem</button></span></form></details>';
    }
    return html + footHtml(p);
  }

  var renderPending = false;
  function render() {
    renderStatus();
    if (!user || !state.loaded) return;
    var list = $("list"), a = document.activeElement;
    if (a && list.contains(a) && a.tagName === "INPUT" &&
      (a.type === "checkbox" || a.type === "radio" ? a.checked !== a.defaultChecked : a.value !== a.defaultValue)) { renderPending = true; return; }
    renderPending = false;
    var rank = function (p) { return isHit(p) ? 0 : (p.status === "choose" && !awaitingFetch(p)) ? 1 : 2; };
    var ps = state.products.slice().sort(function (x, y) {
      return (rank(x) - rank(y)) || String(y.createdAt || "").localeCompare(String(x.createdAt || ""));
    });
    if (!ps.length) {
      list.innerHTML = '<div class="empty"><b>Ingen produkter endnu</b>' +
        (state.canWrite ? "Skriv navnet på en vare eller indsæt et link fra prisjagt.dk ovenfor. Så finder og henter vi produktet, du vælger variant, og derefter ser du laveste pris, butikkerne og prisen dag for dag."
          : "Når der er tilføjet produkter, ser du laveste pris, butikker og prisudvikling her.") + '</div>';
      return;
    }
    list.innerHTML = ps.map(function (p) {
      var open = isOpen(p);
      return '<article class="item' + (isHit(p) ? " hit" : "") + '" data-status="' + esc(p.status) + '">' +
        '<button type="button" class="head" data-act="toggle" data-id="' + esc(p._id) + '" aria-expanded="' + open + '">' + headHtml(p) + '</button>' +
        (open ? '<div class="body">' + bodyHtml(p) + '</div>' : '') + '</article>';
    }).join("");
    ps.forEach(function (p) { if (isOpen(p) && p.status === "tracking") drawChart(p); });
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
      '<circle cx="' + X(t1) + '" cy="' + Y(lastP.p) + '" r="4.5" fill="var(--series)" stroke="var(--bg)" stroke-width="2"/>' +
      '<text class="now" x="' + (X(t1) - 9) + '" y="' + (Y(lastP.p) + (tgt != null && lastP.p <= tgt ? 19 : -10)) + '" text-anchor="end">' + esc(kr(lastP.p)) + '</text>' +
      '<g class="hov" visibility="hidden"><line y1="' + mt + '" y2="' + (H - mb) + '" stroke="var(--muted)" stroke-width="1"/>' +
      '<circle r="4.5" fill="var(--series)" stroke="var(--bg)" stroke-width="2"/></g>' +
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
    $("readonly").hidden = state.canWrite;
    $("addForm").hidden = !state.canWrite; $("fHelp").hidden = !state.canWrite; $("fHint").hidden = !state.canWrite;
    render();
  }
  function onWriteError(e) { if (isDenied(e)) { state.canWrite = false; applyAccess(); } }
  function fetchProducts() {
    if (!sb || !user) return;
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
        render(); checkSound();
      }
      if (again) { again = false; fetchProducts(); }
    }, function () {
      fetching = false;
      if (!state.loaded) $("status").textContent = "Listen kan ikke hentes lige nu. Den prøves igen om lidt.";
    });
  }
  function refreshSoon() { if (Date.now() - lastFetch > 2500) fetchProducts(); else { again = true; setTimeout(function () { if (again && !fetching) { again = false; fetchProducts(); } }, 2600); } }
  function setPrefs(d) {
    state.prefs = { always: shopList(d.shops_always), exclude: shopList(d.shops_exclude), only: !!d.shops_only, notify: d.notify_email !== false };
    $("shAlways").value = state.prefs.always.join(", "); $("shExclude").value = state.prefs.exclude.join(", ");
    $("shOnly").checked = state.prefs.only; $("shNotify").checked = state.prefs.notify;
    render();
  }
  function ensureProfile() {
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
      return sb.from("profiles").upsert({ user_id: uid, notify_email: true }).then(function (u) { if (u && u.error) onWriteError(u.error); });
    }, function () {});
  }
  function startSession() {
    state.loaded = false; state.products = []; state.canWrite = true;
    $("status").textContent = "Henter listen …";
    loadSounds();
    ensureProfile(); fetchProducts();
    try {
      channel = sb.channel("pv-products").on("postgres_changes", { event: "*", schema: "public", table: "products" }, function () { refreshSoon(); }).subscribe();
    } catch (e) { channel = null; }
    pollTimer = setInterval(function () { if (document.visibilityState === "visible") fetchProducts(); }, 60000);
  }
  function stopSession() {
    clearInterval(pollTimer); pollTimer = null;
    try { if (channel) sb.removeChannel(channel); } catch (e) {}
    channel = null; state.products = []; state.loaded = false;
  }
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && user) fetchProducts(); });
  window.addEventListener("focus", function () { if (user && Date.now() - lastFetch > 3000) fetchProducts(); });

  // ---- list interactions ----
  function prod(id) { return state.products.filter(function (x) { return x._id === id; })[0]; }
  $("list").addEventListener("click", function (ev) {
    var b = ev.target.closest("[data-act]"); if (!b) return;
    var act = b.dataset.act, id = b.dataset.id, p = prod(id);
    if (act === "toggle") { state.open[id] = !(p ? isOpen(p) : state.open[id]); state.confirmDel = null; render(); }
    else if (act === "range") { state.range[id] = +b.dataset.r; render(); }
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
        if (wasTracking) state.note[cid] = "Gemt. Priserne for de valgte varianter opdateres inden for et kvarter.";
        render(); fetchProducts();
      }, function () { setRowMsg(cid, "Kunne ikke gemme lige nu. Prøv igen om lidt."); });
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
      var fid = fxF.dataset.fixurl, nu = parsePrisjagt(fxF.querySelector("input").value);
      if (!nu) { setRowMsg(fid, "Linket skal være en adresse på https://prisjagt.dk/ ."); return; }
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
    var v = Number(f.querySelector("input").value), id = f.dataset.edit, p = prod(id);
    if (!p || !(v > 0) || (p.targetType === "pct" && v > 95)) return;
    f.querySelector("input").blur();
    if (v === p.targetValue) { render(); return; }
    sb.from("products").update({ target_value: v }).eq("id", id).then(function (r) {
      if (r && r.error) { onWriteError(r.error); return; }
      p.targetValue = v; render(); fetchProducts();
    }, function () {});
  });
  $("list").addEventListener("focusout", function () { setTimeout(function () { if (renderPending) render(); }, 0); });

  // ---- add form ----
  function syncType() {
    var pct = $("fTypePct").checked;
    $("fValLabel").textContent = pct ? "Mindste rabat i procent" : "Højeste pris i kroner";
    $("fVal").placeholder = pct ? "Mindst" : "Højst";
    $("fVal").max = pct ? "95" : "";
    $("fHint").textContent = pct
      ? "Rabatten regnes fra normalprisen, som findes ved første hentning, ikke fra butikkens egen førpris."
      : "Du får besked, når varen er på lager til den pris eller under.";
  }
  // A value that looks like an address (scheme, www., or a single word with a path) is a link; anything else is a name.
  function looksLikeLink(t) { return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(javascript|data|vbscript|file|mailto):/i.test(t) || /^www\./i.test(t) || /^\S+\.\S+\/\S*$/.test(t) || /prisjagt\.dk/i.test(t) && !/\s/.test(t); }
  $("fTypePrice").addEventListener("change", syncType); $("fTypePct").addEventListener("change", syncType);
  $("addForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var msg = $("fMsg"); msg.hidden = true;
    var fail = function (t) { msg.textContent = t; msg.hidden = false; };
    var raw = $("fMain").value.trim().replace(/\s+/g, " "), v = Number($("fVal").value), pct = $("fTypePct").checked, url = null, name = null;
    if (!raw) { fail("Skriv navnet på varen, eller indsæt et link fra prisjagt.dk."); return; }
    if (looksLikeLink(raw)) {
      url = parsePrisjagt(raw);
      if (!url) { fail("Linket skal være en produktside på https://prisjagt.dk/ . Søg efter varen på prisjagt.dk, åbn den, og kopier adressen."); return; }
    } else {
      if (raw.length < 2 || raw.length > 140) { fail("Navnet skal være mellem 2 og 140 tegn."); return; }
      name = raw;
    }
    if (!(v > 0) || (pct && v > 95)) { fail(pct ? "Skriv en rabat mellem 1 og 95 %." : "Skriv en pris i hele kroner."); return; }
    if (!sb) return;
    var btn = $("fSubmit"); btn.disabled = true;
    var row = url ? { name: PLACEHOLDER, source_url: url, target_type: pct ? "pct" : "price", target_value: v, active: true }
      : { name: name, target_type: pct ? "pct" : "price", target_value: v };
    sb.from("products").insert(row).then(function (r) {
      btn.disabled = false;
      if (r && r.error) {
        if (isDenied(r.error)) { onWriteError(r.error); return; }
        fail(r.error.code === "23514" ? (url ? "Databasen afviste linket eller målet. Tjek, at linket er fra prisjagt.dk." : "Databasen afviste navnet eller målet. Tjek dem, og prøv igen.") : "Kunne ikke gemme lige nu. Prøv igen om lidt.");
        return;
      }
      $("fMain").value = ""; $("fVal").value = "";
      fetchProducts();
    }, function () { btn.disabled = false; fail("Kunne ikke gemme lige nu. Prøv igen om lidt."); });
  });

  // ---- settings ----
  $("shopForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!sb || !user) return;
    var data = { user_id: user.id, shops_always: shopList($("shAlways").value), shops_exclude: shopList($("shExclude").value), shops_only: $("shOnly").checked,
      notify_email: $("shNotify").checked, sound: muted ? "off" : "on" };
    var msg = $("shMsg");
    if (data.shops_only && !data.shops_always.length) { msg.textContent = "Skriv mindst én butik på “tjek altid”-listen først."; return; }
    msg.textContent = "Gemmer …";
    sb.from("profiles").upsert(data).then(function (r) {
      if (r && r.error) { msg.textContent = isDenied(r.error) ? "Din adresse har ikke adgang til at gemme endnu." : "Kunne ikke gemme lige nu. Prøv igen om lidt."; onWriteError(r.error); return; }
      setPrefs({ shops_always: data.shops_always, shops_exclude: data.shops_exclude, shops_only: data.shops_only, notify_email: data.notify_email });
      msg.textContent = "Gemt. Gælder fra næste kørsel.";
    }, function () { msg.textContent = "Kunne ikke gemme lige nu. Prøv igen om lidt."; });
  });

  // ---- sign-in ----
  function otpMessage(e) {
    var m = String(e && e.message || "").toLowerCase(), c = e && e.status, code = String(e && e.code || "").toLowerCase(), all = m + " " + code;
    if (c === 429 || /rate.?limit|too many|only request this after/.test(all)) return "Der er sendt for mange login-links lige nu. Vent et par minutter, og prøv igen.";
    if (/invalid.*e-?mail|e-?mail.*invalid|validation_failed|unable to validate email/.test(all)) return "Det ligner ikke en gyldig e-mailadresse.";
    if (/not allowed|signups? (are |is )?(not allowed|disabled)|hook|database error|not (on|in) the|forbidden|unauthori[sz]ed|otp_disabled|user_not_found|not_allowed/.test(all) || c === 422 || c === 403)
      return "Den adresse er ikke på listen endnu. Ejeren skal tilføje den, før du kan logge ind.";
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
      if (r && r.error) { msg.textContent = otpMessage(r.error); msg.hidden = false; return; }
      $("sentTo").textContent = email; $("sentBox").hidden = false; $("loginForm").hidden = true;
    }, function (e) { btn.disabled = false; msg.textContent = otpMessage(e); msg.hidden = false; });
  });
  $("sentBack").addEventListener("click", function () { $("sentBox").hidden = true; $("loginForm").hidden = false; $("lEmail").focus(); });
  $("logoutBtn").addEventListener("click", function () {
    sb.auth.signOut().then(function () { handleSession(null); }, function () { handleSession(null); });
  });

  function showAuth(errText) {
    $("authView").hidden = false; $("appView").hidden = true; $("acts").hidden = true;
    $("status").textContent = "";
    if (errText) { $("lMsg").textContent = errText; $("lMsg").hidden = false; }
  }
  function showApp() {
    $("authView").hidden = true; $("appView").hidden = false; $("acts").hidden = false;
    $("who").textContent = user.email || "";
    syncSound(); syncType();
  }
  function handleSession(session) {
    if (!session || !session.user) {
      if (user) stopSession();
      user = null; showAuth();
      return;
    }
    if (user && user.id === session.user.id) return;
    if (user) stopSession();
    user = session.user; showApp(); startSession();
  }
  function hashError() {
    var raw = (location.hash || "").replace(/^#/, "") + "&" + (location.search || "").replace(/^\?/, "");
    var q = {}; raw.split("&").forEach(function (kv) { var i = kv.indexOf("="); if (i > 0) q[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, " ")); });
    if (!q.error && !q.error_code) return null;
    try { history.replaceState(null, "", location.pathname); } catch (e) {}
    return /expired|otp_expired|access_denied/.test((q.error_code || "") + " " + (q.error || ""))
      ? "Login-linket er udløbet eller er brugt allerede. Send et nyt." : "Login mislykkedes. Send et nyt login-link.";
  }

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
