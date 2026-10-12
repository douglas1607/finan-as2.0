self.addEventListener('install', (e) => {
    console.log('[Service Worker] Instalado com sucesso.');
});

self.addEventListener('fetch', (e) => {
    // Permite que o app busque os dados normalmente da API e Render
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});