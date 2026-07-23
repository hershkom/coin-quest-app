// Coin Quest service worker — offline support (backlog item #2).
// Strategy:
//  - App shell + game assets are precached on install.
//  - Navigations (the HTML) go network-first so an online device always gets
//    the freshest deploy, falling back to the cached shell offline.
//  - Everything else (same-origin assets + the CDN scripts the app can't
//    boot without) is stale-while-revalidate: instant from cache, silently
//    refreshed in the background.
// Bump CACHE_VERSION on breaking asset changes; activate cleans old caches.
const CACHE_VERSION='cq-v7';

// app.js/questions.js/styles.css are the app's actual LOGIC, not decorative
// assets -- stale-while-revalidate for them meant every deploy's first load
// (even while online) still ran the OLD code, with the fix only appearing
// after a SECOND reload once the background refresh finished. That's exactly
// the class of "why is this still broken" confusion real device-testing hit
// more than once this project. Serve these network-first (like navigations),
// same offline-fallback-to-cache safety net, so an online reload always gets
// this deploy's actual code in one shot.
const CORE_LOGIC=['app.js','questions.js','styles.css'];
function isCoreLogic(url){ return CORE_LOGIC.some(f=>url.pathname.endsWith('/'+f)||url.pathname.endsWith(f)); }

// All paths RELATIVE to the SW location, because the app lives at the domain
// root on Firebase Hosting but under /coin-quest-app/ on GitHub Pages.
const PRECACHE=[
  './',
  'index.html',
  'app.js',
  'questions.js',
  'styles.css',
  'privacy.html',
  'terms.html',
  'store-assets/icon-512.png',
  'games/classicube/',
  'games/classicube/classicube.js',
  'static/default.zip',
  'vendor/jsqr.js',
];
// Cross-origin scripts the app cannot boot without.
const CDN_HOSTS=['cdnjs.cloudflare.com','www.gstatic.com'];

self.addEventListener('install',e=>{
  e.waitUntil(
    caches.open(CACHE_VERSION)
      .then(c=>c.addAll(PRECACHE))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate',e=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE_VERSION).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch',e=>{
  const req=e.request;
  if(req.method!=='GET') return;
  const url=new URL(req.url);

  // Never intercept Firebase Auth/Database traffic — sign-in redirects and
  // realtime sync must always hit the network directly.
  if(url.pathname.startsWith('/__/')||url.hostname.endsWith('firebasedatabase.app')||
     url.hostname.endsWith('googleapis.com')||url.hostname==='accounts.google.com') return;

  // Navigations: network-first, cached shell as offline fallback.
  if(req.mode==='navigate'){
    e.respondWith(
      fetch(req).then(res=>{
        const copy=res.clone();
        caches.open(CACHE_VERSION).then(c=>c.put(req,copy));
        return res;
      }).catch(()=>caches.match(req).then(r=>r||caches.match('./')))
    );
    return;
  }

  // Core logic files: network-first, same offline fallback pattern as
  // navigations above -- see the CORE_LOGIC comment for why.
  if(url.origin===location.origin&&isCoreLogic(url)){
    e.respondWith(
      fetch(req).then(res=>{
        if(res&&res.status===200){
          const copy=res.clone();
          caches.open(CACHE_VERSION).then(c=>c.put(req,copy));
        }
        return res;
      }).catch(()=>caches.match(req))
    );
    return;
  }

  // Everything else (same-origin static assets + boot-critical CDNs):
  // stale-while-revalidate -- fine here since these are true assets (images,
  // game files, library scripts), not logic that needs to be exactly current.
  if(url.origin===location.origin||CDN_HOSTS.includes(url.hostname)){
    e.respondWith(
      caches.match(req).then(cached=>{
        const refresh=fetch(req).then(res=>{
          if(res&&res.status===200){
            const copy=res.clone();
            caches.open(CACHE_VERSION).then(c=>c.put(req,copy));
          }
          return res;
        }).catch(()=>cached);
        return cached||refresh;
      })
    );
  }
});
