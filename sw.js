// 앱 화면 파일을 캐시해 오프라인에서도 열리게 함 (Claude API 호출은 캐시하지 않음)
const CACHE = 'gyeol-reader-v1';
const ASSETS = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/main.js', './js/ui.js', './js/db.js', './js/text.js', './js/image.js',
  './js/speech.js', './js/claude.js', './js/shelf.js', './js/reader.js', './js/quiz.js', './js/parent.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 네트워크 우선, 실패하면 캐시 (업데이트가 바로 반영되도록)
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./index.html'))),
  );
});
