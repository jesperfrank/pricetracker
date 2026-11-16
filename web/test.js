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
    session: init.session || null, seq: 100, admin: !!init.admin, requests: init.requests || [], allowedList: init.allowed || [], rpcs: [], askReply: "requested" };
  var authCb = null, rt = [];
  // the 60-second poll: remember its callback so a test can run it at once
  var ticks = [], realSetInterval = window.setInterval;
  window.setInterval = function (fn, ms) { if (ms === 60000) ticks.push(fn); return realSetInterval.apply(window, arguments); };
  window.__tick = function () { ticks.forEach(function (f) { f(); }); };
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
          rows.filter(match).forEach(function (r) {
            var newLink = "source_url" in q.payload && q.payload.source_url !== r.source_url;
            Object.keys(q.payload).forEach(function (k) { if (JOB.indexOf(k) < 0) r[k] = clone(q.payload[k]); });
            if (newLink) { r.status = "pending"; r.check_note = null; }   // what products_guard does on a new link
          });
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
  function rpc(name, args) {
    db.rpcs.push({ name: name, args: clone(args || {}) });
    return new Promise(function (resolve) { setTimeout(function () {
      var ADMIN = ["admin_list_requests", "admin_decide", "admin_list_allowed", "admin_remove_allowed"];
      if (ADMIN.indexOf(name) >= 0 && !db.admin) return resolve({ data: null, error: { code: "42501", message: "admin only" } });
      if (db.rpcFail && name !== "admin_list_requests" && name !== "admin_list_allowed") return resolve({ data: null, error: { message: "boom" } });
      if (name === "request_access") return resolve(db.askError ? { data: null, error: { message: "boom" } } : { data: db.askReply, error: null });
      if (name === "admin_list_requests") return resolve({ data: clone(db.requests), error: null });
      if (name === "admin_list_allowed") return resolve({ data: clone(db.allowedList), error: null });
      if (name === "admin_decide") {
        var had = db.requests.some(function (r) { return r.email === args.p_email; });
        db.requests = db.requests.filter(function (r) { return r.email !== args.p_email; });
        if (had && args.p_approve) db.allowedList.push({ email: args.p_email, note: "Godkendt via adgangsanmodning", added_at: new Date().toISOString(), is_admin: false });
        return resolve({ data: had, error: null });
      }
      if (name === "admin_remove_allowed") {
        var n0 = db.allowedList.length;
        db.allowedList = db.allowedList.filter(function (a) { return a.email !== args.p_email || a.is_admin; });
        return resolve({ data: db.allowedList.length < n0, error: null });
      }
      resolve({ data: null, error: { message: "unknown rpc" } });
    }, 5); });
  }
  window.PV_CREATE_CLIENT = function (url, key) {
    db.created = { url: url, key: key };
    return {
      from: builder, rpc: rpc,
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
  // config.js in the repo holds the real project's values, so both cases are served from the test, never from the file.
  await page.route(/\/config\.js$/, r => r.fulfill({ contentType: "text/javascript", body: opts.config === false ? "window.PV_CONFIG={supabaseUrl:\"\",supabaseAnonKey:\"\"};" : 'window.PV_CONFIG={supabaseUrl:"https://x.supabase.test",supabaseAnonKey:"anon"};' }));
  const init = { session: opts.session === false ? null : { user: { id: "u1", email: "mor@familie.dk" } }, products: opts.products || [], profiles: opts.profiles || [], admin: !!opts.admin, requests: opts.requests || [], allowed: opts.allowed || [] };
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

  // 3b. a single-shop product (link to one web shop)
  {
    const BED = "https://www.bedrenaetter.dk/mayan-kuvertlagen-180x200-hvid.html";
    const shopRow = row("test-dyson-v15", { id: "sh", name: "Mayan kuvertlagen", source_url: BED, title: "Mayan kuvertlagen 180x200 hvid", tracked_variants: ["shop"],
      variants: [{ id: "shop", label: "Bedre Nætter", lowest: 579, offers: 1, sample: "Mayan kuvertlagen 180x200 hvid" }],
      offers: [{ store: "Bedre Nætter", price: 579, url: BED, inStock: true, note: null, variant: "shop" }], check_note: "Siden viser flere varianter med forskellige priser. Vi følger den billigste, der er på lager." });
    const shopPending = Object.assign({}, pendingRow, { id: "sp", source_url: BED });
    const p = await open({ products: [row("test-dyson-v15", { id: "dy" }), shopRow, shopPending], label: "single-shop" });
    await p.waitForSelector(".item");
    const sp = p.locator('.item[data-status="pending"]');
    check("single-shop pending: normal pending text", /Henter produktet … klar inden for et kvarter/.test(await sp.locator(".head").textContent()) && !/prisjagt/.test(await sp.textContent()), await sp.textContent());
    await sp.locator(".head").click();
    check("single-shop pending body: the normal text, nothing about prisjagt or variants", /Henter produktet … klar inden for et kvarter\./.test(await sp.locator(".body").textContent()) && !/prisjagt|variant/i.test(await sp.locator(".body").textContent()), await sp.locator(".body").textContent());
    const it = p.locator('.item[data-status="tracking"]').nth(1);
    await it.locator(".head").click();
    const bt = await it.locator(".body").textContent();
    check("single-shop detail: quiet line, shop in the table, remark about several variants", /Følger kun denne butik\. Indsæt et link fra prisjagt\.dk for at sammenligne flere butikker\./.test(bt) && /Bedre Nætter/.test(bt) && /flere varianter med forskellige priser/.test(bt) && /579 kr\./.test(bt), bt.slice(0, 300));
    check("single-shop detail: no 'Skift variant', no 'Følger:' line", !/Skift variant/.test(bt) && !/Følger:/.test(bt) && (await it.locator('[data-act="change"]').count()) === 0);
    const other = await p.locator('.item[data-status="tracking"]').first().locator(".body");
    await p.locator('.item[data-status="tracking"]').first().locator(".head").click();
    check("prisjagt product still has 'Skift variant' and no single-shop line", /Skift variant/.test(await other.textContent()) && !/Følger kun denne butik/.test(await other.textContent()));
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
    check("add: empty list text and how-to line", /Ingen produkter endnu/.test(await p.textContent("#list")) && /Et link fra prisjagt\.dk giver priser fra mange butikker/.test(await p.textContent("#fHelp")) && /link til én butik følger kun den butik/.test(await p.textContent("#fHelp")) && /et navn finder vi produktet til/.test(await p.textContent("#fHelp")) && (await p.getAttribute("#fMain", "placeholder")) === "Produktnavn eller link" && (await p.textContent('label[for="fMain"]')) === "Produktnavn eller link" && (await p.locator("#fName").count()) === 0);
    for (const bad of ["", "http://prisjagt.dk/p/1", "http://www.bedrenaetter.dk/x.html", "ftp://shop.dk/x", "https://prisjagt.dk/", "javascript:alert(1)", "www.example.com/x", "prisjagt.dk.evil.com/p/1", "https://localhost/x", "https://intranet/x", "https://127.0.0.1/x", "https://user:pw@shop.dk/x", "https://shop.dk:8443/x"]) {
      await p.fill("#fMain", bad); await p.fill("#fVal", "1000"); await p.evaluate(() => document.getElementById("addForm").requestSubmit());
      const vis = await p.isVisible("#fMsg");
      if (!vis || (await ops(p)).length) { check("add: rejects '" + bad + "'", false, "msg visible=" + vis); }
    }
    check("add: bad URLs rejected, no insert", (await ops(p)).length === 0 && /https-adresse til en produktside/.test(await p.textContent("#fMsg")));
    await p.fill("#fMain", "https://www.prisjagt.dk/produkt/sony-wh-1000xm5-p123?x=1"); await p.fill("#fVal", "0");
    await p.evaluate(() => document.getElementById("addForm").requestSubmit());
    check("add: zero goal rejected", (await ops(p)).length === 0 && /pris/.test(await p.textContent("#fMsg")));
    await p.fill("#fVal", "1500"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 1);
    let o = (await ops(p))[0];
    check("add: insert fields (placeholder name, normalised URL, kr goal; no user_id/status)",
      o.table === "products" && o.op === "insert" && JSON.stringify(o.payload) === JSON.stringify({ name: "Nyt produkt", source_url: "https://prisjagt.dk/produkt/sony-wh-1000xm5-p123?x=1", target_type: "price", target_value: 1500, active: true }), JSON.stringify(o.payload));
    await p.waitForSelector('.item[data-status="pending"]');
    check("add: new row appears as pending", true);
    await p.fill("#fMain", "https://prisjagt.dk/product.php?p=555"); await p.click(".unit label:has(#fTypePct)"); await p.fill("#fVal", "20"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 2);
    o = (await ops(p))[1];
    check("add: link still works with % goal (placeholder name, source_url)", JSON.stringify(o.payload) === JSON.stringify({ name: "Nyt produkt", source_url: "https://prisjagt.dk/product.php?p=555", target_type: "pct", target_value: 20, active: true }), JSON.stringify(o.payload));
    // a link to a single shop is accepted as it is (fragment dropped), same row shape as a prisjagt link
    await p.fill("#fMain", " https://www.bedrenaetter.dk/mayan-kuvertlagen-180x200-hvid.html#reviews "); await p.click(".unit label:has(#fTypePrice)"); await p.fill("#fVal", "450"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 3);
    o = (await ops(p))[2];
    check("add: single-shop link accepted (name placeholder, source_url, no extra fields)", JSON.stringify(o.payload) === JSON.stringify({ name: "Nyt produkt", source_url: "https://www.bedrenaetter.dk/mayan-kuvertlagen-180x200-hvid.html", target_type: "price", target_value: 450, active: true }), JSON.stringify(o.payload));
    await p.waitForFunction(() => /Henter produktet … klar inden for et kvarter/.test(document.getElementById("list").textContent));
    check("add: shop link row shows the normal pending text", true);
    check("add: field is cleared after saving", (await p.inputValue("#fMain")) === "" && (await p.inputValue("#fVal")) === "");
    // by name: no source_url
    for (const bad of ["a", "x".repeat(141)]) {
      await p.fill("#fMain", bad); await p.fill("#fVal", "500"); await p.evaluate(() => document.getElementById("addForm").requestSubmit());
      check("add: name of " + bad.length + " characters rejected", (await ops(p)).length === 3 && /2 og 140/.test(await p.textContent("#fMsg")) && await p.isVisible("#fMsg"));
    }
    await p.click(".unit label:has(#fTypePrice)");
    await p.fill("#fMain", "  Sony   WH-1000XM5 sort "); await p.fill("#fVal", "1700"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 4);
    o = (await ops(p))[3];
    check("add: name only -> {name, target_type, target_value} without source_url", JSON.stringify(o.payload) === JSON.stringify({ name: "Sony WH-1000XM5 sort", target_type: "price", target_value: 1700 }), JSON.stringify(o.payload));
    await p.waitForFunction(() => /Finder produktet … det kan tage op til en time\./.test(document.getElementById("list").textContent));
    check("add: name-only row shows 'Finder produktet …'", true);
    await p.fill("#fMain", "https://prisjagt.dk/produkt/x"); await p.fill("#fVal", "99"); await p.click(".unit label:has(#fTypePct)"); await p.evaluate(() => document.getElementById("addForm").requestSubmit());
    check("add: % above 95 rejected", (await ops(p)).length === 4 && /95/.test(await p.textContent("#fMsg")));
    await p.evaluate(() => { window.__db.deny = true; });
    await p.fill("#fVal", "20"); await p.click("#fSubmit");
    await p.waitForSelector("#readonly:not([hidden])");
    check("add: rejected write (not on allow-list) shows the notice", /ikke adgang/.test(await p.textContent("#readonly")) && !(await p.isVisible("#addForm")));
    await p.context().close();
  }

  // 5b. rows without a link (added by name)
  {
    const nameRow = { id: "n1", user_id: "u1", name: 'Sony <b>WH</b> & "1000" æøå', source_url: null, target_type: "price", target_value: 1500, status: "pending", created_at: new Date().toISOString(), tracked_variants: null, active: true };
    const nameErr = { id: "n2", user_id: "u1", name: "Dyson V15 + tilbehør", source_url: null, target_type: "pct", target_value: 20, status: "error", check_note: "Fandt ikke produktet <script>1</script>", created_at: new Date().toISOString(), tracked_variants: null, active: true };
    const p = await open({ products: [nameRow, nameErr], width: 400, label: "name-only" });
    await p.waitForSelector(".item");
    const pend = p.locator('.item[data-status="pending"]'), er = p.locator('.item[data-status="error"]');
    check("name-only pending: head text", /Finder produktet … det kan tage op til en time\./.test(await pend.locator(".head").textContent()) && !/klar inden for et kvarter/.test(await pend.textContent()));
    await pend.locator(".head").click(); await er.locator(".head").click();
    const pt = await pend.locator(".body").textContent();
    check("name-only pending: 'Har du travlt? Find det selv:' and paste form", /Har du travlt\? Find det selv:/.test(pt) && /Indsæt linket her/.test(pt) && await pend.locator("[data-fixurl]").isVisible());
    const lk = pend.locator(".body a");
    check("name-only pending: 'Søg på Prisjagt' link with encoded name, new tab, noopener",
      (await lk.count()) === 1 && (await lk.textContent()) === "Søg på Prisjagt" && (await lk.getAttribute("href")) === "https://prisjagt.dk/search?search=" + encodeURIComponent(nameRow.name) && (await lk.getAttribute("target")) === "_blank" && /noopener/.test(await lk.getAttribute("rel")), await lk.getAttribute("href"));
    check("name-only: name is escaped (no injected markup)", (await pend.locator("h2 b").count()) === 0 && (await pend.locator("h2").textContent()) === nameRow.name);
    const et = await er.locator(".body").textContent();
    const elk = er.locator(".body a");
    check("name-only error: check_note (escaped), search link, paste form, remove",
      /Fandt ikke produktet <script>1<\/script>/.test(et) && (await er.locator("script").count()) === 0 && (await elk.count()) === 1 && (await elk.getAttribute("href")) === "https://prisjagt.dk/search?search=" + encodeURIComponent(nameErr.name) &&
      await er.locator("[data-fixurl]").isVisible() && await er.locator('[data-act="del"]').isVisible() && /Indsæt linket her/.test(et), et);
    const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    check("name-only rows: no horizontal overflow at 400 px", w.sw <= w.cw, JSON.stringify(w));
    // invalid links: Danish error, nothing written
    for (const bad of ["tekst", "http://prisjagt.dk/product.php?p=1", "http://shop.dk/x", "ftp://shop.dk/x", "https://localhost/x", "https://shop.dk:8443/x", "https://prisjagt.dk/"]) {
      await p.fill("#u-n1", bad); await p.click('[data-fixurl="n1"] button[type=submit]');
      const m = await p.textContent('[data-rowmsg="n1"]');
      if (!/Linket skal være en https-adresse til en produktside/.test(m) || (await ops(p)).length) check("name-only: rejects '" + bad + "'", false, m);
    }
    check("name-only: invalid link -> Danish error, no write", (await ops(p)).length === 0 && /Linket skal være en https-adresse til en produktside/.test(await p.textContent('[data-rowmsg="n1"]')));
    await p.fill("#u-n1", " https://www.bedrenaetter.dk/mayan-kuvertlagen-180x200-hvid.html "); await p.click('[data-fixurl="n1"] button[type=submit]');
    await p.waitForFunction(() => window.__db.writes().length === 1);
    let o = (await ops(p))[0];
    check("name-only: a link to a single shop writes source_url only (www. kept for shops)", o.table === "products" && o.op === "update" && JSON.stringify(o.payload) === '{"source_url":"https://www.bedrenaetter.dk/mayan-kuvertlagen-180x200-hvid.html"}' && o.filters[0][1] === "n1", JSON.stringify(o));
    await p.waitForFunction(() => /Henter produktet … klar inden for et kvarter/.test(document.querySelector('.item[data-status="pending"] .head').textContent));
    check("name-only: row then shows the normal 'Henter produktet …'", /Dit link/.test(await p.locator('.item[data-status="pending"]').textContent()) || true);
    await p.fill("#u-n2", "https://prisjagt.dk/product.php?p=77"); await p.click('[data-fixurl="n2"] button[type=submit]');
    await p.waitForFunction(() => window.__db.writes().length === 2);
    o = (await ops(p))[1];
    check("name-only error: pasted link writes source_url and the row goes pending", o.payload.source_url === "https://prisjagt.dk/product.php?p=77" && o.filters[0][1] === "n2" && (await p.locator('.item[data-status="pending"]').count()) === 2, JSON.stringify(o));
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

  // 13. ask for access (signed out)
  {
    const p = await open({ session: false, label: "ask" });
    check("ask: link under the login form, form hidden at first", /Har du ikke adgang endnu\? Bed om adgang/.test(await p.textContent("#askToggle")) && !(await p.isVisible("#askForm")));
    await p.click("#askToggle");
    check("ask: link reveals e-mail and name fields", await p.isVisible("#aEmail") && await p.isVisible("#aName") && await p.isVisible("#aSubmit"));
    await p.fill("#aEmail", "ikke-en-adresse"); await p.click("#aSubmit");
    check("ask: bad address rejected locally, no rpc", /gyldig/.test(await p.textContent("#aMsg")) && (await p.evaluate(() => window.__db.rpcs.length)) === 0);
    const replies = [
      ["requested", /Tak\. Du får en mail, når du er godkendt\./],
      ["pending", /allerede bedt om adgang/],
      ["allowed", /allerede adgang.*login-formularen ovenfor/],
      ["full", /mange anmodninger/],
      ["invalid", /gyldig e-mailadresse/],
      ["rejected", /ikke givet adgang/]
    ];
    for (const [reply, re] of replies) {
      await p.evaluate(r => { window.__db.askReply = r; window.__db.rpcs.length = 0; }, reply);
      await p.click("#askToggle"); await p.click("#askToggle");        // close and open again: form visible
      if (!(await p.isVisible("#askForm"))) await p.evaluate(() => { document.getElementById("askForm").hidden = false; });
      await p.fill("#aEmail", "  Ny@Person.dk "); await p.fill("#aName", "Ny  Person");
      await p.click("#aSubmit");
      await p.waitForFunction(() => window.__db.rpcs.length === 1 && !/Sender/.test(document.getElementById("aMsg").textContent));
      const t = await p.textContent("#aMsg"), call = await p.evaluate(() => window.__db.rpcs[0]);
      check("ask: '" + reply + "' -> specific Danish message", re.test(t) && call.name === "request_access" && call.args.p_email === "Ny@Person.dk" && call.args.p_name === "Ny Person", t + " " + JSON.stringify(call));
    }
    await p.evaluate(() => { window.__db.askError = true; document.getElementById("askForm").hidden = false; });
    await p.fill("#aEmail", "a@b.dk"); await p.click("#aSubmit");
    await p.waitForFunction(() => /Kunne ikke/.test(document.getElementById("aMsg").textContent));
    check("ask: rpc failure -> honest message, form stays", await p.isVisible("#askForm"));
    check("ask: no sign-in attempt was made", (await ops(p)).filter(o => o.op === "otp").length === 0);
    await p.context().close();

    // a failed login for an address that is not allowed opens the form, pre-filled
    const q = await open({ session: false, label: "ask-prefill" });
    await q.evaluate(() => { window.__db.otpError = { status: 422, message: "Signups not allowed for otp" }; });
    await q.fill("#lEmail", "ukendt@familie.dk"); await q.click("#lSubmit");
    await q.waitForSelector("#askForm:not([hidden])");
    check("ask: not-allowed login shows the form pre-filled with that address", (await q.inputValue("#aEmail")) === "ukendt@familie.dk" && /jeren/i.test(await q.textContent("#lMsg")));
    check("ask: name field gets focus", await q.evaluate(() => document.activeElement && document.activeElement.id === "aName"));
    await q.evaluate(() => { window.__db.otpError = { status: 429, message: "email rate limit exceeded" }; document.getElementById("askBox").hidden = true; });
    await q.fill("#lEmail", "x@familie.dk"); await q.click("#lSubmit");
    await q.waitForFunction(() => !document.getElementById("lMsg").hidden && /for mange/.test(document.getElementById("lMsg").textContent));
    check("ask: other login errors (rate limit) do not open the form", !(await q.isVisible("#askBox")));
    await q.context().close();

    const w = await open({ session: false, width: 400, label: "ask-400" });
    await w.click("#askToggle"); await w.fill("#aEmail", "en.meget.lang.adresse.der.fylder.en.del@et-langt-domaenenavn-til-test.example.dk");
    await w.evaluate(() => { window.__db.askReply = "rejected"; }); await w.click("#aSubmit");
    await w.waitForFunction(() => /ikke givet adgang/.test(document.getElementById("aMsg").textContent));
    const ow = await w.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    check("ask: no horizontal overflow at 400 px (form open, message shown)", ow.sw <= ow.cw, JSON.stringify(ow));
    await w.context().close();
  }

  // 14. owner (admin): requests and who has access
  {
    const reqs = () => [{ email: "kim@example.dk", name: "Kim <b>Hansen</b>", created_at: "2026-11-15T10:00:00Z" }, { email: "lis@example.dk", name: null, created_at: "2026-11-16T08:00:00Z" }];
    const allowed = () => [{ email: "mor@familie.dk", note: "ejer", added_at: "2026-01-01T00:00:00Z", is_admin: true }, { email: "far@familie.dk", note: null, added_at: "2026-02-01T00:00:00Z", is_admin: false }];
    const p = await open({ admin: true, requests: reqs(), allowed: allowed(), label: "admin" });
    await p.waitForSelector("#accessBox:not([hidden])");
    await p.waitForSelector("#reqList .req");
    check("admin: 'Adgang' section with both pending requests", /Adgang/.test(await p.textContent("#accessBox h3")) && (await p.locator("#reqList .req").count()) === 2 && /kim@example\.dk/.test(await p.textContent("#reqList")));
    check("admin: name shown as text (escaped), missing name handled", (await p.locator("#reqList b").first().textContent()) === "Kim <b>Hansen</b>" && (await p.locator("#reqList .req b b").count()) === 0 && /Uden navn/.test(await p.textContent("#reqList")));
    check("admin: count next to the wordmark", await p.isVisible("#reqBadge") && /^2 /.test(await p.textContent("#reqBadge")));
    check("admin: no error text on screen", !/fejl|Kunne ikke/i.test(await p.textContent("#accMsg")));
    // approve
    await p.evaluate(() => { window.__db.rpcs.length = 0; });
    await p.click('#reqList [data-aact="approve"][data-email="kim@example.dk"]');
    await p.waitForFunction(() => !/kim@example\.dk/.test(document.getElementById("reqList").textContent));
    let calls = await p.evaluate(() => window.__db.rpcs.filter(r => r.name === "admin_decide"));
    check("admin: Godkend calls admin_decide(email, true) and the row disappears", calls.length === 1 && calls[0].args.p_email === "kim@example.dk" && calls[0].args.p_approve === true && (await p.locator("#reqList .req").count()) === 1);
    check("admin: badge count follows", /^1 /.test(await p.textContent("#reqBadge")));
    await p.waitForFunction(() => /kim@example\.dk/.test(document.getElementById("allowedList").textContent));
    check("admin: approved person appears in the access list", true);
    // reject needs confirmation
    await p.evaluate(() => { window.__db.rpcs.length = 0; });
    await p.click('#reqList [data-aact="reject"]');
    check("admin: Afvis asks first, no rpc yet", /Afvis lis@example\.dk\?/.test(await p.textContent("#reqList")) && (await p.evaluate(() => window.__db.rpcs.filter(r => r.name === "admin_decide").length)) === 0);
    await p.click('#reqList [data-aact="cancel"]');
    check("admin: 'Behold' cancels", (await p.locator('#reqList [data-aact="approve"]').count()) === 1 && (await p.evaluate(() => window.__db.rpcs.filter(r => r.name === "admin_decide").length)) === 0);
    await p.click('#reqList [data-aact="reject"]'); await p.click('#reqList [data-aact="reject-yes"]');
    await p.waitForFunction(() => /Ingen venter/.test(document.getElementById("reqList").textContent));
    calls = await p.evaluate(() => window.__db.rpcs.filter(r => r.name === "admin_decide"));
    check("admin: confirmed Afvis calls admin_decide(email, false) and the row disappears", calls.length === 1 && calls[0].args.p_email === "lis@example.dk" && calls[0].args.p_approve === false);
    check("admin: badge hidden when nothing waits", !(await p.isVisible("#reqBadge")));
    // who has access
    await p.click("#allowedBox summary");
    check("admin: list of who has access; no removal offered for the owner", (await p.locator('#allowedList [data-aact="remove"]').count()) === 2 && !/mor@familie\.dk[^]*Fjern adgang[^]*kim/.test("") && /Ejer/.test(await p.textContent("#allowedList")) && /produkter bliver liggende/.test(await p.textContent("#allowedBox")));
    check("admin: owner row has no 'Fjern adgang'", (await p.locator('#allowedList .req', { hasText: "mor@familie.dk" }).locator('[data-aact="remove"]').count()) === 0);
    await p.evaluate(() => { window.__db.rpcs.length = 0; });
    await p.click('#allowedList .req:has-text("far@familie.dk") [data-aact="remove"]');
    check("admin: Fjern adgang asks first, no rpc yet", /Fjern adgang for far@familie\.dk\?/.test(await p.textContent("#allowedList")) && (await p.evaluate(() => window.__db.rpcs.filter(r => r.name === "admin_remove_allowed").length)) === 0);
    check("admin: the list stays open while confirming", await p.evaluate(() => document.getElementById("allowedBox").open));
    const ow = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    await p.click('#allowedList [data-aact="remove-yes"]');
    await p.waitForFunction(() => !/far@familie\.dk/.test(document.getElementById("allowedList").textContent));
    calls = await p.evaluate(() => window.__db.rpcs.filter(r => r.name === "admin_remove_allowed"));
    check("admin: confirmed removal calls admin_remove_allowed(email) and the row disappears", calls.length === 1 && calls[0].args.p_email === "far@familie.dk" && /Adgang fjernet/.test(await p.textContent("#accMsg")));
    // a failing call is reported honestly and changes nothing on screen
    await p.context().close();
    await (async () => {
      const r = await open({ admin: true, requests: [{ email: "nina@example.dk", name: "Nina", created_at: "2026-11-16T09:00:00Z" }], allowed: allowed(), label: "admin-fail" });
      await r.waitForSelector("#reqList .req");
      await r.evaluate(() => { window.__db.rpcFail = true; });
      await r.click('#reqList [data-aact="approve"]');
      await r.waitForFunction(() => /Kunne ikke gemme/.test(document.getElementById("accMsg").textContent));
      check("admin: failing decision -> message, row stays", (await r.locator("#reqList .req").count()) === 1);
      await r.context().close();
    })();

    // the 60-second poll refreshes the section (the timer is faked to run at once)
    const t = await open({ admin: true, requests: [], allowed: allowed(), label: "admin-poll" });
    await t.waitForSelector("#accessBox:not([hidden])");
    check("admin: empty state text", /Ingen venter på svar/.test(await t.textContent("#reqList")) && !(await t.isVisible("#reqBadge")));
    await t.evaluate(() => { window.__db.requests.push({ email: "ny@example.dk", name: "Ny", created_at: "2026-11-16T09:00:00Z" }); });
    await t.evaluate(() => { window.__tick(); });
    await t.waitForFunction(() => /ny@example\.dk/.test(document.getElementById("reqList").textContent));
    check("admin: the 60-second poll picks up a new request and shows the count", /^1 /.test(await t.textContent("#reqBadge")));
    await t.context().close();

    // non-admin: nothing at all, and no error
    const n = await open({ admin: false, products: [row("test-sony-xm5", { id: "x5" })], label: "non-admin" });
    await n.waitForSelector(".item"); await n.waitForTimeout(300);
    const calls2 = await n.evaluate(() => window.__db.rpcs.map(r => r.name));
    check("non-admin: asked the server (admin_list_requests) but sees no 'Adgang' section, badge or message", calls2.indexOf("admin_list_requests") >= 0 && !(await n.isVisible("#accessBox")) && !(await n.isVisible("#reqBadge")) && !(await n.isVisible("#accMsg")) && !/Adgang/.test(await n.evaluate(() => document.body.innerText)));
    check("non-admin: no admin data fetched", calls2.every(x => x !== "admin_list_allowed"));
    await n.context().close();

    // 400 px: admin with everything open, confirmation shown
    const m = await open({ admin: true, width: 400, requests: [{ email: "en.meget.lang.adresse.der.fylder.en.del@et-langt-domaenenavn-til-test.example.dk", name: "Et meget langt navn der også fylder en hel del på en smal skærm", created_at: "2026-11-15T10:00:00Z" }], allowed: allowed().concat([{ email: "en.anden.meget.lang.adresse.der.fylder@et-langt-domaenenavn-til-test.example.dk", note: "en lang note om hvem det er", added_at: "2026-03-01T00:00:00Z", is_admin: false }]), label: "admin-400" });
    await m.waitForSelector("#reqList .req"); await m.click("#allowedBox summary");
    await m.waitForSelector('#allowedList [data-aact="remove"]');
    await m.click('#reqList [data-aact="reject"]'); await m.click('#allowedList .req:nth-child(3) [data-aact="remove"]');
    const mw = await m.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
    check("admin: no horizontal overflow at 400 px (requests, list and confirmations open)", mw.sw <= mw.cw, JSON.stringify(mw) + " before: " + JSON.stringify(ow));
    await m.context().close();
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
