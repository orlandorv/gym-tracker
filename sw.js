// Bump this on every deploy that changes any cached file. Old caches are
// dropped automatically on activate, so this one line is the whole release
// process — nothing else in here needs to change per deploy.
const CACHE_VERSION = 'v17';
const CACHE_NAME = `gym-tracker-${CACHE_VERSION}`;

// Registered as a relative path from index.html, so these resolve under
// wherever the app is actually hosted (e.g. /repo-name/ on GitHub Pages)
// rather than assuming the domain root.
const APP_SHELL = [
    './',
    './index.html',
    './styles.css',
    './manifest.webmanifest',
    './js/app.js',
    './js/db.js',
    './js/seed.js',
    './js/units.js',
    './js/dom.js',
    './js/store.js',
    './js/library.js',
    './js/picker.js',
    './js/stepper.js',
    './js/templates.js',
    './js/workout.js',
    './js/timer.js',
    './js/sfx.js',
    './js/records.js',
    './js/history.js',
    './js/volume.js',
    './js/settings.js',
    './icons/icon-180.png',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            // Deliberately not cache.addAll(APP_SHELL): that's all-or-nothing —
            // one flaky request out of 23, fetched in a single burst, fails
            // the whole precache and silently leaves it empty. On a gym's
            // spotty wifi (the entire reason this exists) that's the most
            // likely time for exactly that to happen. Caching each file on
            // its own means a single miss doesn't cost the other 22 — and
            // whatever didn't make it here still gets picked up the first
            // time it's actually requested, via the fetch handler below.
            const results = await Promise.allSettled(
                APP_SHELL.map(async (url) => {
                    const response = await fetch(url, { cache: 'no-store' });
                    if (!response.ok) throw new Error(`${url} -> ${response.status}`);
                    await cache.put(url, response);
                }),
            );
            const failed = results.filter((r) => r.status === 'rejected');
            if (failed.length) {
                console.warn('gym-tracker sw: some app-shell files failed to precache', failed.map((r) => r.reason?.message));
            }
            // Don't wait for old tabs to close before this version takes
            // over installing — see the note by clients.claim() below for
            // why that still isn't quite instant for an already-open tab.
            return self.skipWaiting();
        }),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
            // Take control of any already-open tab immediately rather than
            // only new ones. The tab's already-loaded HTML/JS is still the
            // old version in memory though — that's what needs a reload,
            // not the control handoff itself.
            .then(() => self.clients.claim()),
    );
});

// Cache-first for the app shell: this is what makes the app open instantly
// with no network at all, which is the entire point on a gym's spotty wifi.
// Anything not precached falls through to the network, and quietly gets
// cached for next time if it succeeds.
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;

            return fetch(event.request)
                .then((response) => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                    }
                    return response;
                })
                .catch(() => cached);
        }),
    );
});
