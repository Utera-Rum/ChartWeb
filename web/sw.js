// 画面の部品だけをキャッシュする。価格データ(bitbank)は常に最新を取るのでキャッシュしない。
// 通信できるときは常に最新のファイルを使い、オフラインのときだけキャッシュで開く。
const CACHE = "chartweb-v1";
const SHELL = ["./", "index.html", "style.css", "app.js", "indicators.js", "signals.js", "datafeed.js", "manifest.webmanifest", "icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"];
const LIB = "https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !req.url.startsWith(LIB)) return; // bitbank などはそのまま通す
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })),
  );
});
