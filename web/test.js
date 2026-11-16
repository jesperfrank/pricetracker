// Browser test for the Prisvagten front end. Run: node web/test.js
// Serves web/ from a local http server and replaces the Supabase client with a small in-page fake.
const http = require("http"), fs = require("fs"), path = require("path");
const { chromium } = require("playwright");

const ROOT = __dirname;
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, "test-fixtures.json"), "utf8"));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".mp3": "audio/mpeg", ".json": "application/json" };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("no"); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});

// ---- the in-page fake of the supabase-js surface the app uses ----
const FAKE = `
(function () {
  var init = window.__INIT || {};
  var db = window.__db = { products: init.products || [], profiles: init.profiles || [], ops: [], deny: false, otpError: null,
    session: init.session || null, seq: 100 };
  var authCb = null, rt = [];
  var JOB = ["status","title","variants","offers","history","normal_price","verdict","warning","check_note","last_checked","notified_price","notified_at"];
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function builder(table) {
    var q = { op: "select", payload: null, filters: [], single: null };
    var b = {
      select: function () { return b; }, order: function () { return b; },
      eq: function (c, v) { q.filters.push([c, v]); return b; },
      maybeSingle: function () { q.single = "maybe"; return b; }, single: function () { q.single = "one"; return b; },
      insert: function (o) { q.op = "insert"; q.payload = o; return b; },
      update: function (o) { q.op = "update"; q.payload = o; return b; },
      upsert: function (o) { q.op = "upsert"; q.payload = o; return b; },
      delete: function () { q.op = "delete"; return b; },
      then: function (res, rej) { return run().then(res, rej); }
    };
    function match(r) { return q.filters.every(function (f) { return r[f[0]] === f[1]; }); }
    function run() {
      return new Promise(function (resolve) { setTimeout(function () {
        if (q.op !== "select") db.ops.push({ table: table, op: q.op, payload: clone(q.payload), filters: clone(q.filters) });
        var rows = table === "products" ? db.products : db.profiles;
        if (q.op !== "select" && db.deny) return resolve({ data: null, error: { code: "42501", message: "new row violates row-level security policy" } });
        if (db.failReads && q.op === "select") return resolve({ data: null, error: { message: "boom" } });
        if (q.op === "select") {
          var out = rows.filter(match).map(clone);
          return resolve({ data: q.single ? (out[0] || null) : out, error: null });
        }
        if (q.op === "insert") {
          var r = Object.assign({ id: "new-" + (++db.seq), status: "pending", user_id: "u1", created_at: new Date().toISOString(), tracked_variants: null }, clone(q.payload));
          rows.push(r); return resolve({ data: null, error: null });
        }
        if (q.op === "update") {
          rows.filter(match).forEach(function (r) { Object.keys(q.payload).forEach(function (k) { if (JOB.indexOf(k) < 0) r[k] = clone(q.payload[k]); }); });
          return resolve({ data: null, error: null });
        }
        if (q.op === "upsert") {
          var ex = rows.filter(function (r) { return r.user_id === q.payload.user_id; })[0];
          if (ex) Object.assign(ex, clone(q.payload)); else rows.push(clone(q.payload));
          return resolve({ data: null, error: null });
        }
        if (q.op === "delete") {
          var keep = rows.filter(function (r) { return !match(r); }); rows.length = 0; keep.forEach(function (r) { rows.push(r); });
          return resolve({ data: null, error: null });
        }
      }, 5); });
    }
    return b;
  }
  db.writes = function () { return db.ops.filter(function (o) { return o.table !== 'profiles'; }); };
  window.__emit = function () { rt.forEach(function (f) { f({ eventType: "UPDATE" }); }); };
  window.PV_CREATE_CLIENT = function (url, key) {
    db.created = { url: url, key: key };
    return {
      from: builder,
      auth: {
        getSession: function () { return Promise.resolve({ data: { session: db.session }, error: null }); },
        onAuthStateChange: function (cb) { authCb = cb; return { data: { subscription: { unsubscribe: function () {} } } }; },
        signInWithOtp: function (a) { db.ops.push({ op: "otp", payload: clone(a) }); return Promise.resolve(db.otpError ? { data: null, error: db.otpError } : { data: {}, error: null }); },
        signOut: function () { db.session = null; db.ops.push({ op: "signout" }); if (authCb) authCb("SIGNED_OUT", null); return Promise.resolve({ error: null }); }
      },
      channel: function () { var c = { on: function (t, f, cb) { rt.push(cb); return c; }, subscribe: function () { return c; } }; return c; },
      removeChannel: function () {}
    };
  };
  // audio stubs: count what would be played
  window.__audio = { starts: 0, ctx: 0 };
  function Ctx() { window.__audio.ctx++; this.currentTime = 0; this.destination = {}; this.sampleRate = 44100; }
  Ctx.prototype = { resume: function () {}, close: function () {},
    createDynamicsCompressor: function () { return { connect: function () {} }; },
    createGain: function () { return { gain: {}, connect: function () {} }; },
    createOscillator: function () { return { frequency: {}, connect: function () {}, start: function () { window.__audio.starts++; }, stop: function () {} }; },
    createBufferSource: function () { return { connect: function () {}, start: function () { window.__audio.starts++; } }; } };
  window.AudioContext = Ctx;
  window.OfflineAudioContext = function () { return { decodeAudioData: function () { return Promise.resolve({ fake: true }); } }; };
})();
`;

