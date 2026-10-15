self.addEventListener('install', (e) => {
    self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
    // Deixa todas as requisições (API e CoinGecko) passarem direto pela rede sem manipulação de cache
    e.respondWith(fetch(e.request).catch(() => {
        return caches.match(e.request);
    }));
});