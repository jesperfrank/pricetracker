// Minimal service worker: lets the app shell open offline. Network first, so a new deploy is used at once.
var CACHE = "prisvagten-shell-v1";
var SHELL = ["./", "index.html", "app.js", "styles.css", "config.js", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/apple-touch-icon.png"];

// Only same-origin GET requests are ever handled. Everything else (Supabase, jsDelivr, fonts, POST) is left alone.
function shouldHandle(method, url, selfOrigin) {
  if (String(method).toUpperCase() !== "GET") return false;
  try { var u = new URL(url); return u.origin === selfOrigin && !/\/sounds\//.test(u.pathname); } catch (e) { return false; }
}

if (typeof module !== "undefined" && module.exports) module.exports = { shouldHandle: shouldHandle, CACHE: CACHE, SHELL: SHELL };

if (typeof self !== "undefined" && typeof self.addEventListener === "function" && typeof self.skipWaiting === "function") {
  self.addEventListener("install", function (e) {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE).then(function (c) {
      // one missing file must not stop the worker from installing
      return Promise.all(SHELL.map(function (u) { return c.add(new Request(u, { cache: "reload" })).catch(function () {}); }));
    }));
  });
  self.addEventListener("activate", function (e) {
    e.waitUntil(caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); }));
  });
  self.addEventListener("fetch", function (e) {
    var req = e.request;
    if (!shouldHandle(req.method, req.url, self.location.origin)) return;
    e.respondWith(fetch(req).then(function (res) {
      if (res && res.ok && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {});
      }
      return res;
    }).catch(function () {
      return caches.match(req, { ignoreSearch: true }).then(function (hit) {
        return hit || (req.mode === "navigate" ? caches.match("index.html") : undefined) || Response.error();
      });
    }));
  });
}