const results = []; const pageErrors = [];
function check(name, ok, extra) { results.push({ name, ok: !!ok, extra }); console.log((ok ? "PASS " : "FAIL ") + name + (ok ? "" : "  <- " + (extra || ""))); }

let browser;
async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 900, height: opts.height || 900 }, colorScheme: opts.scheme || "light" });
  const page = await ctx.newPage();
  page.on("pageerror", e => pageErrors.push(opts.label + ": " + e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) pageErrors.push(opts.label + " console: " + m.text()); });
  await page.route(/cdn\.jsdelivr\.net/, r => r.fulfill({ contentType: "text/javascript", body: "/* test: client is injected */" }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: "text/css", body: "" }));
  if (opts.config !== false) await page.route(/\/config\.js$/, r => r.fulfill({ contentType: "text/javascript", body: 'window.PV_CONFIG={supabaseUrl:"https://x.supabase.test",supabaseAnonKey:"anon"};' }));
  const init = { session: opts.session === false ? null : { user: { id: "u1", email: "mor@familie.dk" } }, products: opts.products || [], profiles: opts.profiles || [] };
  await page.addInitScript("window.__INIT = " + JSON.stringify(init) + ";");
  if (opts.fake !== false) await page.addInitScript(FAKE);
  if (opts.storage) await page.addInitScript(s => { for (const k in s) localStorage.setItem(k, s[k]); }, opts.storage);
  await page.goto(base + "/index.html");
  return page;
}
const row = (id, over) => Object.assign({ id, user_id: "u1", shops_always: null, shops_exclude: null, shops_only: null }, JSON.parse(JSON.stringify(FIX[id.split("#")[0]] || {})), over || {});
const ops = page => page.evaluate(() => window.__db.writes());

const pendingRow = { id: "p1", user_id: "u1", name: "Nyt produkt", source_url: "https://prisjagt.dk/produkt/ny", target_type: "price", target_value: 500, status: "pending", created_at: new Date().toISOString(), tracked_variants: null, active: true };
const chooseRow = { id: "c1", user_id: "u1", name: "Nyt produkt", title: "Sony WH-1000XM5", source_url: "https://prisjagt.dk/produkt/sony", target_type: "pct", target_value: 15, status: "choose", created_at: new Date().toISOString(), active: true, tracked_variants: null,
  variants: [{ id: "va", label: "Sort", lowest: 2049, offers: 8 }, { id: "vb", label: "Sølv", lowest: 2199, offers: 3 }, { id: "vc", label: "Midnatsblå <b>x</b>", lowest: 2299, offers: 1 }] };
const errorRow = { id: "e1", user_id: "u1", name: "Defekt link", source_url: "https://prisjagt.dk/produkt/dead", target_type: "price", target_value: 100, status: "error", check_note: "Siden findes ikke længere på prisjagt.dk <script>1</script>", created_at: new Date().toISOString(), active: true, tracked_variants: null };
let base;

