// Coin Quest service worker — offline support (backlog item #2).
// Strategy:
//  - App shell + game assets are precached on install.
//  - Navigations (the HTML) go network-first so an online device always gets
//    the freshest deploy, falling back to the cached shell offline.
//  - Everything else (same-origin assets + the CDN scripts the app can't
//    boot without) is stale-while-revalidate: instant from cache, silently
//    refreshed in the background.
// Bump CACHE_VERSION on breaking asset changes; activate cleans old caches.
const CACHE_VERSION='cq-v3';

// All paths RELATIVE to the SW location, because the app lives at the domain
// root on Firebase Hosting but under /coin-quest-app/ on GitHub Pages.
const PRECACHE=[
  './',
  'index.html',
  'app.js',
  'styles.css',
  'privacy.html',
  'terms.html',
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

  // Assets (same-origin + boot-critical CDNs): stale-while-revalidate.
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
