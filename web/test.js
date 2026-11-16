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
  var db = window.__db = { products: init.products || [], lists: init.lists || [], noLists: !!init.noLists, profiles: init.profiles || [], imports: init.imports || [], noImports: !!init.noImports, ops: [], deny: false, otpError: null,
    session: init.session || null, seq: 100, admin: !!init.admin, requests: init.requests || [], allowedList: init.allowed || [], rpcs: [], askReply: "requested" };
  var authCb = null, rt = [];
  // the 60-second poll: remember its callback so a test can run it at once
  var ticks = [], realSetInterval = window.setInterval;
  window.setInterval = function (fn, ms) { if (ms === 60000) ticks.push(fn); return realSetInterval.apply(window, arguments); };
  window.__tick = function () { ticks.forEach(function (f) { f(); }); };
  var JOB = ["status","title","variants","offers","history","normal_price","verdict","warning","check_note","last_checked","notified_price","notified_at","backfill_state","digest_price","digest_at"];
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function builder(table) {
    var q = { op: "select", payload: null, filters: [], single: null, sel: false };
    var b = {
      select: function () { q.sel = true; return b; }, order: function () { return b; },
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
      return new Promise(function (resolve, reject) { setTimeout(function () {
        if (db.netFail && q.op !== "select") return reject(new Error("Failed to fetch"));
        if (q.op !== "select") db.ops.push({ table: table, op: q.op, payload: clone(q.payload), filters: clone(q.filters) });
        var rows = table === "products" ? db.products : table === "lists" ? db.lists : table === "imports" ? db.imports : db.profiles;
        if (table === "imports" && db.noImports) return resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table public.imports in the schema cache" } });
        if (q.op === "insert" && db.insertError && (table === "products" || table === "imports")) return resolve({ data: null, error: clone(db.insertError) });
        if (table === "products" && q.op === "insert" && db.oldGoalCheck && q.payload.target_type === "auto") return resolve({ data: null, error: { code: "23514", message: 'new row for relation "products" violates check constraint "products_target_type_check"', details: "Failing row contains (...)." } });
        if (table === "lists" && db.noLists) return resolve({ data: null, error: { code: "42P01", message: "relation public.lists does not exist" } });
        if (q.op !== "select" && db.deny) return resolve({ data: null, error: { code: "42501", message: "new row violates row-level security policy" } });
        if (db.failReads && q.op === "select") return resolve({ data: null, error: { message: "boom" } });
        if (q.op === "select") {
          var out = rows.filter(match).map(clone);
          return resolve({ data: q.single ? (out[0] || null) : out, error: null });
        }
        if (table === "lists" && (q.op === "insert" || q.op === "update")) {   // what the database enforces
          var nm = String(q.payload.name == null ? "" : q.payload.name).trim(), self = q.op === "update" ? rows.filter(match).map(function (x) { return x.id; }) : [];
          if (nm.length < 1 || nm.length > 40 || (q.op === "insert" && rows.length >= 30)) return resolve({ data: null, error: { code: "23514", message: "check" } });
          if (rows.some(function (x) { return self.indexOf(x.id) < 0 && x.name.toLowerCase() === nm.toLowerCase(); })) return resolve({ data: null, error: { code: "23505", message: "duplicate key" } });
          q.payload.name = nm;
        }
        if (table === "imports" && q.op === "insert") {   // what the database enforces for a new import
          var iu = String(q.payload.url || ""), irx = new RegExp("^https://(www[.])?(onskeskyen[.]dk|gowish[.]com)/(s/[a-z0-9_-]{1,64}|([a-z]{2}(-[a-z]{2})?/)?wishlists/[a-z0-9_-]{1,64})/?([?#][^ ]*)?$", "i");
          if (iu.length > 300 || !irx.test(iu)) return resolve({ data: null, error: { code: "23514", message: "check" } });
          if (rows.length >= 20) return resolve({ data: null, error: { code: "23514", message: "Du kan højst have 20 ønskelister. Stop eller skjul en først." } });
          if (rows.filter(function (x) { return x.status === "pending"; }).length >= 5) return resolve({ data: null, error: { code: "23514", message: "Du kan højst have 5 ønskelister i gang. Vent, til de er hentet." } });
          if (q.payload.list_id && !db.lists.some(function (l) { return l.id === q.payload.list_id; })) return resolve({ data: null, error: { code: "23503", message: "fk" } });
          var ir = { id: "im-" + (++db.seq), user_id: "u1", list_id: q.payload.list_id || null, url: iu, status: "pending", note: null, found: null, added: null, created_at: new Date().toISOString(), done_at: null };
          rows.push(ir); return resolve({ data: null, error: null });
        }
        if (q.op === "insert") {
          var r = Object.assign({ id: "new-" + (++db.seq), status: "pending", user_id: "u1", created_at: new Date().toISOString(), tracked_variants: null }, clone(q.payload));
          if (table === "lists") r.id = "l-new-" + db.seq;
          if (table === "products" && r.list_id && !db.lists.some(function (l) { return l.id === r.list_id; })) return resolve({ data: null, error: { code: "23503", message: "fk" } });
          rows.push(r); return resolve({ data: q.sel ? clone(r) : null, error: null });
        }
        if (q.op === "update" && table === "products" && "bought_price" in q.payload && q.payload.bought_price !== null && !(q.payload.bought_price > 0 && q.payload.bought_price <= 10000000)) return resolve({ data: null, error: { code: "23514", message: "products_bought_price_check" } });
        if (q.op === "update") {
          rows.filter(match).forEach(function (r) {
            var newLink = "source_url" in q.payload && q.payload.source_url !== r.source_url;
            if ("bought_price" in q.payload && q.payload.bought_price !== null && !(q.payload.bought_price > 0 && q.payload.bought_price <= 10000000)) return;   // check constraint (see below)
            Object.keys(q.payload).forEach(function (k) { if (JOB.indexOf(k) < 0) r[k] = clone(q.payload[k]); });
            if (q.payload.bought_at) r.bought_at = "2026-11-16T12:00:00Z";   // products_guard: the server stamps the time
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
          var gone = rows.filter(match).map(function (r) { return r.id; });
          if (table === "lists") db.products.forEach(function (p) { if (gone.indexOf(p.list_id) >= 0) p.list_id = null; });   // on delete set null
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
  const ctx = await browser.newContext({ viewport: { width: opts.width || 900, height: opts.height || 900 }, colorScheme: opts.scheme || "light", serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", e => pageErrors.push(opts.label + ": " + e.message));
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) pageErrors.push(opts.label + " console: " + m.text()); });
  await page.route(/cdn\.jsdelivr\.net/, r => r.fulfill({ contentType: "text/javascript", body: "/* test: client is injected */" }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: "text/css", body: "" }));
  // config.js in the repo holds the real project's values, so both cases are served from the test, never from the file.
  await page.route(/\/config\.js$/, r => r.fulfill({ contentType: "text/javascript", body: opts.config === false ? "window.PV_CONFIG={supabaseUrl:\"\",supabaseAnonKey:\"\"};" : 'window.PV_CONFIG={supabaseUrl:"https://x.supabase.test",supabaseAnonKey:"anon"};' }));
  const init = { session: opts.session === false ? null : { user: { id: "u1", email: "mor@familie.dk" } }, products: opts.products || [], lists: opts.lists || [], noLists: !!opts.noLists, imports: opts.imports || [], noImports: !!opts.noImports, profiles: opts.profiles || [], admin: !!opts.admin, requests: opts.requests || [], allowed: opts.allowed || [] };
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
    check("status line: last updated and Black Friday, no update interval", /^Opdateret /.test(st) && !/kvarter/.test(st) && /Black Friday/.test(st), st);
    check("six rows shown", (await p.locator(".item").count()) === 6);
    const pend = await p.locator('.item[data-status="pending"]').textContent();
    check("pending row text", /Henter produktet …/.test(pend) && !/kvarter/.test(pend), pend);
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
    check("tracking row: verdict, stats, chart, shops table, goal edit, prefs, change variant", /Laveste 30 dage/.test(tt) && /Normalpris/.test(tt) && /Butikker/.test(tt) && /Skift variant/.test(tt) && /Butiksvalg/.test(tt) && await p.locator(".chart svg").first().isVisible(), tt.slice(0, 200));
    // chart interactions
    await p.locator(".chart svg").first().scrollIntoViewIfNeeded();
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
    check("single-shop pending: normal pending text", /Henter produktet …/.test(await sp.locator(".head").textContent()) && !/prisjagt/.test(await sp.textContent()), await sp.textContent());
    await sp.locator(".head").click();
    check("single-shop pending body: nothing about prisjagt or variants", !/prisjagt|variant|kvarter/i.test(await sp.locator(".body").textContent()), await sp.locator(".body").textContent());
    const it = p.locator('.item[data-status="tracking"]').nth(1);
    await it.locator(".head").click();
    const bt = await it.locator(".body").textContent();
    check("single-shop detail: quiet line, shop in the table, remark about several variants", /Kun denne butik\. Et link fra prisjagt\.dk sammenligner flere\./.test(bt) && /Bedre Nætter/.test(bt) && /flere varianter med forskellige priser/.test(bt) && /579 kr\./.test(bt), bt.slice(0, 300));
    check("single-shop detail: no 'Skift variant', no 'Variant:' line", !/Skift variant/.test(bt) && !/Variant:/.test(bt) && (await it.locator('[data-act="change"]').count()) === 0);
    check("single-shop with archive points (fixture history): the short gaps note", /Ældre priser kan være upræcise og have huller\./.test(bt), bt.slice(0, 300));
    const other = await p.locator('.item[data-status="tracking"]').first().locator(".body");
    await p.locator('.item[data-status="tracking"]').first().locator(".head").click();
    check("prisjagt product still has 'Skift variant' and no single-shop line", /Skift variant/.test(await other.textContent()) && !/Kun denne butik/.test(await other.textContent()));
    await p.context().close();
    // a single-shop product without archive points: no note about older prices
    const plainRow = Object.assign({}, shopRow, { id: "pl", history: [{ d: "2026-11-10", p: 599, s: "Bedre Nætter", src: "check" }, { d: "2026-11-16", p: 579, s: "Bedre Nætter", src: "check" }] });
    const pa = await open({ products: [plainRow], label: "single-shop-plain" });
    await pa.waitForSelector(".item");
    await pa.locator(".item .head").first().click();
    const at = await pa.locator(".item .body").first().textContent();
    check("single-shop without archive points: no note about older prices", !/Internet Archive|offentlige prisoversigter/.test(at), at.slice(0, 400));
    await pa.context().close();
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
    await p.waitForFunction(() => /valgte variant/.test(document.body.textContent));
    check("choose: row waits for next fetch afterwards", true);
    await p.context().close();
  }

  // 5. add product
  {
    const p = await open({ products: [], label: "add" });
    await p.waitForSelector("#addForm:not([hidden])");
    await p.click(".goal label:has(#fTypePrice)");
    check("footer: tip rules sit in a collapsed details next to Indstillinger", !(await p.evaluate(() => document.getElementById("howBox").open)) && /Sådan vurderer vi tilbud/.test(await p.textContent("#howBox summary")) && !(await p.isVisible("#howBox p")) && /laveste pris de seneste 30 dage/.test(await p.textContent("#howBox")) && !/hvert kvarter/.test(await p.innerText("#appView .access, #tryRow")) );
    check("add: empty list text, placeholder names all three inputs, no explanatory paragraphs", /Ingen produkter endnu/.test(await p.textContent("#list")) && (await p.getAttribute("#fMain", "placeholder")) === "Produktnavn, link eller ønskeliste" && (await p.textContent('label[for="fMain"]')) === "Produktnavn, link eller ønskeliste" && (await p.locator("#fHelp").count()) === 0 && (await p.locator("#fName").count()) === 0);
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
    await p.fill("#fMain", "https://prisjagt.dk/product.php?p=555"); await p.click(".goal label:has(#fTypePct)"); await p.fill("#fVal", "20"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 2);
    o = (await ops(p))[1];
    check("add: link still works with % goal (placeholder name, source_url)", JSON.stringify(o.payload) === JSON.stringify({ name: "Nyt produkt", source_url: "https://prisjagt.dk/product.php?p=555", target_type: "pct", target_value: 20, active: true }), JSON.stringify(o.payload));
    // a link to a single shop is accepted as it is (fragment dropped), same row shape as a prisjagt link
    await p.fill("#fMain", " https://www.bedrenaetter.dk/mayan-kuvertlagen-180x200-hvid.html#reviews "); await p.click(".goal label:has(#fTypePrice)"); await p.fill("#fVal", "450"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 3);
    o = (await ops(p))[2];
    check("add: single-shop link accepted (name placeholder, source_url, no extra fields)", JSON.stringify(o.payload) === JSON.stringify({ name: "Nyt produkt", source_url: "https://www.bedrenaetter.dk/mayan-kuvertlagen-180x200-hvid.html", target_type: "price", target_value: 450, active: true }), JSON.stringify(o.payload));
    await p.waitForFunction(() => /Henter produktet …/.test(document.getElementById("list").textContent));
    check("add: shop link row shows the normal pending text", true);
    check("add: field is cleared after saving", (await p.inputValue("#fMain")) === "" && (await p.inputValue("#fVal")) === "");
    // by name: no source_url
    for (const bad of ["a", "x".repeat(141)]) {
      await p.fill("#fMain", bad); await p.fill("#fVal", "500"); await p.evaluate(() => document.getElementById("addForm").requestSubmit());
      check("add: name of " + bad.length + " characters rejected", (await ops(p)).length === 3 && /2 og 140/.test(await p.textContent("#fMsg")) && await p.isVisible("#fMsg"));
    }
    await p.click(".goal label:has(#fTypePrice)");
    await p.fill("#fMain", "  Sony   WH-1000XM5 sort "); await p.fill("#fVal", "1700"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 4);
    o = (await ops(p))[3];
    check("add: name only -> {name, target_type, target_value} without source_url", JSON.stringify(o.payload) === JSON.stringify({ name: "Sony WH-1000XM5 sort", target_type: "price", target_value: 1700 }), JSON.stringify(o.payload));
    await p.waitForFunction(() => /Finder produktet …/.test(document.getElementById("list").textContent));
    check("add: name-only row shows 'Finder produktet …'", true);
    await p.fill("#fMain", "https://prisjagt.dk/produkt/x"); await p.fill("#fVal", "99"); await p.click(".goal label:has(#fTypePct)"); await p.evaluate(() => document.getElementById("addForm").requestSubmit());
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
    check("name-only pending: head text", /Finder produktet …/.test(await pend.locator(".head").textContent()) && !/kvarter|time/.test(await pend.textContent()));
    await pend.locator(".head").click(); await er.locator(".head").click();
    const pt = await pend.locator(".body").textContent();
    check("name-only pending: search link and paste form, no filler", /Søg selv på Prisjagt/.test(pt) && !/Har du travlt/.test(pt) && /Indsæt linket her/.test(pt) && await pend.locator("[data-fixurl]").isVisible());
    const lk = pend.locator(".body a");
    check("name-only pending: 'Søg selv på Prisjagt' link with encoded name, new tab, noopener",
      (await lk.count()) === 1 && (await lk.textContent()) === "Søg selv på Prisjagt" && (await lk.getAttribute("href")) === "https://prisjagt.dk/search?search=" + encodeURIComponent(nameRow.name) && (await lk.getAttribute("target")) === "_blank" && /noopener/.test(await lk.getAttribute("rel")), await lk.getAttribute("href"));
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
    await p.waitForFunction(() => /Henter produktet …/.test(document.querySelector('.item[data-status="pending"] .head').textContent));
    check("name-only: row then shows the normal 'Henter produktet …'", /Dit link/.test(await p.locator('.item[data-status="pending"]').textContent()) || true);
    await p.fill("#u-n2", "https://prisjagt.dk/product.php?p=77"); await p.click('[data-fixurl="n2"] button[type=submit]');
    await p.waitForFunction(() => window.__db.writes().length === 2);
    o = (await ops(p))[1];
    check("name-only error: pasted link writes source_url and the row goes pending", o.payload.source_url === "https://prisjagt.dk/product.php?p=77" && o.filters[0][1] === "n2" && (await p.locator('.item[data-status="pending"]').count()) === 2, JSON.stringify(o));
    await p.context().close();
  }

  // 5b. goal "auto" (no goal of your own): the default choice in the add form
  {
    const p = await open({ products: [], label: "add-auto" });
    await p.waitForSelector("#addForm:not([hidden])");
    check("add auto: default choice is 'Godt tilbud', amount and hint hidden",
      await p.isChecked("#fTypeAuto") && /Godt tilbud/.test(await p.textContent(".goal")) && !(await p.isVisible("#fAmount")) && !(await p.isVisible("#fHint")));
    await p.fill("#fMain", "Sony WH-1000XM5 sort"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 1);
    let o = (await ops(p))[0];
    check("add auto: name only -> target_type auto, target_value null", JSON.stringify(o.payload) === JSON.stringify({ name: "Sony WH-1000XM5 sort", target_type: "auto", target_value: null }), JSON.stringify(o.payload));
    await p.fill("#fMain", "https://prisjagt.dk/product.php?p=555"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 2);
    o = (await ops(p))[1];
    check("add auto: link -> placeholder name, source_url, auto goal", JSON.stringify(o.payload) === JSON.stringify({ name: "Nyt produkt", source_url: "https://prisjagt.dk/product.php?p=555", target_type: "auto", target_value: null, active: true }), JSON.stringify(o.payload));
    await p.click(".goal label:has(#fTypePct)");
    check("add auto: choosing % shows the amount field", await p.isVisible("#fAmount") && /rabat/i.test(await p.textContent("#fValLabel")));
    await p.fill("#fMain", "https://prisjagt.dk/product.php?p=556"); await p.click("#fSubmit");
    check("add auto: % without a value is still refused", (await ops(p)).length === 2 && await p.isVisible("#fMsg"));
    await p.click(".goal label:has(#fTypeAuto)");
    check("add auto: back to auto hides the amount again", !(await p.isVisible("#fAmount")));
    await p.context().close();
  }

  // 5c. goal "auto" in the list and the edit form; suggested goals
  {
    const dy = row("test-dyson-v15", { id: "dy", target_type: "auto", target_value: null });
    const so = row("test-sony-xm5", { id: "x5" });
    const p = await open({ products: [dy, so], label: "auto-edit" });
    await p.waitForSelector(".item");
    const it = p.locator('.item:has(.head[data-id="dy"])');
    const head = await it.locator(".head").textContent();
    check("auto goal: head says 'godt tilbud' and the deal is shown as a hit", /godt tilbud/.test(head) && /Godt tilbud/.test(head) && !/mål \d/.test(head) && (await it.getAttribute("class")).indexOf("hit") >= 0, head);
    await p.locator('.head[data-id="dy"]').click();
    const body = await p.locator('.item:has(.head[data-id="dy"]) .body').textContent();
    check("auto goal: the verdict says why, not repeated in a second line", /3\.999 kr\. er 13 % under normalprisen/.test(body) && !/Derfor giver vi besked/.test(body) && body.split("er 13 % under normalprisen").length === 2, body.slice(0, 300));
    check("auto goal: edit form has the three choices, auto selected, no number field",
      (await p.inputValue("#et-dy")) === "auto" && (await p.locator("#et-dy option").count()) === 3 && !(await p.isVisible("#e-dy")));
    // suggested goals
    const sg = await p.locator('.item:has(.head[data-id="dy"]) .sugg .chip').allTextContents();
    check("suggestions: laveste set, 10 % under normalpris (4.600 -> 4.140), laveste 30 dage", sg.length >= 2 && sg.length <= 3 && /^Laveste set: [\d.]+ kr\.$/.test(sg[0]) && sg.indexOf("10 % under normalpris: 4.140 kr.") >= 0, JSON.stringify(sg));
    await p.locator('[data-act="goal"][data-id="dy"]').nth(1).click();
    await p.waitForFunction(() => window.__db.writes().length === 1);
    let o = (await ops(p))[0];
    check("suggestion click: saves target_type price with that value via update", o.op === "update" && o.filters[0][1] === "dy" && o.payload.target_type === "price" && typeof o.payload.target_value === "number" && o.payload.target_value > 0, JSON.stringify(o));
    const saved = o.payload.target_value;
    await p.waitForFunction(() => /mål [\d.]+ kr\./.test(document.querySelector('.head[data-id="dy"]').textContent));
    check("suggestion click: the goal now shows as a price goal and that chip is pressed",
      new RegExp("mål " + saved.toLocaleString("da-DK") + " kr\\.").test(await p.textContent('.head[data-id="dy"]')) && (await p.locator('[data-act="goal"][aria-pressed="true"]').count()) >= 1);
    // edit: price -> auto, then auto -> pct
    await p.selectOption("#et-dy", "auto");
    check("edit: choosing auto hides the number field", !(await p.isVisible("#e-dy")));
    await p.click('[data-edit="dy"] button[type=submit]');
    await p.waitForFunction(() => window.__db.writes().length === 2);
    o = (await ops(p))[1];
    check("edit: to auto -> {target_type auto, target_value null}", JSON.stringify(o.payload) === '{"target_type":"auto","target_value":null}', JSON.stringify(o.payload));
    await p.waitForFunction(() => /godt tilbud/.test(document.querySelector('.head[data-id="dy"]').textContent));
    await p.selectOption("#et-dy", "pct");
    check("edit: choosing % shows the number field", await p.isVisible("#e-dy"));
    await p.fill("#e-dy", "20"); await p.click('[data-edit="dy"] button[type=submit]');
    await p.waitForFunction(() => window.__db.writes().length === 3);
    o = (await ops(p))[2];
    check("edit: auto -> pct writes both fields", JSON.stringify(o.payload) === '{"target_type":"pct","target_value":20}', JSON.stringify(o.payload));
    // a product without history shows no suggestions; neither does a read-only user
    const nh = row("test-dyson-v15", { id: "nh", history: [] });
    const q = await open({ products: [nh], label: "no-sugg" });
    await q.waitForSelector(".item"); await q.locator('.head[data-id="nh"]').click();
    check("suggestions: none without history", (await q.locator(".sugg").count()) === 0);
    await q.context().close();
    // too little history for a verdict: 10 % under the first price is a hit, with its reason
    const thin = row("test-dyson-v15", { id: "th", target_type: "auto", target_value: null, normal_price: null, verdict: { level: "unknown", text: "Der er endnu ikke nok prishistorik til at vurdere prisen." }, history: [{ d: "2026-11-10", p: 5000, s: "A", src: "check" }, { d: "2026-11-16", p: 3999, s: "Elgiganten", src: "check" }] });
    const r = await open({ products: [thin], label: "auto-thin" });
    await r.waitForSelector(".item"); await r.locator('.head[data-id="th"]').click();
    check("auto goal: too little history -> 20 % under the first price is explained", /3\.999 kr\. er 20 % under første pris \(5\.000 kr\.\)\./.test(await r.textContent('.item .body')), (await r.textContent('.item .body')).slice(0, 200));
    await r.evaluate(() => { var d = window.__db.products[0]; d.history[0].p = 4200; window.__emit(); });
    await r.waitForFunction(() => !/under første pris/.test(document.querySelector(".item .body").textContent));
    check("auto goal: only 5 % under the first price -> no hit, no sentence", (await r.getAttribute(".item", "class")).indexOf("hit") < 0);
    await r.context().close();
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
    check("ask: link under the login form, form hidden at first", /Ingen adgang endnu\? Bed om adgang/.test(await p.textContent("#askToggle")) && !(await p.isVisible("#askForm")));
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
      ["rejected", /fik ikke adgang/]
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
    await w.waitForFunction(() => /fik ikke adgang/.test(document.getElementById("aMsg").textContent));
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
    await p.waitForFunction(() => /Ingen anmodninger/.test(document.getElementById("reqList").textContent));
    calls = await p.evaluate(() => window.__db.rpcs.filter(r => r.name === "admin_decide"));
    check("admin: confirmed Afvis calls admin_decide(email, false) and the row disappears", calls.length === 1 && calls[0].args.p_email === "lis@example.dk" && calls[0].args.p_approve === false);
    check("admin: badge hidden when nothing waits", !(await p.isVisible("#reqBadge")));
    // who has access
    await p.click("#allowedBox summary");
    check("admin: list of who has access; no removal offered for the owner", (await p.locator('#allowedList [data-aact="remove"]').count()) === 2 && !/mor@familie\.dk[^]*Fjern adgang[^]*kim/.test("") && /Ejer/.test(await p.textContent("#allowedList")) && /Personens produkter beholdes/.test(await p.textContent("#allowedBox")));
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
    check("admin: empty state text", /Ingen anmodninger/.test(await t.textContent("#reqList")) && !(await t.isVisible("#reqBadge")));
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

  // 10b. lists
  {
    const L1 = { id: "l1", user_id: "u1", name: "Elektronik" }, L2 = { id: "l2", user_id: "u1", name: "Bastian" };
    const mk = () => [row("test-sony-xm5", { id: "x5", list_id: "l1" }), row("test-ps5-pro", { id: "ps", list_id: "l1" }), row("test-dyson-v15", { id: "dy", list_id: "l2" }), row("test-lego-falcon", { id: "lg" })];
    const chips = p => p.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#chips .lchip"), b => b.innerText.replace(/\s+/g, " ").trim()));
    const pressed = p => p.evaluate(() => Array.prototype.map.call(document.querySelectorAll('#chips .lchip[aria-pressed="true"]'), b => b.innerText.replace(/\s+/g, " ").trim()));
    const shown = p => p.evaluate(() => document.querySelectorAll("#list .item").length);
    const dbq = (p, f) => p.evaluate(f);
    const settle = p => p.waitForTimeout(150);
    const lsGet = p => p.evaluate(() => { try { return localStorage.getItem("pv-list"); } catch (e) { return "ERR"; } });

    // zero lists: almost as before
    {
      const p = await open({ products: mk().map(r => Object.assign(r, { list_id: null })), label: "lists-zero" });
      await p.waitForSelector(".item"); await settle(p);
      check("lists: with no lists only 'Alle' and '+ Ny liste' show, all products listed", JSON.stringify(await chips(p)) === JSON.stringify(["Alle 4", "+ Ny liste"]) && (await shown(p)) === 4, JSON.stringify(await chips(p)));
      check("lists: no 'Uden liste', no actions, no form, no list picker", !(await p.isVisible("#listAct")) && !(await p.isVisible("#listForm")) && (await p.locator('[data-lsel="none"]').count()) === 0);
      await p.locator('.head[data-id="x5"]').click();
      check("lists: with no lists the product view has no 'Liste' select", (await p.locator("[data-listpick]").count()) === 0);
      // create
      await p.click('[data-lact="new"]');
      check("lists: '+ Ny liste' opens a small name field", await p.isVisible("#lfName") && (await p.evaluate(() => document.activeElement.id)) === "lfName");
      await p.fill("#lfName", "   "); await p.click("#lfSave");
      check("lists: blank name is refused with a message, nothing written", /mellem 1 og 40/.test(await p.textContent("#listMsg")) && (await dbq(p, () => window.__db.ops.filter(o => o.table === "lists").length)) === 0);
      await p.fill("#lfName", "Elektronik"); await p.click("#lfSave"); await settle(p);
      const w = await dbq(p, () => window.__db.ops.filter(o => o.table === "lists"));
      check("lists: creating writes one lists row with the trimmed name", w.length === 1 && w[0].op === "insert" && w[0].payload.name === "Elektronik", JSON.stringify(w));
      check("lists: the new list is shown, selected, with count 0; form closed", JSON.stringify(await pressed(p)) === JSON.stringify(["Elektronik 0"]) && !(await p.isVisible("#listForm")), JSON.stringify(await chips(p)));
      check("lists: an empty list says so", /Ingen produkter på denne liste endnu/.test(await p.textContent("#list")) && (await shown(p)) === 0);
      const id = await dbq(p, () => window.__db.lists[0].id);
      check("lists: the choice is remembered in localStorage", (await lsGet(p)) === id, await lsGet(p));
      // adding into the selected list
      await p.fill("#fMain", "Bærbar computer"); await p.click("#fSubmit"); await settle(p);
      let ins = (await ops(p)).filter(o => o.table === "products" && o.op === "insert");
      check("lists: a product added while a list is selected goes into that list", ins.length === 1 && ins[0].payload.list_id === id, JSON.stringify(ins));
      check("lists: and shows in that list, count 1", (await shown(p)) === 1 && /Elektronik 1/.test((await chips(p)).join("|")), JSON.stringify(await chips(p)));
      await p.click('[data-lsel="all"]');
      await p.fill("#fMain", "Kaffemaskine"); await p.click("#fSubmit"); await settle(p);
      ins = (await ops(p)).filter(o => o.table === "products" && o.op === "insert");
      check("lists: added while 'Alle' is selected, no list_id is sent", ins.length === 2 && !("list_id" in ins[1].payload), JSON.stringify(ins[1]));
      check("lists: 'Uden liste' appears now that a list and an unlisted product exist", /Uden liste 5/.test((await chips(p)).join("|")), JSON.stringify(await chips(p)));
      await p.click('[data-lsel="none"]');
      await p.fill("#fMain", "Brødrister"); await p.click("#fSubmit"); await settle(p);
      ins = (await ops(p)).filter(o => o.table === "products" && o.op === "insert");
      check("lists: added while 'Uden liste' is selected, no list_id is sent", ins.length === 3 && !("list_id" in ins[2].payload));
      // duplicate name, case-insensitive
      await p.click('[data-lact="new"]'); await p.fill("#lfName", "elektronik"); await p.click("#lfSave");
      check("lists: a name that exists (any case) is refused", /allerede en liste/.test(await p.textContent("#listMsg")) && (await dbq(p, () => window.__db.lists.length)) === 1);
      await p.keyboard.press("Escape");
      check("lists: Escape closes the name field", !(await p.isVisible("#listForm")));
      await p.context().close();
    }

    // several lists: chips, filter, counts, order
    {
      const p = await open({ products: mk(), lists: [L1, L2], label: "lists-many" });
      await p.waitForSelector(".item"); await settle(p);
      check("lists: chips in name order with counts, 'Uden liste' last before '+ Ny liste'", JSON.stringify(await chips(p)) === JSON.stringify(["Alle 4", "Bastian 1", "Elektronik 2", "Uden liste 1", "+ Ny liste"]), JSON.stringify(await chips(p)));
      check("lists: 'Alle' is selected by default and shows everything", JSON.stringify(await pressed(p)) === JSON.stringify(["Alle 4"]) && (await shown(p)) === 4);
      check("lists: no actions while 'Alle' is selected", !(await p.isVisible("#listAct")));
      await p.click('[data-lsel="l1"]');
      check("lists: selecting a chip filters the products", (await shown(p)) === 2 && (await p.locator('.head[data-id="x5"]').count()) === 1 && (await p.locator('.head[data-id="dy"]').count()) === 0);
      check("lists: 'Omdøb' and 'Slet liste' show for a selected list", /Omdøb/.test(await p.textContent("#listAct")) && /Slet liste/.test(await p.textContent("#listAct")));
      await p.click('[data-lsel="none"]');
      check("lists: 'Uden liste' shows the unlisted product", (await shown(p)) === 1 && (await p.locator('.head[data-id="lg"]').count()) === 1 && !(await p.isVisible("#listAct")));
      check("lists: choice is remembered ('none')", (await lsGet(p)) === "none");

      // moving a product
      await p.click('[data-lsel="l1"]');
      await p.locator('.head[data-id="x5"]').click();
      const opts = await p.locator("#lp-x5 option").allTextContents();
      check("lists: the product view has a 'Liste' select with 'Ingen liste' and the lists in order", JSON.stringify(opts) === JSON.stringify(["Ingen liste", "Bastian", "Elektronik"]) && (await p.locator("#lp-x5").inputValue()) === "l1", JSON.stringify(opts));
      await p.selectOption("#lp-x5", "l2"); await settle(p);
      let up = (await ops(p)).filter(o => o.op === "update");
      check("lists: moving writes list_id", up.length === 1 && up[0].payload.list_id === "l2" && up[0].filters[0][1] === "x5", JSON.stringify(up));
      check("lists: the moved product leaves this list view and counts follow", (await shown(p)) === 1 && /Bastian 2/.test((await chips(p)).join("|")) && /Elektronik 1/.test((await chips(p)).join("|")), JSON.stringify(await chips(p)));
      await p.click('[data-lsel="l2"]');
      await p.selectOption("#lp-x5", ""); await settle(p);
      up = (await ops(p)).filter(o => o.op === "update");
      check("lists: 'Ingen liste' writes list_id null", up.length === 2 && up[1].payload.list_id === null);
      check("lists: 'Uden liste' count follows", /Uden liste 2/.test((await chips(p)).join("|")), JSON.stringify(await chips(p)));

      // renaming
      await p.click('[data-lsel="l1"]'); await p.click('[data-lact="rename"]');
      check("lists: 'Omdøb' opens the field with the current name", (await p.inputValue("#lfName")) === "Elektronik" && /Gem navn/.test(await p.textContent("#lfSave")));
      await p.fill("#lfName", "Bastian"); await p.click("#lfSave");
      check("lists: renaming to another list's name is refused", /allerede en liste/.test(await p.textContent("#listMsg")));
      await p.fill("#lfName", "Teknik"); await p.click("#lfSave"); await settle(p);
      const rn = (await ops(p)).filter(o => o.table === "lists");
      check("lists: renaming writes the new name for that list", rn.length === 1 && rn[0].op === "update" && rn[0].payload.name === "Teknik" && rn[0].filters[0][1] === "l1", JSON.stringify(rn));
      check("lists: renamed chip is shown, re-sorted, still selected", JSON.stringify(await chips(p)).includes('"Bastian 1","Teknik 1"') && JSON.stringify(await pressed(p)) === JSON.stringify(["Teknik 1"]), JSON.stringify(await chips(p)));

      // deleting
      await p.click('[data-lact="del"]');
      const ct = await p.textContent("#listAct");
      check("lists: delete asks first and says the products are kept and moved to 'Uden liste'", /Slet listen Teknik\?/.test(ct) && /Produkterne beholdes/.test(ct) && /Uden liste/.test(ct) && (await dbq(p, () => window.__db.ops.filter(o => o.table === "lists" && o.op === "delete").length)) === 0, ct);
      await p.click('[data-lact="del-no"]');
      check("lists: 'Behold' cancels the deletion", !/Slet listen/.test(await p.textContent("#listAct")) && (await dbq(p, () => window.__db.lists.length)) === 2);
      await p.click('[data-lact="del"]'); await p.click('[data-lact="del-yes"]'); await settle(p);
      const dw = await ops(p);
      check("lists: confirmed delete removes only the list row, never a product", dw.filter(o => o.op === "delete").length === 1 && dw.filter(o => o.op === "delete")[0].table === "lists" && dw.filter(o => o.op === "delete")[0].filters[0][1] === "l1", JSON.stringify(dw.filter(o => o.op === "delete")));
      check("lists: all four products are still there, now without that list", (await dbq(p, () => window.__db.products.length)) === 4 && (await dbq(p, () => window.__db.products.filter(x => x.list_id === "l1").length)) === 0);
      check("lists: after deleting, 'Alle' is selected and shows all products", JSON.stringify(await pressed(p)) === JSON.stringify(["Alle 4"]) && (await shown(p)) === 4 && (await lsGet(p)) === "all", JSON.stringify(await chips(p)));
      check("lists: 'Uden liste' counts the products that lost their list", /Uden liste 3/.test((await chips(p)).join("|")), JSON.stringify(await chips(p)));
      // the 30 cap
      await p.context().close();
    }

    // 30 lists: the cap is explained, not just rejected
    {
      const many = []; for (let i = 1; i <= 30; i++) many.push({ id: "m" + i, user_id: "u1", name: "Liste " + (i < 10 ? "0" : "") + i });
      const p = await open({ products: mk().slice(0, 1), lists: many, label: "lists-cap" });
      await p.waitForSelector(".item"); await settle(p);
      await p.click('[data-lact="new"]'); await p.fill("#lfName", "En til"); await p.click("#lfSave");
      check("lists: a 31st list is refused with an explanation", /højst have 30 lister/.test(await p.textContent("#listMsg")) && (await dbq(p, () => window.__db.lists.length)) === 30);
      await p.context().close();
    }

    // remembered selection
    {
      const p = await open({ products: mk(), lists: [L1, L2], storage: { "pv-list": "l2" }, label: "lists-saved" });
      await p.waitForSelector(".item"); await settle(p);
      check("lists: a remembered list is selected on load", JSON.stringify(await pressed(p)) === JSON.stringify(["Bastian 1"]) && (await shown(p)) === 1 && (await p.locator('.head[data-id="dy"]').count()) === 1);
      await p.context().close();

      const r = await open({ products: mk(), lists: [L1, L2], label: "lists-reload" });
      await r.waitForSelector(".item"); await settle(r);
      await r.click('[data-lsel="l1"]'); await r.reload(); await r.waitForSelector(".item"); await settle(r);
      check("lists: the choice survives a reload", JSON.stringify(await pressed(r)) === JSON.stringify(["Elektronik 2"]) && (await shown(r)) === 2, JSON.stringify(await pressed(r)));
      await r.context().close();

      const g = await open({ products: mk(), lists: [L1, L2], storage: { "pv-list": "findes-ikke" }, label: "lists-gone" });
      await g.waitForSelector(".item"); await settle(g);
      check("lists: a remembered list that no longer exists falls back to 'Alle'", JSON.stringify(await pressed(g)) === JSON.stringify(["Alle 4"]) && (await shown(g)) === 4);
      await g.context().close();

      const n = await open({ products: mk().map(r => Object.assign(r, { list_id: "l1" })), lists: [L1, L2], storage: { "pv-list": "none" }, label: "lists-none-gone" });
      await n.waitForSelector(".item"); await settle(n);
      check("lists: 'Uden liste' remembered but nothing is unlisted: falls back to 'Alle', no such chip", JSON.stringify(await pressed(n)) === JSON.stringify(["Alle 4"]) && (await n.locator('[data-lsel="none"]').count()) === 0);
      await n.context().close();

      const b = await browser.newContext({ viewport: { width: 900, height: 900 } });
      const bp = await b.newPage(); bp.on("pageerror", e => pageErrors.push("blocked-storage: " + e.message));
      await bp.route(/cdn\.jsdelivr\.net/, r => r.fulfill({ contentType: "text/javascript", body: "" }));
      await bp.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: "text/css", body: "" }));
      await bp.route(/\/config\.js$/, r => r.fulfill({ contentType: "text/javascript", body: 'window.PV_CONFIG={supabaseUrl:"https://x.supabase.test",supabaseAnonKey:"anon"};' }));
      await bp.addInitScript("window.__INIT = " + JSON.stringify({ session: { user: { id: "u1", email: "mor@familie.dk" } }, products: mk(), lists: [L1, L2] }) + ";");
      await bp.addInitScript(FAKE);
      await bp.addInitScript(() => { const thrower = () => { throw new Error("blocked"); }; Storage.prototype.getItem = thrower; Storage.prototype.setItem = thrower; });
      await bp.goto(base + "/index.html"); await bp.waitForSelector(".item"); await settle(bp);
      await bp.click('[data-lsel="l1"]');
      check("lists: blocked localStorage still works (falls back to 'Alle', selection works for the session)", (await shown(bp)) === 2 && JSON.stringify(await pressed(bp)) === JSON.stringify(["Elektronik 2"]));
      await b.close();
    }

    // before schema.sql is run again: no lists table, the page behaves as before
    {
      const p = await open({ products: mk().map(r => { delete r.list_id; return r; }), noLists: true, label: "lists-missing" });
      await p.waitForSelector(".item"); await settle(p);
      check("lists: without the lists table the chip row stays hidden and all products show", !(await p.isVisible("#listsBox")) && (await shown(p)) === 4);
      await p.context().close();
    }

    // read-only user: sees lists, cannot change them
    {
      const p = await open({ products: mk(), lists: [L1], label: "lists-readonly" });
      await p.waitForSelector(".item"); await settle(p);
      await p.evaluate(() => { window.__db.deny = true; });
      await p.click('[data-lact="new"]'); await p.fill("#lfName", "Ny"); await p.click("#lfSave"); await settle(p);
      check("lists: a refused write (no access) shows a message and no list", /ikke adgang/.test(await p.textContent("#listMsg")) && (await dbq(p, () => window.__db.lists.length)) === 1);
      await p.context().close();
    }

    // phone width: long names wrap inside the row, no horizontal page scroll
    {
      const long = []; for (let i = 1; i <= 8; i++) long.push({ id: "w" + i, user_id: "u1", name: ["Fødselsdagsgaver til hele familien", "Bastian", "Elektronik og tilbehør", "Hus", "Have", "Børnene", "Køkken", "Jul"][i - 1] });
      const prods = mk(); prods[0].list_id = "w1";
      const p = await open({ products: prods, lists: long.concat([{ id: "wx", user_id: "u1", name: "Et navn på fyrre tegn som fylder helt " }]), width: 360, label: "lists-phone" });
      await p.waitForSelector(".item"); await settle(p);
      await p.click('[data-lact="new"]');
      await p.click('[data-lsel="w1"]'); await p.click('[data-lact="del"]');
      const ov = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      check("lists: no horizontal overflow at 360 px with many long chips and the confirmation open", ov.sw <= ov.cw, JSON.stringify(ov));
      await p.context().close();
    }
  }

  // 10c. Onskeskyen import and the clearer save errors
  {
    const SCHEMA_OLD = "Siden er blevet opdateret, men databasen mangler den nyeste opdatering.";
    const FIX_IT = "Kør supabase/schema.sql igen i Supabase.";
    const imp = (id, over) => Object.assign({ id, user_id: "u1", list_id: null, url: "https://onskeskyen.dk/s/e0mfx8", status: "pending", note: null, found: null, added: null, created_at: "2026-11-16T09:00:00Z", done_at: null }, over || {});
    const writesOf = p => p.evaluate(() => window.__db.writes());
    const msgOf = p => p.evaluate(() => (document.getElementById("fMsg").hidden ? "" : document.getElementById("fMsg").textContent));
    const send = async (p, text) => { await p.fill("#fMain", text); await p.click("#fSubmit"); await p.waitForTimeout(160); };
    const lines = p => p.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#importBox .impl"), e => e.firstChild.textContent));
    const LISTS = [{ id: "l1", user_id: "u1", name: "Elektronik" }];

    // link detection: an Onskeskyen / gowish list link becomes an import, nothing else does
    const yes = [
      ["https://onskeskyen.dk/s/e0mfx8", "https://onskeskyen.dk/s/e0mfx8"],
      ["  https://www.OnskeSkyen.dk/s/e0mfx8?utm_source=x#y ", "https://www.onskeskyen.dk/s/e0mfx8"],
      ["onskeskyen.dk/s/e0mfx8", "https://onskeskyen.dk/s/e0mfx8"],
      ["http://onskeskyen.dk/s/e0mfx8", "https://onskeskyen.dk/s/e0mfx8"],
      ["https://gowish.com/s/e0mfx8", "https://gowish.com/s/e0mfx8"],
      ["https://onskeskyen.dk/wishlists/4seSLtIddxXUVB2Z?sharedBy=9lflg7q4Ybu7D4cx&utm_source=shortlink", "https://onskeskyen.dk/wishlists/4seSLtIddxXUVB2Z"],
      ["https://onskeskyen.dk/da/wishlists/4seSLtIddxXUVB2Z", "https://onskeskyen.dk/da/wishlists/4seSLtIddxXUVB2Z"],
      ["https://www.gowish.com/en-GB/wishlists/4seSLtIddxXUVB2Z/", "https://www.gowish.com/en-GB/wishlists/4seSLtIddxXUVB2Z/"],
    ];
    for (const [typed, stored] of yes) {
      const p = await open({ products: [], label: "wish-yes" });
      await p.waitForSelector("#addForm:not([hidden])");
      await p.click(".goal label:has(#fTypePct)");            // a goal with no amount: irrelevant for a wish list
      await send(p, typed);
      const w = await writesOf(p);
      check("wish link '" + typed.trim().slice(0, 50) + "' -> one import with the clean https address, no product", w.length === 1 && w[0].table === "imports" && w[0].op === "insert" && w[0].payload.url === stored && Object.keys(w[0].payload).join() === "url", JSON.stringify(w));
      check("wish link: field cleared, no message, status line shows", (await p.inputValue("#fMain")) === "" && (await msgOf(p)) === "" && (await lines(p)).length === 1);
      await p.context().close();
    }
    const no = [
      ["https://www.bedrenaetter.dk/mayan-kuvertlagen.html", "products"], ["https://prisjagt.dk/produkt/sony-p123", "products"], ["https://www.prisjagt.dk/product.php?p=555", "products"],
      ["https://onskeskyen.dk.evil.com/s/e0mfx8", "products"], ["https://evil.com/onskeskyen.dk/s/e0mfx8", "products"], ["https://shop.dk/vare?ref=https://onskeskyen.dk/s/e0mfx8", "products"],
      ["https://gowish.example.dk/s/abc", "products"], ["Ønskeskyen gave til far", "products"], ["gowish", "products"],
    ];
    for (const [typed, table] of no) {
      const p = await open({ products: [], label: "wish-no" });
      await p.waitForSelector("#addForm:not([hidden])");
      await p.click(".goal label:has(#fTypePrice)"); await p.fill("#fVal", "100");
      await send(p, typed);
      const w = await writesOf(p);
      check("'" + typed.slice(0, 50) + "' is not an import", w.length === 1 && w[0].table === table, JSON.stringify(w));
      await p.context().close();
    }
    {
      const p = await open({ products: [], label: "wish-other-path" });
      await p.waitForSelector("#addForm:not([hidden])");
      for (const typed of ["https://onskeskyen.dk/profile/abc", "https://onskeskyen.dk/", "https://onskeskyen.dk/s/", "https://user:pw@onskeskyen.dk/s/abc", "https://onskeskyen.dk:8443/s/abc"]) {
        await send(p, typed);
        check("other onskeskyen.dk address '" + typed + "': asks for the shared link, writes nothing", /delte link til ønskelisten fra Ønskeskyen/.test(await msgOf(p)) && (await writesOf(p)).length === 0, await msgOf(p));
      }
      await p.context().close();
    }

    // the selected list goes with the import
    {
      const p = await open({ products: [], lists: LISTS, storage: { "pv-list": "l1" }, label: "wish-list" });
      await p.waitForSelector(".lchip");
      await send(p, "https://onskeskyen.dk/s/e0mfx8");
      let w = await writesOf(p);
      check("import: the selected list is sent as list_id", w.length === 1 && w[0].payload.list_id === "l1" && w[0].payload.url === "https://onskeskyen.dk/s/e0mfx8", JSON.stringify(w));
      await p.context().close();
      const q = await open({ products: [], lists: LISTS, storage: { "pv-list": "all" }, label: "wish-nolist" });
      await q.waitForSelector(".lchip");
      await send(q, "https://onskeskyen.dk/s/e0mfx8");
      w = await writesOf(q);
      check("import: no list selected -> no list_id (the job decides)", w.length === 1 && !("list_id" in w[0].payload), JSON.stringify(w));
      await q.context().close();
    }

    // status lines
    {
      const today = new Date().toISOString(), yest = new Date(Date.now() - 36 * 3600e3).toISOString(), old = "2026-10-03T10:00:00Z";
      const p = await open({ products: [row("test-sony")], lists: LISTS, label: "wish-lines", imports: [
        imp("a", { created_at: "2026-11-16T09:00:00Z" }),
        imp("b", { status: "done", found: 12, added: 12, created_at: "2026-11-16T08:00:00Z", title: "Bastians ønskeliste", synced_at: today, sync_fails: 0, note: "De er lagt på en ny liste, Fødselsdagsønsker." }),
        imp("c", { status: "done", found: 7, added: 7, created_at: "2026-11-16T07:00:00Z", title: "Jul", synced_at: yest }),
        imp("d", { status: "error", note: "Ønskelisten er ikke offentlig eller findes ikke. Bed ejeren om at dele den offentligt.", created_at: "2026-11-16T06:00:00Z" }),
        imp("e", { status: "done", found: 1, added: 1, created_at: "2026-11-16T05:00:00Z", title: "Én ting", synced_at: old }),
        imp("f", { status: "done", found: 3, added: 0, created_at: "2026-11-16T04:00:00Z", note: "3 ønsker fandtes allerede." }),
        imp("g", { status: "error", created_at: "2026-11-16T03:00:00Z" }),
        imp("h", { status: "done", found: 12, added: 12, created_at: "2026-11-16T02:00:00Z", title: "Bastians ønskeliste", synced_at: today, sync_fails: 2, note: "Ønskelisten er ikke offentlig lige nu. Prøver igen i morgen." }),
      ] });
      await p.waitForSelector("#importBox .impl");
      const ls = await lines(p);
      const oldTxt = new Intl.DateTimeFormat("da-DK", { day: "numeric", month: "short" }).format(new Date(old));
      check("status lines: pending; a standing line per finished import (title, count, updated today / yesterday / date); no title; failing day with its note; errors as before; newest first", JSON.stringify(ls) === JSON.stringify([
        "Henter ønsker fra Ønskeskyen …",
        "Følger Bastians ønskeliste · 12 ønsker · opdateret i dag",
        "Følger Jul · 7 ønsker · opdateret i går",
        "Ønskelisten er ikke offentlig eller findes ikke. Bed ejeren om at dele den offentligt.",
        "Følger Én ting · 1 ønske · opdateret " + oldTxt,
        "Følger ønskelisten · 3 ønsker",
        "Ønskelisten kunne ikke hentes.",
        "Følger Bastians ønskeliste · 12 ønsker · opdateret i dag · Ønskelisten er ikke offentlig lige nu. Prøver igen i morgen.",
      ]), JSON.stringify(ls));
      check("status lines: 'Stop' on finished lines, 'Skjul' on failed ones, no button on the pending one",
        (await p.locator('#importBox [data-iact="stop"]').count()) === 5 && (await p.locator('#importBox [data-iact="hide"]').count()) === 2 && (await p.locator('#importBox .impl[data-istatus="pending"] button').count()) === 0);
      check("status lines sit right below the list chips", await p.evaluate(() => document.getElementById("listsBox").nextElementSibling.id === "importBox"));
      // stop: asks first, 'Behold' cancels, 'Ja, stop' deletes the import row only (the products stay)
      await p.locator('#importBox .impl:nth-child(2) [data-iact="stop"]').click();
      check("stop: asks first, nothing written yet", /Stop\? Varerne beholdes\./.test(await p.textContent("#importBox .impl:nth-child(2)")) && (await writesOf(p)).length === 0);
      await p.locator('#importBox [data-iact="stop-no"]').click();
      check("stop: 'Behold' cancels", (await writesOf(p)).length === 0 && /Følger Bastians ønskeliste · 12 ønsker/.test(await p.textContent("#importBox .impl:nth-child(2)")) && (await p.locator('#importBox [data-iact="stop-yes"]').count()) === 0);
      await p.locator('#importBox .impl:nth-child(2) [data-iact="stop"]').click();
      await p.locator('#importBox [data-iact="stop-yes"]').click();
      await p.waitForFunction(() => document.querySelectorAll("#importBox .impl").length === 7);
      let w = await writesOf(p);
      check("stop: the import row is deleted (only that one), the line goes, the product stays", w.length === 1 && w[0].table === "imports" && w[0].op === "delete" && JSON.stringify(w[0].filters) === JSON.stringify([["id", "b"]]) && (await p.locator(".item").count()) === 1, JSON.stringify(w));
      // hide on an error line
      await p.locator('#importBox .impl[data-istatus="error"] [data-iact="hide"]').first().click();
      await p.waitForFunction(() => document.querySelectorAll("#importBox .impl").length === 6);
      w = await writesOf(p);
      check("hide: an error line is deleted at once, without a question", w.length === 2 && w[1].op === "delete" && w[1].filters[0][1] === "d", JSON.stringify(w[1]));
      // refresh by the same polling: the job finishes the pending one
      await p.evaluate(() => { var r = window.__db.imports.filter(function (x) { return x.id === "a"; })[0]; r.status = "done"; r.added = 5; r.found = 5; r.title = "Nyt navn"; r.synced_at = new Date().toISOString(); window.__tick(); });
      await p.waitForFunction(() => /Følger Nyt navn · 5 ønsker · opdateret i dag/.test(document.getElementById("importBox").textContent));
      check("status line follows the poll: pending turns into a standing line", !/Henter ønsker/.test(await p.textContent("#importBox")));
      await p.evaluate(() => { window.__db.imports.push({ id: "z", user_id: "u1", list_id: null, url: "https://gowish.com/s/zz", status: "pending", note: null, found: null, added: null, created_at: "2026-11-16T10:00:00Z" }); window.__emit(); });
      await p.waitForFunction(() => /Henter ønsker fra Ønskeskyen/.test(document.getElementById("importBox").textContent), null, { timeout: 8000 });
      check("status line follows the realtime event too", true);
      await p.context().close();
      const q = await open({ products: [row("test-sony")], label: "wish-none", imports: [] });
      await q.waitForSelector(".item");
      check("no imports -> no status line at all", !(await q.isVisible("#importBox")));
      await q.context().close();
    }

    // the creating flow: pending line at once, caps
    {
      const p = await open({ products: [], label: "wish-flow" });
      await p.waitForSelector("#addForm:not([hidden])");
      await send(p, "https://onskeskyen.dk/s/e0mfx8");
      check("after adding: the pending line is shown", JSON.stringify(await lines(p)) === JSON.stringify(["Henter ønsker fra Ønskeskyen …"]));
      for (let i = 0; i < 4; i++) await send(p, "https://onskeskyen.dk/s/kode" + i);
      check("5 pending imports are accepted", (await lines(p)).length === 5);
      const before = (await writesOf(p)).length;
      await send(p, "https://onskeskyen.dk/s/sjette");
      check("a 6th pending import is refused with a Danish message, nothing written", /Du har allerede 5 ønskelister i gang/.test(await msgOf(p)) && (await writesOf(p)).length === before, await msgOf(p));
      await p.context().close();
      const r = await open({ products: [], label: "wish-20", imports: Array.from({ length: 20 }, (_, i) => imp("x" + i, { status: "done", added: 1, created_at: "2026-11-15T10:" + String(10 + i) + ":00Z" })) });
      await r.waitForSelector("#importBox .impl");
      await send(r, "https://onskeskyen.dk/s/ny");
      check("20 rows: asks to stop or hide one first", /^Du følger 20 ønskelister\. Stop eller skjul en først\.$/.test(await msgOf(r)) && (await writesOf(r)).length === 0);
      await r.context().close();
      const t = await open({ products: [], label: "wish-server-cap" });
      await t.waitForSelector("#addForm:not([hidden])");
      await t.evaluate(() => { window.__db.insertError = { code: "23514", message: "Du kan højst have 5 ønskelister i gang. Vent, til de er hentet." }; });
      await send(t, "https://onskeskyen.dk/s/e0mfx8");
      check("the database's own limit message is shown", /^Du kan højst have 5 ønskelister i gang/.test(await msgOf(t)), await msgOf(t));
      await t.context().close();
    }

    // the table does not exist yet (schema.sql not run again)
    {
      const p = await open({ products: [row("test-sony")], noImports: true, label: "wish-notable" });
      await p.waitForSelector(".item");
      check("no imports table: page works, no status line, no message", (await p.locator(".item").count()) === 1 && !(await p.isVisible("#importBox")) && !(await p.isVisible("#fMsg")));
      await send(p, "https://onskeskyen.dk/s/e0mfx8");
      check("no imports table: a clear Danish message when someone tries (no fix-it hint for a normal person)", (await msgOf(p)) === SCHEMA_OLD, await msgOf(p));
      check("no imports table: the field keeps the text so nothing is lost", (await p.inputValue("#fMain")) === "https://onskeskyen.dk/s/e0mfx8");
      await p.context().close();
      const a = await open({ products: [row("test-sony")], noImports: true, admin: true, label: "wish-notable-admin" });
      await a.waitForSelector("#accessBox:not([hidden])");
      await send(a, "https://onskeskyen.dk/s/e0mfx8");
      check("no imports table, admin: also told to run schema.sql again", (await msgOf(a)) === SCHEMA_OLD + " " + FIX_IT, await msgOf(a));
      await a.context().close();
    }

    // save errors for products: network vs. a database older than the site
    {
      const cases = [
        ["goal 'auto' not allowed yet (23514 on target_type), by name", { code: "23514", message: 'new row for relation "products" violates check constraint "products_target_type_check"', details: "Failing row contains (...)." }, "Sony WH-1000XM5", true],
        ["goal 'auto' not allowed yet, by link", { code: "23514", message: 'new row for relation "products" violates check constraint "products_target_type_check"' }, "https://www.bedrenaetter.dk/x.html", true],
        ["target_value NOT NULL (23502)", { code: "23502", message: 'null value in column "target_value" of relation "products" violates not-null constraint' }, "Sony WH-1000XM5", true],
        ["undefined column 42703", { code: "42703", message: 'column "list_id" of relation "products" does not exist' }, "Sony WH-1000XM5", true],
        ["undefined column PGRST204", { code: "PGRST204", message: "Could not find the 'list_id' column of 'products' in the schema cache" }, "Sony WH-1000XM5", true],
        ["undefined table 42P01", { code: "42P01", message: 'relation "public.products" does not exist' }, "Sony WH-1000XM5", true],
        ["undefined table PGRST205", { code: "PGRST205", message: "Could not find the table 'public.products' in the schema cache" }, "Sony WH-1000XM5", true],
        ["shop link against the old prisjagt-only check", { code: "23514", message: 'new row for relation "products" violates check constraint "products_source_url_check"' }, "https://www.bedrenaetter.dk/x.html", true],
        ["network error (no code)", { message: "TypeError: Failed to fetch" }, "Sony WH-1000XM5", false],
        ["other database error", { code: "XX000", message: "boom" }, "Sony WH-1000XM5", false],
      ];
      for (const admin of [false, true]) {
        for (const [name, err, typed, schema] of cases) {
          const p = await open({ products: [], admin, label: "save-err" });
          await p.waitForSelector("#addForm:not([hidden])"); if (admin) await p.waitForSelector("#accessBox:not([hidden])");
          await p.evaluate(e => { window.__db.insertError = e; }, err);
          await send(p, typed);
          const m = await msgOf(p), want = schema ? SCHEMA_OLD + (admin ? " " + FIX_IT : "") : "Kunne ikke gemme lige nu. Prøv igen om lidt.";
          check("save error (" + (admin ? "admin" : "normal") + "): " + name, m === want, m);
          await p.context().close();
        }
      }
      // a rejected request (network down) keeps the old text
      const n = await open({ products: [], label: "save-net" });
      await n.waitForSelector("#addForm:not([hidden])");
      await n.evaluate(() => { window.__db.netFail = true; });
      await send(n, "Sony WH-1000XM5");
      check("save error: network failure -> 'Kunne ikke gemme lige nu'", (await msgOf(n)) === "Kunne ikke gemme lige nu. Prøv igen om lidt.", await msgOf(n));
      await send(n, "https://onskeskyen.dk/s/e0mfx8");
      check("save error: network failure on an import -> the same text", (await msgOf(n)) === "Kunne ikke gemme lige nu. Prøv igen om lidt.", await msgOf(n));
      await n.context().close();
      // the real database rules are still reported as before (a name the database refuses, a prisjagt link it refuses)
      const o = await open({ products: [], label: "save-old-msgs" });
      await o.waitForSelector("#addForm:not([hidden])");
      await o.evaluate(() => { window.__db.insertError = { code: "23514", message: 'new row for relation "products" violates check constraint "products_name_not_blank"' }; });
      await send(o, "Sony WH-1000XM5");
      check("save error: a refused name keeps its own message", /Databasen afviste navnet eller målet/.test(await msgOf(o)), await msgOf(o));
      await o.evaluate(() => { window.__db.insertError = { code: "23514", message: 'new row for relation "products" violates check constraint "products_source_url_check"' }; });
      await send(o, "https://prisjagt.dk/produkt/x");
      check("save error: a refused prisjagt link keeps its own message", /Databasen afviste linket eller målet/.test(await msgOf(o)), await msgOf(o));
      await o.context().close();
    }

    // untrusted text: wish titles (as product names), list names and notes are escaped like any other text
    {
      const evil = "<script>window.__xss=1</script><img src=x onerror=window.__xss=2>";
      const p = await open({ products: [row("test-sony", { id: "h1", name: evil, source_url: "https://shop.dk/x" })], lists: [{ id: "l1", user_id: "u1", name: evil }], label: "wish-xss", imports: [
        imp("n1", { status: "done", added: 1, found: 1, title: evil, synced_at: new Date().toISOString(), sync_fails: 1, note: "De er lagt på listen " + evil + "." }), imp("n2", { status: "error", note: evil }),
      ] });
      await p.waitForSelector("#importBox .impl"); await p.waitForSelector(".item");
      await p.locator(".head").first().click();
      const r = await p.evaluate(() => ({ x: window.__xss, scripts: document.querySelectorAll("#list script, #importBox script, #chips script").length, imgs: document.querySelectorAll("#list img, #importBox img, #chips img").length,
        item: document.querySelector(".item h2").textContent, note: document.getElementById("importBox").textContent, chip: document.querySelector('#chips .lchip[data-lsel="l1"]').textContent }));
      check("hostile title: product name, list name and import note are text, no element, no script run", r.x === undefined && r.scripts === 0 && r.imgs === 0 && r.item === evil && r.note.indexOf(evil) >= 0 && r.chip.indexOf(evil) >= 0, JSON.stringify(r));
      await p.context().close();
    }

    // the hint under the add field: only for the choices that need a number
    {
      const p = await open({ products: [], label: "wish-hint" });
      await p.waitForSelector("#addForm:not([hidden])");
      const none = !(await p.isVisible("#fHint"));
      await p.click(".goal label:has(#fTypePrice)");
      const price = await p.isVisible("#fHint") && (await p.textContent("#fHint")) === "Varen skal være på lager.";
      await p.click(".goal label:has(#fTypePct)");
      const pct = (await p.textContent("#fHint")) === "Regnes fra normalprisen.";
      await p.click(".goal label:has(#fTypeAuto)");
      check("hint under the add field: none for the default, one short line for price and percent", none && price && pct && !(await p.isVisible("#fHint")));
      await p.context().close();
    }
  }

  // 10d. standing imports per list, bought products, the morning-mail setting
  {
    const imp = (id, over) => Object.assign({ id, user_id: "u1", list_id: null, url: "https://onskeskyen.dk/s/e0mfx8", status: "done", note: null, found: 4, added: 4, created_at: "2026-11-16T09:00:00Z", done_at: null, title: "Ønsker " + id, synced_at: new Date().toISOString(), sync_fails: 0 }, over || {});
    const LISTS = [{ id: "l1", user_id: "u1", name: "Elektronik" }, { id: "l2", user_id: "u1", name: "Bastian" }];
    const lines = pg => pg.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#importBox .impl"), e => e.firstChild.textContent));
    const prods = [Object.assign(row("test-sony-xm5", { id: "x5" }), { list_id: "l1" }), Object.assign(row("test-lego-falcon", { id: "lg" }), { list_id: "l2" }), row("test-dyson-v15", { id: "dy" })];

    // an import only shows when its list (or "Alle") is selected
    {
      const p = await open({ products: prods, lists: LISTS, label: "imp-lists", storage: { "pv-list": "all" }, imports: [imp("i1", { list_id: "l1" }), imp("i2", { list_id: "l2" }), imp("i3", { list_id: null })] });
      await p.waitForSelector("#importBox .impl");
      check("imports per list: 'Alle' shows every standing line", (await lines(p)).length === 3);
      await p.click('#chips [data-lsel="l1"]');
      check("imports per list: Elektronik shows only its own", JSON.stringify(await lines(p)) === JSON.stringify(["Følger Ønsker i1 · 4 ønsker · opdateret i dag"]), JSON.stringify(await lines(p)));
      await p.click('#chips [data-lsel="l2"]');
      check("imports per list: Bastian shows only its own", JSON.stringify(await lines(p)) === JSON.stringify(["Følger Ønsker i2 · 4 ønsker · opdateret i dag"]));
      await p.click('#chips [data-lsel="none"]');
      check("imports per list: 'Uden liste' shows the one without a list", JSON.stringify(await lines(p)) === JSON.stringify(["Følger Ønsker i3 · 4 ønsker · opdateret i dag"]));
      await p.click('#chips [data-lsel="all"]');
      check("imports per list: back on 'Alle' they are all there; the chips' counts are the products' only", (await lines(p)).length === 3 && (await p.textContent('#chips [data-lsel="l1"]')).replace(/\s+/g, " ").trim() === "Elektronik 1");
      // a list with no import and no pending: the box is hidden
      await p.evaluate(() => { window.__db.imports = window.__db.imports.filter(function (x) { return x.id !== "i2"; }); window.__tick(); });
      await p.waitForFunction(() => document.querySelectorAll("#importBox .impl").length === 2);
      await p.click('#chips [data-lsel="l2"]');
      check("imports per list: a list without an import shows no line and no box", !(await p.isVisible("#importBox")));
      await p.context().close();
    }

    // the caps still make sense with standing lines: only pending ones count towards 5, all rows towards 20
    {
      const p = await open({ products: [], label: "imp-caps", imports: [imp("s1"), imp("s2"), imp("s3"), imp("s4", { status: "pending" }), imp("s5", { status: "pending" }), imp("s6", { status: "pending" }), imp("s7", { status: "pending" })] });
      await p.waitForSelector("#importBox .impl");
      await p.fill("#fMain", "https://onskeskyen.dk/s/femte"); await p.click("#fSubmit"); await p.waitForTimeout(200);
      check("caps: 3 standing + 4 pending: a 5th pending is accepted", (await p.evaluate(() => window.__db.imports.length)) === 8);
      await p.fill("#fMain", "https://onskeskyen.dk/s/sjette"); await p.click("#fSubmit"); await p.waitForTimeout(200);
      check("caps: the 6th pending is refused, standing lines do not count as pending", /Du har allerede 5 ønskelister i gang/.test(await p.textContent("#fMsg")) && (await p.evaluate(() => window.__db.imports.length)) === 8);
      await p.context().close();
    }

    // Købt / Fortryd
    {
      const p = await open({ products: prods, lists: LISTS, label: "bought", storage: { "pv-list": "all" } });
      await p.waitForSelector(".item");
      const head = id => p.locator('.head[data-id="' + id + '"]');
      check("bought: before, the hit sits first and is highlighted", (await p.locator(".item").first().getAttribute("class")).indexOf("hit") >= 0 && (await p.locator(".item h2").first().textContent()) === row("test-dyson-v15").name);
      await head("dy").click();
      check("bought: a small 'Købt' action in the detail view", (await p.locator('[data-act="buy"][data-id="dy"]').textContent()) === "Købt" && (await p.locator('[data-bought="dy"]').count()) === 0);
      await p.click('[data-act="buy"][data-id="dy"]');
      await p.waitForFunction(() => window.__db.writes().length === 1);
      let o = (await ops(p))[0];
      check("bought: one click, no question: bought_at = now and bought_price = the lowest in-stock price", o.table === "products" && o.op === "update" && o.filters[0][1] === "dy" && Object.keys(o.payload).sort().join() === "bought_at,bought_price" && o.payload.bought_price === 3999 && Math.abs(Date.parse(o.payload.bought_at) - Date.now()) < 60000, JSON.stringify(o));
      await p.waitForFunction(() => /Købt for 3\.999 kr\./.test(document.body.textContent));
      const it = p.locator(".item", { has: p.locator('.head[data-id="dy"]') });
      check("bought: the line says 'Købt for 3.999 kr.', no goal text, no highlight, no 'Mål nået'", (await it.locator(".meta").first().textContent()) === "Købt for 3.999 kr." && (await it.getAttribute("class")).indexOf("hit") < 0 && !/Mål nået|Godt tilbud/.test(await it.locator(".head").textContent()) && (await it.locator(".price span").textContent()) === "");
      check("bought: dimmed, and at the bottom of the list", (await it.getAttribute("class")).indexOf("bought") >= 0 && +(await it.evaluate(e => getComputedStyle(e).opacity)) < 1 && (await p.locator(".item").last().getAttribute("class")).indexOf("bought") >= 0 && (await p.locator(".item").first().getAttribute("class")).indexOf("bought") < 0);
      const cel = await p.evaluate(() => (window.__pvCelebrations || []).length);
      await p.evaluate(() => window.__tick()); await p.waitForTimeout(200);
      check("bought: no sound or celebration for it (the one before the click was the hit it used to be)", (await p.evaluate(() => (window.__pvCelebrations || []).length)) === cel);
      check("bought: counts in the chips as before", (await p.textContent('#chips [data-lsel="all"]')).replace(/\s+/g, " ").trim() === "Alle 3");
      // edit the price
      await p.fill("#bp-dy", "4100"); await p.click('[data-bought="dy"] button[type=submit]');
      await p.waitForFunction(() => window.__db.writes().length === 2);
      o = (await ops(p))[1];
      check("bought: the price can be edited afterwards (only that column)", JSON.stringify(o.payload) === '{"bought_price":4100}' && o.filters[0][1] === "dy", JSON.stringify(o));
      await p.waitForFunction(() => /Købt for 4\.100 kr\. · nu 3\.999 kr\./.test(document.body.textContent));
      check("bought: when today's price differs it says 'nu ...'", true);
      await p.fill("#bp-dy", "0"); await p.click('[data-bought="dy"] button[type=submit]');
      check("bought: a price of 0 is refused locally", (await ops(p)).length === 2 && /Skriv en pris/.test(await p.textContent('[data-rowmsg="b-dy"]')));
      await p.fill("#bp-dy", "3999"); await p.click('[data-bought="dy"] button[type=submit]');
      await p.waitForFunction(() => window.__db.writes().length === 3);
      check("bought: same price as today: no 'nu'", (await it.locator(".meta").first().textContent()) === "Købt for 3.999 kr.");
      await p.fill("#bp-dy", ""); await p.click('[data-bought="dy"] button[type=submit]');
      await p.waitForFunction(() => window.__db.writes().length === 4);
      check("bought: an empty price is allowed (price unknown): just 'Købt'", JSON.stringify((await ops(p))[3].payload) === '{"bought_price":null}' && (await it.locator(".meta").first().textContent()) === "Købt");
      // undo
      await p.click('[data-act="unbuy"][data-id="dy"]');
      await p.waitForFunction(() => window.__db.writes().length === 5);
      o = (await ops(p))[4];
      check("Fortryd: clears both columns, the product is a hit again and back on top", JSON.stringify(o.payload) === '{"bought_at":null,"bought_price":null}' && (await p.locator(".item").first().getAttribute("class")).indexOf("hit") >= 0 && (await p.locator(".item.bought").count()) === 0);
      // a product whose price is not known: the price is stored as null
      await head("lg").click();
      await p.evaluate(() => { var r = window.__db.products.filter(function (x) { return x.id === "lg"; })[0]; r.offers = r.offers.map(function (o) { o.inStock = false; return o; }); window.__tick(); });
      await p.waitForTimeout(150);
      await p.click('[data-act="buy"][data-id="lg"]');
      await p.waitForFunction(() => window.__db.writes().length === 6);
      check("bought: nothing in stock, so no price is guessed (null)", (await ops(p))[5].payload.bought_price === null);
      await p.context().close();
    }

    // not offered on rows that have no price yet, nor to people who may not write; a denied write says so
    {
      const p = await open({ products: [pendingRow, errorRow, row("test-sony-xm5", { id: "x5" })], label: "bought-none" });
      await p.waitForSelector(".item");
      for (const id of ["p1", "e1"]) await p.locator('.head[data-id="' + id + '"]').click();
      await p.locator('.head[data-id="x5"]').click();
      check("bought: no 'Købt' on pending or failed rows, only on the one with prices", (await p.locator('[data-act="buy"]').count()) === 1 && (await p.locator('[data-act="buy"]').getAttribute("data-id")) === "x5");
      await p.evaluate(() => { window.__db.deny = true; });
      await p.click('[data-act="buy"][data-id="x5"]');
      await p.waitForSelector("#readonly:not([hidden])");
      check("bought: a denied write turns the page read-only, no 'Købt' any more", (await p.locator('[data-act="buy"]').count()) === 0 && (await p.locator(".item.bought").count()) === 0);
      await p.context().close();
      const q = await open({ products: [Object.assign(row("test-sony-xm5", { id: "x5" }), { bought_at: "2026-11-10T10:00:00Z", bought_price: 2100 })], label: "bought-warn" });
      await q.waitForSelector(".item");
      await q.locator('.head[data-id="x5"]').click();
      check("bought: Fortryd and the price field are there from the stored values", (await q.inputValue("#bp-x5")) === "2100" && (await q.locator('[data-act="unbuy"]').count()) === 1 && /Købt for 2\.100 kr\. · nu 2\.049 kr\./.test(await q.textContent(".head")));
      await q.context().close();
    }

    // the morning mail setting
    {
      const p = await open({ products: [], label: "digest" });
      await p.waitForSelector("#addForm:not([hidden])");
      await p.locator("#settingsBox summary").click();
      check("digest: the setting 'Saml tilbud i én morgenmail', off by default", /^\s*Saml tilbud i én morgenmail\s*$/.test(await p.textContent('label.chk:has(#shDigest)')) && !(await p.isChecked("#shDigest")) && !(await p.isDisabled("#shDigest")));
      await p.check("#shDigest"); await p.click('#shopForm button[type=submit]');
      await p.waitForFunction(() => window.__db.profiles[0] && window.__db.profiles[0].mail_digest === true);
      const pr = await p.evaluate(() => window.__db.ops.filter(x => x.table === "profiles" && "mail_digest" in x.payload).pop().payload);
      check("digest: saved as mail_digest true with the other settings; never digest_sent_at", pr.mail_digest === true && pr.notify_email === true && !("digest_sent_at" in pr), JSON.stringify(pr));
      await p.uncheck("#shNotify");
      check("digest: follows the e-mail switch (off means no mails at all, so the choice is greyed out)", await p.isDisabled("#shDigest"));
      await p.check("#shNotify");
      check("digest: and is available again", !(await p.isDisabled("#shDigest")));
      await p.uncheck("#shDigest"); await p.click('#shopForm button[type=submit]');
      await p.waitForFunction(() => window.__db.profiles[0].mail_digest === false);
      check("digest: switched off again", true);
      await p.context().close();
      const q = await open({ products: [], label: "digest-on", profiles: [{ user_id: "u1", notify_email: true, mail_digest: true, shops_always: [], shops_exclude: [], shops_only: false }] });
      await q.waitForSelector("#addForm:not([hidden])");
      await q.locator("#settingsBox summary").click();
      await q.waitForFunction(() => document.getElementById("shDigest").checked);
      check("digest: shown on when the profile has it on", true);
      await q.context().close();
    }
  }

  // 11. layout at 400px, 12. screenshots
  {
    const LISTS = [{ id: "l1", user_id: "u1", name: "Elektronik" }, { id: "l2", user_id: "u1", name: "Bastian" }, { id: "l3", user_id: "u1", name: "Hjemmet" }];
    const inList = { x5: "l1", ps: "l1", so: "l1", lg: "l2", dy: "l3" };
    const states = all.concat([row("test-lego-falcon", { id: "lg" }), row("test-sonicare", { id: "so" })]).map(r => inList[r.id] ? Object.assign({}, r, { list_id: inList[r.id] }) : r);
    const p = await open({ products: states, width: 400, height: 900, lists: LISTS, label: "mobile" });
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
      const d = await open({ products: states, scheme, lists: LISTS, label: "shot-" + scheme });
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

  // 15. installable app (PWA): manifest, icons, service worker, install item
  {
    const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    const rel = u => !/^(\/|[a-z]+:)/i.test(u);
    const bare = async (ctxOpts, init) => {   // a page with the fake client but without open()'s defaults
      const ctx = await browser.newContext(Object.assign({ serviceWorkers: "block" }, ctxOpts || {}));
      const pg = await ctx.newPage(); pg.on("pageerror", e => pageErrors.push("pwa: " + e.message));
      await pg.route(/cdn\.jsdelivr\.net/, r => r.fulfill({ contentType: "text/javascript", body: "/* test: client is injected */" }));
      await pg.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: "text/css", body: "" }));
      await pg.route(/\/config\.js$/, r => r.fulfill({ contentType: "text/javascript", body: 'window.PV_CONFIG={supabaseUrl:"https://x.supabase.test",supabaseAnonKey:"anon"};' }));
      await pg.addInitScript("window.__INIT = { session: null };");
      await pg.addInitScript(FAKE);
      if (init) await pg.addInitScript(init.fn, init.arg);
      await pg.goto(base + "/index.html");
      return pg;
    };
    const mLink = /<link rel="manifest" href="([^"]+)"/.exec(html);
    check("manifest is linked with a relative href", mLink && rel(mLink[1]), mLink && mLink[1]);
    let man = null;
    try { man = JSON.parse(fs.readFileSync(path.join(ROOT, mLink[1]), "utf8")); } catch (e) {}
    check("manifest is valid JSON with relative start_url and scope", man && man.start_url === "./" && man.scope === "./" && man.display === "standalone" && man.lang === "da" && man.name === "Prisvagten");
    const pngSize = f => { const b = fs.readFileSync(f); return b.readUInt32BE(16) + "x" + b.readUInt32BE(20); };
    const icons = (man && man.icons) || [];
    check("manifest icons exist on disk with the stated sizes, incl. maskable", icons.length >= 3 && icons.every(i => rel(i.src) && fs.existsSync(path.join(ROOT, i.src)) && pngSize(path.join(ROOT, i.src)) === i.sizes) && icons.some(i => i.purpose === "maskable"));
    check("apple-touch-icon is 180x180 and linked", /rel="apple-touch-icon" href="icons\/apple-touch-icon.png"/.test(html) && pngSize(path.join(ROOT, "icons", "apple-touch-icon.png")) === "180x180");
    check("theme-color metas for light and dark", /name="theme-color"[^>]*prefers-color-scheme: light/.test(html) && /name="theme-color"[^>]*prefers-color-scheme: dark/.test(html));

    let parses = true; try { new (require("vm").Script)(fs.readFileSync(path.join(ROOT, "sw.js"), "utf8")); } catch (e) { parses = false; }
    check("service worker file parses", parses);
    const sw = require(path.join(ROOT, "sw.js"));
    const O = "https://jesperfrank.github.io";
    check("worker handles same-origin GET only", sw.shouldHandle("GET", O + "/pricetracker/app.js", O) && sw.shouldHandle("get", O + "/pricetracker/", O)
      && !sw.shouldHandle("POST", O + "/pricetracker/app.js", O) && !sw.shouldHandle("PUT", O + "/x", O) && !sw.shouldHandle("DELETE", O + "/x", O));
    check("worker ignores cross-origin requests (Supabase, jsDelivr, fonts)", !sw.shouldHandle("GET", "https://abc.supabase.co/rest/v1/products", O)
      && !sw.shouldHandle("GET", "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js", O) && !sw.shouldHandle("GET", "not a url", O));
    check("worker does not touch sounds", !sw.shouldHandle("GET", O + "/pricetracker/sounds/kasse.mp3", O));
    check("shell files all exist", sw.SHELL.filter(f => f !== "./").every(f => fs.existsSync(path.join(ROOT, f))));

    {   // the worker registers and creates its versioned cache
      const ctx = await browser.newContext({ serviceWorkers: "allow" });
      const pg = await ctx.newPage(); pg.on("pageerror", e => pageErrors.push("sw: " + e.message));
      await pg.route(/cdn\.jsdelivr\.net/, r => r.fulfill({ contentType: "text/javascript", body: "" }));
      await pg.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: "text/css", body: "" }));
      await pg.goto(base + "/index.html");
      const ok = await pg.evaluate(() => navigator.serviceWorker.ready.then(() => new Promise(r => setTimeout(r, 500))).then(() => caches.keys()).then(k => k.length === 1 && /^prisvagten-shell-v/.test(k[0]))).catch(() => false);
      check("service worker registers and creates a versioned cache", ok);
      await ctx.close();
    }
    for (const mode of ["reject", "throw"]) {   // a failing registration must not break the page
      const pg = await bare({}, { arg: mode, fn: m => { Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: () => { if (m === "throw") throw new Error("nope"); return Promise.reject(new Error("nope")); } } }); } });
      await pg.waitForSelector("#authView:not([hidden])", { timeout: 5000 }).catch(() => {});
      check("page works when service worker registration " + (mode === "throw" ? "throws" : "is rejected"), await pg.isVisible("#authView"));
      await pg.context().close();
    }
    {
      const p = await open({ session: false, label: "install" });
      check("install item is hidden until the browser offers install", !(await p.isVisible("#installBox")));
      await p.evaluate(() => { const e = new Event("beforeinstallprompt", { cancelable: true }); e.prompt = () => { window.__prompted = true; }; window.dispatchEvent(e); });
      check("install link shows on beforeinstallprompt", await p.isVisible("#installBtn") && /Læg på hjemmeskærmen/.test(await p.textContent("#installBtn")));
      await p.click("#installBtn");
      check("install link triggers the prompt and goes away", await p.evaluate(() => window.__prompted === true) && !(await p.isVisible("#installBox")));
      await p.context().close();
      const sp = await bare({}, { fn: () => { const mm = window.matchMedia.bind(window); window.matchMedia = q => /display-mode: standalone/.test(q) ? { matches: true, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} } : mm(q); } });
      await sp.evaluate(() => window.dispatchEvent(new Event("beforeinstallprompt", { cancelable: true })));
      check("install item stays hidden when running standalone", !(await sp.isVisible("#installBox")) && !(await sp.isVisible("#installIos")));
      await sp.context().close();
      const ip = await bare({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1" });
      check("iOS shows a collapsed hint with the Del instruction", await ip.isVisible("#installIos") && !(await ip.evaluate(() => document.getElementById("installIos").open)) && /Tryk på Del, og vælg Føj til hjemmeskærm\./.test(await ip.textContent("#installIos")));
      await ip.context().close();
    }
  }

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