(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch();

  // 1. empty config
  {
    const p = await open({ config: false, fake: false, label: "empty-config" });
    const t = await p.textContent("#setupMsg");
    check("empty config shows 'ikke sat op endnu'", await p.isVisible("#setupMsg") && /ikke sat op endnu/.test(t), t);
    check("empty config hides login and app", !(await p.isVisible("#authView")) && !(await p.isVisible("#appView")));
    await p.context().close();
  }

  // 2. signed out
  {
    const p = await open({ session: false, label: "signed-out" });
    check("signed-out: wordmark, email field and button", await p.isVisible("h1") && await p.isVisible("#lEmail") && /Send login-link/.test(await p.textContent("#lSubmit")));
    check("signed-out: no sound/logout in header", !(await p.isVisible("#acts")));
    await p.fill("#lEmail", "ikke-en-adresse"); await p.click("#lSubmit");
    check("signed-out: bad address rejected locally", /gyldig|e-mailadresse/.test(await p.textContent("#lMsg")) && (await ops(p)).length === 0);
    await p.fill("#lEmail", "mor@familie.dk"); await p.click("#lSubmit");
    await p.waitForSelector("#sentBox:not([hidden])");
    check("signed-out: 'Tjek din indbakke' with address", /Tjek din indbakke/.test(await p.textContent("#sentBox")) && (await p.textContent("#sentTo")) === "mor@familie.dk");
    const o = (await ops(p)).find(x => x.op === "otp");
    check("signed-out: signInWithOtp with emailRedirectTo = page URL", o && o.payload.email === "mor@familie.dk" && o.payload.options.emailRedirectTo === base + "/index.html", JSON.stringify(o));
    await p.click("#sentBack");
    check("signed-out: can go back", await p.isVisible("#loginForm"));
    const cases = [
      [{ status: 429, message: "email rate limit exceeded" }, /for mange|Vent/],
      [{ status: 422, message: "Signups not allowed for otp" }, /jeren/i],
      [{ status: 500, message: "Error sending magic link email", code: "unexpected_failure" }, /Kunne ikke sende/],
      [{ message: "Database error saving new user", status: 500 }, /jeren/i]
    ];
    for (const [err, re] of cases) {
      await p.evaluate(e => { window.__db.otpError = e; }, err);
      await p.fill("#lEmail", "x@y.dk"); await p.click("#lSubmit");
      await p.waitForFunction(() => !document.getElementById("lMsg").hidden);
      const t = await p.textContent("#lMsg");
      check("signed-out: error '" + (err.message) + "' -> specific Danish text", re.test(t), t);
      await p.evaluate(() => { document.getElementById("lMsg").hidden = true; });
    }
    await p.context().close();
  }

  // 2b. link error in URL hash
  {
    const p = await open({ session: false, label: "hash" });
    await p.goto(base + "/index.html?r=1#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired");
    await p.waitForFunction(() => !document.getElementById("lMsg").hidden);
    check("expired login link gives a message", /udløbet/.test(await p.textContent("#lMsg")));
    await p.context().close();
  }

  // 3. signed in, four states
  const all = [row("test-sony-xm5", { id: "x5", target_value: 1700 }), row("test-ps5-pro", { id: "ps" }), row("test-dyson-v15", { id: "dy" }), pendingRow, chooseRow, errorRow];
  {
    const p = await open({ products: all, label: "states" });
    await p.waitForSelector(".item");
    check("signed in: email, log ud, sound toggle in header", /mor@familie\.dk/.test(await p.textContent("#who")) && await p.isVisible("#logoutBtn") && await p.isVisible("#soundBtn"));
    const st = await p.textContent("#status");
    check("status line: last updated, every quarter, Black Friday", /opdateret/.test(st) && /hvert kvarter/.test(st) && /Black Friday/.test(st), st);
    check("six rows shown", (await p.locator(".item").count()) === 6);
    const pend = await p.locator('.item[data-status="pending"]').textContent();
    check("pending row text", /Henter produktet … klar inden for et kvarter/.test(pend), pend);
    check("pending row uses placeholder name until title", /Nyt produkt/.test(pend));
    const ch = p.locator('.item[data-status="choose"]');
    check("choose row opens by itself with 3 variants and prices", (await ch.locator('input[data-var]').count()) === 3 && /fra 2\.049 kr\./.test(await ch.textContent()) && /8 tilbud/.test(await ch.textContent()));
    check("choose row shows title (name is placeholder)", /Sony WH-1000XM5/.test(await ch.locator("h2").textContent()));
    check("variant label is escaped", (await ch.locator(".var b").count()) === 0 && /<b>x<\/b>/.test(await ch.textContent()));
    const er = p.locator('.item[data-status="error"]');
    await er.locator(".head").click();
    check("error row: check_note as text (escaped), fix-link form and remove", /findes ikke længere/.test(await er.textContent()) && (await er.locator("script").count()) === 0 && await er.locator("[data-fixurl]").isVisible() && await er.locator('[data-act="del"]').isVisible());
    const tr = p.locator('.item[data-status="tracking"]').first();
    await p.locator('.item[data-status="tracking"] .head').first().click();
    const tt = await p.locator('.item[data-status="tracking"] .body').first().textContent();
    check("tracking row: verdict, stats, chart, shops table, goal edit, prefs, change variant", /Laveste nu/.test(tt) && /Normalpris/.test(tt) && /Butikker/.test(tt) && /Skift variant/.test(tt) && /Butikker for dette produkt/.test(tt) && await p.locator(".chart svg").first().isVisible(), tt.slice(0, 200));
    // chart interactions
    const box = await p.locator(".chart svg").first().boundingBox();
    await p.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
    check("chart hover tooltip", await p.locator(".chart .tip").first().isVisible());
    await p.locator('.ranges button[data-r="30"]').first().click();
    check("range button switches", (await p.locator('.ranges button[aria-pressed="true"]').first().textContent()) === "1 md.");
    check("chart table view exists", (await p.locator("details summary", { hasText: "Vis som tabel" }).count()) >= 1);
    await p.context().close();
  }

  // 4. choose variants
  {
    const p = await open({ products: [chooseRow], label: "choose" });
    await p.waitForSelector("[data-choose]");
    await p.click('[data-choose] button[type=submit]');
    check("choose: nothing ticked -> message, no write", /mindst én/.test(await p.textContent("[data-rowmsg]")) && (await ops(p)).length === 0);
    await p.check('input[data-var="va"]'); await p.check('input[data-var="vc"]');
    await p.click('[data-choose] button[type=submit]');
    await p.waitForFunction(() => window.__db.writes().length > 0);
    const o = (await ops(p))[0];
    check("choose: writes tracked_variants", o.table === "products" && o.op === "update" && JSON.stringify(o.payload) === '{"tracked_variants":["va","vc"]}' && o.filters[0][1] === "c1", JSON.stringify(o));
    await p.waitForFunction(() => /Varianten er valgt/.test(document.body.textContent));
    check("choose: row waits for next fetch afterwards", true);
    await p.context().close();
  }

  // 5. add product
  {
    const p = await open({ products: [], label: "add" });
    await p.waitForSelector("#addForm:not([hidden])");
    check("add: empty list text and how-to line", /Ingen produkter endnu/.test(await p.textContent("#list")) && /Søg efter varen på prisjagt\.dk/.test(await p.textContent("#fHelp")));
    for (const bad of ["", "tekst", "http://prisjagt.dk/p/1", "https://example.com/prisjagt.dk/p/1", "https://prisjagt.dk.evil.com/p/1", "https://prisjagt.dk/", "javascript:alert(1)"]) {
      await p.fill("#fUrl", bad); await p.fill("#fVal", "1000"); await p.evaluate(() => document.getElementById("addForm").requestSubmit());
      const vis = await p.isVisible("#fMsg");
      if (!vis || (await ops(p)).length) { check("add: rejects '" + bad + "'", false, "msg visible=" + vis); }
    }
    check("add: bad URLs rejected, no insert", (await ops(p)).length === 0 && /prisjagt\.dk/.test(await p.textContent("#fMsg")));
    await p.fill("#fUrl", "https://www.prisjagt.dk/produkt/sony-wh-1000xm5-p123?x=1"); await p.fill("#fVal", "0");
    await p.evaluate(() => document.getElementById("addForm").requestSubmit());
    check("add: zero goal rejected", (await ops(p)).length === 0 && /pris/.test(await p.textContent("#fMsg")));
    await p.fill("#fVal", "1500"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 1);
    let o = (await ops(p))[0];
    check("add: insert fields (placeholder name, normalised URL, kr goal; no user_id/status)",
      o.table === "products" && o.op === "insert" && JSON.stringify(o.payload) === JSON.stringify({ name: "Nyt produkt", source_url: "https://prisjagt.dk/produkt/sony-wh-1000xm5-p123?x=1", target_type: "price", target_value: 1500, active: true }), JSON.stringify(o.payload));
    await p.waitForSelector('.item[data-status="pending"]');
    check("add: new row appears as pending", true);
    await p.fill("#fUrl", "https://prisjagt.dk/produkt/lego-p9"); await p.fill("#fName", "LEGO Falcon"); await p.click(".unit label:has(#fTypePct)"); await p.fill("#fVal", "20"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 2);
    o = (await ops(p))[1];
    check("add: own name and % goal", o.payload.name === "LEGO Falcon" && o.payload.target_type === "pct" && o.payload.target_value === 20, JSON.stringify(o.payload));
    await p.fill("#fUrl", "https://prisjagt.dk/produkt/x"); await p.fill("#fVal", "99"); await p.evaluate(() => document.getElementById("addForm").requestSubmit());
    check("add: % above 95 rejected", (await ops(p)).length === 2 && /95/.test(await p.textContent("#fMsg")));
    await p.evaluate(() => { window.__db.deny = true; });
    await p.fill("#fVal", "20"); await p.click("#fSubmit");
    await p.waitForSelector("#readonly:not([hidden])");
    check("add: rejected write (not on allow-list) shows the notice", /ikke adgang/.test(await p.textContent("#readonly")) && !(await p.isVisible("#addForm")));
    await p.context().close();
  }

  // 6. goal edit + 7. delete + 8. shop prefs
  {
    const p = await open({ products: [row("test-sony-xm5", { id: "x5", target_value: 1700 }), row("test-lego-falcon", { id: "lg" })], label: "edit" });
    await p.waitForSelector(".item");
    await p.locator('.head[data-id="x5"]').click();
    await p.fill('#e-x5', "1900"); await p.click('[data-edit="x5"] button[type=submit]');
    await p.waitForFunction(() => window.__db.writes().length === 1);
    let o = (await ops(p))[0];
    check("goal edit: update target_value only", o.op === "update" && JSON.stringify(o.payload) === '{"target_value":1900}' && o.filters[0][1] === "x5", JSON.stringify(o));
    await p.waitForFunction(() => /mål 1\.900 kr\./.test(document.body.textContent));
    check("goal edit: shown after refetch", true);

    await p.click('[data-act="del"][data-id="x5"]');
    check("delete: asks first", /Fjern produktet og dets historik\?/.test(await p.textContent('.item .body')) && (await ops(p)).length === 1);
    await p.click('[data-act="del-no"]');
    check("delete: 'Behold' cancels", (await ops(p)).length === 1 && await p.isVisible('[data-edit="x5"]'));
    await p.click('[data-act="del"][data-id="x5"]'); await p.click('[data-act="del-yes"]');
    await p.waitForFunction(() => window.__db.writes().length === 2);
    o = (await ops(p))[1];
    check("delete: confirmed -> delete op, row gone", o.op === "delete" && o.filters[0][1] === "x5" && (await p.locator(".item").count()) === 1);

    // per-product prefs
    await p.locator('.head[data-id="lg"]').click();
    await p.locator("details.pshops summary").click();
    await p.fill("#sa-lg", "Proshop, hifiklubben.dk"); await p.fill("#se-lg", "CDON"); await p.check("#so-lg");
    await p.click('[data-shops="lg"] button[type=submit]');
    await p.waitForFunction(() => window.__db.writes().length === 3);
    o = (await ops(p))[2];
    check("product shop prefs saved as arrays", o.op === "update" && JSON.stringify(o.payload) === '{"shops_always":["Proshop","hifiklubben.dk"],"shops_exclude":["CDON"],"shops_only":true}', JSON.stringify(o.payload));

    // general prefs + notify
    await p.locator("#settingsBox summary").click();
    check("settings: profile row created on first login", await p.evaluate(() => window.__db.profiles.length === 1 && window.__db.profiles[0].user_id === "u1"));
    await p.fill("#shAlways", "Magasin"); await p.fill("#shExclude", "Coolshop, Power"); await p.check("#shOnly"); await p.uncheck("#shNotify");
    await p.click('#shopForm button[type=submit]');
    await p.waitForFunction(() => window.__db.ops.some(x => x.table === "profiles" && x.payload.shops_always));
    const pr = await p.evaluate(() => window.__db.profiles[0]);
    check("settings: prefs and notify_email saved", JSON.stringify(pr.shops_always) === '["Magasin"]' && JSON.stringify(pr.shops_exclude) === '["Coolshop","Power"]' && pr.shops_only === true && pr.notify_email === false, JSON.stringify(pr));
    await p.check("#shNotify"); await p.uncheck("#shOnly"); await p.fill("#shAlways", "");
    await p.click('#shopForm button[type=submit]');
    await p.waitForFunction(() => window.__db.profiles[0].notify_email === true);
    check("settings: notify toggles back on", true);
    await p.click("#logoutBtn");
    await p.waitForSelector("#authView:not([hidden])");
    check("log out returns to login screen", !(await p.isVisible("#appView")));
    await p.context().close();
  }

  // 9. celebration
  {
    const p = await open({ products: [row("test-sony-xm5", { id: "x5", target_value: 1700 })], label: "celebrate" });
    await p.waitForSelector(".item");
    await p.waitForTimeout(300);
    await p.click("h1");   // first interaction
    const c0 = await p.evaluate(() => (window.__pvCelebrations || []).length);
    check("celebration: nothing for a row that is not a hit", c0 === 0);
    await p.evaluate(() => { window.__db.products[0].target_value = 2100; window.__emit(); });
    await p.waitForFunction(() => (window.__pvCelebrations || []).length >= 1, null, { timeout: 8000 });
    const c = await p.evaluate(() => ({ cel: window.__pvCelebrations, audio: window.__audio, canvas: document.querySelectorAll("canvas.confetti").length }));
    check("celebration: realtime change to a hit -> tier 1 + confetti + audio", c.cel[0].tier === 1 && c.cel[0].ids[0] === "x5" && c.canvas === 1 && c.audio.starts > 0, JSON.stringify(c));
    check("hit row is marked", await p.locator(".item.hit").count() === 1 && /Mål nået/.test(await p.textContent(".item.hit .meta")));
    await p.evaluate(() => { window.__db.products[0].target_value = 1700; window.__emit(); });
    await p.waitForFunction(() => document.querySelectorAll(".item.hit").length === 0, null, { timeout: 8000 });
    check("hit clears when price no longer meets goal", true);
    await p.context().close();

    // hit already present at load: waits for the first click
    const q = await open({ products: [row("test-sony-xm5", { id: "x5", target_value: 2100 })], label: "celebrate-load" });
    await q.waitForSelector(".item.hit"); await q.waitForTimeout(400);
    check("celebration: not before first click", (await q.evaluate(() => (window.__pvCelebrations || []).length)) === 0);
    await q.click("h1");
    check("celebration: on first click after load", (await q.evaluate(() => (window.__pvCelebrations || []).length)) === 1);
    await q.context().close();

    // tiers 2 and 3
    const good = { verdict: { level: "good", text: "Godt tilbud." } };
    const t2 = row("test-sony-xm5", Object.assign({ id: "t2", target_value: 2100 }, good));
    const t3 = row("test-sony-xm5", Object.assign({ id: "t3", target_value: 2100 }, good)); t3.offers[0].price = 1500;
    const r = await open({ products: [t2], label: "tier2" }); await r.waitForSelector(".item.hit"); await r.click("h1");
    check("celebration tier 2 (verdict good)", (await r.evaluate(() => window.__pvCelebrations[0].tier)) === 2); await r.context().close();
    const s = await open({ products: [t3], label: "tier3" }); await s.waitForSelector(".item.hit"); await s.click("h1");
    check("celebration tier 3 (lowest in whole history)", (await s.evaluate(() => window.__pvCelebrations[0].tier)) === 3); await s.context().close();

    // muted: no celebration; toggle remembered
    const m = await open({ products: [row("test-sony-xm5", { id: "x5", target_value: 2100 })], label: "muted", storage: { "pv-muted": "1" } });
    await m.waitForSelector(".item.hit"); await m.click("h1");
    check("muted: no celebration", (await m.evaluate(() => (window.__pvCelebrations || []).length)) === 0 && /Lyd fra/.test(await m.textContent("#soundBtn")));
    await m.click("#soundBtn");
    check("sound toggle remembered in localStorage", (await m.evaluate(() => localStorage.getItem("pv-muted"))) === "0" && /Lyd til/.test(await m.textContent("#soundBtn")));
    await m.click("#tryBtn");
    check("'Prøv lyden' plays", (await m.evaluate(() => window.__audio.starts)) > 0);
    await m.context().close();
  }

  // 10. 60-second polling / focus refetch
  {
    const p = await open({ products: [row("test-sony-xm5", { id: "x5" })], label: "refetch" });
    await p.waitForSelector(".item");
    await p.evaluate(() => { window.__db.products.push(JSON.parse(JSON.stringify(window.__db.products[0])), {}); window.__db.products.pop(); window.__db.products[1].id = "x6"; window.__db.products[1].name = "Nyt fra serveren"; });
    await p.waitForTimeout(3300);
    await p.evaluate(() => window.dispatchEvent(new Event("focus")));
    await p.waitForFunction(() => document.querySelectorAll(".item").length === 2, null, { timeout: 6000 });
    check("refetch on tab focus picks up new rows", true);
    await p.context().close();
  }

  // 11. layout at 400px, 12. screenshots
  {
    const states = all.concat([row("test-lego-falcon", { id: "lg" }), row("test-sonicare", { id: "so" })]);
    const p = await open({ products: states, width: 400, height: 900, label: "mobile" });
    await p.waitForSelector(".item");
    for (const id of ["x5", "ps", "dy", "lg", "so", "p1", "e1"]) await p.locator('.head[data-id="' + id + '"]').click();
    await p.locator("#settingsBox summary").click();
    await p.waitForTimeout(300);
    const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
    check("no horizontal overflow at 400 px (all rows open)", w.sw <= w.cw && w.bw <= w.cw, JSON.stringify(w));
    await p.screenshot({ path: path.join(ROOT, "screenshot-mobile.png"), fullPage: true });
    const q = await open({ products: states.concat([]), width: 400, session: false, label: "mobile-out" });
    const w2 = await q.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    check("no horizontal overflow signed out at 400 px", w2);
    await p.context().close(); await q.context().close();

    for (const scheme of ["light", "dark"]) {
      const d = await open({ products: states, scheme, label: "shot-" + scheme });
      await d.waitForSelector(".item");
      await d.locator('.head[data-id="x5"]').click();
      await d.locator('.head[data-id="x5"]').scrollIntoViewIfNeeded();
      await d.waitForSelector("canvas.confetti", { state: "detached", timeout: 8000 }).catch(() => {});
      await d.waitForTimeout(250);
      await d.screenshot({ path: path.join(ROOT, "screenshot-" + scheme + ".png"), fullPage: true });
      const s = await open({ session: false, scheme, label: "shot-out-" + scheme });
      await s.screenshot({ path: path.join(ROOT, "screenshot-login-" + scheme + ".png") });
      await d.context().close(); await s.context().close();
    }
    check("screenshots saved", ["screenshot-light.png", "screenshot-dark.png", "screenshot-mobile.png"].every(f => fs.existsSync(path.join(ROOT, f))));
  }

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
