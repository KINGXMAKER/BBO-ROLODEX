self.addEventListener('install', (event) => {
    // Force the waiting service worker to become the active service worker.
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    // Tell the active service worker to take control of the page immediately.
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    
    // Intercept POST requests to the /share action defined in manifest.json
    if (event.request.method === 'POST' && url.pathname.endsWith('/share')) {
        event.respondWith((async () => {
            try {
                const formData = await event.request.formData();
                const imageFile = formData.get('image');
                
                if (imageFile) {
                    // Open a cache and store the shared image file
                    const cache = await caches.open('bbo-share-cache');
                    await cache.put('/shared-image', new Response(imageFile, {
                        headers: {
                            'Content-Type': imageFile.type,
                            'Content-Length': imageFile.size
                        }
                    }));
                }
                
                // Redirect the user to the app with a query parameter indicating a share occurred
                return Response.redirect('./index.html?shared=true', 303);
            } catch (err) {
                console.error('Error handling share target POST', err);
                return Response.redirect('./index.html', 303);
            }
        })());
    }
});
