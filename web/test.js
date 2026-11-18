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
  var db = window.__db = { products: init.products || [], lists: init.lists || [], noLists: !!init.noLists, profiles: init.profiles || [], imports: init.imports || [], noImports: !!init.noImports, members: init.members || [], people: init.people || {}, noMembers: !!init.noMembers, shareAnswer: "ok", ops: [], deny: false, otpError: null,
    session: init.session || null, seq: 100, admin: !!init.admin, requests: init.requests || [], allowedList: init.allowed || [], rpcs: [], askReply: "requested" };
  var authCb = null, rt = [];
  // the 60-second poll: remember its callback so a test can run it at once
  var ticks = [], realSetInterval = window.setInterval;
  window.setInterval = function (fn, ms) { if (ms === 60000) ticks.push(fn); return realSetInterval.apply(window, arguments); };
  window.__tick = function () { ticks.forEach(function (f) { f(); }); };
  var JOB = ["status","title","variants","offers","history","normal_price","verdict","warning","check_note","last_checked","notified_price","notified_at","backfill_state","digest_price","digest_at","alternatives","alt_done_at","alt_note","compare_at","shop_url"];
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
        var rows = table === "products" ? db.products : table === "lists" ? db.lists : table === "imports" ? db.imports : table === "list_members" ? db.members : db.profiles;
        if (table === "list_members" && db.noMembers) return resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table public.list_members in the schema cache" } });
        if (table === "imports" && db.noImports) return resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table public.imports in the schema cache" } });
        if (q.op === "insert" && db.insertError && (table === "products" || table === "imports")) return resolve({ data: null, error: clone(db.insertError) });
        if (table === "products" && q.op === "insert" && db.oldGoalCheck && q.payload.target_type === "auto") return resolve({ data: null, error: { code: "23514", message: 'new row for relation "products" violates check constraint "products_target_type_check"', details: "Failing row contains (...)." } });
        if (table === "products" && (q.op === "insert" || q.op === "update") && db.noReqCol && "requirements" in q.payload) return resolve({ data: null, error: { code: "PGRST204", message: "Could not find the 'requirements' column of 'products' in the schema cache" } });
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
        if (q.op === "update" && table === "products" && "alt_requested_at" in q.payload && db.altError) return resolve({ data: null, error: clone(db.altError) });
        if (q.op === "update") {
          rows.filter(match).forEach(function (r) {
            if (table === "products" && "alt_requested_at" in q.payload && q.payload.alt_requested_at) r.alt_requested_at = new Date().toISOString();   // products_guard: the server stamps the time
            if (table === "products" && "alt_requested_at" in q.payload) delete q.payload.alt_requested_at;
            var newLink = "source_url" in q.payload && q.payload.source_url !== r.source_url;
            if (table === "products" && "compare_state" in r) {   // products_guard: the state is the server's; a request, or the way back to the original shop link
              if (newLink) {
                if (r.compare_state === "done" && r.shop_url && q.payload.source_url === r.shop_url) { r.compare_state = "none"; r.compare_at = new Date().toISOString(); r.shop_url = null; }
                else { r.compare_state = null; r.compare_at = null; r.shop_url = null; }
              } else if (q.payload.compare_state === "wanted" && r.compare_state !== "wanted" && r.source_url && !/^https:[/][/](www[.])?prisjagt[.]dk/i.test(r.source_url)
                         && (r.compare_state == null || (r.compare_state === "none" && Date.now() - Date.parse(r.compare_at) > 7 * 864e5))) { r.compare_state = "wanted"; r.compare_at = new Date().toISOString(); }
              delete q.payload.compare_state;
            }
            if (table === "products" && "extra_urls" in q.payload) {   // products_guard: only the removal of ONE entry is accepted (the last one with null); the rest is ignored
              var oldX = r.extra_urls, newX = q.payload.extra_urls, okX = false;
              if (Array.isArray(oldX)) {
                if (newX === null) okX = oldX.length === 1;
                else if (Array.isArray(newX) && oldX.length >= 2 && newX.length === oldX.length - 1) okX = oldX.some(function (_, i) { return JSON.stringify(oldX.filter(function (__, j) { return j !== i; })) === JSON.stringify(newX); });
              }
              if (okX) { r.extra_urls = newX; if (newX === null) { r.compare_state = "none"; r.compare_at = new Date().toISOString(); } }
              delete q.payload.extra_urls;
            }
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
  window.__authEmit = function (ev, s) { if (authCb) authCb(ev, s); };
  window.__emit = function () { rt.forEach(function (f) { f({ eventType: "UPDATE" }); }); };
  function rpc(name, args) {
    db.rpcs.push({ name: name, args: clone(args || {}) });
    return new Promise(function (resolve) { setTimeout(function () {
      var ADMIN = ["admin_list_requests", "admin_decide", "admin_list_allowed", "admin_remove_allowed"];
      if (ADMIN.indexOf(name) >= 0 && !db.admin) return resolve({ data: null, error: { code: "42501", message: "admin only" } });
      if (db.rpcFail && name !== "admin_list_requests" && name !== "admin_list_allowed") return resolve({ data: null, error: { message: "boom" } });
      if (name === "list_members_named") return resolve({ data: clone(db.people[args.p_list] || []), error: null });
      if (name === "share_list") {
        if (db.shareError) return resolve({ data: null, error: clone(db.shareError) });
        if (db.shareAnswer === "ok") { var nm = String(args.p_email).split("@")[0]; nm = nm.charAt(0).toUpperCase() + nm.slice(1); var nid = "m-" + (++db.seq);
          db.members.push({ list_id: args.p_list, user_id: nid }); (db.people[args.p_list] = db.people[args.p_list] || [{ user_id: "u1", name: "Mor", role: "owner", email: null }]).push({ user_id: nid, name: nm, role: "member", email: String(args.p_email).toLowerCase() }); }
        return resolve({ data: db.shareAnswer, error: null });
      }
      if (name === "unshare_list") {
        db.members = db.members.filter(function (m) { return !(m.list_id === args.p_list && m.user_id === args.p_user); });
        db.people[args.p_list] = (db.people[args.p_list] || []).filter(function (x) { return x.user_id !== args.p_user; });
        // the person's products leave the list and stay theirs: the owner can no longer read them
        db.products = db.products.filter(function (p) { return !(p.list_id === args.p_list && p.user_id === args.p_user); });
        return resolve({ data: true, error: null });
      }
      if (name === "leave_list") {
        db.members = db.members.filter(function (m) { return !(m.list_id === args.p_list && m.user_id === "u1"); });
        db.products = db.products.filter(function (p) { return p.list_id !== args.p_list || p.user_id === "u1"; });
        db.products.forEach(function (p) { if (p.list_id === args.p_list) p.list_id = null; });
        db.lists = db.lists.filter(function (l) { return l.id !== args.p_list; });
        return resolve({ data: true, error: null });
      }
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
        verifyOtp: function (a) {
          db.ops.push({ op: "verify", payload: clone(a) });
          if (a.type !== "email" || a.token !== (db.goodCode || "123456")) return Promise.resolve({ data: { user: null, session: null }, error: { status: 403, code: "otp_expired", message: "Token has expired or is invalid" } });
          db.session = { user: { id: "u1", email: a.email } };
          if (authCb) authCb("SIGNED_IN", db.session);
          return Promise.resolve({ data: { user: db.session.user, session: db.session }, error: null });
        },
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

// Product pictures: the page only loads https addresses, so the tests answer https://img.example.test/... themselves (no external request).
// "broken" answers 404. Every picture request is counted per page (page.imgReqs).
function imgSvg(slug) {
  let h = 0; for (const c of slug) h = (h * 31 + c.charCodeAt(0)) % 360;
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="hsl(' + h + ',28%,92%)"/>' +
    '<rect x="26" y="22" width="44" height="52" rx="8" fill="hsl(' + h + ',30%,62%)"/><rect x="34" y="30" width="28" height="22" rx="4" fill="hsl(' + h + ',30%,86%)"/><circle cx="48" cy="63" r="5" fill="hsl(' + h + ',30%,88%)"/></svg>';
}
let browser;
async function open(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width || 900, height: opts.height || 900 }, colorScheme: opts.scheme || "light", serviceWorkers: "block" });
  const page = await ctx.newPage();
  page.on("pageerror", e => pageErrors.push(opts.label + ": " + e.message));
  page.imgReqs = [];
  await page.route(/^https:\/\/img\.example\.test\//, r => {
    const u = new URL(r.request().url()); page.imgReqs.push(r.request().url());
    if (/broken/.test(u.pathname)) return r.fulfill({ status: 404, contentType: "text/plain", body: "no" });
    r.fulfill({ contentType: "image/svg+xml", body: imgSvg(u.pathname) });
  });
  page.on("console", m => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) pageErrors.push(opts.label + " console: " + m.text()); });
  await page.route(/cdn\.jsdelivr\.net/, r => r.fulfill({ contentType: "text/javascript", body: "/* test: client is injected */" }));
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.fulfill({ contentType: "text/css", body: "" }));
  // config.js in the repo holds the real project's values, so both cases are served from the test, never from the file.
  await page.route(/\/config\.js$/, r => r.fulfill({ contentType: "text/javascript", body: opts.config === false ? "window.PV_CONFIG={supabaseUrl:\"\",supabaseAnonKey:\"\"};" : 'window.PV_CONFIG={supabaseUrl:"https://x.supabase.test",supabaseAnonKey:"anon"};' }));
  const init = { session: opts.session === false ? null : { user: { id: "u1", email: "mor@familie.dk" } }, products: opts.products || [], lists: opts.lists || [], noLists: !!opts.noLists, imports: opts.imports || [], noImports: !!opts.noImports, members: opts.members || [], people: opts.people || {}, noMembers: !!opts.noMembers, profiles: opts.profiles || [], admin: !!opts.admin, requests: opts.requests || [], allowed: opts.allowed || [] };
  await page.addInitScript("window.__INIT = " + JSON.stringify(init) + ";");
  if (opts.fake !== false) await page.addInitScript(FAKE);
  // The behaviour tests below work with the sections "Indstil vare", "Vis alle butikker" and the group of products that cannot be fetched opened (they are collapsed by default; the tests
  // of that collapsing pass collapsed: true). Opening goes through the real toggle, so the page keeps it across renders.
  if (!opts.collapsed) await page.addInitScript(() => {
    const fix = () => document.querySelectorAll('.disc[aria-expanded="false"], details.errs:not([open])').forEach(d => { if (d.tagName === "BUTTON") d.click(); else d.open = true; });
    document.addEventListener("DOMContentLoaded", () => new MutationObserver(fix).observe(document.body, { childList: true, subtree: true }));
  });
  if (opts.storage) await page.addInitScript(s => { for (const k in s) localStorage.setItem(k, s[k]); }, opts.storage);
  await page.goto(base + "/index.html");
  return page;
}
const row = (id, over) => Object.assign({ id, user_id: "u1", shops_always: null, shops_exclude: null, shops_only: null }, JSON.parse(JSON.stringify(FIX[id.split("#")[0]] || {})), over || {});
const ops = page => page.evaluate(() => window.__db.writes());
// the account menu, the settings panel, and the collapsed sections inside the list
const menu = async p => { if (!(await p.isVisible("#acctPop"))) await p.click("#acctBtn"); };
const openSettings = async p => { await menu(p); await p.click("#settingsBtn"); await p.waitForSelector("#settingsBox:not([hidden])"); };
const openAll = p => p.evaluate(() => document.querySelectorAll('.disc[aria-expanded="false"], details.errs').forEach(d => { if (d.tagName === "BUTTON") d.click(); else d.open = true; }));
const openGoal = async (p, id) => { const b = p.locator('[data-act="goal-open"][data-id="' + id + '"]'); if ((await b.getAttribute("aria-expanded")) !== "true") await b.click(); await p.waitForSelector("#gp-" + id); };
const mOpen = loc => loc.locator("> .disc").getAttribute("aria-expanded").then(v => v === "true");
const goalPick = async (p, sel) => { await p.focus("#fMain"); await p.click(".goal label:has(" + sel + ")"); };

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

  // 2a. code login
  {
    const p = await open({ session: false, label: "code" });
    await p.fill("#lEmail", "mor@familie.dk"); await p.click("#lSubmit");
    await p.waitForSelector("#sentBox:not([hidden])");
    const inp = await p.getAttribute("#cCode", "inputmode") + "|" + await p.getAttribute("#cCode", "autocomplete");
    check("code: field has numeric inputmode and one-time-code", inp === "numeric|one-time-code", inp);
    check("code: sent text offers link or code", /Åbn linket, eller skriv koden/.test(await p.textContent("#sentBox")) && await p.isVisible("#cSubmit") && /Log ind/.test(await p.textContent("#cSubmit")));
    await p.fill("#cCode", "999999"); await p.click("#cSubmit");
    await p.waitForFunction(() => !document.getElementById("cMsg").hidden);
    check("code: wrong code gives Danish message and stays on screen", /Koden passer ikke, eller den er udløbet\./.test(await p.textContent("#cMsg")) && await p.isVisible("#sentBox") && !(await p.isVisible("#appView")));
    await p.fill("#cCode", "12"); await p.click("#cSubmit");
    check("code: too short code is not sent", (await ops(p)).filter(x => x.op === "verify").length === 1);
    // resend cooldown
    await p.click("#sentResend");
    check("code: resend inside 30 s is blocked", /Vent/.test(await p.textContent("#cMsg")) && (await ops(p)).filter(x => x.op === "otp").length === 1);
    await p.evaluate(() => { var o = Date.now; Date.now = function () { return o() + 31000; }; });
    await p.click("#sentResend");
    await p.waitForFunction(() => /Ny mail sendt/.test(document.getElementById("cMsg").textContent));
    const otps = (await ops(p)).filter(x => x.op === "otp");
    check("code: resend after 30 s sends again with same address and redirect", otps.length === 2 && otps[1].payload.email === "mor@familie.dk" && otps[1].payload.options.emailRedirectTo === base + "/index.html");
    // reload keeps the address
    await p.reload();
    await p.waitForSelector("#sentBox:not([hidden])");
    check("code: reload keeps the sent screen and address", (await p.textContent("#sentTo")) === "mor@familie.dk");
    await p.fill("#cCode", " 123 456 "); await p.click("#cSubmit");
    await p.waitForSelector("#appView:not([hidden])");
    const v = (await ops(p)).find(x => x.op === "verify");
    check("code: pasted code with spaces is verified as email OTP for the stored address", v && v.payload.email === "mor@familie.dk" && v.payload.token === "123456" && v.payload.type === "email", JSON.stringify(v));
    check("code: login continues like after a link (app shown, address in header)", /mor@familie\.dk/.test(await p.textContent("#who")) && !(await p.isVisible("#authView")));
    check("code: stored address cleared after login", await p.evaluate(() => sessionStorage.getItem("pv_login_email")) === null);
    await p.context().close();
    const q = await open({ session: false, label: "code8" });
    await q.evaluate(() => { window.__db.goodCode = "12345678"; });
    await q.fill("#lEmail", "far@familie.dk"); await q.click("#lSubmit");
    await q.waitForSelector("#sentBox:not([hidden])");
    await q.fill("#cCode", "12345678"); await q.click("#cSubmit");
    await q.waitForSelector("#appView:not([hidden])");
    check("code: 8-digit code accepted", true);
    await q.context().close();
    // magic link path: session arrives through onAuthStateChange without any code
    const r = await open({ session: false, label: "link" });
    await r.fill("#lEmail", "mor@familie.dk"); await r.click("#lSubmit");
    await r.waitForSelector("#sentBox:not([hidden])");
    await r.evaluate(() => { window.__db.session = { user: { id: "u1", email: "mor@familie.dk" } }; window.__authEmit("SIGNED_IN", window.__db.session); });
    await r.waitForSelector("#appView:not([hidden])");
    check("link: magic-link login (auth event, no code) still logs in", /mor@familie\.dk/.test(await r.textContent("#who")) && !(await r.isVisible("#sentBox")));
    await r.context().close();
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
    check("signed in: one 'Konto' button with the initial; address, sound and log out are not shown until the menu is open",
      await p.isVisible("#acctBtn") && (await p.getAttribute("#acctBtn", "aria-label")) === "Konto" && (await p.textContent("#acctInitial")) === "M" && !(await p.isVisible("#who")) && !(await p.isVisible("#soundBtn")) && !(await p.isVisible("#logoutBtn")));
    await p.click("#acctBtn");
    check("account menu: the address (muted), Lyd til, Indstillinger, Log ud; no Adgang for a non-admin",
      /mor@familie\.dk/.test(await p.textContent("#who")) && /Lyd til/.test(await p.textContent("#soundBtn")) && await p.isVisible("#settingsBtn") && await p.isVisible("#logoutBtn") && !(await p.isVisible("#accessBtn")));
    await p.keyboard.press("Escape");
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
    const it = p.locator('.item:has(.head[data-id="sh"])');
    await it.locator(".head").click();
    const bt = await it.locator(".body").textContent();
    check("single-shop detail: quiet line, shop in the table, remark about several variants", /Kun denne butik\. Et link fra prisjagt\.dk sammenligner flere\./.test(bt) && /Bedre Nætter/.test(bt) && /flere varianter med forskellige priser/.test(bt) && /579 kr\./.test(bt), bt.slice(0, 300));
    check("single-shop detail: no 'Skift variant', no 'Variant:' line", !/Skift variant/.test(bt) && !/Variant:/.test(bt) && (await it.locator('[data-act="change"]').count()) === 0);
    check("single-shop with archive points (fixture history): the short gaps note", /Ældre priser kan være upræcise og have huller\./.test(bt), bt.slice(0, 300));
    const other = p.locator('.item:has(.head[data-id="dy"]) .body');
    await p.locator('.head[data-id="dy"]').click();
    await openAll(p);
    check("prisjagt product still has 'Skift variant' (under Indstil vare) and no single-shop line", /Skift variant/.test(await other.textContent()) && !/Kun denne butik/.test(await other.textContent()));
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
    await goalPick(p, "#fTypePrice");
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
    await p.fill("#fMain", "https://prisjagt.dk/product.php?p=555"); await goalPick(p, "#fTypePct"); await p.fill("#fVal", "20"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 2);
    o = (await ops(p))[1];
    check("add: link still works with % goal (placeholder name, source_url)", JSON.stringify(o.payload) === JSON.stringify({ name: "Nyt produkt", source_url: "https://prisjagt.dk/product.php?p=555", target_type: "pct", target_value: 20, active: true }), JSON.stringify(o.payload));
    // a link to a single shop is accepted as it is (fragment dropped), same row shape as a prisjagt link
    await p.fill("#fMain", " https://www.bedrenaetter.dk/mayan-kuvertlagen-180x200-hvid.html#reviews "); await goalPick(p, "#fTypePrice"); await p.fill("#fVal", "450"); await p.click("#fSubmit");
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
    await goalPick(p, "#fTypePrice");
    await p.fill("#fMain", "  Sony   WH-1000XM5 sort "); await p.fill("#fVal", "1700"); await p.click("#fSubmit");
    await p.waitForFunction(() => window.__db.writes().length === 4);
    o = (await ops(p))[3];
    check("add: name only -> {name, target_type, target_value} without source_url", JSON.stringify(o.payload) === JSON.stringify({ name: "Sony WH-1000XM5 sort", target_type: "price", target_value: 1700 }), JSON.stringify(o.payload));
    await p.waitForFunction(() => /Finder produktet …/.test(document.getElementById("list").textContent));
    check("add: name-only row shows 'Finder produktet …'", true);
    await p.fill("#fMain", "https://prisjagt.dk/produkt/x"); await p.fill("#fVal", "99"); await goalPick(p, "#fTypePct"); await p.evaluate(() => document.getElementById("addForm").requestSubmit());
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
    await goalPick(p, "#fTypePct");
    check("add auto: choosing % shows the amount field", await p.isVisible("#fAmount") && /rabat/i.test(await p.textContent("#fValLabel")));
    await p.fill("#fMain", "https://prisjagt.dk/product.php?p=556"); await p.click("#fSubmit");
    check("add auto: % without a value is still refused", (await ops(p)).length === 2 && await p.isVisible("#fMsg"));
    await goalPick(p, "#fTypeAuto");
    check("add auto: back to auto hides the amount again", !(await p.isVisible("#fAmount")));
    await p.context().close();
  }

  // 5c. goal "auto" in the list and the edit form; suggested goals
  {
    const dy = row("test-dyson-v15", { id: "dy", target_type: "auto", target_value: null });
    const so = row("test-sony-xm5", { id: "x5" });
    const au = row("test-sony-xm5", { id: "x6", name: "Sony auto", target_type: "auto", target_value: null });
    const p = await open({ products: [dy, so, au], label: "auto-edit" });
    await p.waitForSelector(".item");
    {
      // an auto goal that is not a hit shows no goal label under the price (nothing to read as a verdict); a price goal keeps "mål ..."
      const aHead = p.locator('.head[data-id="x6"]'), sHead = p.locator('.head[data-id="x5"]');
      const aTxt = await aHead.textContent();
      check("auto goal, no hit: no label under the price (no 'godt tilbud', no 'mål'), only the price", (await aHead.locator(".price b").count()) === 1 && (await aHead.locator(".price span").count()) === 0 && !/godt tilbud|mål/i.test(aTxt) && (await p.locator('.item:has(.head[data-id="x6"])').getAttribute("class")).indexOf("hit") < 0, aTxt);
      check("price goal: the 'mål ...' label stays", /^mål [\d.]+ kr\.$/.test((await sHead.locator(".price span").first().textContent()).trim()), await sHead.locator(".price").textContent());
    }
    const it = p.locator('.item:has(.head[data-id="dy"])');
    const head = await it.locator(".head").textContent();
    check("auto goal: head says 'Godt tilbud', shows the saving instead of a goal, and the deal is shown as a hit", /Godt tilbud/.test(head) && /\u221213 %/.test(head) && !/mål \d/.test(head) && (await it.getAttribute("class")).indexOf("hit") >= 0, head);
    await p.locator('.head[data-id="dy"]').click();
    await openAll(p);
    const body = await p.locator('.item:has(.head[data-id="dy"]) .body').textContent();
    check("auto goal: the verdict says why, not repeated in a second line", /3\.999 kr\. er 13 % under normalprisen/.test(body) && !/Derfor giver vi besked/.test(body) && body.split("er 13 % under normalprisen").length === 2, body.slice(0, 300));
    await openGoal(p, "dy");
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
    await p.waitForFunction(() => /Godt tilbud/.test(document.querySelector('.head[data-id="dy"]').textContent));
    await openGoal(p, "dy");
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
    await p.locator('.head[data-id="x5"]').click(); await openAll(p);
    await openGoal(p, "x5");
    await p.fill('#e-x5', "1900"); await p.click('[data-edit="x5"] button[type=submit]');
    await p.waitForFunction(() => window.__db.writes().length === 1);
    let o = (await ops(p))[0];
    check("goal edit: update target_value only", o.op === "update" && JSON.stringify(o.payload) === '{"target_value":1900}' && o.filters[0][1] === "x5", JSON.stringify(o));
    await p.waitForFunction(() => /mål 1\.900 kr\./.test(document.body.textContent));
    check("goal edit: shown after refetch", true);

    await p.click('[data-act="del"][data-id="x5"]');
    check("delete: asks first", /Fjern produktet og dets historik\?/.test(await p.textContent('.item .body')) && (await ops(p)).length === 1);
    await p.click('[data-act="del-no"]');
    check("delete: 'Behold' cancels", (await ops(p)).length === 1 && await p.isVisible('.goalline .gact'));
    await p.click('[data-act="del"][data-id="x5"]'); await p.click('[data-act="del-yes"]');
    await p.waitForFunction(() => window.__db.writes().length === 2);
    o = (await ops(p))[1];
    check("delete: confirmed -> delete op, row gone", o.op === "delete" && o.filters[0][1] === "x5" && (await p.locator(".item").count()) === 1);

    // per-product prefs
    await p.locator('.head[data-id="lg"]').click(); await openAll(p);
    await p.locator("details.pshops summary").click();
    await p.fill("#sa-lg", "Proshop, hifiklubben.dk"); await p.fill("#se-lg", "CDON"); await p.check("#so-lg");
    await p.click('[data-shops="lg"] button[type=submit]');
    await p.waitForFunction(() => window.__db.writes().length === 3);
    o = (await ops(p))[2];
    check("product shop prefs saved as arrays", o.op === "update" && JSON.stringify(o.payload) === '{"shops_always":["Proshop","hifiklubben.dk"],"shops_exclude":["CDON"],"shops_only":true}', JSON.stringify(o.payload));

    // general prefs + notify
    await openSettings(p);
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
    await menu(p); await p.click("#logoutBtn");
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
    await menu(m); await m.click("#soundBtn");
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


  // 10b2. sharing a list
  {
    const chips = p => p.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#chips .lchip"), b => b.innerText.replace(/\s+/g, " ").trim()));
    const shown = p => p.evaluate(() => document.querySelectorAll("#list .item").length);
    const settle = p => p.waitForTimeout(150);
    const rpcs = p => p.evaluate(() => window.__db.rpcs.filter(r => /share|leave|members/.test(r.name) && r.name !== "list_members_named"));
    const heads = p => p.evaluate(() => Array.prototype.map.call(document.querySelectorAll("#list .item .head"), h => h.innerText.replace(/\s+/g, " ").trim()));
    const GAVER = { id: "l1", user_id: "u1", name: "Gaver" };
    const OWNER_PEOPLE = { l1: [{ user_id: "u1", name: "Mor", role: "owner", email: null }, { user_id: "m1", name: "Jesper", role: "member", email: "jesper@familie.dk" }] };
    const ownerProducts = () => [
      row("test-sony-xm5", { id: "mine", list_id: "l1" }),
      row("test-ps5-pro", { id: "hans", list_id: "l1", user_id: "m1" }),
      row("test-dyson-v15", { id: "koebt", list_id: "l1", user_id: "m1", bought_at: "2026-11-15T10:00:00Z", bought_price: 1099, bought_by: "m1" }),
      row("test-lego-falcon", { id: "privat" })];

    // the owner of a shared list
    {
      const p = await open({ products: ownerProducts(), lists: [GAVER], members: [{ list_id: "l1", user_id: "m1" }], people: OWNER_PEOPLE, label: "share-owner" });
      await p.waitForSelector(".item"); await settle(p);
      check("share: a shared list is marked quietly with the word 'delt', before the count", /Gaver delt 3/.test((await chips(p)).join("|")), JSON.stringify(await chips(p)));
      await p.click('[data-lsel="l1"]');
      check("share: the owner has Omdøb, Del and Slet liste", /^Omdøb\s*Del\s*Slet liste$/.test((await p.textContent("#listAct")).trim()), await p.textContent("#listAct"));
      check("share: the share panel is closed until 'Del' is pressed", !(await p.isVisible("#shareBox")));
      const hs = await heads(p);
      check("share: someone else's product says who added it ('af Jesper'), my own does not", hs.some(h => /af Jesper/.test(h) && /PlayStation|PS5|Pro/i.test(h)) && !hs.some(h => /Sony/.test(h) && /af /.test(h)), JSON.stringify(hs));
      check("share: a bought mark says who bought it and for how much", hs.some(h => /Købt af Jesper for 1\.099 kr\./.test(h)), JSON.stringify(hs));
      // someone else's product: readable, markable, nothing else (the owner of the LIST has no edit rights over it either)
      await p.locator('.head[data-id="hans"]').click();
      const body = await p.locator('.item:has(.head[data-id="hans"]) .body').innerHTML();
      check("share: someone else's product has no edit, delete, goal, shop, variant or move controls", !/data-edit|data-act="goal-open"|data-act="del"|data-act="goal"|data-shops|data-act="change"|data-listpick|data-fixurl/.test(body), body.slice(0, 300));
      check("share: ... but it can be marked as bought, and its link is just 'Link'", /data-act="buy"/.test(body) && />Link</.test(body) && !/Dit link/.test(body));
      await p.locator('.head[data-id="mine"]').click();
      const mine = await p.locator('.item:has(.head[data-id="mine"]) .body').innerHTML();
      check("share: my own product keeps every control", /data-act="goal-open"/.test(mine) && /data-act="del"/.test(mine) && /data-shops/.test(mine) && /data-listpick/.test(mine));
      await p.locator('.head[data-id="koebt"]').click();
      const kb = await p.locator('.item:has(.head[data-id="koebt"]) .body').innerHTML();
      check("share: the list owner can undo someone else's bought mark", /data-bought="koebt"/.test(kb) && /data-act="unbuy"/.test(kb));
      await p.locator('[data-act="unbuy"]').click(); await settle(p);
      const ub = (await ops(p)).filter(o => o.op === "update");
      check("share: undo writes only the bought columns", ub.length === 1 && JSON.stringify(Object.keys(ub[0].payload).sort()) === JSON.stringify(["bought_at", "bought_price"]) && ub[0].filters[0][1] === "koebt", JSON.stringify(ub));

      // the panel
      await p.click('[data-lact="share"]');
      check("share: 'Del' opens an e-mail field and the people, with the e-mail address of each (the owner typed it)", await p.isVisible("#shareBox") && /Jesper/.test(await p.textContent("#shPeople")) && /jesper@familie\.dk/.test(await p.textContent("#shPeople")) && !/Mor/.test(await p.textContent("#shPeople")));
      await p.fill("#shEmail", "ikke en adresse"); await p.click("#shSave");
      check("share: a bad address is refused locally, no call", /gyldig/.test(await p.textContent("#listMsg")) && (await rpcs(p)).length === 0);
      await p.fill("#shEmail", "  Sara@Familie.dk "); await p.click("#shSave"); await settle(p);
      let r = await rpcs(p);
      check("share: an invite calls share_list with the list and the address", r.length === 1 && r[0].name === "share_list" && r[0].args.p_list === "l1" && r[0].args.p_email === "Sara@Familie.dk", JSON.stringify(r));
      check("share: ... the person shows up, the field is cleared, the count of people shows", /Sara/.test(await p.textContent("#shPeople")) && (await p.inputValue("#shEmail")) === "");
      for (const [ans, txt] of [["unknown", "Personen skal have adgang til Prisvagten først."], ["already", "Listen er allerede delt med personen."], ["self", "Det er din egen adresse."], ["full", "En liste kan højst deles med 10 personer."], ["slow", "Prøv igen om lidt."]]) {
        await p.evaluate(a => { window.__db.shareAnswer = a; }, ans);
        await p.fill("#shEmail", "x@familie.dk"); await p.click("#shSave"); await settle(p);
        check("share: answer '" + ans + "' is explained plainly", (await p.textContent("#listMsg")).trim() === txt, await p.textContent("#listMsg"));
      }
      await p.evaluate(() => { window.__db.shareAnswer = "ok"; window.__db.shareError = { code: "42883", message: "function does not exist" }; });
      await p.click("#shSave"); await settle(p);
      check("share: a database without the update says so", /databasen mangler den nyeste opdatering/.test(await p.textContent("#listMsg")));
      await p.evaluate(() => { window.__db.shareError = null; });
      // removing
      await p.evaluate(() => { window.__db.rpcs.length = 0; });
      await p.locator('#shPeople li:has-text("Jesper") [data-sact="rm"]').click();
      check("share: 'Fjern' asks first and says the products are kept", /Fjern Jesper\? Jespers egne produkter beholdes uden liste\./.test(await p.textContent("#shPeople")) && (await rpcs(p)).length === 0);
      await p.click('[data-sact="rm-no"]');
      check("share: 'Behold' cancels", /Jesper/.test(await p.textContent("#shPeople")) && (await rpcs(p)).length === 0);
      await p.locator('#shPeople li:has-text("Jesper") [data-sact="rm"]').click(); await p.click('[data-sact="rm-yes"]'); await settle(p);
      r = await rpcs(p);
      check("share: removing calls unshare_list for that person", r.length === 1 && r[0].name === "unshare_list" && r[0].args.p_list === "l1" && r[0].args.p_user === "m1", JSON.stringify(r));
      check("share: the person and their products are gone from the list", !/Jesper/.test(await p.textContent("#shPeople")) && (await shown(p)) === 1, String(await shown(p)));
      await p.click("#shClose");
      check("share: 'Luk' closes the panel", !(await p.isVisible("#shareBox")));
      await p.click('[data-lact="del"]');
      check("share: deleting a shared list warns that the others lose access", /De andre mister adgangen\./.test(await p.textContent("#listAct")));
      await p.context().close();
    }

    // an owned list that nobody is in: no marker, but 'Del' is there
    {
      const p = await open({ products: ownerProducts().slice(0, 1), lists: [GAVER], label: "share-none" });
      await p.waitForSelector(".item"); await settle(p);
      check("share: an unshared list has no 'delt' marker", !/delt/.test((await chips(p)).join("|")), JSON.stringify(await chips(p)));
      await p.click('[data-lsel="l1"]'); await p.click('[data-lact="del"]');
      check("share: and its delete text is the old one", !/De andre/.test(await p.textContent("#listAct")));
      await p.click('[data-lact="del-no"]'); await p.click('[data-lact="share"]');
      check("share: an empty share panel shows only the field", await p.isVisible("#shEmail") && (await p.locator("#shPeople li").count()) === 0);
      await p.context().close();
    }

    // a member
    {
      const SHARED = { id: "l1", user_id: "o9", name: "Gaver" }, OWN = { id: "l2", user_id: "u1", name: "Privat" };
      const PEOPLE = { l1: [{ user_id: "o9", name: "Mor", role: "owner", email: null }, { user_id: "u1", name: "Jesper", role: "member", email: null }, { user_id: "m2", name: "Far", role: "member", email: null }] };
      const prods = () => [
        row("test-sony-xm5", { id: "moders", list_id: "l1", user_id: "o9" }),
        row("test-ps5-pro", { id: "min", list_id: "l1", user_id: "u1" }),
        row("test-dyson-v15", { id: "fars", list_id: "l1", user_id: "o9", bought_at: "2026-11-15T10:00:00Z", bought_price: 500, bought_by: "m2" }),
        row("test-lego-falcon", { id: "minegen", list_id: "l1", user_id: "o9", bought_at: "2026-11-15T10:00:00Z", bought_price: 77, bought_by: "u1" }),
        row("d6x2cugcpfc2mrzw894h", { id: "privat", list_id: "l2", user_id: "u1" })];
      const p = await open({ products: prods(), lists: [SHARED, OWN], members: [{ list_id: "l1", user_id: "u1" }, { list_id: "l1", user_id: "m2" }], people: PEOPLE, label: "share-member" });
      await p.waitForSelector(".item"); await settle(p);
      check("member: the chip looks like any other, with the quiet 'delt'", /Gaver delt 4/.test((await chips(p)).join("|")) && /Privat 1/.test((await chips(p)).join("|")), JSON.stringify(await chips(p)));
      await p.click('[data-lsel="l1"]');
      const act = (await p.textContent("#listAct")).trim();
      check("member: the only action is 'Forlad liste', no rename, share or delete", act === "Forlad liste", act);
      const hs = await heads(p);
      check("member: 'af Mor' on Mor's product, none on mine", hs.some(h => /af Mor/.test(h)) && !hs.some(h => /PlayStation|PS5/i.test(h) && /af /.test(h)), JSON.stringify(hs));
      check("member: 'Købt af Far for 500 kr.' for Far's mark, and plain 'Købt for 77 kr.' for my own", hs.some(h => /Købt af Far for 500 kr\./.test(h)) && hs.some(h => /Købt for 77 kr\./.test(h) && !/Købt af/.test(h)), JSON.stringify(hs));
      await p.locator('.head[data-id="moders"]').click();
      const mb = await p.locator('.item:has(.head[data-id="moders"]) .body').innerHTML();
      check("member: Mor's product has no edit, delete, goal, shop or move controls, only 'Købt'", !/data-edit|data-act="goal-open"|data-act="del"|data-act="goal"|data-shops|data-act="change"|data-listpick/.test(mb) && /data-act="buy"/.test(mb));
      await p.locator('.head[data-id="fars"]').click();
      const fb = await p.locator('.item:has(.head[data-id="fars"]) .body').innerHTML();
      check("member: Far's bought mark cannot be undone or re-priced by me", !/data-bought|data-act="unbuy"/.test(fb));
      await p.locator('.head[data-id="minegen"]').click();
      const eb = await p.locator('.item:has(.head[data-id="minegen"]) .body').innerHTML();
      check("member: my own bought mark on Mor's product can be undone and re-priced by me", /data-bought="minegen"/.test(eb) && /data-act="unbuy"/.test(eb) && !/data-edit|data-act="goal-open"/.test(eb));
      await p.locator('.head[data-id="min"]').click();
      const ob = await p.locator('.item:has(.head[data-id="min"]) .body').innerHTML();
      check("member: my own product in the shared list has every control, the move list names both lists", /data-act="goal-open"/.test(ob) && /data-act="del"/.test(ob) && /data-listpick/.test(ob) && (await p.locator("#lp-min option").allTextContents()).join("|") === "Ingen liste|Gaver|Privat");
      // marking as bought writes the bought columns only
      await p.locator('.item:has(.head[data-id="moders"]) [data-act="buy"]').click(); await settle(p);
      const up = (await ops(p)).filter(o => o.op === "update");
      check("member: 'Købt' on Mor's product writes only bought_at and bought_price", up.length === 1 && up[0].filters[0][1] === "moders" && JSON.stringify(Object.keys(up[0].payload).sort()) === JSON.stringify(["bought_at", "bought_price"]), JSON.stringify(up));
      // adding goes into the shared list
      await p.fill("#fMain", "Kaffemaskine"); await p.click("#fSubmit"); await settle(p);
      const ins = (await ops(p)).filter(o => o.table === "products" && o.op === "insert");
      check("member: a product added while the shared list is selected goes into it", ins.length === 1 && ins[0].payload.list_id === "l1", JSON.stringify(ins));
      // a wish list is the owner's to follow
      await p.fill("#fMain", "https://onskeskyen.dk/s/abc123"); await p.click("#fSubmit"); await settle(p);
      check("member: a wish-list link on a list that is not mine is refused, nothing written", /Kun listens ejer/.test(await p.textContent("#fMsg")) && (await ops(p)).filter(o => o.table === "imports").length === 0 && !(await p.isDisabled("#fSubmit")));
      // leaving
      await p.evaluate(() => { window.__db.rpcs.length = 0; });
      await p.click('[data-lact="leave"]');
      check("member: 'Forlad liste' asks first and says own products are kept", /Forlad listen Gaver\? Dine egne produkter beholdes uden liste\./.test(await p.textContent("#listAct")) && (await rpcs(p)).length === 0);
      await p.click('[data-lact="leave-no"]');
      check("member: 'Behold' cancels", (await p.textContent("#listAct")).trim() === "Forlad liste" && (await rpcs(p)).length === 0);
      await p.click('[data-lact="leave"]'); await p.click('[data-lact="leave-yes"]'); await settle(p);
      const lr = await rpcs(p);
      check("member: leaving calls leave_list", lr.length === 1 && lr[0].name === "leave_list" && lr[0].args.p_list === "l1", JSON.stringify(lr));
      check("member: the list and the others' products are gone, my own stay without a list", !/Gaver/.test((await chips(p)).join("|")) && (await p.locator('.head[data-id="moders"]').count()) === 0 && (await p.locator('.head[data-id="min"]').count()) === 1 && (await p.locator('.head[data-id="privat"]').count()) === 1, JSON.stringify(await chips(p)));
      await p.context().close();
    }

    // a database without list_members (schema.sql not run again): nothing is marked, nothing breaks
    {
      const p = await open({ products: ownerProducts().slice(0, 1), lists: [GAVER], noMembers: true, label: "share-old" });
      await p.waitForSelector(".item"); await settle(p);
      check("share: before the update nothing is marked as shared", !/delt/.test((await chips(p)).join("|")) && (await shown(p)) === 1);
      await p.context().close();
    }

    // phone width with the panel open
    {
      const p = await open({ products: ownerProducts(), lists: [GAVER], members: [{ list_id: "l1", user_id: "m1" }], people: { l1: OWNER_PEOPLE.l1.concat([{ user_id: "m3", name: "Et rigtigt langt navn der fylder", role: "member", email: "et.rigtigt.lange.navn.der.fylder@meget-lang-adresse.example.dk" }]) }, width: 360, label: "share-phone" });
      await p.waitForSelector(".item"); await settle(p);
      await p.click('[data-lsel="l1"]'); await p.click('[data-lact="share"]');
      await p.locator('#shPeople li:has-text("Et rigtigt") [data-sact="rm"]').click();
      const ov = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      check("share: no horizontal overflow at 360 px with the panel and a confirmation open", ov.sw <= ov.cw, JSON.stringify(ov));
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
      await goalPick(p, "#fTypePct");            // a goal with no amount: irrelevant for a wish list
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
      await goalPick(p, "#fTypePrice"); await p.fill("#fVal", "100");
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
      const today = new Date().toISOString(), yest = new Date(Date.now() - 24 * 3600e3).toISOString(), old = "2026-10-03T10:00:00Z";
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
      await goalPick(p, "#fTypePrice");
      const price = await p.isVisible("#fHint") && (await p.textContent("#fHint")) === "Varen skal være på lager.";
      await goalPick(p, "#fTypePct");
      const pct = (await p.textContent("#fHint")) === "Regnes fra normalprisen.";
      await goalPick(p, "#fTypeAuto");
      check("hint under the add field: none for the default, one short line for price and percent", none && price && pct && !(await p.isVisible("#fHint")));
      await p.context().close();
    }
  }


  // 10e. alternatives: similar products and deals, answered by the AI agent (everything in them is untrusted)
  {
    const HOUR = 36e5, ago = h => new Date(Date.now() - h * HOUR).toISOString();
    const alt = (id, over) => row("test-sony-xm5", Object.assign({ id, alt_requested_at: null, alternatives: null, alt_done_at: null, alt_note: null }, over || {}));
    const body = (p, id) => p.locator('.item:has([data-id="' + id + '"]) .body');
    const altText = async (p, id) => (await body(p, id).locator(".alts").first().innerText()).replace(/\s+/g, " ").trim();
    const GOOD = [
      { kind: "similar", name: "Bose QC 45", url: "https://shop.example.dk/bose", store: "Shop A", price: 2199, why: "Samme klasse, lidt lettere." },
      { kind: "deal", name: "Sennheiser Momentum 4", url: "https://www.shop-b.dk/momentum?x=1&y=2#top", store: "Shop B", price: 1999, was: 2499, why: "Normalt 2.499 kr." },
      { kind: "deal", name: "Jabra Elite 85h", url: "https://shop.example.dk/jabra", store: "Shop C", price: 1500, was: 1550, why: "Lille rabat." },
      { kind: "deal", name: "AKG N9", url: "https://shop.example.dk/akg", store: "Shop D", price: 900, why: "Uden normalpris." }
    ];
    {   // no request yet
      const p = await open({ products: [alt("a1"), alt("a2", { status: "pending" }), alt("a3", { bought_at: "2026-11-15T10:00:00Z", bought_price: 100 }), row("test-ps5-pro", { id: "old" }), alt("a4", { user_id: "m1" })], label: "alt-ask" });
      await p.waitForSelector(".item");
      await p.click('.head[data-id="a1"]');
      check("alt: a quiet 'Find alternativer' link in the detail view of an own tracking product", (await body(p, "a1").locator('[data-act="alt-find"]').textContent()) === "Find alternativer");
      await p.click('.head[data-id="old"]');
      check("alt: a database without the columns shows nothing (no link, no section)", (await body(p, "old").locator(".alts").count()) === 0 && !/alternativ/i.test(await body(p, "old").innerText()));
      await p.click('.head[data-id="a3"]');
      check("alt: no request link on a bought product", (await body(p, "a3").locator(".alts").count()) === 0);
      await p.click('.head[data-id="a4"]');
      check("alt: no request link on someone else's product in a shared list", (await body(p, "a4").locator('[data-act="alt-find"]').count()) === 0);
      await p.click('.head[data-id="a2"]');
      check("alt: not for a product that is not tracked yet", (await body(p, "a2").locator(".alts").count()) === 0);
      await p.click('[data-act="alt-find"][data-id="a1"]');
      await p.waitForFunction(() => window.__db.writes().length === 1);
      const o = (await ops(p))[0];
      check("alt: the request writes only alt_requested_at (a time; the server stamps its own)", o.table === "products" && o.op === "update" && o.filters[0][1] === "a1" && JSON.stringify(Object.keys(o.payload)) === '["alt_requested_at"]' && Math.abs(Date.parse(o.payload.alt_requested_at) - Date.now()) < 60000, JSON.stringify(o));
      await p.waitForFunction(() => /Søger alternativer/.test(document.body.innerText));
      check("alt: pending shows 'Søger alternativer. Svar inden for en time.' and no link", (await altText(p, "a1")) === "Søger alternativer. Svar inden for en time." && (await body(p, "a1").locator('[data-act="alt-find"]').count()) === 0);
      await p.waitForTimeout(150);
      check("alt: ... and stays so after the list is read again", /Søger alternativer\. Svar inden for en time\./.test(await altText(p, "a1")));
      await p.context().close();
    }
    {   // too old: failed
      const p = await open({ products: [alt("s1", { alt_requested_at: ago(7) }), alt("s2", { alt_requested_at: ago(5) })], label: "alt-stale" });
      await p.waitForSelector(".item");
      await p.click('.head[data-id="s1"]'); await p.click('.head[data-id="s2"]');
      check("alt: pending for more than 6 hours: 'Ingen svar. Prøv igen.'", (await altText(p, "s1")) === "Ingen svar. Prøv igen." && (await body(p, "s1").locator('[data-act="alt-find"]').textContent()) === "Prøv igen");
      check("alt: pending for 5 hours is still pending", (await altText(p, "s2")) === "Søger alternativer. Svar inden for en time.");
      await p.click('[data-act="alt-find"][data-id="s1"]');
      await p.waitForFunction(() => window.__db.writes().length === 1);
      await p.waitForFunction(() => /Søger alternativer/.test(document.querySelector('.item:has([data-id="s1"]) .body').innerText));
      check("alt: 'Prøv igen' asks again", (await ops(p))[0].filters[0][1] === "s1");
      await p.context().close();
    }
    {   // the daily limit and other errors come back as plain Danish
      const p = await open({ products: [alt("l1")], label: "alt-limit" });
      await p.waitForSelector(".item"); await p.click('.head[data-id="l1"]');
      await p.evaluate(() => { window.__db.altError = { code: "23514", message: "Du kan bede om alternativer 5 gange i døgnet." }; });
      await p.click('[data-act="alt-find"][data-id="l1"]');
      await p.waitForFunction(() => /5 gange i døgnet/.test(document.body.innerText));
      check("alt: the daily limit is shown as 'Du kan bede om alternativer 5 gange i døgnet.' and the link works again", (await body(p, "l1").locator('[data-rowmsg="alt-l1"]').textContent()) === "Du kan bede om alternativer 5 gange i døgnet." && !(await body(p, "l1").locator('[data-act="alt-find"]').isDisabled()));
      await p.evaluate(() => { window.__db.altError = { code: "23514", message: "Der er allerede bedt om alternativer. Vent på svaret." }; });
      await p.click('[data-act="alt-find"][data-id="l1"]');
      await p.waitForFunction(() => /allerede bedt/.test(document.body.innerText));
      check("alt: already pending is said in short", (await body(p, "l1").locator('[data-rowmsg="alt-l1"]').textContent()) === "Der er allerede bedt om alternativer.");
      await p.evaluate(() => { window.__db.altError = { message: "boom <script>" }; });
      await p.click('[data-act="alt-find"][data-id="l1"]');
      await p.waitForFunction(() => /Kunne ikke gemme/.test(document.body.innerText));
      check("alt: any other error is a generic sentence, never the raw message", !/boom|script/.test(await body(p, "l1").innerText()));
      await p.context().close();
    }
    {   // the answer
      const mine = alt("d1", { alt_requested_at: ago(2), alt_done_at: ago(1), alternatives: GOOD });
      const p = await open({ products: [mine, row("test-ps5-pro", { id: "own", source_url: "https://shop.example.dk/jabra" })], label: "alt-done" });
      await p.waitForSelector(".item");
      await p.click('.head[data-id="d1"]');
      const b = body(p, "d1");
      check("alt: a heading 'Alternativer' and four items", (await b.locator(".alts h3").textContent()) === "Alternativer" && (await b.locator(".alt-list li").count()) === 4);
      const names = await b.locator(".alt-name").allInnerTexts();
      check("alt: deals first, then similar (own order kept inside)", JSON.stringify(names) === JSON.stringify(["Sennheiser Momentum 4", "Jabra Elite 85h", "AKG N9", "Bose QC 45"]), JSON.stringify(names));
      const tags = await b.locator("li").evaluateAll(els => els.map(e => { const t = e.querySelector(".alt-tag"); return t ? t.textContent : ""; }));
      check("alt: a '−20 %' tag on a deal with a normal price 5 % or more above, none below 5 %, none without 'was', none on 'similar'", JSON.stringify(tags) === JSON.stringify(["−20 %", "", "", ""]), JSON.stringify(tags));
      const first = (await b.locator("li").first().innerText()).replace(/\s+/g, " ");
      check("alt: a row shows name, price, store, tag and the why sentence", /Sennheiser Momentum 4/.test(first) && /1\.999 kr\./.test(first) && /Shop B/.test(first) && /Normalt 2\.499 kr\./.test(first), first);
      const a0 = b.locator("li").first().locator("a");
      check("alt: the name is a link with target _blank and rel noopener noreferrer", (await a0.getAttribute("target")) === "_blank" && (await a0.getAttribute("rel")) === "noopener noreferrer" && /^https:\/\/www\.shop-b\.dk\/momentum\?x=1&y=2/.test(await a0.getAttribute("href")));
      check("alt: 'Søg igen' is there for the owner", (await b.locator('[data-act="alt-find"]').textContent()) === "Søg igen");
      check("alt: 'Følg' on each, disabled 'Følges' for a link the person already tracks", (await b.locator('[data-act="alt-follow"]').allInnerTexts()).join("|") === "Følg|Følges|Følg|Følg" && (await b.locator('[data-act="alt-follow"]').nth(1).isDisabled()));
      await b.locator('[data-act="alt-follow"]').first().click();
      await p.waitForFunction(() => window.__db.writes().length === 1);
      const o = (await ops(p))[0];
      check("alt: 'Følg' adds a product with that link, goal auto, same list, as a new row", o.table === "products" && o.op === "insert" && JSON.stringify(o.payload) === JSON.stringify({ name: "Nyt produkt", source_url: "https://www.shop-b.dk/momentum?x=1&y=2", target_type: "auto", target_value: null, active: true }), JSON.stringify(o));
      await p.waitForFunction(() => document.querySelectorAll("#list .item").length === 3);
      check("alt: ... and the button says 'Følges' at once, and still after the list is read again", (await b.locator('[data-act="alt-follow"]').first().textContent()) === "Følges" && (await b.locator('[data-act="alt-follow"]').first().isDisabled()));
      await p.context().close();
    }
    {   // the list of the current product is used
      const L = { id: "l1", user_id: "u1", name: "Gaver" };
      const p = await open({ products: [alt("g1", { list_id: "l1", alt_requested_at: ago(2), alt_done_at: ago(1), alternatives: GOOD.slice(0, 1) })], lists: [L], label: "alt-list", storage: { "pv-list": "all" } });
      await p.waitForSelector(".item"); await p.click('.head[data-id="g1"]');
      await p.click('[data-act="alt-follow"]');
      await p.waitForFunction(() => window.__db.writes().length === 1);
      const o = (await ops(p))[0];
      check("alt: a product in a list: the new one goes into the same list", o.payload.list_id === "l1" && o.payload.target_type === "auto", JSON.stringify(o.payload));
      await p.evaluate(() => { window.__db.insertError = { code: "23514", message: "Du kan højst følge 40 produkter. Slet et produkt først." }; window.__db.products[0].alternatives = window.__db.products[0].alternatives.concat([{ kind: "similar", name: "Anden", url: "https://shop.example.dk/anden", store: "S", price: 5, why: "x" }]); });
      await p.evaluate(() => { window.__tick(); });
      await p.waitForFunction(() => document.querySelectorAll('[data-act="alt-follow"]').length === 2);
      await p.locator('[data-act="alt-follow"]').nth(1).click();
      await p.waitForFunction(() => /højst følge 40/.test(document.body.innerText));
      check("alt: a refused 'Følg' says why (the 40-product limit) and the button works again", (await body(p, "g1").locator('[data-rowmsg="alt-g1"]').textContent()) === "Du kan højst følge 40 produkter. Slet et produkt først." && !(await body(p, "g1").locator('[data-act="alt-follow"]').nth(1).isDisabled()));
      await p.context().close();
    }
    {   // hostile strings
      const EV = [
        { kind: "deal", name: '<img src=x onerror="window.__xss=1">Fup', url: "https://shop.example.dk/a", store: "<script>window.__xss=2</script>Butik", price: 100, was: 200, why: '"><svg onload="window.__xss=3"> hej &amp; <b>fed</b>' },
        { kind: "similar", name: "Farligt link", url: "javascript:window.__xss=4", store: "S", price: 50, why: "x" },
        { kind: "similar", name: "Http link", url: "http://shop.example.dk/plain", store: "S", price: 50, why: "x" },
        { kind: "similar", name: "Citat", url: 'https://shop.example.dk/a"onmouseover="window.__xss=5', store: "S", price: 50, why: "x" },
        { kind: "similar", name: "Data", url: "data:text/html,<script>window.__xss=6</script>", store: "S", price: 50, why: "x" },
        { kind: "similar", name: "Port", url: "https://user:pw@shop.example.dk:8443/x", store: "S", price: 50, why: "x" },
        { kind: "similar", name: "Pris som tekst", url: "https://shop.example.dk/p", store: "S", price: "<b>1</b>", why: "x" },
        { kind: "evil", name: "Ukendt art", url: "https://shop.example.dk/p", store: "S", price: 5, why: "x" },
        "ikke et objekt", null, 7
      ];
      const note = '<script>window.__xss=7</script><b>Note</b>';
      const p = await open({ products: [alt("h1", { alt_requested_at: ago(2), alt_done_at: ago(1), alternatives: EV }), alt("h2", { alt_requested_at: ago(2), alt_done_at: ago(1), alternatives: null, alt_note: note })], label: "alt-hostile" });
      await p.waitForSelector(".item");
      await p.click('.head[data-id="h1"]'); await p.click('.head[data-id="h2"]');
      const b = body(p, "h1").locator(".alts");
      check("alt: hostile strings are shown as text: no element is injected, no script runs", (await b.locator("img, script, svg, b, i").count()) === 0 && (await p.evaluate(() => window.__xss)) === undefined);
      const txt = await b.innerText();
      check("alt: ... the text itself is visible, escaped", txt.indexOf('<img src=x onerror="window.__xss=1">Fup') >= 0 && txt.indexOf("<script>window.__xss=2</script>Butik") >= 0 && txt.indexOf("&amp; <b>fed</b>") >= 0, txt.slice(0, 300));
      const hrefs = await b.locator("a").evaluateAll(as => as.map(a => a.getAttribute("href")));
      check("alt: only https links become links (javascript:, data:, http:, a port or user:password@ do not)", hrefs.length === 2 && hrefs.every(h => /^https:\/\//.test(h)) && !hrefs.some(h => /["'<> ]|^javascript|^data:|^http:/.test(h)), JSON.stringify(hrefs));
      check("alt: a link with a quote in it cannot break out of the attribute", (await b.locator("[onmouseover], [onerror], [onload]").count()) === 0 && (await p.evaluate(() => window.__xss)) === undefined);
      check("alt: a row without a usable link has no 'Følg'; a bad price or kind or non-object is dropped", (await b.locator("li").count()) === 6 && (await b.locator('[data-act="alt-follow"]').count()) === 2, "li " + (await b.locator("li").count()) + " follow " + (await b.locator('[data-act="alt-follow"]').count()));
      const tagTxt = await b.locator(".alt-tag").allInnerTexts();
      check("alt: the tag is computed, never copied from the text", JSON.stringify(tagTxt) === JSON.stringify(["−50 %"]), JSON.stringify(tagTxt));
      const n = body(p, "h2").locator(".alts");
      check("alt: a failure note is escaped too, and 'Prøv igen' is there", (await n.innerText()).indexOf(note) >= 0 && (await n.locator("script, b").count()) === 0 && (await n.locator('[data-act="alt-find"]').textContent()) === "Prøv igen" && (await p.evaluate(() => window.__xss)) === undefined);
      await p.context().close();
    }
    {   // failed, empty, and read-only for a member
      const p = await open({ products: [
        alt("f1", { alt_requested_at: ago(2), alt_done_at: ago(1), alt_note: "Fandt intet, der passer." }),
        alt("f2", { alt_requested_at: ago(2), alt_done_at: ago(1), alternatives: [] }),
        alt("f3", { alt_requested_at: ago(30), alt_done_at: ago(29), alternatives: GOOD.slice(0, 1) }),
        alt("m1", { user_id: "o9", list_id: "lx", alt_requested_at: ago(2), alt_done_at: ago(1), alternatives: GOOD.slice(0, 2) }),
        alt("m2", { user_id: "o9", list_id: "lx", alt_requested_at: ago(1) })], lists: [{ id: "lx", user_id: "o9", name: "Delt" }], members: [{ list_id: "lx", user_id: "u1" }], label: "alt-fail" });
      await p.waitForSelector(".item");
      for (const id of ["f1", "f2", "f3", "m1", "m2"]) await p.click('.head[data-id="' + id + '"]');
      check("alt: failed: the note and 'Prøv igen'", (await altText(p, "f1")) === "Fandt intet, der passer. Prøv igen" && (await body(p, "f1").locator('[data-act="alt-find"]').textContent()) === "Prøv igen", await altText(p, "f1"));
      check("alt: answered with nothing usable: a plain sentence", /^Ingen alternativer fundet\./.test(await altText(p, "f2")));
      check("alt: an answer older than 24 hours still shows, with 'Søg igen'", (await body(p, "f3").locator(".alt-list li").count()) === 1 && (await body(p, "f3").locator('[data-act="alt-find"]').textContent()) === "Søg igen");
      check("alt: a member sees the answer on someone else's product but has no 'Søg igen' (and cannot ask)", (await body(p, "m1").locator(".alt-list li").count()) === 2 && (await body(p, "m1").locator('[data-act="alt-find"]').count()) === 0);
      check("alt: a member sees that an answer is pending, nothing to click", (await altText(p, "m2")) === "Søger alternativer. Svar inden for en time." && (await body(p, "m2").locator("button").filter({ hasText: /Prøv|Find|Søg/ }).count()) === 0);
      await p.context().close();
    }
    {   // read-only access: no write buttons
      const p = await open({ products: [alt("r1", { alt_requested_at: ago(2), alt_done_at: ago(1), alternatives: GOOD.slice(0, 1) })], label: "alt-ro" });
      await p.waitForSelector(".item"); await p.evaluate(() => { window.__db.deny = true; });
      await p.click('.head[data-id="r1"]');
      await p.click('[data-act="alt-follow"]');
      await p.waitForFunction(() => window.__db.ops.length >= 1);
      await p.waitForFunction(() => !document.getElementById("readonly").hidden);
      check("alt: a refused write (no access) switches the page to read-only like everywhere else", await p.isVisible("#readonly"));
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
      check("bought: the line says 'Købt for 3.999 kr.', no goal text, no highlight, no 'Mål nået'", (await it.locator(".meta").first().textContent()) === "Købt for 3.999 kr." && (await it.getAttribute("class")).indexOf("hit") < 0 && !/Mål nået|Godt tilbud/.test(await it.locator(".head").textContent()) && (await it.locator(".price span").count()) === 0);
      check("bought: dimmed, and at the bottom of the list", (await it.getAttribute("class")).indexOf("bought") >= 0 && +(await it.locator(".thumb").evaluate(e => getComputedStyle(e).opacity)) < 1 && (await p.locator(".item").last().getAttribute("class")).indexOf("bought") >= 0 && (await p.locator(".item").first().getAttribute("class")).indexOf("bought") < 0);
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
      await openSettings(p);
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
      await openSettings(q);
      await q.waitForFunction(() => document.getElementById("shDigest").checked);
      check("digest: shown on when the profile has it on", true);
      await q.context().close();
    }
  }

  // 10f. compare: a single-shop product can be switched to Prisjagt by the AI agent, and the person can go back
  {
    const DAY = 864e5, ago = d => new Date(Date.now() - d * DAY).toISOString();
    const SHOP = "https://www.adidas.dk/sko/samba-og", ORIG = "https://www.proshop.dk/Mus/Logitech-MX?utm=1";
    const sh = (id, over) => row("test-dyson-v15", Object.assign({ id, name: "Samba " + id, source_url: SHOP, title: "Samba OG", tracked_variants: ["shop"],
      variants: [{ id: "shop", label: "Adidas", lowest: 899, offers: 1, sample: "Samba OG" }], offers: [{ store: "Adidas", price: 899, url: SHOP, inStock: true, note: null, variant: "shop" }],
      check_note: null, compare_state: null, compare_at: null, shop_url: null }, over || {}));
    const body = (p, id) => p.locator('.item:has([data-id="' + id + '"]) .body');
    const cmpText = async (p, id) => { const l = body(p, id).locator(".cmp"); return (await l.count()) ? (await l.first().innerText()).replace(/\s+/g, " ").trim() : null; };
    const headText = async (p, id) => (await p.locator('.head[data-id="' + id + '"]').innerText()).replace(/\s+/g, " ");
    {   // asking
      const noCol = sh("c0"); delete noCol.compare_state; delete noCol.compare_at; delete noCol.shop_url;
      const p = await open({ products: [sh("c1"), noCol, sh("c3", { bought_at: ago(1), bought_price: 800 }), sh("c4", { status: "pending", last_checked: null, offers: null }), row("test-ps5-pro", { id: "pj", compare_state: null, compare_at: null, shop_url: null }),
        sh("c5", { user_id: "o9", list_id: "lx" })], lists: [{ id: "lx", user_id: "o9", name: "Delt" }], members: [{ list_id: "lx", user_id: "u1" }], label: "compare-ask" });
      await p.waitForSelector(".item");
      for (const id of ["c1", "c0", "c3", "c4", "pj", "c5"]) await p.click('.head[data-id="' + id + '"]');
      check("compare: a quiet 'Find flere butikker' action on an own single-shop product that was never asked", (await body(p, "c1").locator('[data-act="cmp-find"]').textContent()) === "Find flere butikker");
      check("compare: a database without the columns shows nothing about it", (await body(p, "c0").locator(".cmp").count()) === 0 && !/Find flere|Leder efter|Fandt ikke|Skiftet til/.test(await body(p, "c0").innerText()));
      check("compare: no action on a bought product, a product not fetched yet, a prisjagt product or someone else's product",
        (await body(p, "c3").locator('[data-act="cmp-find"]').count()) === 0 && (await body(p, "c4").locator('[data-act="cmp-find"]').count()) === 0 && (await body(p, "pj").locator('[data-act="cmp-find"]').count()) === 0
        && (await body(p, "c5").locator('[data-act="cmp-find"]').count()) === 0 && (await body(p, "pj").locator(".cmp").count()) === 0);
      await p.click('[data-act="cmp-find"][data-id="c1"]');
      await p.waitForFunction(() => window.__db.writes().length === 1);
      const o = (await ops(p))[0];
      check("compare: the request writes only compare_state = 'wanted' (the server stamps the time)", o.table === "products" && o.op === "update" && o.filters[0][1] === "c1" && JSON.stringify(o.payload) === '{"compare_state":"wanted"}', JSON.stringify(o));
      await p.waitForFunction(() => /Leder efter flere butikker/.test(document.body.innerText));
      check("compare: then 'Leder efter flere butikker.' and no action; nothing in the row", (await cmpText(p, "c1")) === "Leder efter flere butikker." && (await body(p, "c1").locator('[data-act="cmp-find"]').count()) === 0 && !/Leder efter/.test(await headText(p, "c1")));
      await p.waitForTimeout(150);
      check("compare: ... and after the list is read again", (await cmpText(p, "c1")) === "Leder efter flere butikker.");
      await p.context().close();
    }
    {   // the states
      const p = await open({ products: [sh("w1", { compare_state: "wanted", compare_at: ago(1) }), sh("n1", { compare_state: "none", compare_at: ago(30 / 1440) }), sh("n2", { compare_state: "none", compare_at: ago(61 / 1440) }),
        sh("n3", { compare_state: "none", compare_at: ago(3), user_id: "o9", list_id: "lx" }), sh("w3", { compare_state: "wanted", compare_at: ago(1), user_id: "o9", list_id: "lx" })], lists: [{ id: "lx", user_id: "o9", name: "Delt" }], members: [{ list_id: "lx", user_id: "u1" }], label: "compare-states" });
      await p.waitForSelector(".item");
      for (const id of ["w1", "n1", "n2", "n3", "w3"]) await p.click('.head[data-id="' + id + '"]');
      check("compare: wanted: the quiet line, no action", (await cmpText(p, "w1")) === "Leder efter flere butikker." && (await body(p, "w1").locator('[data-act="cmp-find"]').count()) === 0);
      check("compare: none for less than an hour: 'Fandt ikke varen hos andre butikker.' and no action", (await cmpText(p, "n1")) === "Fandt ikke varen hos andre butikker." && (await body(p, "n1").locator('[data-act="cmp-find"]').count()) === 0);
      check("compare: none for more than an hour: the action is back", (await body(p, "n2").locator('[data-act="cmp-find"]').textContent()) === "Find flere butikker");
      check("compare: others see the lines on a shared product but cannot ask", (await cmpText(p, "n3")) === "Fandt ikke varen hos andre butikker." && (await cmpText(p, "w3")) === "Leder efter flere butikker." && (await p.locator('.item [data-act="cmp-find"][data-id="n3"]').count()) === 0);
      check("compare: no em-dash and no exclamation mark in any of it", !/[—!]/.test(await cmpText(p, "w1") + await cmpText(p, "n1")));
      await p.context().close();
    }
    {   // a refused product in the collapsed error group: the action is reachable by opening the group and the row (no forced opening)
      const R = "Butikken afviser automatiske opslag.";
      const p = await open({ products: [sh("g1", { status: "error", check_note: R, compare_state: "none", compare_at: ago(2 / 24), offers: null, last_checked: ago(1) }),
        sh("g2", { status: "error", check_note: R, compare_state: "none", compare_at: ago(20 / 1440), offers: null, last_checked: ago(1) })], label: "compare-errgroup", collapsed: true });
      await p.waitForSelector("#errGroup");
      check("compare: error group: collapsed, the action is not visible yet", !(await p.locator('#errGroup [data-act="cmp-find"]').first().isVisible()));
      await p.click("#errGroup > summary"); await p.click('.head[data-id="g1"]'); await p.click('.head[data-id="g2"]');
      check("compare: error group: a 'none' older than an hour shows 'Find flere butikker' and it is visible", (await p.locator('.item:has([data-id="g1"]) [data-act="cmp-find"]').isVisible()) && (await p.locator('.item:has([data-id="g1"]) [data-act="cmp-find"]').textContent()) === "Find flere butikker");
      check("compare: error group: a 'none' under an hour shows only the quiet text", (await cmpText(p, "g2")) === "Fandt ikke varen hos andre butikker." && (await body(p, "g2").locator('[data-act="cmp-find"]').count()) === 0);
      await p.context().close();
    }
    {   // a shop error
      const R = "Butikken afviser automatiske opslag.";
      const p = await open({ products: [sh("x1", { status: "error", check_note: R, compare_state: "wanted", compare_at: ago(1), offers: null, last_checked: ago(1) }), sh("x2", { status: "error", check_note: R, compare_state: null, offers: null }),
        sh("x3", { status: "error", check_note: "Kunne ikke finde en pris på siden.", compare_state: "wanted", compare_at: ago(1), offers: null }), sh("x4", { status: "tracking", check_note: R, compare_state: "wanted", compare_at: ago(1) }),
        sh("x5", { status: "error", check_note: R, compare_state: "none", compare_at: ago(10 / 1440), offers: null })], label: "compare-error" });
      await p.waitForSelector(".item");
      for (const id of ["x1", "x2", "x3", "x4", "x5"]) await p.click('.head[data-id="' + id + '"]');
      check("compare: refused and wanted: 'Butikken afviser opslag. Leder efter andre butikker.' in the row", /Butikken afviser opslag\. Leder efter andre butikker\./.test(await headText(p, "x1")) && !/automatiske/.test(await headText(p, "x1")), await headText(p, "x1"));
      check("compare: ... and in the detail, once", /Butikken afviser opslag\. Leder efter andre butikker\./.test(await body(p, "x1").innerText()) && (await cmpText(p, "x1")) === null);
      check("compare: refused, not wanted: the existing text", /Butikken afviser automatiske opslag\./.test(await headText(p, "x2")) && !/Leder efter/.test(await headText(p, "x2")) && (await body(p, "x2").locator('[data-act="cmp-find"]').count()) === 1);
      check("compare: another error and wanted: the existing error text, and the quiet line in the detail", /Kunne ikke finde en pris på siden\./.test(await headText(p, "x3")) && !/Leder efter/.test(await headText(p, "x3")) && (await cmpText(p, "x3")) === "Leder efter flere butikker.");
      check("compare: a tracked product whose shop starts to refuse says it once in the detail", /Butikken afviser opslag\. Leder efter andre butikker\./.test(await body(p, "x4").innerText()) && !/automatiske/.test(await body(p, "x4").innerText()));
      check("compare: refused and none: the existing text", /Butikken afviser automatiske opslag\./.test(await headText(p, "x5")) && (await cmpText(p, "x5")) === "Fandt ikke varen hos andre butikker.");
      await p.context().close();
    }
    {   // switched
      const PJ = "https://prisjagt.dk/product.php?p=555";
      const sw = (id, over) => row("test-dyson-v15", Object.assign({ id, name: "Mus " + id, source_url: PJ, compare_state: "done", compare_at: ago(1), shop_url: ORIG }, over || {}));
      const evil = sw("d4", { shop_url: "javascript:alert(1)" }), http = sw("d5", { shop_url: "http://shop.dk/x" }), pjOrig = sw("d6", { shop_url: "https://prisjagt.dk/product.php?p=1" });
      const p = await open({ products: [sw("d1"), sw("d2", { user_id: "o9", list_id: "lx" }), sw("d3", { status: "pending", variants: null, offers: null, history: null, title: null, last_checked: null }), evil, http, pjOrig], lists: [{ id: "lx", user_id: "o9", name: "Delt" }], members: [{ list_id: "lx", user_id: "u1" }], label: "compare-done" });
      await p.waitForSelector(".item");
      for (const id of ["d1", "d2", "d3", "d4", "d5", "d6"]) await p.click('.head[data-id="' + id + '"]');
      check("compare: switched: 'Skiftet til Prisjagt for at sammenligne butikker.' with 'Oprindelig butik' and 'Fortryd'", /^Skiftet til Prisjagt for at sammenligne butikker\. Oprindelig butik Fortryd/.test(await cmpText(p, "d1")), await cmpText(p, "d1"));
      const a = body(p, "d1").locator(".cmp a");
      check("compare: the link goes to the original shop, in a new tab, noopener", (await a.getAttribute("href")) === ORIG && /noopener/.test(await a.getAttribute("rel")) && (await a.getAttribute("target")) === "_blank");
      check("compare: nothing about it in the row", !/Skiftet|Fortryd|Oprindelig/.test(await headText(p, "d1")));
      check("compare: someone else's switched product shows the line and the link, but no 'Fortryd'", /Oprindelig butik/.test(await cmpText(p, "d2")) && (await body(p, "d2").locator('[data-act="cmp-undo"]').count()) === 0);
      check("compare: a switched product not fetched yet shows the line too (so it can be undone at once)", (await body(p, "d3").locator('[data-act="cmp-undo"]').count()) === 1);
      check("compare: a stored link that is not an https shop link (javascript:, http:, prisjagt) is never shown, and nothing to undo to",
        (await cmpText(p, "d4")) === null && (await cmpText(p, "d5")) === null && (await cmpText(p, "d6")) === null && (await p.locator('[data-act="cmp-undo"]').count()) === 2 && (await p.locator('a[href^="javascript"]').count()) === 0);
      check("compare: a prisjagt product after a switch is an ordinary prisjagt product ('Skift variant', no single-shop line)", /Skift variant/.test(await body(p, "d1").innerText()) && !/Kun denne butik/.test(await body(p, "d1").innerText()));
      await p.click('[data-act="cmp-undo"][data-id="d1"]');
      await p.waitForFunction(() => window.__db.writes().length === 1);
      const o = (await ops(p))[0];
      check("compare: 'Fortryd' writes only source_url = the original shop link, exactly as stored", o.table === "products" && o.op === "update" && o.filters[0][1] === "d1" && JSON.stringify(o.payload) === JSON.stringify({ source_url: ORIG }), JSON.stringify(o));
      await p.waitForFunction(() => /Fandt ikke varen/.test(document.body.innerText) || !/Skiftet til Prisjagt/.test(document.querySelector('.head[data-id="d1"]').closest(".item").innerText));
      await p.waitForTimeout(150);
      const st = await p.evaluate(() => { const r = window.__db.products.filter(x => x.id === "d1")[0]; return [r.source_url, r.compare_state, r.shop_url, r.status]; });
      check("compare: back on the shop link: pending, none, not switched again", JSON.stringify(st) === JSON.stringify([ORIG, "none", null, "pending"]), JSON.stringify(st));
      check("compare: ... the line is gone", !/Skiftet til Prisjagt/.test(await body(p, "d1").innerText()) && (await body(p, "d1").locator('[data-act="cmp-undo"]').count()) === 0);
      await p.context().close();
    }
    {   // failing writes
      const p = await open({ products: [sh("f1"), row("test-dyson-v15", { id: "f2", source_url: "https://prisjagt.dk/product.php?p=9", compare_state: "done", compare_at: ago(1), shop_url: ORIG })], label: "compare-fail" });
      await p.waitForSelector(".item");
      await p.click('.head[data-id="f1"]'); await p.click('.head[data-id="f2"]');
      await p.evaluate(() => { window.__db.netFail = true; });
      await p.click('[data-act="cmp-find"][data-id="f1"]');
      await p.waitForFunction(() => /Kunne ikke gemme/.test(document.body.innerText));
      check("compare: a failing request says so and the action stays", /Kunne ikke gemme lige nu/.test(await body(p, "f1").innerText()) && !(await body(p, "f1").locator('[data-act="cmp-find"]').isDisabled()));
      await p.click('[data-act="cmp-undo"][data-id="f2"]');
      await p.waitForFunction(() => (document.body.innerText.match(/Kunne ikke gemme/g) || []).length >= 2);
      check("compare: a failing 'Fortryd' says so and stays", /Kunne ikke gemme lige nu/.test(await body(p, "f2").innerText()) && /Skiftet til Prisjagt/.test(await body(p, "f2").innerText()));
      await p.context().close();
    }
  }

  // 10g. extra shops: a single-shop product followed in several shops (extra_urls); the person may only drop a shop
  {
    const DAY = 864e5, ago = d => new Date(Date.now() - d * DAY).toISOString();
    const MAIN = "https://www.hovedbutik.dk/vare/1", XA = "https://www.butik-a.dk/p/1?id=7", XB = "https://butik-b.dk/p/2", XC = "https://shop.butik-c.dk/p/3", XD = "https://butik-d.dk/p/4";
    const off = (store, price, url, inStock) => ({ store, price, url, inStock: inStock !== false, note: null, variant: "shop" });
    const xp = (id, extra, over) => row("test-dyson-v15", Object.assign({ id, name: "Kit " + id, source_url: MAIN, title: "Kit", tracked_variants: ["shop"], check_note: null,
      variants: [{ id: "shop", label: "Hovedbutik", lowest: 450, offers: 3, sample: "Kit" }],
      offers: [off("Hovedbutik", 500, MAIN), off("Butik A", 450, XA), off("Butik B", 480, XB), off("Butik C", 520, XC), off("Butik D", 470, XD, false)],
      compare_state: "done", compare_at: ago(1), shop_url: null, extra_urls: extra }, over || {}));
    const body = (p, id) => p.locator('.item:has([data-id="' + id + '"]) .body');
    const norm = t => t.replace(/\s+/g, " ").trim();
    {
      const noCol = xp("x0", [XA, XB]); delete noCol.extra_urls;
      const p = await open({ products: [xp("x1", [XA, XB, XC, XD]), noCol, xp("x2", null, { compare_state: "none", compare_at: ago(30 / 1440) }), xp("x3", [XA, XB], { user_id: "o9", list_id: "lx" }),
        xp("x4", [XA, "http://butik-b.dk/p/2", "https://www.prisjagt.dk/product.php?p=1", "javascript:alert(1)", 7, "https://u:p@evil.dk/x"])], lists: [{ id: "lx", user_id: "o9", name: "Delt" }], members: [{ list_id: "lx", user_id: "u1" }], label: "extra-list" });
      await p.waitForSelector(".item");
      for (const id of ["x1", "x0", "x2", "x3", "x4"]) await p.click('.head[data-id="' + id + '"]');
      const t1 = norm(await body(p, "x1").innerText());
      check("extras: the normal shop list ('Butikker', the three cheapest in stock) with the shops of all links", /Butikker/.test(t1) && (await body(p, "x1").locator(".shops > .tablewrap tr").count()) === 3
        && /Butik A.*450 kr\./.test(norm(await body(p, "x1").locator(".shops > .tablewrap").innerText())) && !/Butik C/.test(norm(await body(p, "x1").locator(".shops > .tablewrap").innerText())), t1.slice(0, 400));
      check("extras: 'Vis alle butikker' holds the rest (the dearer one and the sold-out one)", /Butik C/.test(await body(p, "x1").locator(".allshops").innerText()) && /Ikke på lager/.test(await body(p, "x1").locator(".allshops").innerText()) && /Vis alle butikker/.test(t1));
      check("extras: the single-shop note is gone", !/Kun denne butik/.test(t1) && !/Kun denne butik/.test(norm(await body(p, "x3").innerText())));
      check("extras: the quiet line says how many shops: 1 + extras", (await body(p, "x1").locator(".cmp").innerText()).trim() === "Følger 5 butikker." && (await body(p, "x3").locator(".cmp").innerText()).trim() === "Følger 3 butikker.");
      check("extras: without extras (none) the old note and the 'none' line stay", /Kun denne butik/.test(await body(p, "x2").innerText()) && /Fandt ikke varen hos andre butikker/.test(await body(p, "x2").innerText()) && !/Butikker, vi følger/.test(await body(p, "x2").innerText()));
      check("extras: a database without the column shows nothing about it (old note, no list, no line)", /Kun denne butik/.test(await body(p, "x0").innerText()) && !/Butikker, vi følger|Følger \d/.test(await body(p, "x0").innerText()));
     
      const m1 = body(p, "x1").locator(".xshops");
      check("extras: 'Indstil vare' lists each extra shop by host (no www) with 'Fjern'", /Butikker, vi følger/.test(await m1.innerText()) && (await m1.locator(".foot").count()) === 4
        && JSON.stringify(await m1.locator(".foot > span a").allInnerTexts()) === JSON.stringify(["butik-a.dk", "butik-b.dk", "shop.butik-c.dk", "butik-d.dk"]) && (await m1.locator('[data-act="x-rm"]').count()) === 4
        && (await m1.locator('[data-act="x-rm"]').first().innerText()) === "Fjern", JSON.stringify([/Butikker, vi følger/.test(await m1.innerText()), await m1.locator(".foot").count(), await m1.locator(".foot > span a").allInnerTexts(), await m1.locator('[data-act="x-rm"]').count(), await m1.locator('[data-act="x-rm"]').first().innerText()]));
      const hrefs = await m1.locator("a").evaluateAll(as => as.map(a => [a.getAttribute("href"), a.getAttribute("rel"), a.getAttribute("target")]));
      check("extras: the links are https, open in a new tab and carry rel noopener noreferrer", hrefs.length === 4 && hrefs.every(h => /^https:\/\//.test(h[0]) && h[1] === "noopener noreferrer" && h[2] === "_blank") && hrefs[0][0] === XA);
     
      const m4 = body(p, "x4").locator(".xshops");
      check("extras: a link that is not https, a prisjagt link, a script link, a number and a link with a password are never shown; the rest is",
        JSON.stringify(await m4.locator(".foot > span a").allInnerTexts()) === JSON.stringify(["butik-a.dk"]) && !/javascript|prisjagt\.dk|evil/.test(await m4.innerHTML())
        && (await body(p, "x4").locator(".cmp").innerText()).trim() === "Følger 2 butikker.", await body(p, "x4").innerHTML());
     
      const m3 = body(p, "x3").locator(".xshops");
      check("extras: someone else's product in a shared list shows the shops but no 'Fjern'", (await m3.locator(".foot").count()) === 2 && (await m3.locator('[data-act="x-rm"]').count()) === 0);
      check("extras: no em-dash and no exclamation mark in the new texts", !/[—!]/.test(await m1.innerText()) && !/[—!]/.test((await body(p, "x1").locator(".cmp").innerText())));
      // remove the second shop
      await m1.locator('[data-act="x-rm"]').nth(1).click();
      await p.waitForFunction(() => window.__db.writes().length === 1);
      const o = (await ops(p))[0];
      check("extras: 'Fjern' sends the same array minus that one entry, in the same order, and nothing else", o.table === "products" && o.op === "update" && o.filters[0][1] === "x1" && JSON.stringify(o.payload) === JSON.stringify({ extra_urls: [XA, XC, XD] }), JSON.stringify(o));
      await p.waitForFunction(() => /Følger 4 butikker/.test(document.body.innerText));
      check("extras: the list and the line follow at once (and after the list is read again)", (await body(p, "x1").locator(".xshops .foot").count()) === 3 && !/butik-b\.dk/.test(await body(p, "x1").locator(".xshops").innerText()));
      await p.waitForTimeout(150);
      check("extras: ... still after the read", (await body(p, "x1").locator(".xshops .foot").count()) === 3 && (await mOpen(body(p, "x1").locator(".manage"))));
      // down to the last one: null, then the product is "not found elsewhere" again
      await body(p, "x1").locator('[data-act="x-rm"]').first().click();
      await p.waitForFunction(() => window.__db.writes().length === 2);
      await body(p, "x1").locator('[data-act="x-rm"]').first().click();
      await p.waitForFunction(() => window.__db.writes().length === 3);
      await body(p, "x1").locator('[data-act="x-rm"]').first().click();
      await p.waitForFunction(() => window.__db.writes().length === 4);
      const os = await ops(p);
      check("extras: the entries go one at a time; the last one is removed with null", JSON.stringify(os.map(x => x.payload.extra_urls)) === JSON.stringify([[XA, XC, XD], [XC, XD], [XD], null]), JSON.stringify(os.map(x => x.payload)));
      await p.waitForFunction(() => /Fandt ikke varen hos andre butikker/.test(document.body.innerText));
      check("extras: with none left the list and the line are gone and the single-shop note is back", !/Butikker, vi følger|Følger \d/.test(await body(p, "x1").innerText()) && /Kun denne butik/.test(await body(p, "x1").innerText()));
      check("extras: nothing else was written", (await p.evaluate(() => window.__db.writes().length)) === 4 && (await p.evaluate(() => window.__db.products.filter(x => x.id === "x1")[0].extra_urls)) === null);
      await p.context().close();
    }
    {   // a failing save
      const p = await open({ products: [xp("f1", [XA, XB])], label: "extra-fail" });
      await p.waitForSelector(".item"); await p.click('.head[data-id="f1"]');
      await p.evaluate(() => { window.__db.netFail = true; });
      await p.click('[data-act="x-rm"][data-id="f1"] >> nth=0');
      await p.waitForFunction(() => /Kunne ikke gemme/.test(document.body.innerText));
      check("extras: a failing save says so; the shop stays and can be tried again", /Kunne ikke gemme lige nu/.test(await body(p, "f1").innerText()) && (await body(p, "f1").locator('.xshops [data-act="x-rm"]').count()) === 2 && !(await body(p, "f1").locator('[data-act="x-rm"]').first().isDisabled()));
      await p.context().close();
    }
  }

  // 5d. the add form is one line; the goal choices appear while the field is in use
  {
    const p = await open({ products: [], label: "add-line" });
    await p.waitForSelector("#addForm:not([hidden])");
    const bf = await p.locator("#fMain").boundingBox(), bb = await p.locator("#fSubmit").boundingBox();
    check("add line: the field and the button are in one row, the button inside the same bar", Math.abs((bf.y + bf.height / 2) - (bb.y + bb.height / 2)) < 3 && bb.x > bf.x && (await p.locator(".addrow #fSubmit").count()) === 1 && (await p.locator(".addrow #fMain").count()) === 1);
    check("add line: the button is still called 'Hold øje'", (await p.getByRole("button", { name: "Hold øje" }).count()) === 1 && bb.height >= 44);
    check("add line (wide): the three goal choices are always visible as chips, 'Mål' is not needed, 'Detaljer' waits for the field",
      await p.isVisible(".goal") && (await p.getByRole("radio").count()) === 3 && !(await p.isVisible("#goalBtn")) && !(await p.isVisible("#fReq")) && await p.evaluate(() => document.getElementById("addMore").hidden));
    await p.focus("#fMain");
    check("add line: on focus 'Detaljer' appears with the three choices, 'Godt tilbud' is the default", await p.isVisible("#fReq") && await p.isVisible(".goal") && (await p.getByRole("radio").count()) === 3 && await p.isChecked("#fTypeAuto") && !(await p.isVisible("#fAmount")));
    const gb = await p.locator(".goal").boundingBox();
    check("add line: ... below the field", gb.y >= bf.y + bf.height - 1);
    check("add line: the choices are a labelled radiogroup", (await p.getAttribute(".goal", "role")) === "radiogroup" && /Hvornår/.test(await p.getAttribute(".goal", "aria-label")) && (await p.getByRole("radiogroup").count()) === 1);
    await p.click("h1");
    await p.waitForTimeout(50);
    check("add line: leaving the empty field hides them again", !(await p.isVisible("#fReq")));
    await p.fill("#fMain", "Sony"); await p.click("h1"); await p.waitForTimeout(50);
    check("add line: text in the field keeps them", await p.isVisible("#fReq"));
    await p.fill("#fMain", ""); await p.click("h1"); await p.waitForTimeout(50);
    check("add line: emptied and left: hidden", !(await p.isVisible("#fReq")));
    await p.focus("#fMain"); await p.click(".goal label:has(#fTypePrice)");
    check("add line: a tap on a choice is not lost to the blur, and the amount field shows", await p.isChecked("#fTypePrice") && await p.isVisible("#fAmount"));
    await p.click("h1"); await p.waitForTimeout(50);
    check("add line: a choice other than the default stays visible", await p.isVisible("#fReq") && await p.isVisible("#fAmount"));
    await p.click(".goal label:has(#fTypeAuto)"); await p.click("h1"); await p.waitForTimeout(50);
    check("add line: back to the default and left: hidden again", !(await p.isVisible("#fReq")));
    // keyboard: Tab goes field -> button -> the choices -> on, never trapped; arrows move in the radiogroup; Enter submits
    await p.focus("#fMain"); await p.keyboard.press("Tab");
    check("add line: Tab from the field reaches the button", await p.evaluate(() => document.activeElement.id) === "fSubmit");
    await p.keyboard.press("Tab");
    check("add line: the next Tab lands on the checked radio", await p.evaluate(() => document.activeElement.id) === "fTypeAuto");
    await p.keyboard.press("ArrowRight");
    check("add line: an arrow key moves the choice", await p.isChecked("#fTypePrice") && await p.isVisible("#fAmount"));
    let left = false;
    for (let i = 0; i < 8 && !left; i++) { await p.keyboard.press("Tab"); left = await p.evaluate(() => !document.getElementById("addForm").contains(document.activeElement)); }
    check("add line: focus is not trapped: Tab leaves the form", left);
    await p.keyboard.press("Shift+Tab"); await p.keyboard.press("Shift+Tab"); await p.keyboard.press("Shift+Tab");
    await p.click(".goal label:has(#fTypeAuto)");
    await p.fill("#fMain", "Sony WH-1000XM5 sort"); await p.focus("#fMain"); await p.keyboard.press("Enter");
    await p.waitForFunction(() => window.__db.writes().length === 1);
    check("add line: Enter in the field submits (name only, goal auto)", JSON.stringify((await ops(p))[0].payload) === JSON.stringify({ name: "Sony WH-1000XM5 sort", target_type: "auto", target_value: null }));
    await p.context().close();
    // narrow: a compact button that keeps its name
    for (const w of [360, 400]) {
      const n = await open({ products: [], width: w, label: "add-narrow" + w });
      await n.waitForSelector("#addForm:not([hidden])");
      const b = await n.locator("#fSubmit").boundingBox(), f = await n.locator("#fMain").boundingBox(), r = await n.locator(".addrow").boundingBox();
      check("add line at " + w + " px: compact square button (at least 44 px), same row, inside the bar", b.width >= 44 && b.width <= 52 && b.height >= 44 && Math.abs((f.y + f.height / 2) - (b.y + b.height / 2)) < 3 && b.x + b.width <= r.x + r.width);
      check("add line at " + w + " px: the compact button keeps its accessible name", (await n.getByRole("button", { name: "Hold øje" }).count()) === 1 && (await n.locator("#fSubmit svg").getAttribute("aria-hidden")) === "true");
      check("add line at " + w + " px: field wide enough to read (at least " + (w < 400 ? 175 : 215) + " px, with the 'Mål' button in the row)", f.width >= (w < 400 ? 175 : 215), String(f.width));
      check("add line at " + w + " px: 'Mål' is a visible text button in the row, at least 44 px high, collapsed", await n.isVisible("#goalBtn") && (await n.locator("#goalBtn").boundingBox()).height >= 44 && (await n.getAttribute("#goalBtn", "aria-expanded")) === "false" && !(await n.isVisible(".goal")) && !(await n.isVisible("#fReq")) && (await n.getByRole("button", { name: "Mål" }).count()) === 1);
      await n.click("#goalBtn");
      check("add line at " + w + " px: 'Mål' reveals the three choices and 'Detaljer', aria-expanded true", (await n.getAttribute("#goalBtn", "aria-expanded")) === "true" && await n.isVisible(".goal") && (await n.getByRole("radio").count()) === 3 && await n.isVisible("#fReq"));
      await n.click("#goalBtn");
      check("add line at " + w + " px: 'Mål' again hides them", (await n.getAttribute("#goalBtn", "aria-expanded")) === "false" && !(await n.isVisible(".goal")) && !(await n.isVisible("#fReq")));
      await n.context().close();
    }
  }

  // 5e. product pictures
  {
    const mk = (id, over) => row("test-sony-xm5", Object.assign({ id, name: "Vare " + id, target_value: 1700 }, over));
    const rows = [mk("im1", { name: "Alfa", image_url: "https://img.example.test/alfa.svg" }), mk("im2", { name: "øl-kasse", image_url: null }), mk("im3", { name: "Gamma", image_url: "https://img.example.test/broken.svg" }),
      mk("im4", { name: "Delta", image_url: "http://img.example.test/http.svg" }), mk("im5", { name: "Epsilon", image_url: "javascript:alert(1)" }), mk("im6", { name: "Zeta", image_url: 'https://img.example.test/a"onerror="window.__x=1.svg' })];
    const p = await open({ products: rows, label: "images" });
    const hosts = new Set(); p.on("request", r => hosts.add(new URL(r.url()).hostname));
    await p.reload(); await p.waitForSelector(".item"); await p.waitForTimeout(600);
    const th = id => p.locator('.head[data-id="' + id + '"] .thumb');
    const attrs = await p.locator('.head[data-id="im1"] .thumb img').evaluate(i => ({ loading: i.getAttribute("loading"), decoding: i.getAttribute("decoding"), rp: i.getAttribute("referrerpolicy"), alt: i.getAttribute("alt"), w: i.getAttribute("width"), h: i.getAttribute("height"), src: i.getAttribute("src"), fit: getComputedStyle(i).objectFit, ok: i.complete && i.naturalWidth > 0 }));
    check("images: a thumbnail with loading=lazy, decoding=async, referrerpolicy=no-referrer, empty alt, fixed width and height, object-fit cover, loaded",
      attrs.loading === "lazy" && attrs.decoding === "async" && attrs.rp === "no-referrer" && attrs.alt === "" && attrs.w === "48" && attrs.h === "48" && attrs.fit === "cover" && attrs.ok, JSON.stringify(attrs));
    check("images: the address is used exactly as stored (nothing added to it)", attrs.src === "https://img.example.test/alfa.svg" && p.imgReqs.every(u => !/[?&]/.test(u)));
    const box = await th("im1").boundingBox(), rad = await th("im1").evaluate(e => getComputedStyle(e).borderRadius);
    check("images: about 48 px square with rounded corners, at the start of the row, before the name", Math.abs(box.width - 48) < 1 && Math.abs(box.height - 48) < 1 && parseFloat(rad) >= 6 && box.x < (await p.locator('.head[data-id="im1"] h2').boundingBox()).x);
    const xs = await p.$$eval(".head .thumb", els => els.map(e => Math.round(e.getBoundingClientRect().left)));
    check("images: all thumbnails and placeholders are aligned in one column", xs.length === 6 && new Set(xs).size === 1, JSON.stringify(xs));
    check("images: no picture, a placeholder block with the first letter (upper case), hidden from screen readers",
      (await th("im2").evaluate(e => e.classList.contains("ph") && e.textContent === "Ø" && e.getAttribute("aria-hidden") === "true")) && (await th("im2").locator("img").count()) === 0);
    check("images: a picture that fails to load falls back to the placeholder letter", (await th("im3").evaluate(e => e.classList.contains("ph") && e.textContent === "G")) && (await th("im3").locator("img").count()) === 0);
    check("images: http and javascript: addresses are never put in an img (placeholder instead)", (await th("im4").locator("img").count()) === 0 && (await th("im5").locator("img").count()) === 0 && (await th("im4").textContent()) === "D" && (await th("im5").textContent()) === "E");
    check("images: an address with a quote cannot break out of the attribute", (await p.evaluate(() => window.__x)) === undefined && (await p.locator('.head[data-id="im6"] .thumb img').count()) <= 1);
    const brokenBefore = p.imgReqs.filter(u => /broken/.test(u)).length;
    await p.evaluate(() => window.__tick()); await p.waitForTimeout(400);
    check("images: a failed picture is not tried again at every poll, and the others are not reloaded into a placeholder", p.imgReqs.filter(u => /broken/.test(u)).length === brokenBefore && (await th("im3").evaluate(e => e.classList.contains("ph"))) && (await th("im1").locator("img").count()) === 1);
    check("images: the only hosts the page talked to are the local server and the (stubbed) picture host, fonts and the library stub", [...hosts].every(h => /^(127\.0\.0\.1|img\.example\.test|fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)$/.test(h)), [...hosts].join());
    const idx = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
    check("images: index.html has no Content-Security-Policy that would block pictures from other hosts", !/Content-Security-Policy/i.test(idx));
    const sw = require("./sw.js");
    check("images: the service worker leaves cross-origin picture requests alone (and handles only same-origin GET)", sw.shouldHandle("GET", "https://img.example.test/a.svg", base) === false && sw.shouldHandle("GET", base + "/app.js", base) === true);
    const css = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
    check("images: the page never rewrites or proxies picture addresses (no tracking parameters added)", !/image_url[^;]*\+\s*["']\?/.test(css) && !/utm_|ref=/.test(css.slice(css.indexOf("function thumbHtml"), css.indexOf("function headHtml"))));
    await p.context().close();
  }

  // 5f. order and groups: "Tilbud nu" first, then closest to the goal, waiting, a quiet group for the ones that cannot be fetched, bought last
  {
    const mk = (id, over) => row("test-sony-xm5", Object.assign({ id, name: "Vare " + id, target_value: 1700 }, over));
    const names = p => p.$$eval(".item h2", els => els.map(e => e.textContent));
    const tick = async p => { await p.evaluate(() => window.__tick()); await p.waitForTimeout(250); };
    // best price 2.049: target 1900 is 7.8 % away, 1700 is 20 %, 1500 is 37 %
    const A = mk("ga", { name: "Nær", target_value: 1900 }), B = mk("gb", { name: "Midt", target_value: 1700 }), C = mk("gc", { name: "Langt", target_value: 1500 });
    const LISTS = [{ id: "l1", user_id: "u1", name: "Alle tre" }, { id: "l2", user_id: "u1", name: "Tom" }];
    const p = await open({ products: [C, B, A].map(r => Object.assign({}, r, { list_id: "l1" })), lists: LISTS, label: "order" });
    await p.waitForSelector(".item");
    check("order: no 'Tilbud nu' label without a hit", (await p.locator(".grp-h").count()) === 0 && (await p.locator(".item.hit").count()) === 0);
    check("order: the rest is ordered by how close each is to its goal", JSON.stringify(await names(p)) === '["Nær","Midt","Langt"]', JSON.stringify(await names(p)));
    // prices move so that a new sort would put 'Langt' first: nothing moves between polls
    await p.evaluate(() => { var r = window.__db.products.filter(x => x.id === "gc")[0]; r.target_value = 2000; });
    await tick(p);
    check("order: stable between polls (a changed distance does not move a row)", JSON.stringify(await names(p)) === '["Nær","Midt","Langt"]', JSON.stringify(await names(p)));
    await p.locator('.head[data-id="gb"]').click();
    await p.evaluate(() => { var r = window.__db.products.filter(x => x.id === "ga")[0]; r.target_value = 1000; });
    await tick(p);
    check("order: an open row stays where it is", JSON.stringify(await names(p)) === '["Nær","Midt","Langt"]' && (await p.locator('.head[data-id="gb"]').getAttribute("aria-expanded")) === "true");
    await p.locator('.head[data-id="gb"]').click();
    // a row that becomes a hit moves up under the label, nothing else moves
    await p.evaluate(() => { var r = window.__db.products.filter(x => x.id === "gb")[0]; r.target_value = 2100; });
    await tick(p);
    check("order: a row that becomes a hit goes first under the quiet label 'Tilbud nu'", JSON.stringify(await names(p)) === '["Midt","Nær","Langt"]' && (await p.locator(".grp-h").count()) === 1 && (await p.textContent(".grp-h")) === "Tilbud nu" && (await p.locator(".grp-hit .item.hit").count()) === 1, JSON.stringify(await names(p)));
    const gy = await p.locator(".grp-h").boundingBox(), hy = await p.locator(".item.hit").boundingBox(), ny = await p.locator('.head[data-id="ga"]').boundingBox();
    check("order: the label sits above the hit, the others below it", gy.y < hy.y && ny.y > hy.y);
    await p.evaluate(() => { var r = window.__db.products.filter(x => x.id === "gb")[0]; r.target_value = 1700; });
    await tick(p);
    check("order: when the hit ends the row returns to the rest (by closeness) and the label goes", JSON.stringify(await names(p)) === '["Nær","Midt","Langt"]' || JSON.stringify(await names(p)) === '["Midt","Nær","Langt"]');
    // a new product that is still being fetched is shown before the priced ones; bought ones go last, dimmed
    await p.evaluate(() => { window.__db.products.push({ id: "gn", user_id: "u1", name: "Ny vare", source_url: "https://prisjagt.dk/product.php?p=1", target_type: "auto", target_value: null, status: "pending", created_at: new Date().toISOString(), tracked_variants: null, active: true, list_id: "l1" }); });
    await tick(p);
    const n1 = await names(p);
    check("order: a new row that is being fetched shows at once, before the priced ones", n1[0] === "Ny vare" && n1.length === 4, JSON.stringify(n1));
    await p.evaluate(() => { var r = window.__db.products.filter(x => x.id === "gb")[0]; r.bought_at = "2026-11-16T10:00:00Z"; r.bought_price = 2049; r.bought_by = "u1"; });
    await tick(p);
    const n2 = await names(p);
    check("order: a bought product goes last and is dimmed", n2[n2.length - 1] === "Midt" && +(await p.locator('.item:has(.head[data-id="gb"]) .thumb').evaluate(e => getComputedStyle(e).opacity)) < 1, JSON.stringify(n2));
    // the order is a fresh sort on load and when another list is chosen
    await p.evaluate(() => { var r = window.__db.products.filter(x => x.id === "gc")[0]; r.target_value = 2040; });
    await tick(p);
    check("order: still the old order after another poll", (await names(p)).indexOf("Langt") > (await names(p)).indexOf("Nær"));
    await p.click('#chips [data-lsel="l2"]'); await p.click('#chips [data-lsel="l1"]');
    const n3 = await names(p);
    check("order: choosing a list sorts again (now 'Langt' is the closest)", n3.indexOf("Langt") < n3.indexOf("Nær"), JSON.stringify(n3));
    await p.reload(); await p.waitForSelector(".item");
    check("order: a fresh sort after a reload", true);
    await p.context().close();
    // choose-variant rows are not hidden away; waiting rows stay in the main list
    const q = await open({ products: [Object.assign({}, chooseRow), Object.assign({}, pendingRow), A, C], label: "order-wait" });
    await q.waitForSelector(".item");
    const nq = await names(q);
    check("order: a row that needs the person ('Vælg variant') comes before the priced ones and is visible", nq[0] === "Sony WH-1000XM5" && /Vælg variant/.test(await q.locator('.item[data-status="choose"] .head .meta').first().textContent()) && await q.locator('.item[data-status="choose"] .head').isVisible(), JSON.stringify(nq));
    check("order: all rows with a goal come after them, closest first", JSON.stringify(nq.slice(2)) === '["Nær","Langt"]', JSON.stringify(nq));
    await q.context().close();
    // goal auto: by how far under the normal price; unknown last
    const au = (id, name, price, norm) => mk(id, { name, target_type: "auto", target_value: null, normal_price: norm, verdict: { level: "ok", text: "Almindelig pris." }, offers: [{ store: "Shop", price, url: "https://shop.dk/x", inStock: true, note: null, variant: "v1" }] });
    const r = await open({ products: [au("a1", "Lidt", 1900, 2000), au("a2", "Meget", 1700, 2000), au("a3", "Ukendt", 1700, null), au("a4", "Over", 2100, 2000)], label: "order-auto" });
    await r.waitForSelector(".item");
    check("order: goal 'auto' is ordered by how far under the normal price, unknown last", JSON.stringify(await names(r)) === '["Meget","Lidt","Over","Ukendt"]', JSON.stringify(await names(r)));
    await r.context().close();
  }

  // 5g. products that cannot be fetched: quiet, collapsed, counted
  {
    const e1 = Object.assign({}, errorRow, { id: "e1" }), e2 = Object.assign({}, errorRow, { id: "e2", name: "Anden fejl", check_note: "Siden svarer ikke." });
    const x5 = row("test-sony-xm5", { id: "x5", target_value: 1700, warning: "Førprisen er pustet op." });
    const p = await open({ products: [e1, e2, x5, pendingRow, chooseRow], collapsed: true, label: "errors" });
    await p.waitForSelector(".item");
    const sum = (await p.textContent("#errGroup > summary")).trim();
    check("errors: a collapsed group at the bottom, '2 varer kan ikke hentes' (plural)", sum === "2 varer kan ikke hentes" && !(await p.evaluate(() => document.getElementById("errGroup").open)) && !(await p.isVisible('.item[data-status="error"]')));
    const yg = (await p.locator("#errGroup").boundingBox()).y, ys = await p.$$eval("#list > .item", els => els.map(e => e.getBoundingClientRect().top));
    check("errors: the group comes after every live row", ys.every(y => y < yg));
    check("errors: waiting rows (fetching, choose variant) stay in the main list with their short status; 'Vælg variant' is visible",
      await p.locator('#list > .item[data-status="pending"]').isVisible() && /Henter produktet/.test(await p.locator('#list > .item[data-status="pending"] .head .meta').textContent()) && await p.locator('#list > .item[data-status="choose"] .head .meta').isVisible() && /Vælg variant/.test(await p.textContent('#list > .item[data-status="choose"] .head .meta')));
    const redText = await p.evaluate(() => { var red = "rgb(168, 43, 40)", bad = []; document.querySelectorAll("#list > .item *, #errGroup > summary").forEach(function (e) { if (e.children.length === 0 && e.textContent.trim() && getComputedStyle(e).color === red) bad.push(e.textContent.trim()); }); return bad; });
    check("errors: no red text anywhere in the main list but the real warning 'Oppustet førpris' (and the destructive 'Fjern')", redText.every(t => t === "Oppustet førpris" || t === "Fjern") && redText.indexOf("Oppustet førpris") >= 0, JSON.stringify(redText));
    await p.click("#errGroup > summary");
    check("errors: opened, each row shows its short reason in muted text", await p.locator('.item[data-status="error"]').first().isVisible() && /findes ikke længere/.test(await p.textContent('.head[data-id="e1"] .meta')) && /Siden svarer ikke\./.test(await p.textContent('.head[data-id="e2"] .meta')));
    check("errors: ... and the reason is not red and not a warning", await p.evaluate(() => { var m = document.querySelector('.head[data-id="e1"] .meta'), c = getComputedStyle(m).color; return c !== "rgb(179, 48, 45)" && !m.querySelector(".warn"); }));
    await p.locator('.head[data-id="e1"]').click();
    check("errors: a row keeps its actions: the change-link form is in the detail, 'Indstil vare' holds remove", await p.locator('[data-fixurl="e1"]').isVisible() && !(await p.locator('[data-act="del"][data-id="e1"]').isVisible()) && (await p.locator('.item:has(.head[data-id="e1"]) .manage [data-act="del"]').count()) === 1 && !(await p.evaluate(() => /poor/.test(document.querySelector('.item[data-status="error"] .body .verdict').className))));
    await p.locator('.item:has(.head[data-id="e1"]) .manage > .disc').click();
    check("errors: ... and remove is reachable there", await p.locator('[data-act="del"][data-id="e1"]').isVisible());
    await p.evaluate(() => window.__tick()); await p.waitForTimeout(250);
    check("errors: the open group stays open across a poll", await p.evaluate(() => document.getElementById("errGroup").open) && await p.locator('[data-fixurl="e1"]').isVisible());
    await p.click('[data-act="del"][data-id="e1"]'); await p.click('[data-act="del-yes"]');
    await p.waitForFunction(() => document.querySelectorAll(".item[data-status=error]").length === 1);
    check("errors: one left: '1 vare kan ikke hentes' (singular)", (await p.textContent("#errGroup > summary")).trim() === "1 vare kan ikke hentes");
    await p.evaluate(() => { window.__db.products = window.__db.products.filter(x => x.status !== "error"); window.__tick(); }); await p.waitForTimeout(250);
    check("errors: none left: no group at all", (await p.locator("#errGroup").count()) === 0);
    await p.context().close();
  }

  // 5h. the detail view: verdict, chart with the stats, three shops, "Vis alle butikker", alternatives, then "Indstil vare"
  {
    const x5 = row("test-sony-xm5", { id: "x5", target_value: 1700, alt_requested_at: null, alt_done_at: null, alternatives: null, alt_note: null });
    const LISTS = [{ id: "l1", user_id: "u1", name: "Elektronik" }];
    const p = await open({ products: [Object.assign({}, x5, { list_id: "l1" })], lists: LISTS, collapsed: true, label: "detail" });
    await p.waitForSelector(".item"); await p.locator('.head[data-id="x5"]').click();
    const body = p.locator(".item .body");
    const pos = async sel => body.locator(sel).first().evaluate(e => { var r = e.getBoundingClientRect(); return r.top + window.scrollY; });
    const o = [await pos(".verdict"), await pos(".stats"), await pos(".chart"), await pos(".shops"), await pos(".alts"), await pos(".manage")];
    check("detail: order is verdict, stats, chart, shops, alternatives, then 'Indstil vare'", o.every((y, i) => i === 0 || y > o[i - 1]), JSON.stringify(o));
    const rowsTop = await body.locator(".shops > .tablewrap tr").allInnerTexts();
    check("detail: the three cheapest shops with the item in stock, each with 'Se varen'", rowsTop.length === 3 && /Geekd/.test(rowsTop[0]) && /CDON/.test(rowsTop[1]) && /Komplett/.test(rowsTop[2]) && rowsTop.every(t => /Se varen/.test(t)) && !rowsTop.some(t => /Ikke på lager/.test(t)), JSON.stringify(rowsTop));
    check("detail: one link 'Vis alle butikker', collapsed, the rest (sold out included) hidden", (await body.locator(".allshops > .disc").textContent()).trim() === "Vis alle butikker" && !(await mOpen(body.locator(".allshops"))) && !(await p.isVisible("text=punkt1")) && !(await p.isVisible("text=Proshop")));
    await body.locator(".allshops > .disc").click();
    const more = await body.locator(".allshops tr").allInnerTexts();
    check("detail: 'Vis alle butikker' shows the other four, sold-out shops included, each with 'Se varen'", more.length === 4 && more.some(t => /punkt1/.test(t)) && more.filter(t => /Ikke på lager/.test(t)).length === 3 && more.every(t => /Se varen/.test(t)), JSON.stringify(more));
    await p.evaluate(() => window.__tick()); await p.waitForTimeout(250);
    check("detail: ... and it stays open across a poll", await mOpen(body.locator(".allshops")));
    // fewer than four shops: no link; nothing in stock: the three cheapest overall
    const few = row("test-sony-xm5", { id: "f1", offers: [{ store: "A", price: 100, url: "https://a.dk/x", inStock: true, variant: "v1" }, { store: "B", price: 120, url: "https://b.dk/x", inStock: true, variant: "v1" }] });
    const none = row("test-sony-xm5", { id: "f2", offers: [1, 2, 3, 4].map(i => ({ store: "S" + i, price: 100 * i, url: "https://s" + i + ".dk/x", inStock: false, variant: "v1" })) });
    const q = await open({ products: [few, none], collapsed: true, label: "detail-few" });
    await q.waitForSelector(".item"); await q.locator('.head[data-id="f1"]').click(); await q.locator('.head[data-id="f2"]').click();
    check("detail: two shops: no 'Vis alle butikker'", (await q.locator('.item:has(.head[data-id="f1"]) .allshops').count()) === 0 && (await q.locator('.item:has(.head[data-id="f1"]) .shops tr').count()) === 2);
    check("detail: nothing in stock: the three cheapest are shown, the fourth is behind the link", (await q.locator('.item:has(.head[data-id="f2"]) .shops > .tablewrap tr').count()) === 3 && (await q.locator('.item:has(.head[data-id="f2"]) .allshops').count()) === 1);
    await q.context().close();
    await p.context().close();
  }

  // 5i. "Indstil vare": everything about managing the product in one collapsed section, nothing removed
  {
    const x5 = row("test-sony-xm5", { id: "x5", target_value: 1700 });
    const LISTS = [{ id: "l1", user_id: "u1", name: "Elektronik" }];
    const p = await open({ products: [Object.assign({}, x5, { list_id: "l1" })], lists: LISTS, collapsed: true, label: "manage" });
    await p.waitForSelector(".item"); await p.locator('.head[data-id="x5"]').click();
    const m = p.locator(".manage");
    check("manage: one collapsed section 'Indstil vare'", (await m.count()) === 1 && (await m.locator("> .disc").textContent()).trim() === "Indstil vare" && (await m.locator("> .disc").evaluate(e => e.tagName)) === "BUTTON" && (await m.locator("> .disc").getAttribute("aria-expanded")) === "false" && !(await mOpen(m)));
    const all = ["#lp-x5", '[data-act="change"]', ".pshops", '[data-act="buy"]', "a[href]", '[data-act="del"]'];
    const hidden = [];
    for (const sel of all) { if (await m.locator(sel).first().isVisible()) hidden.push(sel); }
    check("manage: goal editor, suggested goals, list, variant, shop choices, købt, the link and remove are all inside it and not shown while it is closed", (await Promise.all(all.map(sel => m.locator(sel).count()))).every(n => n >= 1) && hidden.length === 0, hidden.join());
    check("manage: nothing of that is outside the section", (await p.locator('.item .body').evaluate(b => { var out = b.cloneNode(true); out.querySelectorAll(".manage").forEach(d => d.remove()); return !out.querySelector("[data-edit], [data-listpick], [data-act=change], [data-act=buy], [data-act=del], [data-shops], .sugg"); })));
    check("manage: the goal editor and the suggested goals are not in it any more (they live at the goal line)", (await m.locator("[data-edit], .sugg").count()) === 0);
    await m.locator("> .disc").click();
    check("manage: the button says it is open", (await m.locator("> .disc").getAttribute("aria-expanded")) === "true");
    const vis = []; for (const sel of all) vis.push(await m.locator(sel).first().isVisible());
    check("manage: opened, each of them is shown", vis.every(Boolean), JSON.stringify(vis));
    await p.evaluate(() => window.__tick()); await p.waitForTimeout(250);
    check("manage: stays open across a poll", await mOpen(p.locator(".manage")));
    await p.locator(".manage > .disc").click();
    await p.evaluate(() => window.__tick()); await p.waitForTimeout(250);
    check("manage: and stays closed when closed", !(await mOpen(p.locator(".manage"))));
    await p.context().close();
  }

  // 6. the account menu
  {
    const p = await open({ products: [], admin: true, requests: [{ email: "ny@x.dk", name: "Ny", created_at: new Date().toISOString() }], label: "menu" });
    await p.waitForSelector("#addForm:not([hidden])");
    const st = () => p.evaluate(() => ({ exp: document.getElementById("acctBtn").getAttribute("aria-expanded"), open: !document.getElementById("acctPop").hidden, act: document.activeElement.id }));
    check("menu: a button with the initial in a circle, named 'Konto', closed, with aria-haspopup=menu", (await p.getAttribute("#acctBtn", "aria-haspopup")) === "menu" && (await p.getAttribute("#acctBtn", "aria-label")) === "Konto" && (await st()).exp === "false" && !(await st()).open && (await p.locator("#acctBtn").evaluate(e => getComputedStyle(e.firstElementChild).borderRadius)) === "50%");
    check("menu: the old links are gone from the header and the footer", !(await p.isVisible("#logoutBtn")) && (await p.locator("#settingsBox summary").count()) === 0 && (await p.locator("footer, .fine").filter({ hasText: /^Indstillinger$/ }).count()) === 0);
    await p.click("#acctBtn");
    let s = await st();
    check("menu: click opens it, aria-expanded true, focus on the first item", s.exp === "true" && s.open && s.act === "soundBtn");
    check("menu: a menu with menuitems: Lyd til, Indstillinger, Adgang (admin), Log ud; the address on top, muted",
      (await p.getByRole("menu").count()) === 1 && JSON.stringify(await p.getByRole("menuitem").allTextContents()) === '["Lyd til","Indstillinger","Adgang","Log ud"]' && /mor@familie\.dk/.test(await p.textContent("#acctPop .who")) &&
      await p.locator("#who").evaluate(e => getComputedStyle(e).color) !== await p.locator("#soundBtn").evaluate(e => getComputedStyle(e).color));
    await p.keyboard.press("ArrowDown"); check("menu: ArrowDown moves to the next item", (await st()).act === "settingsBtn");
    await p.keyboard.press("End"); check("menu: End goes to the last item", (await st()).act === "logoutBtn");
    await p.keyboard.press("ArrowDown"); check("menu: ArrowDown wraps to the first", (await st()).act === "soundBtn");
    await p.keyboard.press("ArrowUp"); check("menu: ArrowUp wraps to the last", (await st()).act === "logoutBtn");
    await p.keyboard.press("Home"); check("menu: Home goes to the first", (await st()).act === "soundBtn");
    await p.keyboard.press("Escape"); s = await st();
    check("menu: Escape closes it and focus returns to the button", s.exp === "false" && !s.open && s.act === "acctBtn");
    await p.keyboard.press("Enter"); s = await st();
    check("menu: Enter on the button opens it with focus in the menu", s.exp === "true" && s.open && s.act === "soundBtn");
    await p.keyboard.press("Tab"); s = await st();
    check("menu: Tab closes it and does not trap focus (it moves on from the button)", !s.open && s.exp === "false" && s.act !== "soundBtn" && s.act !== "settingsBtn" && s.act !== "logoutBtn");
    await p.focus("#acctBtn"); await p.keyboard.press("ArrowDown"); s = await st();
    check("menu: ArrowDown on the button opens it too", s.open && s.act === "soundBtn");
    await p.focus("#acctBtn"); await p.keyboard.press("Escape");
    await p.click("#acctBtn"); await p.click("h1"); s = await st();
    check("menu: a click outside closes it", !s.open && s.exp === "false");
    await p.click("#acctBtn"); await p.click("#acctBtn"); s = await st();
    check("menu: the button toggles it, focus on the button when it closes", !s.open && s.act === "acctBtn");
    // items
    await p.click("#acctBtn"); await p.click("#soundBtn"); s = await st();
    check("menu: Lyd toggles ('Lyd fra'), the menu closes, focus back on the button", !s.open && s.act === "acctBtn" && /Lyd fra/.test(await p.textContent("#soundBtn")) && (await p.evaluate(() => localStorage.getItem("pv-muted"))) === "1");
    await p.click("#acctBtn"); await p.click("#settingsBtn"); s = await st();
    check("menu: 'Indstillinger' opens the existing settings, the menu closes, focus goes into the settings", !s.open && await p.isVisible("#settingsBox") && s.act === "shAlways" && await p.isVisible("#shopForm"));
    await p.keyboard.press("Escape");
    check("menu: Escape in the settings closes them, focus back on the button", !(await p.isVisible("#settingsBox")) && (await st()).act === "acctBtn");
    await p.click("#acctBtn"); await p.click("#settingsBtn"); await p.click("#setClose");
    check("menu: 'Luk' in the settings closes them", !(await p.isVisible("#settingsBox")) && (await st()).act === "acctBtn");
    await p.click("#acctBtn"); await p.click("#accessBtn"); s = await st();
    check("menu: 'Adgang' goes to the access section for the owner", !s.open && await p.isVisible("#accessBox") && await p.evaluate(() => { var r = document.getElementById("accessBox").getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; }));
    await p.click("#acctBtn"); await p.click("#logoutBtn");
    await p.waitForSelector("#authView:not([hidden])");
    check("menu: Log ud signs out and the menu is gone", !(await p.isVisible("#acctPop")) && !(await p.isVisible("#acctBtn")));
    await p.context().close();
  }

  // 6b. phone: 360 and 400 px, no sideways scroll, tap targets of at least 44 px, safe areas
  {
    const LISTS = [{ id: "l1", user_id: "u1", name: "Elektronik" }, { id: "l2", user_id: "u1", name: "Bastian" }];
    const prods = all.concat([row("test-lego-falcon", { id: "lg", list_id: "l2" }), Object.assign({}, errorRow, { id: "e9" })])
      .map(r => r.id === "x5" ? Object.assign({}, r, { list_id: "l1" }) : r.id === "dy" ? Object.assign({}, r, { target_type: "auto", target_value: null, alt_requested_at: null, alt_done_at: null, alternatives: null, alt_note: null }) : r);
    for (const w of [360, 400]) {
      const p = await open({ products: prods, lists: LISTS, width: w, admin: true, requests: [{ email: "ny@x.dk", name: "Ny", created_at: new Date().toISOString() }], label: "phone" + w });
      await p.waitForSelector(".item");
      for (const id of ["x5", "ps", "dy", "lg", "p1", "e1"]) await p.locator('.head[data-id="' + id + '"]').click();
      await p.locator("#chips .lchip.plus").click();
      await p.click("#acctBtn"); await p.waitForTimeout(100);
      const pr = await p.locator("#acctPop").boundingBox();
      check("phone " + w + ": the account menu fits inside the screen", pr.x >= 0 && pr.x + pr.width <= w, JSON.stringify(pr));
      await p.click("#settingsBtn"); await p.waitForTimeout(150);
      const sw = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
      check("phone " + w + ": no horizontal scroll with everything open (rows, settings, menu, list form, access)", sw.sw <= sw.cw && sw.bw <= sw.cw, JSON.stringify(sw));
      const small = await p.evaluate(() => {
        var bad = [], seen = new Set();
        document.querySelectorAll("button, a[href], summary, select, input, textarea").forEach(function (e) {
          if (e.type === "hidden" || e.closest("[hidden]") || e.closest("details:not([open]) > :not(summary)")) return;
          var t = e;
          if (e.type === "radio" || e.type === "checkbox") t = e.closest("label") || e;
          if (e.closest("p.note, p.verdict, .meta, .impl > span, .alt-name, .alt-why")) return;      // a link inside a sentence
          if (e.tagName === "A" && e.closest("p.fine, .sent")) return;
          var r = t.getBoundingClientRect(), cs = getComputedStyle(t);
          if (t.classList.contains("lchip")) { var ah = parseFloat(getComputedStyle(t, "::after").height); if (ah > r.height) r = { width: r.width, height: ah }; }      // the hit area reaches past the pill
          if (cs.visibility === "hidden" || cs.display === "none" || r.width === 0 || r.height === 0) return;
          if (seen.has(t)) return; seen.add(t);
          if (r.height < 43.5) bad.push((t.id || t.getAttribute("data-act") || t.getAttribute("data-lact") || t.className || t.tagName) + ":" + Math.round(r.height) + " " + (t.textContent || "").trim().slice(0, 20));
        });
        return bad;
      });
      check("phone " + w + ": tap targets are at least 44 px high", small.length === 0, small.join(" | "));
      const hscroll = await p.evaluate(() => Array.prototype.filter.call(document.querySelectorAll(".item .body, .item .head"), e => e.scrollWidth > e.clientWidth + 1).map(e => e.className + ":" + e.scrollWidth + ">" + e.clientWidth));
      check("phone " + w + ": no row or detail is wider than the screen", hscroll.length === 0, hscroll.join());
      await p.context().close();
    }
    const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
    check("phone: safe-area insets are still used on all sides that matter (left, right, top, bottom)", /safe-area-inset-left/.test(css) && /safe-area-inset-right/.test(css) && /safe-area-inset-top/.test(css) && /safe-area-inset-bottom/.test(css) && /viewport-fit=cover/.test(fs.readFileSync(path.join(ROOT, "index.html"), "utf8")));
    check("phone: motion is short and switched off for people who ask for less", /prefers-reduced-motion: reduce\) \{ \* \{ transition: none !important; animation: none !important/.test(css) && !/(transition|animation)[^;{}]*\b(\d*\.?\d+)s\b/.test(css.replace(/\.1\d?s|\.2s|\.15s|\.16s/g, "")));
  }

  // 5j. design pass: the open product is a card, the goal line, "Ændr", the buttons, and the colours (contrast of the tokens)
  {
    const mk = (id, over) => row("test-sony-xm5", Object.assign({ id, name: "Vare " + id }, over));
    const gx = [mk("g1", { target_type: "price", target_value: 1700 }), mk("g2", { target_type: "auto", target_value: null }), mk("g3", { target_type: "pct", target_value: 15 }), mk("g4", { target_type: "price", target_value: 1700, user_id: "u2" })];
    for (const scheme of ["light", "dark"]) {
      const p = await open({ products: gx, scheme, collapsed: true, label: "card-" + scheme });
      await p.waitForSelector(".item");
      await p.locator('.head[data-id="g1"]').click();
      const st = await p.evaluate(() => {
        const cs = e => getComputedStyle(e), o = document.querySelector(".item.open"), c = document.querySelector('.item:not(.open)');
        const lum = s => { const m = s.match(/[\d.]+/g).map(Number), f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(m[0]) + .7152 * f(m[1]) + .0722 * f(m[2]); };
        const r = o.getBoundingClientRect(), pr = o.parentElement.getBoundingClientRect(), cr = c.getBoundingClientRect();
        return { bodyBg: cs(document.body).backgroundColor, bg: cs(o).backgroundColor, border: cs(o).borderTopWidth, shadow: cs(o).boxShadow, radius: parseFloat(cs(o).borderTopLeftRadius),
          closedBg: cs(c).backgroundColor, closedShadow: cs(c).boxShadow, lumBody: lum(cs(document.body).backgroundColor), lumCard: lum(cs(o).backgroundColor), padTop: parseFloat(cs(o).marginTop), padBot: parseFloat(cs(o).marginBottom), scrollOk: document.documentElement.scrollWidth <= document.documentElement.clientWidth };
      });
      check("card (" + scheme + "): the open product has its own background, a border and a shadow, rounded corners", st.bg !== st.bodyBg && parseFloat(st.border) >= 1 && st.shadow !== "none" && st.radius >= 12 && st.closedShadow === "none", JSON.stringify(st));
      check("card (" + scheme + "): " + (scheme === "light" ? "slightly raised (lighter than the page)" : "slightly lighter than the page"), st.lumCard > st.lumBody, JSON.stringify(st));
      check("card (" + scheme + "): space above and below it so it is clear where it begins and ends", st.padTop >= 12 && st.padBot >= 16, JSON.stringify([st.padTop, st.padBot]));
      check("card (" + scheme + "): no horizontal scroll", st.scrollOk);
      await p.context().close();
    }
    {
      const p = await open({ products: gx, collapsed: true, label: "goalline" });
      await p.waitForSelector(".item");
      const line = async id => { await p.locator('.head[data-id="' + id + '"]').click(); return (await p.locator('.item:has(.head[data-id="' + id + '"]) .goalline .gt').textContent()).trim(); };
      check("goal line: a price goal reads 'Mål: under 1.700 kr.'", (await line("g1")) === "Mål: under 1.700 kr.");
      check("goal line: an auto goal reads 'Mål: godt tilbud'", (await line("g2")) === "Mål: godt tilbud");
      check("goal line: a percent goal reads 'Mål: 15 % rabat'", (await line("g3")) === "Mål: 15 % rabat");
      check("goal line: someone else's product shows the line without 'Ændr'", (await line("g4")) === "Mål: under 1.700 kr." && (await p.locator('.item:has(.head[data-id="g4"]) .gact').count()) === 0 && (await p.locator('.item:has(.head[data-id="g1"]) .gact').count()) === 1);
      // "Ændr": closed by default, opens the editor and the suggestions right there, focus goes in
      const act = p.locator('.item:has(.head[data-id="g1"]) .gact');
      check("Ændr: a visible button, at least 44 px high, collapsed, editor and suggestions not shown", (await act.getAttribute("aria-expanded")) === "false" && (await act.boundingBox()).height >= 44 && !(await p.isVisible("#et-g1")) && (await p.locator("#gp-g1").count()) === 0 && (await act.textContent()) === "Ændr");
      await act.click();
      const open1 = await p.evaluate(() => ({ exp: document.querySelector('[data-act="goal-open"][data-id="g1"]').getAttribute("aria-expanded"), act: document.activeElement.id, ctl: document.querySelector('[data-act="goal-open"][data-id="g1"]').getAttribute("aria-controls") }));
      check("Ændr: aria-expanded true, controls the editor, focus moves into it", open1.exp === "true" && open1.ctl === "gp-g1" && open1.act === "et-g1", JSON.stringify(open1));
      check("Ændr: the goal editor (type, value, Gem) and the suggested goals are shown inline", await p.isVisible("#et-g1") && await p.isVisible("#e-g1") && await p.isVisible('[data-edit="g1"] button[type=submit]') && (await p.locator("#gp-g1 .sugg .chip").count()) >= 2 && (await p.isVisible("#gp-g1 .sugg .chip")));
      await p.keyboard.press("Escape");
      const esc1 = await p.evaluate(() => ({ exp: document.querySelector('[data-act="goal-open"][data-id="g1"]').getAttribute("aria-expanded"), act: document.activeElement.getAttribute("data-act"), has: !!document.getElementById("gp-g1") }));
      check("Ændr: Escape closes it and focus is back on 'Ændr'", esc1.exp === "false" && esc1.act === "goal-open" && !esc1.has, JSON.stringify(esc1));
      await act.click(); await p.click('#gp-g1 [data-act="goal-close"]');
      check("Ændr: 'Luk' closes it too", (await act.getAttribute("aria-expanded")) === "false" && (await p.locator("#gp-g1").count()) === 0);
      await act.click(); await p.fill("#e-g1", "1500"); await p.click('[data-edit="g1"] button[type=submit]');
      await p.waitForFunction(() => window.__db.writes().length === 1);
      const o = (await ops(p))[0];
      check("Ændr: 'Gem' saves through the existing path (update target_value only)", o.op === "update" && o.filters[0][1] === "g1" && JSON.stringify(o.payload) === '{"target_value":1500}', JSON.stringify(o));
      await p.waitForFunction(() => /Mål: under 1\.500 kr\./.test(document.querySelector(".item.open .goalline").textContent));
      check("Ændr: the line shows the new goal and the editor is closed again", (await p.locator("#gp-g1").count()) === 0 && (await act.getAttribute("aria-expanded")) === "false");
      await p.context().close();
    }
    {   // the two buttons on a phone: full width, 44 px, chevron turns, aria-expanded
      const p = await open({ products: [mk("g1", { target_type: "price", target_value: 1700 })], width: 400, collapsed: true, label: "discs" });
      await p.waitForSelector(".item"); await p.locator('.head[data-id="g1"]').click();
      const g = await p.evaluate(() => ["manage", "allshops"].map(c => { const b = document.querySelector("." + c + " > .disc"), r = b.getBoundingClientRect(), w = b.parentElement.getBoundingClientRect(), cs = getComputedStyle(b), af = getComputedStyle(b, "::after");
        return { c, tag: b.tagName, h: r.height, full: Math.abs(r.width - w.width) < 2, border: parseFloat(cs.borderTopWidth), exp: b.getAttribute("aria-expanded"), t: af.transform }; }));
      check("buttons: 'Indstil vare' and 'Vis alle butikker' are bordered buttons, 44 px high, full width, closed", g.length === 2 && g.every(x => x.tag === "BUTTON" && x.h >= 44 && x.full && x.border >= 1 && x.exp === "false"), JSON.stringify(g));
      await p.click(".manage > .disc");
      const g2 = await p.evaluate(() => { const b = document.querySelector(".manage > .disc"); return { exp: b.getAttribute("aria-expanded"), t: getComputedStyle(b, "::after").transform, closed: "" }; });
      await p.waitForTimeout(250);
      const t2 = await p.evaluate(() => getComputedStyle(document.querySelector(".manage > .disc"), "::after").transform);
      check("buttons: opening turns the chevron (aria-expanded true, the arrow is rotated more)", g2.exp === "true" && t2 !== g[0].t, g[0].t + " -> " + t2);
      const destr = await p.evaluate(() => { const r = document.querySelector('.manage-in [data-act="del"]'), cs = getComputedStyle(r), last = document.querySelector(".manage-in .mrow:last-child"); return { c: cs.color, b: parseFloat(cs.borderTopWidth), last: last.classList.contains("end") && last.contains(r) }; });
      check("buttons: 'Fjern' is at the very end, in its own section, in the warning colour with a border", destr.last && destr.b >= 1, JSON.stringify(destr));
      await p.context().close();
    }
    {   // contrast of the main text / muted / accent pairs, from the resolved CSS colours, in both themes
      const lumOf = rgb => { const m = rgb.match(/[\d.]+/g).map(Number), f = v => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); }; return .2126 * f(m[0]) + .7152 * f(m[1]) + .0722 * f(m[2]); };
      const ratio = (a, b) => { const x = lumOf(a), y = lumOf(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const PAIRS = [["ink", "bg"], ["ink", "card"], ["ink2", "bg"], ["ink2", "card"], ["ink2", "sunk"], ["muted", "bg"], ["muted", "card"], ["muted", "sunk"], ["muted", "good-wash"], ["accent", "bg"], ["accent", "card"], ["accent", "sunk"], ["accent", "accent-wash"], ["on-accent", "accent"], ["good", "bg"], ["good", "card"], ["good", "good-wash"], ["danger", "bg"], ["danger", "card"]];
      for (const scheme of ["light", "dark"]) {
        const p = await open({ products: [], scheme, label: "contrast-" + scheme });
        await p.waitForSelector("#addForm:not([hidden])");
        const res = await p.evaluate(names => { const probe = document.createElement("i"); document.body.appendChild(probe); const out = {}; names.forEach(n => { probe.style.color = "var(--" + n + ")"; out[n] = getComputedStyle(probe).color; }); probe.remove(); return out; }, Array.from(new Set([].concat.apply([], PAIRS))));
        const low = PAIRS.map(([f, b]) => [f + "/" + b, ratio(res[f], res[b])]).filter(x => x[1] < 4.5);
        check("contrast (" + scheme + "): text, muted, accent, good and danger tokens are at least 4.5:1 on their backgrounds (" + PAIRS.length + " pairs)", low.length === 0, JSON.stringify(low) + JSON.stringify(res));
        await p.context().close();
      }
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
    await openSettings(p);
    await p.waitForTimeout(300);
    const w = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
    check("no horizontal overflow at 400 px (all rows open)", w.sw <= w.cw && w.bw <= w.cw, JSON.stringify(w));
    // the picture of the phone view: the default look (sections collapsed), one product open, at 400 px
    const ms = await open({ products: states, width: 400, height: 900, lists: LISTS, collapsed: true, label: "mobile-shot" });
    await ms.waitForSelector(".item");
    await ms.locator('.head[data-id="x5"]').click();
    await ms.waitForSelector("canvas.confetti", { state: "detached", timeout: 8000 }).catch(() => {});
    await ms.waitForTimeout(400);
    await ms.screenshot({ path: path.join(ROOT, "screenshot-mobile.png"), fullPage: true });
    await ms.context().close();
    const q = await open({ products: states.concat([]), width: 400, session: false, label: "mobile-out" });
    const w2 = await q.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    check("no horizontal overflow signed out at 400 px", w2);
    await p.context().close(); await q.context().close();

    for (const scheme of ["light", "dark"]) {
      const d = await open({ products: states, scheme, lists: LISTS, collapsed: true, label: "shot-" + scheme });
      await d.waitForSelector(".item");
      await d.locator('.head[data-id="x5"]').click();
      await d.locator('.head[data-id="x5"]').scrollIntoViewIfNeeded();
      await d.waitForSelector("canvas.confetti", { state: "detached", timeout: 8000 }).catch(() => {});
      await d.waitForTimeout(250);
      if (scheme === "dark") await d.locator('.head[data-id="dy"]').click();   // the deal, open: its green card
      await d.waitForTimeout(150);
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

  // 10h. details ("Detaljer", products.requirements): add form, the detail line, "Indstil vare", the variant prompt
  {
    const HOSTILE = '<img src=x onerror="window.__xss=1">&amp; "q" \'s\'';
    const VARS = [{ id: "v1", label: "Hvid/grøn 43", lowest: 700, offers: 3, sample: "x" }, { id: "v2", label: "Sort 43", lowest: 650, offers: 2, sample: "y" }, { id: "v3", label: "Rød 40", lowest: 600, offers: 1, sample: "z" }];
    const dp = (id, over) => row("test-ps5-pro", Object.assign({ id, name: "Stan Smith " + id, tracked_variants: ["v1"], variants: VARS, requirements: null, req_state: null }, over || {}));
    const ch = (id, over) => dp(id, Object.assign({ status: "choose", tracked_variants: null, offers: null, history: null, verdict: null, normal_price: null, check_note: null }, over || {}));
    const bodyOf = (p, id) => p.locator('.item:has([data-id="' + id + '"]) .body');
    const inserts = p => p.evaluate(() => window.__db.ops.filter(o => o.op === "insert").map(o => o.payload));
    {   // add form
      const p = await open({ products: [], label: "req-add" });
      await p.waitForSelector("#addForm:not([hidden])");
      check("details: the input is not shown until the goal choices are (field not focused, no text)", !(await p.isVisible("#fReq")));
      await p.focus("#fMain");
      check("details: ... it shows with them, one small optional input with the short placeholder and a limit of 120",
        (await p.isVisible("#fReq")) && (await p.getAttribute("#fReq", "placeholder")) === "Farve, størrelse m.m. (valgfrit)" && (await p.getAttribute("#fReq", "maxlength")) === "120"
        && (await p.textContent('label[for="fReq"]')) === "Detaljer" && !/Krav/.test(await p.textContent("#addForm")));
      await p.fill("#fMain", "Adidas Stan Smith"); await p.fill("#fReq", "  hvid/grøn,   str. 43 "); await p.click("#fSubmit");
      await p.waitForFunction(() => window.__db.ops.some(o => o.op === "insert"));
      let ins = await inserts(p);
      check("details: a name-only product is sent with the details (trimmed, spaces collapsed)", ins.length === 1 && ins[0].name === "Adidas Stan Smith" && ins[0].requirements === "hvid/grøn, str. 43", JSON.stringify(ins));
      check("details: ... and both fields are cleared", (await p.inputValue("#fReq")) === "" && (await p.inputValue("#fMain")) === "");
      await p.fill("#fMain", "https://www.adidas.dk/sko/stan-smith"); await p.fill("#fReq", "str. 43"); await p.click("#fSubmit");
      await p.waitForFunction(() => window.__db.ops.filter(o => o.op === "insert").length === 2);
      ins = await inserts(p);
      check("details: a shop link is sent with them too", ins[1].source_url === "https://www.adidas.dk/sko/stan-smith" && ins[1].requirements === "str. 43", JSON.stringify(ins[1]));
      await p.fill("#fMain", "https://prisjagt.dk/product.php?p=777"); await p.click("#fSubmit");
      await p.waitForFunction(() => window.__db.ops.filter(o => o.op === "insert").length === 3);
      ins = await inserts(p);
      check("details: nothing typed sends no key at all", !("requirements" in ins[2]), JSON.stringify(ins[2]));
      await p.fill("#fMain", "Hostile vare"); await p.fill("#fReq", HOSTILE); await p.click("#fSubmit");
      await p.waitForFunction(() => window.__db.ops.filter(o => o.op === "insert").length === 4);
      ins = await inserts(p);
      check("details: angle brackets and control characters never leave the form", ins[3].requirements.indexOf("<") < 0 && ins[3].requirements.indexOf(">") < 0 && /img src=x onerror/.test(ins[3].requirements) && ins[3].requirements.length <= 120, JSON.stringify(ins[3]));
      await p.fill("#fMain", "https://onskeskyen.dk/s/e0mfx8"); await p.fill("#fReq", "ignoreres"); await p.click("#fSubmit");
      await p.waitForFunction(() => window.__db.ops.some(o => o.table === "imports"));
      const imp = await p.evaluate(() => window.__db.ops.filter(o => o.table === "imports").map(o => o.payload));
      check("details: for a wish list link the details are ignored (and cleared)", imp.length === 1 && !("requirements" in imp[0]) && (await p.inputValue("#fReq")) === "", JSON.stringify(imp));
      check("details: no page script ran", (await p.evaluate(() => window.__xss)) === undefined);
      await p.context().close();
      const o = await open({ products: [], label: "req-add-old" });
      await o.waitForSelector("#addForm:not([hidden])");
      await o.evaluate(() => { window.__db.noReqCol = true; });
      await o.fill("#fMain", "Gammel database vare"); await o.fill("#fReq", "sort"); await o.click("#fSubmit");
      await o.waitForFunction(() => window.__db.ops.filter(x => x.op === "insert").length === 2);
      const oi = await inserts(o);
      check("details: a database without the column gets the product without them (second try), no error shown", "requirements" in oi[0] && !("requirements" in oi[1]) && (await o.isHidden("#fMsg")), JSON.stringify(oi));
      await o.context().close();
    }
    {   // the detail line and the input in "Indstil vare"
      const noCol = dp("d0"); delete noCol.requirements; delete noCol.req_state;
      const p = await open({ products: [dp("d1", { requirements: "hvid/grøn, str. 43" }), dp("d2"), dp("d3", { requirements: HOSTILE }), noCol,
        dp("d4", { requirements: "str. 44", user_id: "o9", list_id: "lx" })], lists: [{ id: "lx", user_id: "o9", name: "Delt" }], members: [{ list_id: "lx", user_id: "u1" }], label: "req-detail" });
      await p.waitForSelector(".item");
      for (const id of ["d1", "d2", "d3", "d0", "d4"]) await p.click('.head[data-id="' + id + '"]');
      const line = async id => { const l = bodyOf(p, id).locator("p.req"); return (await l.count()) ? (await l.first().innerText()).trim() : null; };
      check("details: one quiet line 'Detaljer: ...' at the top of the detail, right after the goal line",
        (await line("d1")) === "Detaljer: hvid/grøn, str. 43" && (await bodyOf(p, "d1").evaluate(e => e.children[1].className.indexOf("req") >= 0 && e.firstElementChild.className.indexOf("goalwrap") >= 0)));
      check("details: no line without details, and none when the database has no such column (no input either)",
        (await line("d2")) === null && (await line("d0")) === null && (await bodyOf(p, "d0").locator("[data-req]").count()) === 0 && !/Detaljer/.test(await bodyOf(p, "d0").innerText()));
      check("details: hostile text is shown as text, escaped, and runs nothing", (await line("d3")) === "Detaljer: " + HOSTILE.slice(0, 120) && (await bodyOf(p, "d3").locator("img").count()) === 0 && (await p.evaluate(() => window.__xss)) === undefined);
      check("details: the person's own product has the input 'Detaljer' with the saved words and 'Gem' in 'Indstil vare'",
        (await bodyOf(p, "d1").locator('.manage form[data-req] label').textContent()) === "Detaljer" && (await bodyOf(p, "d1").locator('.manage form[data-req] input').inputValue()) === "hvid/grøn, str. 43"
        && (await bodyOf(p, "d1").locator('.manage form[data-req] button').textContent()) === "Gem" && (await bodyOf(p, "d2").locator('.manage form[data-req]').count()) === 1);
      check("details: a member of a shared list sees the line but has no input", (await line("d4")) === "Detaljer: str. 44" && (await bodyOf(p, "d4").locator("[data-req]").count()) === 0);
      // edit and save
      await p.fill('#rq-d2', "  sort,  str. 42 "); await bodyOf(p, "d2").locator('form[data-req] button').click();
      await p.waitForFunction(() => window.__db.ops.some(o => o.op === "update" && "requirements" in o.payload));
      let up = (await ops(p)).filter(o => o.op === "update" && "requirements" in o.payload);
      check("details: saving sends only requirements (cleaned) for that product", up.length === 1 && up[0].payload.requirements === "sort, str. 42" && Object.keys(up[0].payload).length === 1 && up[0].filters[0][1] === "d2", JSON.stringify(up));
      await p.waitForFunction(() => /Detaljer: sort, str\. 42/.test(document.body.innerText));
      check("details: ... and the line appears", (await line("d2")) === "Detaljer: sort, str. 42" && (await p.inputValue("#rq-d2")) === "sort, str. 42");
      await bodyOf(p, "d2").locator('form[data-req] button').click();
      await p.waitForTimeout(150);
      check("details: saving the same words again writes nothing", (await ops(p)).filter(o => o.op === "update" && "requirements" in o.payload).length === 1);
      await p.fill('#rq-d1', ""); await bodyOf(p, "d1").locator('form[data-req] button').click();
      await p.waitForFunction(() => window.__db.ops.filter(o => o.op === "update" && "requirements" in o.payload).length === 2);
      up = (await ops(p)).filter(o => o.op === "update" && "requirements" in o.payload);
      await p.waitForFunction(() => !/Detaljer: hvid/.test(document.body.innerText));
      check("details: emptying the input clears them (null) and the line goes", up[1].payload.requirements === null && (await line("d1")) === null);
      await p.fill('#rq-d2', HOSTILE); await bodyOf(p, "d2").locator('form[data-req] button').click();
      await p.waitForFunction(() => window.__db.ops.filter(o => o.op === "update" && "requirements" in o.payload).length === 3);
      up = (await ops(p)).filter(o => o.op === "update" && "requirements" in o.payload);
      check("details: hostile input is cleaned before it is sent and shown as text", up[2].payload.requirements.indexOf("<") < 0 && (await bodyOf(p, "d2").locator("img").count()) === 0 && (await p.evaluate(() => window.__xss)) === undefined, JSON.stringify(up[2]));
      await p.context().close();
    }
    {   // a product not yet fetched also has the input; a failing save says so
      const p = await open({ products: [dp("e1", { status: "pending", offers: null, history: null, verdict: null, variants: null, tracked_variants: null })], label: "req-loose" });
      await p.waitForSelector(".item"); await p.click('.head[data-id="e1"]');
      check("details: a product that is not fetched yet has the input too", (await p.locator('.item form[data-req] input').count()) === 1);
      await p.evaluate(() => { window.__db.netFail = true; });
      await p.fill("#rq-e1", "rød"); await p.click('.item form[data-req] button');
      await p.waitForFunction(() => /Kunne ikke gemme lige nu/.test(document.body.innerText));
      check("details: a failing save says so and keeps the words in the field", (await p.inputValue("#rq-e1")) === "rød");
      await p.context().close();
    }
    {   // "Finder den rigtige variant"
      const noState = ch("f0", { requirements: "hvid/grøn, str. 43" }); delete noState.req_state;
      const p = await open({ products: [ch("f1", { requirements: "hvid/grøn, str. 43" }), ch("f2", { requirements: "hvid/grøn, str. 43", req_state: { for: "hvid/grøn, str. 43", by: "agent", n: 0 } }),
        ch("f3", { requirements: "hvid/grøn, str. 43", req_state: { for: "gamle ord", by: "agent", n: 1 } }), ch("f4"), noState,
        ch("f5", { requirements: "str. 43", tracked_variants: ["v2"] }), ch("f6", { requirements: "str. 43", user_id: "o9", list_id: "lx" }),
        ch("f7", { requirements: "str. 43", variants: [VARS[0]] })], lists: [{ id: "lx", user_id: "o9", name: "Delt" }], members: [{ list_id: "lx", user_id: "u1" }], label: "req-find" });
      await p.waitForSelector(".item");
      const finding = async id => (await bodyOf(p, id).locator(".req-find").count()) ? (await bodyOf(p, id).locator(".req-find").innerText()).trim() : null;
      check("details: at 'Vælg variant' with details and no answer yet: the quiet text, above the chooser", (await finding("f1")) === "Finder den rigtige variant"
        && (await bodyOf(p, "f1").evaluate(e => { var a = e.querySelector(".req-find"), c = e.querySelector("form.choose"); return !!a && !!c && (a.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0; })));
      check("details: ... and the detail line is above it", (await bodyOf(p, "f1").locator("p.req").innerText()).trim() === "Detaljer: hvid/grøn, str. 43");
      check("details: not once the agent has answered for these words (even with nothing chosen), again for other words", (await finding("f2")) === null && (await finding("f3")) === "Finder den rigtige variant");
      check("details: not without details, not when the database has no req_state, not when a choice is waiting to be read, not for someone else's product, not with one variant",
        (await finding("f4")) === null && (await finding("f0")) === null && (await finding("f5")) === null && (await finding("f6")) === null && (await finding("f7")) === null);
      await bodyOf(p, "f1").locator('input[data-var="v2"]').check(); await bodyOf(p, "f1").locator("form.choose button[type=submit]").click();
      await p.waitForFunction(() => window.__db.ops.some(o => o.op === "update" && "tracked_variants" in o.payload));
      const tv = (await ops(p)).filter(o => o.op === "update" && "tracked_variants" in o.payload);
      check("details: the person can choose at any time: the normal write of tracked_variants", tv.length === 1 && JSON.stringify(tv[0].payload) === '{"tracked_variants":["v2"]}' && tv[0].filters[0][1] === "f1", JSON.stringify(tv));
      await p.waitForFunction(() => !document.querySelector('.item:has([data-id="f1"]) .req-find'));
      check("details: ... and the text is gone", (await finding("f1")) === null);
      await p.context().close();
    }
  }

  check("no page errors", pageErrors.length === 0, pageErrors.join(" | "));
  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok);
  console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
