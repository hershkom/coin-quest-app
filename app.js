/* ===== FIREBASE APP INIT (shared by every family — see AUTH section below) ===== */
const firebaseConfig={
  apiKey:"AIzaSyAc2Wqz_WHR_AisyUzUm-6-U9EvBFhjrPo",
  // The app is served from Firebase Hosting, which answers on BOTH
  // coin-quest-app.web.app and coin-quest-app.firebaseapp.com. The canonical
  // URL is the firebaseapp.com one and authDomain matches it, so the whole
  // OAuth redirect flow is SAME-ORIGIN — Firebase's documented fix for
  // mobile Chrome's storage partitioning, which silently dropped the sign-in
  // result when the app lived on hershkom.github.io (sign-in→welcome loop on
  // a real device). firebaseapp.com specifically (not web.app) because only
  // it is pre-registered as an authorized redirect URI on the project's
  // Google OAuth client — web.app gave redirect_uri_mismatch on a real
  // device, and adding it would require a manual Cloud Console step.
  authDomain:"coin-quest-app.firebaseapp.com",
  databaseURL:"https://coin-quest-app-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:"coin-quest-app",
  storageBucket:"coin-quest-app.firebasestorage.app",
  messagingSenderId:"370682774257",
  appId:"1:370682774257:web:cdb665285cc7b14e1f9f50",
};
firebase.initializeApp(firebaseConfig);
const fbAuth=firebase.auth(), fbDb=firebase.database();

// Offline support: register the service worker (relative path, so the scope
// is correct both at the Firebase Hosting root and under the GitHub Pages
// subdirectory). Failures are non-fatal — the app just stays online-only.
if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
}
let authUser=null;

/* ===== STORAGE: artifact window.storage + localStorage fallback ===== */
const mem={}; let backend='mem';
async function detectBackend(){
  try{ if(window.storage&&window.storage.set){ await window.storage.set('__cs_t','1'); backend='cloud'; return; } }catch(e){}
  try{ if(window.localStorage){ localStorage.setItem('__cs_t','1'); localStorage.removeItem('__cs_t'); backend='local'; return; } }catch(e){}
  backend='mem';
}
// ---- sync dirty-tracking ----
// Maps a storage key to the cloud payload section it belongs to. Pushes send
// ONLY dirty sections via a multi-path update() instead of set()ing the whole
// family tree — so two parents editing different things at the same time no
// longer silently overwrite each other (the old whole-payload write meant
// "last device to push wins" for EVERYTHING, even untouched sections).
const SYNC_SECTIONS={cs_children:'children',cs_chores:'chores',cs_actions:'actions',
  cs_rewards:'rewards',cs_math:'math',cs_streaks:'streaks',cs_badgedefs:'badgeDefs',
  cs_anchored:'anchored',cs_events:'events',cs_calm:'calmMode',cs_games:'games',
  cs_hwm_date:'hwmDate',cs_auditlog:'auditLog',cs_learning:'learning',
  // Only the HASH of the parent code (see buildSyncPayload). Without an entry
  // here a DB.set would never mark anything dirty and pushToFirebase -- which
  // sends dirty sections only -- would silently drop it.
  cs_pinhash:'pinHash',
  // Family-wide so a purchase made on one parent's Google account unlocks the
  // child's device too -- they sign in with different accounts, so Play alone
  // could never carry it across (see MONETIZATION-PLAN M2.1).
  cs_entitlement:'entitlement', cs_trial_started:'trialStartedAt'};
function keyToSyncSection(k){
  if(SYNC_SECTIONS[k]) return SYNC_SECTIONS[k];
  const m=k.match(/^cs_(bal|hist|daily|mathd|badges|matht|taskt|rwt|gtime|learn|learnlvl)_(.+)$/);
  return m?('kids/'+m[2]):null; // per-kid granularity: sibling edits don't collide
}
let syncDirty=new Set(), syncFullPush=false;
function markSyncDirty(k){ const s=keyToSyncSection(k); if(s) syncDirty.add(s); }

const DB={
  async get(k){
    if(backend==='cloud'){ try{ const r=await window.storage.get(k); return r&&r.value!=null?JSON.parse(r.value):null; }catch(e){ return null; } }
    if(backend==='local'){ try{ const v=localStorage.getItem(k); return v!=null?JSON.parse(v):null; }catch(e){ return null; } }
    return (k in mem)?mem[k]:null;
  },
  async set(k,v){ const s=JSON.stringify(v);
    // Any persisted change schedules a debounced cloud push, so no mutation can
    // be forgotten (previously many admin edits saved locally but never synced).
    markSyncDirty(k);
    if(backend==='cloud'){ try{ await window.storage.set(k,s); scheduleSync(); return; }catch(e){} }
    if(backend==='local'){ try{ localStorage.setItem(k,s); scheduleSync(); return; }catch(e){} }
    mem[k]=v; scheduleSync();
  },
  async del(k){
    // Deletions matter to sync too: removing a child must also remove their
    // cloud record, or the next pull resurrects a ghost kid on every device.
    markSyncDirty(k);
    if(backend==='cloud'){ try{ await window.storage.delete(k); scheduleSync(); return; }catch(e){} }
    if(backend==='local'){ try{ localStorage.removeItem(k); scheduleSync(); return; }catch(e){} }
    delete mem[k]; scheduleSync();
  }
};

/* ===== DEFAULTS ===== */
const DEFAULT_CHILDREN=[
  {id:'ariel', name:'אריאל', emoji:'🦊', color:'#7C5CFC', useSchedule:true},
  {id:'noa',   name:'נועה',  emoji:'🐰', color:'#FF6B6B', useSchedule:false},
];
// Children saved before this field existed don't have it — fall back to the
// original hardcoded behavior (schedule shown only for 'ariel') so upgrading
// doesn't silently change anyone's home screen until the parent opts in.
function childUsesSchedule(ch){ return ch?.useSchedule??(ch?.id==='ariel'); }
// Same "field may not exist on old saved data" fallback pattern as
// childUsesSchedule() above -- children saved before themes existed get the
// original hardcoded look (blocks for ariel, unicorn for noa, none for
// anyone else/a newly added child) so nobody's screen silently changes.
// 'blocks' was called 'minecraft' before the store-release rename (S3) --
// childThemeRaw below still accepts the old stored value for back-compat.
function childTheme(ch){ const t=ch?.theme??(ch?.id==='ariel'?'blocks':ch?.id==='noa'?'unicorn':'none'); return t==='minecraft'?'blocks':t; }
const DEFAULT_CHORES=[
  {id:'chore_teeth', label:'צחצוח שיניים', emoji:'🦷', points:5, max:2},
  {id:'chore_toilet', label:'לשבת בשירותים', emoji:'🚽', points:3, max:6},
  {id:'chore_cleanfood', label:'פינוי אוכל אחרי שמסיימים', emoji:'🍽️', points:8, max:3},
];
const DEFAULT_ACTIONS=[
  {id:'tidy', label:'סידור החדר', emoji:'🧸', points:10, max:1},
  {id:'shower', label:'מקלחת', emoji:'🚿', points:5, max:1},
];
const DEFAULT_REWARDS=[
  {id:'screen', label:'30 דקות מסך', emoji:'🎮', cost:30},
  {id:'icecream', label:'גלידה', emoji:'🍦', cost:50},
  {id:'money', label:'שקל אחד', emoji:'💵', cost:20, cash:1},
  {id:'movie', label:'ערב סרט', emoji:'🍿', cost:80},
];
const DEFAULT_MATH={enabled:true, ops:['+','-'], maxNum:20, pts:2, daily:10};
// Age-graded difficulty bands, roughly following the Israeli curriculum. A
// single family-wide maxNum can't serve siblings years apart -- a 6-year-old
// and a 10-year-old sharing one setting means one is bored and the other is
// failing. The band sets BOTH the number ceiling and which operations are
// allowed at all (no multiplication for a 6-year-old, however the parent set
// the global op chips). The existing silent adaptive level (A5) still runs
// INSIDE the band, so difficulty ramps within an age-appropriate ceiling
// rather than across the whole range.
const MATH_TIERS=[
  {id:'t1', minAge:4,  short:'עד 5',   label:'גן (4-5) — חיבור וחיסור עד 5',            maxNum:5,   ops:['+','-']},
  {id:'t2', minAge:6,  short:'עד 10',  label:'כיתה א׳ (6) — חיבור וחיסור עד 10',        maxNum:10,  ops:['+','-']},
  {id:'t3', minAge:7,  short:'עד 20',  label:'כיתה א׳-ב׳ (7) — חיבור וחיסור עד 20',     maxNum:20,  ops:['+','-']},
  {id:'t4', minAge:8,  short:'עד 50',  label:'כיתה ב׳-ג׳ (8) — עד 50, תחילת כפל',       maxNum:50,  ops:['+','-','×']},
  {id:'t5', minAge:9,  short:'עד 100', label:'כיתה ג׳-ד׳ (9) — עד 100, כפל וחילוק',     maxNum:100, ops:['+','-','×','÷']},
  {id:'t6', minAge:10, short:'עד 200', label:'כיתה ה׳ ומעלה (10+) — כל הפעולות',        maxNum:200, ops:['+','-','×','÷']},
];
function tierById(id){ return MATH_TIERS.find(t=>t.id===id)||null; }
function tierForAge(age){
  const a=parseInt(age); if(!Number.isFinite(a)) return null;
  let found=MATH_TIERS[0];
  for(const t of MATH_TIERS) if(a>=t.minAge) found=t;
  return found;
}
// Explicit parent override wins over the age-derived band; a child with
// neither falls back to the family-wide state.math settings, so families set
// up before this existed keep exactly the behaviour they had.
function childMathTier(ch){
  if(!ch) return null;
  return (ch.mathTier&&tierById(ch.mathTier))||tierForAge(ch.age)||null;
}
// "מכרה הידע" (Knowledge Mine) — block-world-themed learning quiz (math/english/
// science) that earns coins and, optionally, game-time minutes. Family-wide
// settings live in state.learning (this section); per-kid progress/level/
// earned-today live in loadKid() like the rest of the per-kid state.
const DEFAULT_LEARNING={enabled:true,
  subjects:{math:true,english:true,science:true},
  coinsPerCorrect:1, sessionBonus:2, dailyMaxCoins:10,
  minutesPerSession:0, dailyMaxMinutes:15, // 0 = game-time reward option off
  gateEnabled:false, customQuestions:[],
  readAloud:true}; // default ON: the target child reads Hebrew/English poorly

/* ===== MONETIZATION (see MONETIZATION-PLAN.md) =====
   MASTER SWITCH. While false the app behaves EXACTLY as it always has:
   isPremium() is unconditionally true, no gate ever fires, no paywall can
   open. Every piece of billing code below ships dark behind it, so partial
   work can be committed and deployed without any risk to the family already
   using this app in production. It is turned on in one final commit (M6.4),
   only once everything is green.
   Tests flip window.__forceMonetization instead of editing this. */
const MONETIZATION_ENABLED=false;
function monetizationOn(){ return MONETIZATION_ENABLED||!!window.__forceMonetization; }
const TRIAL_DAYS=7;
// Free tier limits -- deliberately generous enough to be genuinely usable
// (a real single-child household works fine), so the paid tier sells on
// breadth rather than on crippling the basics.
const FREE_MAX_CHILDREN=1;
const FREE_MAX_CHORES=4;

/* entitlement shape (lives in the synced family record):
     {plan:'legacy'|'premium'|'lifetime', expiresAt:<ms|null>, source, purchaseJson?, signature?}
   'legacy'  -- family that existed before monetization; premium forever.
   'premium' -- active subscription (expiresAt set).
   'lifetime'-- one-time purchase (expiresAt null).
   A Play-sourced entitlement is only honoured if its Google signature
   verifies (see entitlementValid) -- that's what lets it be shared across
   the family's several Google accounts without a server vouching for it. */
const ENTITLEMENT_PLANS=['legacy','premium','lifetime'];
function entitlementValid(e){
  // Whitelist the plan: an unrecognised string used to sail through here and
  // then be returned by entitlementPlan(), where anything !== 'free' counts as
  // premium -- so {plan:'anything'} was a licence.
  if(!e||!ENTITLEMENT_PLANS.includes(e.plan)) return false;
  if(e.expiresAt&&Date.now()>e.expiresAt) return false;
  if(e.source==='play'){
    // A Play entitlement is ONLY meaningful together with the signed payload
    // Google issued for it. Previously these two fields were merely optional
    // inputs to the check, so omitting them skipped verification entirely and
    // fell through to the accept at the bottom -- i.e. the whole signature
    // scheme could be defeated by deleting two fields. Absent payload is now
    // itself a rejection.
    if(!e.purchaseJson||!e.signature) return false;
    const n=window.CoinQuestNative;
    if(n&&typeof n.verifyPurchaseSignature==='function'){
      // Trust the bridge's verdict either way. A throw means the bridge is
      // broken rather than the purchase being good, so it must not grant.
      try{ return !!n.verifyPurchaseSignature(e.purchaseJson,e.signature); }catch(err){ return false; }
    }
    // No bridge at all (browser preview, or an APK older than this feature):
    // nothing here can verify anything. Accepted deliberately -- refusing
    // would lock a genuinely paying customer out of the web view -- and the
    // required payload above still blocks the trivial hand-written forgery.
    return true;
  }
  return true;
}
function trialActive(){
  if(!state.trialStartedAt) return false;
  return (Date.now()-state.trialStartedAt) < TRIAL_DAYS*86400000;
}
function trialDaysLeft(){
  if(!state.trialStartedAt) return 0;
  return Math.max(0,Math.ceil((state.trialStartedAt+TRIAL_DAYS*86400000-Date.now())/86400000));
}
function entitlementPlan(){
  if(!monetizationOn()) return 'legacy';
  if(entitlementValid(state.entitlement)) return state.entitlement.plan;
  return trialActive()?'trial':'free';
}
function isPremium(){ return entitlementPlan()!=='free'; }

/* ---- feature gates ----
   One funnel, so there is exactly one place that decides what's locked and
   exactly one paywall. Note what is deliberately ABSENT: the calm toolkit.
   Emotional-regulation tools for a dysregulated child are not a thing to put
   behind a payment prompt, so they stay free on every plan, forever. */
const PREMIUM_FEATURES={
  multiChild:'יותר מילד אחד',
  moreChores:'יותר מ-'+FREE_MAX_CHORES+' מטלות',
  games:'משחקים וזמן מסך',
  learning:'מכרה הידע',
  streaks:'אתגרי רצף',
  badges:'תגים',
  events:'אירועים ותזכורות',
  reports:'דוח שבועי להורים',
};
// Returns true when the caller may proceed. When it returns false it has
// ALREADY told the user why -- callers just `if(!gate('x')) return;`.
function gate(key){
  if(!monetizationOn()||isPremium()) return true;
  // Anything absent from PREMIUM_FEATURES is free by construction -- so the
  // calm toolkit staying free isn't a promise someone has to remember, it's
  // the default for every key that was never listed as paid.
  if(!(key in PREMIUM_FEATURES)) return true;
  showPaywall(key);
  return false;
}
function featureLocked(key){ return monetizationOn()&&!isPremium()&&(key in PREMIUM_FEATURES); }

/* ---- paywall ----
   Two audiences, two completely different screens. A child must never be
   shown sales copy or a price -- they get a neutral "this is a grown-up
   setting" note and a way to fetch a parent. Purchase pressure tactics
   (countdowns, "today only", shaming) are deliberately absent: this is an
   app families rely on daily, not a funnel. */
let _paywallProducts=null; // filled from the Play bridge when available
function showPaywall(featureKey){
  refreshPaywallPrices(); // sync bridge call -- without this, any paywall opened before visiting Settings shows "—" prices
  const label=PREMIUM_FEATURES[featureKey]||'הפיצ׳ר הזה';
  // The gear/PIN gate is the app's existing notion of "a parent is present";
  // outside the admin screens we must assume the child is holding the device.
  const parentPresent=currentView==='admin';
  if(!parentPresent){
    modalContent.innerHTML=`<div class="m-emoji">🔒</div><h3>זה חלק של ההורים</h3>
      <p>${esc(label)} נפתח דרך אמא או אבא.</p>
      <div style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn ghost" onclick="closeModal()">סגור</button>
        <button class="btn primary" onclick="closeModal();openAdmin()">קרא להורה</button>
      </div>`;
    modalBg.classList.add('show');
    return;
  }
  const priceMonthly=(_paywallProducts&&_paywallProducts.premium_monthly)||'—';
  const priceLifetime=(_paywallProducts&&_paywallProducts.premium_lifetime)||'—';
  const trialNote=trialActive()
    ? `<div style="background:#EAFBF3;border-radius:12px;padding:9px 11px;font-weight:700;font-size:.84rem;margin-bottom:10px;">נשארו ${trialDaysLeft()} ימי ניסיון — הכול פתוח בינתיים 🙂</div>`
    : '';
  modalContent.innerHTML=`<div class="m-emoji">⭐</div><h3>${esc(label)} — בגרסה המלאה</h3>
    ${trialNote}
    <div style="text-align:right;font-size:.86rem;line-height:1.9;margin-bottom:12px;">
      הגרסה המלאה כוללת:<br>
      👧 כמה ילדים שרוצים · 🧹 מטלות ללא הגבלה<br>
      🎮 משחקים וזמן מסך · ⛏️ מכרה הידע<br>
      🌟 אתגרי רצף · 🏅 תגים · 📅 אירועים · 📊 דוח להורים
    </div>
    <div style="background:#F2F0FB;border-radius:12px;padding:9px 11px;font-size:.8rem;margin-bottom:12px;">
      🌿 כלי הרגיעה נשארים חינם תמיד, בכל גרסה.
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <button class="btn primary" onclick="startPurchase('premium_monthly')">⭐ מנוי חודשי · ${esc(priceMonthly)}</button>
      <button class="btn gold" onclick="startPurchase('premium_lifetime')">♾️ רכישה לתמיד · ${esc(priceLifetime)}</button>
      <button class="btn ghost sm" onclick="openRedeemCode()">יש לי קוד הטבה</button>
      <button class="btn ghost sm" onclick="restorePurchases()">שחזור רכישה קיימת</button>
      <button class="btn ghost sm" onclick="closeModal()">לא עכשיו</button>
    </div>`;
  modalBg.classList.add('show');
}
/* ---- Play Billing bridge (JS side; Kotlin in BillingManager.kt) ----
   Everything degrades quietly when billing isn't reachable (browser, or the
   family sideload flavour which is never monetized) -- the buttons explain
   rather than fail. */
function billingAvailable(){
  const n=window.CoinQuestNative;
  return !!(n&&typeof n.billingAvailable==='function'&&n.billingAvailable());
}
function refreshPaywallPrices(){
  if(!billingAvailable()) return;
  try{
    const raw=window.CoinQuestNative.getProducts(); // JSON: {productId: "₪19.90", ...}
    if(raw) _paywallProducts=JSON.parse(raw);
  }catch(e){ console.error('getProducts failed',e); }
}
function startPurchase(productId){
  if(!billingAvailable()){
    modalMsg('🛒','לא זמין כאן','רכישה אפשרית רק דרך אפליקציית האנדרואיד שהותקנה מ-Google Play.');
    return;
  }
  try{ window.CoinQuestNative.startPurchase(productId); }
  catch(e){ toast('שגיאה בפתיחת הרכישה'); }
}
function restorePurchases(){
  if(!billingAvailable()){ toast('שחזור אפשרי רק באפליקציה מ-Google Play'); return; }
  try{ window.CoinQuestNative.restorePurchases(); toast('בודק רכישות קיימות...'); }
  catch(e){ toast('שגיאה בשחזור'); }
}
function openRedeemCode(){
  // Play has no in-app "enter code" surface we can host ourselves; the codes
  // are redeemed in the Play Store and come back as an ordinary purchase.
  modalContent.innerHTML=`<div class="m-emoji">🎁</div><h3>מימוש קוד הטבה</h3>
    <p style="font-size:.88rem;">קודי הטבה נפדים בחנות Google Play. אחרי המימוש חזרו לכאן — הגרסה המלאה תיפתח אוטומטית.</p>
    <div style="display:flex;gap:8px;margin-top:14px;">
      <button class="btn ghost" onclick="closeModal()">סגור</button>
      <button class="btn primary" onclick="openPlayRedeem()">פתח את Google Play</button>
    </div>`;
  modalBg.classList.add('show');
}
function openPlayRedeem(){
  const n=window.CoinQuestNative;
  if(n&&typeof n.openUrl==='function'){ try{ n.openUrl('https://play.google.com/redeem'); return; }catch(e){} }
  window.open('https://play.google.com/redeem','_blank');
}
/* Called from Kotlin once Play has confirmed AND locally verified a purchase.
   The signed payload is stored in the family record so every device -- each on
   its own Google account -- can re-verify it independently. */
async function onPurchaseVerified(productId,purchaseJson,signature,expiresAt){
  const plan=productId==='premium_lifetime'?'lifetime':'premium';
  // A subscription MUST carry an expiry: entitlementValid treats a missing
  // expiresAt as "never lapses", so passing Play's null through would turn a
  // single month's payment into a lifetime licence. The purchase payload
  // carries no expiry date (that needs the server API we don't have), so we
  // stamp a rolling one: now + 33 days (a monthly cycle plus grace).
  // BillingManager re-runs restorePurchases on every launch of the buyer's
  // device; as long as Play still reports the subscription active, this
  // re-stamps and the entitlement rolls forward. Once cancelled and expired,
  // Play stops reporting it, the stamp stops moving, and premium lapses on
  // every family device within ~a month of the buyer's last launch. That lag
  // is the serverless trade-off, and it errs in the customer's favour.
  const exp=plan==='lifetime'?null:(expiresAt||Date.now()+33*86400000);
  state.entitlement={plan,expiresAt:exp,source:'play',purchaseJson,signature};
  await DB.set('cs_entitlement',state.entitlement);
  closeModal();
  renderPlanStatus();
  modalMsg('🎉','תודה!','הגרסה המלאה נפתחה בכל מכשירי המשפחה.');
}
function onPurchaseFailed(msg){
  // A user-cancelled flow is not an error worth a dialog.
  if(msg&&/cancel/i.test(msg)) return;
  toast('הרכישה לא הושלמה');
}
// Trial state for the parent only -- rendered into the admin settings pane,
// never onto a child-facing screen.
function renderPlanStatus(){
  const el=document.getElementById('planStatus'); if(!el) return;
  if(!monetizationOn()){ el.style.display='none'; return; }
  el.style.display='block';
  const plan=entitlementPlan();
  const txt={
    legacy:'✅ גרסה מלאה — לתמיד (משתמש ותיק, תודה!)',
    lifetime:'✅ גרסה מלאה — נרכשה לתמיד',
    premium:'✅ מנוי פעיל'+(state.entitlement&&state.entitlement.expiresAt?' — מתחדש ב-'+new Date(state.entitlement.expiresAt).toLocaleDateString('he-IL'):''),
    trial:'⏳ תקופת ניסיון — נשארו '+trialDaysLeft()+' ימים',
    free:'🔒 גרסה חינמית מוגבלת',
  }[plan]||'';
  el.innerHTML=`<div style="font-weight:800;margin-bottom:6px;">${txt}</div>`+
    (plan==='trial'||plan==='free'
      ? `<button class="btn primary sm" onclick="showPaywall('games')">⭐ שדרוג לגרסה המלאה</button>`
      : '');
}
// Default games must be frame-embeddable (no X-Frame-Options/frame-ancestors
// blocking). The primary game is SELF-HOSTED (games/classicube/ — the
// open-source ClassiCube webclient launched straight into singleplayer):
// same-origin so framing can never break, touch controls on mobile, and —
// per an explicit parent requirement — no multiplayer, no chat with
// strangers, and local /client cheat commands (fly/speed etc.) for the
// creative-mode play the kid actually loves. bloxd.io was removed for
// exactly those reasons (open multiplayer lobby + public chat).
// The old classic.minecraft.net iframe entry was removed (S3, store-release
// prep): embedding Mojang's own live web property inside our app's chrome
// carries real trademark/affiliation risk for a publicly-marketed app --
// ClassiCube (self-hosted, open-source, unaffiliated with Mojang) covers the
// same "build with blocks" play pattern without that exposure. See
// ANDROID-APP-PLAN.md S3 and the cs_games_v5 migration below.
const DEFAULT_GAMES=[
  {id:'classicube', label:'קלאסיקיוב (בנייה חופשית, משחק יחיד)', emoji:'🧱', url:'games/classicube/'},
  // Native game launcher for a REAL app the family already owns/installed
  // separately (e.g. the actual purchased Minecraft) -- `native:true` +
  // `androidPackage` instead of `url`. This is nominative use (naming a real
  // installed product by its own package id, like any app launcher/shortcut),
  // not embedding or redistributing anything, so it carries none of the
  // iframe risk above. Only playable inside the Android wrapper app, where
  // window.CoinQuestNative exists; the enforced countdown runs natively
  // (AccessibilityService + overlay, see android-app/.../GameTimeOverlayService.kt),
  // not in this web page, since the WebView itself is backgrounded the whole
  // time the game is open.
  {id:'minecraft_real', label:'מיינקראפט (הגרסה שקנית)', emoji:'⛏️', native:true, androidPackage:'com.mojang.minecraftpe'},
  // Same nominative-use, same native-enforcement pattern as minecraft_real
  // above -- YouTube can't be embedded in an iframe for general browsing
  // (it sends X-Frame-Options/CSP frame-ancestors denying that, unlike the
  // single-video nocookie embed player), so it can only ever be a native
  // app launch, never a web `url` game. That also means it's exactly as
  // "bought with game time" as any other game: the overlay wall drains the
  // same gtime wallet and enforces the same countdown, just against
  // com.google.android.youtube instead of a game package.
  {id:'youtube', label:'יוטיוב', emoji:'📺', native:true, androidPackage:'com.google.android.youtube'},
];
const DEFAULT_STREAKS=[
  {id:'clean',    title:'יום נקי',       dayWord:'יום נקי',      icon:'🧼', childId:'ariel', goal:30, rewardLabel:'Nintendo Switch 2', rewardEmoji:'🎮', days:{}, current:0, best:0, wonAt:null},
  {id:'behavior', title:'התנהגות טובה', dayWord:'התנהגות טובה', icon:'😊', childId:'ariel', goal:14, rewardLabel:'יום כיף',           rewardEmoji:'🎉', days:{}, current:0, best:0, wonAt:null},
];
function getStreak(id){ return state.streaks.find(s=>s.id===id); }
// Deliberately non-overlapping with DEFAULT_CHORES (teeth-brushing/toilet
// already live there as unrestricted "anytime" tasks) -- these are only the
// truly period-SPECIFIC additions, migrated into state.chores with a
// `period` tag by the cs_anchored_merged_v1 migration in loadState(). Before
// that migration these lived in a totally separate list from DEFAULT_CHORES,
// so a fresh family used to see "brush teeth" duplicated 3x (once per
// period) alongside the flat chore_teeth entry with no way to notice, since
// schedule and non-schedule children never saw both lists at once.
const DEFAULT_ANCHORED_TASKS={
  morning:[{id:'at_m3',label:'לקחת תרופה',emoji:'💊',points:3,max:1}],
  afternoon:[{id:'at_a1',label:'ניקוי אחרי ארוחת צהריים',emoji:'🍽️',points:8,max:1}],
  evening:[{id:'at_e2',label:'אמבטיה',emoji:'🛁',points:5,max:1},{id:'at_e3',label:'קריאה לפני שינה',emoji:'📖',points:3,max:1}],
  sleep_time:20
};
// Fixed set of measurable things a badge can track. 'threshold' metrics compare
// a running number to an admin-set target; 'goal' metrics are a fixed yes/no
// condition (no threshold to configure). The parent picks metric+threshold —
// the underlying formula stays in code so it can't be broken by a typo.
const BADGE_METRICS={
  totalEarned: {label:'סה״כ מטבעות שהרוויח (אי פעם)', kind:'threshold', get:k=>(k.history||[]).reduce((s,h)=>s+(h.points>0?h.points:0),0)},
  // state.streaks holds several challenges, each assigned to ONE child via
  // streak.childId — without filtering to the streaks assigned to the id
  // being evaluated, every other child would also earn these badges the
  // moment the assigned child's streak crosses the threshold.
  streakBest:  {label:'שיא ימים ברצף (כל אתגר)',        kind:'threshold', get:(k,id)=>Math.max(0,...state.streaks.filter(s=>s.childId===id).map(s=>s.best),0)},
  mathTotal:   {label:'תרגילי חשבון שנפתרו (סה״כ)',     kind:'threshold', get:k=>k.mathTotal||0},
  taskTotal:   {label:'מטלות/פעולות שהושלמו (סה״כ)',    kind:'threshold', get:k=>k.taskTotal||0},
  rewardsTotal:{label:'פרסים שנקנו (סה״כ)',              kind:'threshold', get:k=>k.rewardsTotal||0},
  streakGoal:  {label:'השלמת אתגר רצף כלשהו',           kind:'goal',      get:(k,id)=>state.streaks.some(s=>s.childId===id&&s.best>=s.goal)},
  learnTotal:  {label:'תשובות נכונות במכרה הידע (סה״כ)', kind:'threshold', get:k=>Object.values((k.learn&&k.learn.correctTotal)||{}).reduce((a,b)=>a+b,0)},
};
const DEFAULT_BADGE_DEFS=[
  {id:'first_coin',  emoji:'🥇', label:'המטבע הראשון',   metric:'totalEarned',  threshold:1},
  {id:'streak_7',    emoji:'🔥', label:'שבוע ברצף',      metric:'streakBest',   threshold:7},
  {id:'streak_goal', emoji:'🏆', label:'אלוף האתגר',     metric:'streakGoal',   threshold:null},
  {id:'math_50',     emoji:'🧮', label:'מלך החשבון',     metric:'mathTotal',    threshold:50},
  {id:'tasks_100',   emoji:'🧹', label:'גיבור המטלות',   metric:'taskTotal',    threshold:100},
  {id:'first_reward',emoji:'🎁', label:'הקנייה הראשונה', metric:'rewardsTotal', threshold:1},
  {id:'learn_first',  emoji:'⛏️', label:'כורה מתחיל',    metric:'learnTotal',   threshold:1},
  {id:'learn_master',emoji:'💎', label:'אשף מכרה הידע',  metric:'learnTotal',   threshold:150},
];
function badgeIsEarned(def,k,kidId){
  const m=BADGE_METRICS[def.metric]; if(!m) return false;
  return m.kind==='goal' ? !!m.get(k,kidId) : m.get(k,kidId)>=(def.threshold||0);
}
async function checkBadges(){
  const k=cur(); if(!k) return;
  const have=new Set(k.badges.map(b=>b.id));
  let changed=false;
  for(const def of state.badgeDefs){
    if(have.has(def.id)) continue;
    if(badgeIsEarned(def,k,state.current)){
      k.badges.push({id:def.id,ts:Date.now()});
      changed=true;
      queueBadgeCelebration(def);
    }
  }
  if(changed) await DB.set('cs_badges_'+state.current,k.badges);
  renderBadgesBanner();
}
// A new badge used to be a 2-second toast — easy to miss the one moment the
// whole badge system builds toward. Now it's a full celebration modal with a
// coin burst. Queued: if another modal is up (e.g. the reward-purchase
// congratulations) or several badges land at once, celebrations wait their
// turn instead of clobbering whatever the child is reading.
const _badgeQueue=[];
function queueBadgeCelebration(def){
  _badgeQueue.push(def);
  _tryShowBadgeCelebration();
}
function _tryShowBadgeCelebration(){
  if(!_badgeQueue.length) return;
  if(modalBg.classList.contains('show')){ setTimeout(_tryShowBadgeCelebration,900); return; }
  const def=_badgeQueue.shift();
  if(!state.calmMode){ try{ coinBurst(); chime('celebrate'); }catch(e){} }
  modalContent.innerHTML=`
    <div style="font-size:4.6rem;animation:calmpulse 1.6s ease-in-out infinite;">${def.emoji}</div>
    <h3 style="margin:10px 0 4px;">🏅 תג חדש!</h3>
    <div style="font-size:1.35rem;font-weight:900;color:var(--purple);margin-bottom:6px;">${esc(def.label)}</div>
    <p style="margin-top:0;">כל הכבוד! התג נוסף לאוסף שלך.</p>
    <button class="btn primary" onclick="closeModal();_tryShowBadgeCelebration();">מגניב! 🎉</button>`;
  modalBg.classList.add('show');
}
function earnedBadgeCount(k){
  const ids=new Set(state.badgeDefs.map(d=>d.id));
  return k.badges.filter(b=>ids.has(b.id)).length;
}
function renderBadgesBanner(){
  const wrap=document.getElementById('badgesBannerWrap'); if(!wrap) return;
  if(featureLocked('badges')){ wrap.innerHTML=''; return; } // free home: no premium chrome
  const k=cur();
  // No badges defined at all (a parent who removed every one from the admin
  // "תגים" tab) -- there's nothing meaningful to show ("אספת 0 מתוך 0 תגים"
  // reads as broken, not as "feature turned off"), so hide the banner entirely.
  if(!k||!state.badgeDefs.length){ wrap.innerHTML=''; return; }
  wrap.innerHTML=`<button class="badges-banner" onclick="go('badges')">
    <span class="bb-ic">🏅</span>
    <span class="bb-text">אספת ${earnedBadgeCount(k)} מתוך ${state.badgeDefs.length} תגים</span>
    <span class="bb-arrow">›</span>
  </button>`;
}
function renderBadgesView(){
  const k=cur(); if(!k) return;
  const have=new Set(k.badges.map(b=>b.id));
  document.getElementById('badgesSummary').innerHTML=
    `<div style="font-size:2rem;font-weight:900;color:var(--purple);">🏅 ${earnedBadgeCount(k)} / ${state.badgeDefs.length}</div>
     <div class="card-sub">תגים שאספת עד היום</div>`;
  const grid=document.getElementById('badgeGrid'); grid.innerHTML='';
  state.badgeDefs.forEach(b=>{
    const got=have.has(b.id);
    const cell=document.createElement('div');
    cell.className='badge-cell'+(got?'':' locked');
    cell.innerHTML=`<span class="bc-ic">${got?b.emoji:'❓'}</span><div class="bc-lbl">${esc(b.label)}</div>`;
    grid.appendChild(cell);
  });
}

/* ===== STATE ===== */
let state={};
async function loadState(){
  state.children=(await DB.get('cs_children'))??DEFAULT_CHILDREN;
  state.current =(await DB.get('cs_current')) ??null;
  state.chores  =(await DB.get('cs_chores'))  ??DEFAULT_CHORES;
  state.actions =(await DB.get('cs_actions')) ??DEFAULT_ACTIONS;
  state.rewards =(await DB.get('cs_rewards')) ??DEFAULT_REWARDS;
  state.math    =(await DB.get('cs_math'))    ??DEFAULT_MATH;
  state.streaks =await DB.get('cs_streaks');
  if(!state.streaks){
    // Migrate the old single-challenge shape (cs_streak) into the new
    // multi-challenge array so nobody's real in-progress streak is lost.
    const legacy=await DB.get('cs_streak');
    state.streaks=legacy
      ? [{...legacy,id:'clean',title:'יום נקי',dayWord:'יום נקי',icon:'🧼'}, {...DEFAULT_STREAKS[1]}]
      : DEFAULT_STREAKS.map(s=>({...s,days:{}}));
    await DB.set('cs_streaks',state.streaks);
  }
  state.anchored=(await DB.get('cs_anchored'))??DEFAULT_ANCHORED_TASKS;
  // One-time migration: anchored tasks used to live in their own per-period
  // list (cs_anchored), completely disconnected from state.chores -- a parent
  // deleting a task from the chores admin screen had NO effect on its
  // anchored twin, which kept showing (and kept its OWN separate daily count,
  // under a different id) on the schedule-child's home screen forever. Worse,
  // fillQRSelect() (the QR-code generator) only ever listed state.chores/
  // state.actions -- an anchored task could never get a real QR code printed
  // for it at all, so nothing could ever credit its counter to begin with.
  // Fold every anchored task into state.chores with a `period` tag instead:
  // one list, one id, one place to edit or delete, and QR generation "just
  // works" for every task. state.anchored keeps only sleep_time afterward.
  if(!(await DB.get('cs_anchored_merged_v1'))){
    const existingIds=new Set(state.chores.map(t=>t.id));
    for(const period of ['morning','afternoon','evening']){
      for(const task of (state.anchored[period]||[])){
        if(existingIds.has(task.id)) continue;
        state.chores.push({...task,period});
        existingIds.add(task.id);
      }
    }
    await DB.set('cs_chores',state.chores);
    state.anchored={sleep_time:state.anchored.sleep_time??20};
    await DB.set('cs_anchored',state.anchored);
    await DB.set('cs_anchored_merged_v1',true);
  }
  state.games   =(await DB.get('cs_games'))   ??DEFAULT_GAMES;
  // One-time migration v3: bloxd.io is REMOVED (open multiplayer lobby +
  // public chat — parent explicitly doesn't want the kid playing with
  // strangers), replaced by the self-hosted singleplayer ClassiCube.
  // Devices that synced any older games list get the same swap.
  if(!(await DB.get('cs_games_v3'))){
    state.games=state.games.filter(g=>!/bloxd\.io/.test(g.url));
    if(!state.games.some(g=>/classicube/.test(g.url))) state.games.unshift(DEFAULT_GAMES[0]);
    const mc=state.games.find(g=>/classic\.minecraft\.net/.test(g.url)&&!/מקלדת/.test(g.label));
    if(mc) mc.label+=' (למחשב עם מקלדת)';
    await DB.set('cs_games',state.games);
    await DB.set('cs_games_v3',true);
    await DB.del('cs_games_v2');
  }
  // One-time migration v4: add the native real-Minecraft entry for devices
  // that already synced a games list before it existed.
  if(!(await DB.get('cs_games_v4'))){
    if(!state.games.some(g=>g.native&&g.androidPackage==='com.mojang.minecraftpe')){
      state.games.push({...DEFAULT_GAMES[DEFAULT_GAMES.length-1]});
      await DB.set('cs_games',state.games);
    }
    await DB.set('cs_games_v4',true);
  }
  // One-time migration v5 (S3, store-release prep): drop the classic.minecraft.net
  // iframe entry -- see the comment above DEFAULT_GAMES for why. Devices that
  // synced an older games list (including the '(למחשב עם מקלדת)' label added
  // by v3 above) get it removed too.
  if(!(await DB.get('cs_games_v5'))){
    state.games=state.games.filter(g=>!/classic\.minecraft\.net/.test(g.url||''));
    await DB.set('cs_games',state.games);
    await DB.set('cs_games_v5',true);
  }
  // One-time migration v6: add the native YouTube entry for devices that
  // already synced a games list before it existed (same pattern as v4 above).
  if(!(await DB.get('cs_games_v6'))){
    if(!state.games.some(g=>g.native&&g.androidPackage==='com.google.android.youtube')){
      state.games.push({...DEFAULT_GAMES[DEFAULT_GAMES.length-1]});
      await DB.set('cs_games',state.games);
    }
    await DB.set('cs_games_v6',true);
  }
  // One-time seed: make sure at least one coins→minutes package exists in the
  // rewards shop, so the whole buy-time flow works out of the box with zero
  // parent setup. The flag (not the package's presence) guards re-seeding, so
  // a parent who deletes the package isn't fighting the app re-adding it.
  if(!(await DB.get('cs_gtime_seeded'))){
    if(!state.rewards.some(r=>r.minutes)){
      state.rewards.push({id:'gtime15', label:'15 דקות משחק', emoji:'🎮', cost:30, minutes:15});
      await DB.set('cs_rewards',state.rewards);
    }
    await DB.set('cs_gtime_seeded',true);
  }
  state.learning=(await DB.get('cs_learning'))??DEFAULT_LEARNING;
  state.pin     =(await DB.get('cs_pin'))     ??'1234';
  state.pinHash =(await DB.get('cs_pinhash')) ??null; // family-wide parent code (hash only) -- see savePin/verifyPin
  state.entitlement   =(await DB.get('cs_entitlement'))   ??null;
  state.trialStartedAt=(await DB.get('cs_trial_started')) ??null;
  // Grandfathering: a family that already existed when monetization arrives
  // keeps everything, forever, for free. Written unconditionally (not only
  // when the flag is on) so the record is already in place, and already
  // synced, before the switch is ever flipped.
  // Must test PERSISTED data, not state.children -- that falls back to
  // DEFAULT_CHILDREN on a fresh install, which would hand a free lifetime
  // licence to every brand-new download. Several signals, because a long-time
  // family might have persisted any one of them first, and wrongly charging
  // an existing user is far worse than wrongly gifting a rare edge case.
  const preExisting=!!(await DB.get('cs_children'))||!!(await DB.get('cs_familyid'))
    ||!!(await DB.get('cs_chores'))||!!(await DB.get('cs_bal_ariel'));
  if(!state.entitlement&&!state.trialStartedAt&&preExisting){
    state.entitlement={plan:'legacy',expiresAt:null,source:'grandfather'};
    await DB.set('cs_entitlement',state.entitlement);
  }
  state.calmMode=(await DB.get('cs_calm'))    ??false;
  // Bedtime game gate (parent-controlled, on by default): banked game time is
  // otherwise spendable at any hour, so a child with a full wallet could play
  // straight through bedtime. See gameBedtimeBlocked().
  state.gameBedtime=(await DB.get('cs_gamebedtime'))??true;
  // C9 (CALM-UPGRADE-PLAN): family-synced (like rewards/games), NOT device-
  // local -- which calm tools a child sees should follow them across devices.
  state.calmPrefs=(await DB.get('cs_calmprefs'))??{};
  // AN5: device-local like the parent PIN (not synced) -- each Android
  // device with the wrapper installed independently schedules its own OS
  // notification, so there's no shared "family" value to sync.
  state.choreReminder=(await DB.get('cs_chore_reminder'))??{enabled:false,hour:8,minute:0};
  state.badgeDefs=(await DB.get('cs_badgedefs'))??DEFAULT_BADGE_DEFS;
  state.events=(await DB.get('cs_events'))??[];
  state.auditLog=(await DB.get('cs_auditlog'))??[];
  state.familyId=(await DB.get('cs_familyid'))??null;
  _hwmDate=(await DB.get('cs_hwm_date'))??todayStr();
  _hwmAdvanceMono=performance.now();
  await DB.set('cs_hwm_date',_hwmDate);
  state.kid={};
}
async function loadKid(id){
  if(state.kid[id]){ ensureTodayKid(id); return state.kid[id]; }
  state.kid[id]={
    balance:  (await DB.get('cs_bal_'+id))  ??0,
    history:  (await DB.get('cs_hist_'+id)) ??[],
    daily:    (await DB.get('cs_daily_'+id))??{date:'',counts:{},lastMark:{}},
    mathDaily:(await DB.get('cs_mathd_'+id))??{date:'',done:0},
    badges:   (await DB.get('cs_badges_'+id))??[],
    mathTotal:(await DB.get('cs_matht_'+id)) ??0,
    taskTotal:(await DB.get('cs_taskt_'+id)) ??0,
    rewardsTotal:(await DB.get('cs_rwt_'+id))??0,
    // Real money the child has "cashed out" (redeemed a reward with a cash
    // value) but the parent hasn't physically paid out yet -- a running tab,
    // reset to 0 by the parent once they've actually handed over the money
    // (see renderChildrenAdmin's cash badge / adminPayOutCash()).
    cashOwed: (await DB.get('cs_cash_'+id))  ??0,
    gtime:    (await DB.get('cs_gtime_'+id)) ??0, // game-time wallet, in seconds
    mathLevel:(await DB.get('cs_mathlvl_'+id))??1, // adaptive difficulty 1..5
    learn:    (await DB.get('cs_learn_'+id)) ??{progress:{},earnedToday:{date:'',coins:0,minutes:0,sessions:0},recent:{math:[],english:[],science:[]},correctTotal:{math:0,english:0,science:0}},
    learnLevel:(await DB.get('cs_learnlvl_'+id))??{math:1,english:1,science:1}, // adaptive difficulty 1..3 per subject
  };
  ensureTodayKid(id); return state.kid[id];
}
function cur(){ return state.kid[state.current]; }
function curChild(){ return state.children.find(c=>c.id===state.current); }
function todayStr(){ const d=new Date(); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }
function ensureTodayKid(id){
  const t=effectiveToday(), k=state.kid[id]; if(!k) return;
  if(k.daily.date!==t){ k.daily={date:t,counts:{},lastMark:{}}; DB.set('cs_daily_'+id,k.daily); }
  // Devices/cloud data saved before the per-chore cooldown existed have
  // `daily` without `lastMark` -- patch it in-place rather than replacing
  // `daily` wholesale, which would wipe today's already-earned counts.
  if(!k.daily.lastMark||typeof k.daily.lastMark!=='object') k.daily.lastMark={};
  if(k.mathDaily.date!==t){ k.mathDaily={date:t,done:0}; DB.set('cs_mathd_'+id,k.mathDaily); }
  if(k.learn && k.learn.earnedToday.date!==t){ k.learn.earnedToday={date:t,coins:0,minutes:0,sessions:0}; DB.set('cs_learn_'+id,k.learn); }
}
/* ---- anti-tamper helpers ---- */
function dateToNum(str){ const a=(str||'').split('-').map(Number); return new Date(a[0]||1970,(a[1]||1)-1,a[2]||1).getTime(); }
let _hwmDate=null, _hwmAdvanceMono=-Infinity;
function effectiveToday(){
  // High-water-mark date that only moves forward: rewinding the device clock is
  // fully blocked. Jumping the clock FORWARD is clamped to +1 calendar day per
  // call, and successive forward advances must be >=90 real seconds apart
  // (measured with performance.now(), which the device date can't affect) — so
  // winding the clock ahead by weeks/years can't unlock weeks/years of daily
  // allowances in one sitting. This is a deterrent, not a cryptographic guarantee:
  // a very patient child repeating the trick every 90s could still slowly creep
  // it forward. True tamper-proofing needs a server clock, which pullFromFirebase
  // partially provides by syncing the high-water-mark itself once sync is on.
  const t=todayStr();
  if(_hwmDate==null){ _hwmDate=t; _hwmAdvanceMono=performance.now(); return t; }
  const tn=dateToNum(t), hn=dateToNum(_hwmDate);
  if(tn<=hn) return _hwmDate;
  const now=performance.now();
  if(now-_hwmAdvanceMono<90000) return _hwmDate;
  const next=new Date(hn); next.setDate(next.getDate()+1);
  _hwmDate=next.getFullYear()+'-'+(next.getMonth()+1)+'-'+next.getDate();
  _hwmAdvanceMono=now;
  DB.set('cs_hwm_date',_hwmDate);
  return _hwmDate;
}
function findTaskById(id){
  // Look up a task/action by id. Used to validate scanned/typed QR codes
  // against the real config so forged ids are rejected. Anchored (time-of-day)
  // tasks live in state.chores too (tagged with a `period`) since the
  // cs_anchored_merged_v1 migration -- there is exactly one list now.
  if(!id) return null;
  return state.chores.find(x=>x.id===id) || state.actions.find(x=>x.id===id) || null;
}

// G1 (ANDROID-APP-PLAN.md) / retroactive S3 fix: the avatar this replaces
// was a blocky pixel character hardcoded to Ariel's id, using Steve's own
// color palette almost exactly -- tan/skin-toned head, small blue square
// eyes, a flat cyan torso, blue-purple legs. That's a real Minecraft
// character-likeness risk the earlier branding cleanup (S3) missed, since it
// only searched for the literal word "Minecraft" and never looked at what
// this SVG actually drew. Replaced with a generic blocky silhouette (the
// blocky ART STYLE itself isn't anyone's IP) rendered in the CHILD'S OWN
// palette color instead of a fixed skin/cyan combination, with big round
// friendly eyes and a curved smile instead of Steve's small flat features --
// different on every axis that made the original recognizable. Also fixes a
// second bug: it was hardcoded to id==='ariel' even though themes were
// generalized to any child in V6 (see childTheme()) -- now driven by the
// actual theme like everything else.
function blockyAvatarSvg(color,opts){
  opts=opts||{};
  const mouth=opts.mouth==='open'
    ? '<ellipse cx="32" cy="23" rx="7" ry="5" fill="#3A2E1F"/>'
    : '<path d="M24,23 Q32,30 40,23" stroke="#3A2E1F" stroke-width="3" fill="none" stroke-linecap="round"/>';
  return '<svg viewBox="0 0 64 128" style="width:100%;height:100%;filter:drop-shadow(0 2px 4px rgba(0,0,0,.2));">'
    +'<rect x="14" y="2" width="36" height="32" rx="9" fill="'+color+'"/>'
    +'<circle cx="25" cy="17" r="5.5" fill="#fff"/><circle cx="39" cy="17" r="5.5" fill="#fff"/>'
    +'<circle cx="26" cy="18" r="2.6" fill="#2A2440"/><circle cx="40" cy="18" r="2.6" fill="#2A2440"/>'
    +mouth
    +'<rect x="10" y="34" width="44" height="34" rx="12" fill="#6B6585"/>'
    +'<rect x="0" y="36" width="12" height="28" rx="5" fill="#8B85A3"/>'
    +'<rect x="52" y="36" width="12" height="28" rx="5" fill="#8B85A3"/>'
    +'<rect x="16" y="68" width="14" height="30" rx="6" fill="#4A4560"/>'
    +'<rect x="34" y="68" width="14" height="30" rx="6" fill="#4A4560"/>'
    +'</svg>';
}
/* ===== BALANCE / EARN ===== */
function renderBalance(){
  const c=curChild(), k=cur();
  if(c){
    document.getElementById('psName').textContent=c.name;
    const psAv=document.getElementById('psAvatar');
    if(childTheme(c)==='blocks'){
      psAv.innerHTML=blockyAvatarSvg(c.color);
    }else{
      psAv.textContent=c.emoji;
    }
    psAv.style.background=c.color;
    document.getElementById('childName').textContent=c.name;
    const heroAv=document.getElementById('heroAv');
    if(childTheme(c)==='blocks'){
      heroAv.innerHTML=blockyAvatarSvg(c.color);
    }else{
      heroAv.textContent=c.emoji;
    }
    document.getElementById('hero').style.background='linear-gradient(140deg,'+c.color+',var(--sky))';
    const rn=document.getElementById('rwName'); if(rn) rn.textContent=c.name;
    const hn=document.getElementById('histName'); if(hn) hn.textContent=c.name;
    const sf=document.getElementById('scanFor'); if(sf) sf.textContent=c.name;
  }
  if(k){
    document.getElementById('balTop').textContent=k.balance;
    const bh=document.getElementById('balHero'); if(bh) bh.textContent=k.balance;
    const br=document.getElementById('balRewards'); if(br) br.textContent=k.balance;
    const bigCoin=document.getElementById('bigCoinIcon');
    if(bigCoin){
      bigCoin.textContent=coinPileEmoji(k.balance);
      bigCoin.classList.toggle('glowing',k.balance>=COIN_PILE_STAGES[COIN_PILE_STAGES.length-1].min);
    }
  }
  renderMascot();
}
// G4 (ANDROID-APP-PLAN.md): the balance grows through concrete visual
// stages instead of staying a flat number the whole time -- "your coins
// turned into a money bag!" means more to a 7-year-old than "62". Same
// gold circle/bob animation throughout (see .big-coin); only the glyph
// inside changes, plus a gentle glow once the top stage (the app's own
// namesake "safe") is reached.
const COIN_PILE_STAGES=[
  {min:0,   icon:'🪙'}, // a couple of loose coins
  {min:10,  icon:'👛'}, // coin purse
  {min:30,  icon:'💰'}, // money bag
  {min:80,  icon:'📦'}, // a chest
  {min:200, icon:'🏦'}, // the safe/vault itself
];
function coinPileEmoji(balance){
  let icon=COIN_PILE_STAGES[0].icon;
  for(const stage of COIN_PILE_STAGES){ if(balance>=stage.min) icon=stage.icon; }
  return icon;
}
/* ===== G1 (ANDROID-APP-PLAN.md): companion mascot =====
   A small, always-present character in the corner of every kid-facing
   screen (predictability -- same friendly face everywhere, not a one-off
   animation) that reacts when something is earned. Reuses blockyAvatarSvg
   for the 'blocks' theme so the mascot IS the child's own avatar, just
   animated; unicorn/none themes fall back to a simple emoji since there's
   no dedicated sprite for them (matches how renderBalance already treats
   those themes). */
function renderMascot(){
  const wrap=document.getElementById('mascotWrap'); if(!wrap) return;
  const c=curChild();
  if(!c||FIRSTTHEN_HIDDEN_VIEWS.includes(currentView)){ wrap.style.display='none'; return; }
  wrap.style.display='flex';
  const theme=childTheme(c);
  if(theme==='blocks') wrap.innerHTML=blockyAvatarSvg(c.color);
  else if(theme==='unicorn') wrap.textContent='🦄';
  else wrap.textContent=c.emoji||'🦊';
}
// G7 (ANDROID-APP-PLAN.md): a subtle background shift by time of day for
// temporal orientation -- separate from the blocks/unicorn theme's own
// day/night decorations (addThemeDecorations/themeBgFor), which are
// deliberately binary (day/night only) and win via !important when a theme
// IS chosen. This fills the gap for a child with no theme selected, who
// otherwise never gets any time-of-day visual cue at all. Reuses
// currentPeriodKey() (already the source of truth for the day-strip and
// anchored-task scheduling) rather than recomputing the hour boundaries.
function applyPeriodBackground(){
  const app=document.querySelector('.app'); if(!app) return;
  app.classList.remove('period-morning','period-afternoon','period-evening','period-sleep');
  // Same view gate as renderFirstThen/renderMascot -- NOT "!cur()", since
  // cur() keeps returning the previously-active kid while just VIEWING the
  // picker (switching profiles doesn't clear state.current until a new kid
  // is actually picked), which would otherwise leave the tint on there too.
  if(!cur()||FIRSTTHEN_HIDDEN_VIEWS.includes(currentView)) return;
  app.classList.add('period-'+currentPeriodKey());
}
// Called on anything earned (see addPoints) -- a brief, tasteful acknowledgment,
// not a full celebration (that's queueBadgeCelebration's job for milestones).
// The expression swap (blocks theme) happens regardless of motion settings
// since it's a static image change, not an animation; the bounce itself is
// skipped under calm mode / OS reduced-motion, same guard coinBurst() uses.
function mascotReact(){
  const wrap=document.getElementById('mascotWrap'); if(!wrap||wrap.style.display==='none') return;
  const c=curChild(); if(!c) return;
  if(childTheme(c)==='blocks'){
    wrap.innerHTML=blockyAvatarSvg(c.color,{mouth:'open'});
    setTimeout(()=>{ if(document.getElementById('mascotWrap')) renderMascot(); },900);
  }
  const reduceMotion=window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(!reduceMotion && !state.calmMode){
    wrap.classList.remove('mascot-bounce'); void wrap.offsetWidth; wrap.classList.add('mascot-bounce');
    setTimeout(()=>wrap.classList.remove('mascot-bounce'),700);
  }
}
// srcEl (optional): the button/element the child actually tapped to earn
// this. When given, a single coin visibly flies from there to the balance
// pill instead of the generic full-screen burst -- ties the reward directly
// to the action that caused it (DESIGN-IMPROVEMENTS.md V4).
async function addPoints(n,label,type,srcEl){
  // Snapshot the rect NOW, synchronously, before any awaits below -- a
  // caller's own re-render (e.g. mathCheck -> newProblem()) can run before
  // this function resumes and would detach srcEl otherwise (see coinFly()).
  const srcRect=srcEl?srcEl.getBoundingClientRect():null;
  const id=state.current, k=cur();
  if(!Number.isFinite(n)) return;
  k.balance=Math.max(0,Math.min(1000000,Math.round(k.balance+n)));
  k.history.unshift({ts:Date.now(),label,points:n,type});
  if(k.history.length>120) k.history.pop();
  await DB.set('cs_bal_'+id,k.balance);
  await DB.set('cs_hist_'+id,k.history);
  if(type==='spend'){ k.rewardsTotal=(k.rewardsTotal||0)+1; await DB.set('cs_rwt_'+id,k.rewardsTotal); }
  renderBalance();
  if(srcRect && n>0) coinFly(srcRect); else coinBurst();
  // A completed real-world task (scan) gets its OWN recognizable chime+buzz,
  // distinct from math/learning's plain earn tone -- "I actually did the
  // chore" is a bigger, more physical moment than answering a question, and
  // a consistent, distinctive anchor for it helps it register as a habit.
  chime(type==='spend'?true:type==='scan'?'scan':false);
  if(n>0){
    mascotReact(); // G1: the companion reacts to something earned, not to a purchase
    // G8 (ANDROID-APP-PLAN.md): one short, gentle pulse on anything earned
    // (chore marked, correct answer -- both route through here). Skipped in
    // calm mode, same as every other sensory-intensity dial in the app; not
    // given its own separate settings toggle since the OS already lets a
    // parent disable vibration device-wide if calm mode isn't enough.
    if(!state.calmMode&&navigator.vibrate){
      try{ navigator.vibrate(type==='scan'?[25,60,25]:20); }catch(e){}
    }
  }
  scheduleSync();
  checkBadges();
}

/* ===== NAV ===== */
let currentView='picker';
let clockInterval=null;
// The splash screen (index.html) is rendered straight from HTML before any
// JS runs, covering the async detectBackend/loadState/auth bootstrap. The
// very first real navigation is the right moment to remove it -- by then
// SOME view is genuinely ready to show, whichever branch of the bootstrap
// got there (welcome, picker, or straight to a child's home). A hard
// setTimeout fallback in index.html itself covers the case where startup
// throws before go() is ever reached.
let _splashHidden=false;
function hideSplash(){
  if(_splashHidden) return; _splashHidden=true;
  const s=document.getElementById('splash'); if(!s) return;
  s.style.opacity='0';
  setTimeout(()=>s.remove(),300);
}
// AN6 (ANDROID-APP-PLAN.md): keeps the screen from timing out mid-question
// or mid-game -- a child who reads slower than the OS's default screen
// timeout assumes shouldn't lose their place because the phone went dark.
// No-op in a plain browser (window.CoinQuestNative doesn't exist there).
function updateKeepScreenOn(){
  if(window.CoinQuestNative&&typeof window.CoinQuestNative.keepScreenOn==='function'){
    try{ window.CoinQuestNative.keepScreenOn(currentView==='learn'||!!_gt); }catch(e){}
  }
}
function go(v){
  hideSplash();
  stopSpeaking();
  if(currentView==='scan' && v!=='scan') stopCamera();
  if((v!=='picker'&&v!=='admin'&&v!=='welcome') && !cur()){ v='picker'; }
  currentView=v;
  document.querySelectorAll('.view').forEach(el=>el.classList.remove('active'));
  const target=document.getElementById('view-'+v);
  if(target){
    target.classList.add('active');
  }else{
    // Unknown/missing view id: never leave the screen with nothing active —
    // fall back to the welcome view rather than a blank page.
    console.error('go(): no such view', v);
    currentView='welcome';
    const fallback=document.getElementById('view-welcome');
    if(fallback) fallback.classList.add('active');
  }
  document.querySelectorAll('.navbtn').forEach(b=>b.classList.toggle('active', b.dataset.nav===v));
  const onPicker=(v==='picker'||v==='welcome');
  document.getElementById('profileSwitch').style.visibility=onPicker?'hidden':'visible';
  document.getElementById('balPill').style.visibility=onPicker?'hidden':'visible';
  document.getElementById('breakBtn').style.visibility=onPicker?'hidden':'visible';
  document.getElementById('bottomnav').style.display=(onPicker||v==='admin'||v==='streak'||v==='badges')?'none':'flex';
  window.scrollTo(0,0);
  // The schedule (day-strip/first-then/anchored chores) derives its period
  // from the clock at render time — without a periodic refresh, a child who
  // leaves the home view open across a period boundary (e.g. morning->
  // afternoon) or the sleep-time threshold keeps seeing the stale period
  // until they navigate away and back or complete a chore.
  clearInterval(clockInterval); clockInterval=null;
  if(v==='picker') renderPicker();
  if(v==='home'){
    renderChores(); renderStreakBanner(); renderGameTimeBanner(); renderEventsHome(); renderDayStrip(); renderBadgesBanner(); renderRequiredTaskAlert();
    maybeShowDailyGreeting();
  }
  renderFirstThen(); // A1: now runs for every view renderFirstThen() itself allows, not just home
  renderMascot(); // G1: same "which views" rule as the strip above (reuses FIRSTTHEN_HIDDEN_VIEWS)
  renderJourneyMap(); // G2: home-only (renderChores() also calls this, but only runs FOR home -- this call is what actually clears it when navigating AWAY from home)
  applyPeriodBackground(); // G7: same "kid-facing screens only" scope as the strip/mascot above
  // A1: the schedule-refresh interval used to only run on the home view --
  // now it follows the child to any screen (still only ever re-renders
  // home-specific elements like the chore list if home is what's actually
  // showing), so the "now -> then" strip stays correct even if a child
  // spends a while on e.g. the math screen across a period boundary.
  if(childUsesSchedule(curChild())&&!FIRSTTHEN_HIDDEN_VIEWS.includes(v)){
    clockInterval=setInterval(()=>{
      if(currentView==='home'){ renderChores(); renderDayStrip(); renderRequiredTaskAlert(); }
      renderFirstThen();
      // Catch the day->night decoration switch across the sleep-time
      // boundary, same cadence as the schedule refresh above.
      if(document.querySelector('.app').classList.contains('blocks-mode')) addThemeDecorations('blocks');
      applyPeriodBackground(); // G7: same period-boundary catch, for the non-themed background
    },45000);
  }
  if(v==='scan'){ startCamera(); applyScanIntentHint(); }
  if(v==='math') initMath();
  if(v==='chat') initChatView();
  if(v==='rewards') renderRewards();
  if(v==='history') renderHistory();
  if(v==='streak') renderStreakView();
  if(v==='badges') renderBadgesView();
  if(v==='games') renderGamesView();
  if(v==='learn') initLearningView();
  updateKeepScreenOn();
}
// Gated navigation: used by the home tiles and bottom nav so a locked screen
// explains itself instead of opening empty. Kept separate from go() itself --
// go() is also called internally (restore-on-launch, post-purchase refresh)
// where a paywall would be wrong.
const VIEW_FEATURE={games:'games',learn:'learning',streak:'streaks',badges:'badges'};
function goGated(v){
  const f=VIEW_FEATURE[v];
  if(f&&!gate(f)) return;
  go(v);
}
// Self-heal: if something upstream (a thrown error mid-render, a race
// between two go() calls, etc.) ever leaves zero .view elements with
// class="active", fall back to view-welcome with a visible error rather
// than a blank screen. Call this from any catch-all error handler.
function ensureActiveView(){
  if(!document.querySelector('.view.active')){
    console.error('ensureActiveView: no active view, self-healing to welcome');
    go('welcome');
    const el=document.getElementById('welcomeStatus');
    if(el) el.textContent='משהו השתבש. נסה להתחבר שוב.';
  }
}

/* ===== PROFILE PICKER ===== */
function renderPicker(){
  const c=document.getElementById('pickerCards'); c.innerHTML='';
  state.children.forEach(ch=>{
    const card=document.createElement('button');
    card.className='kid-card'; card.style.setProperty('--kc',ch.color);
    // Was a hardcoded id==='ariel' pixel figure using Minecraft-Steve's exact
    // palette (tan head, blue square eyes, cyan torso) AND a sword -- the same
    // character-likeness risk G1 removed everywhere else but missed here. Now
    // driven by the child's theme like every other avatar in the app: the
    // generic blocky silhouette in the child's OWN color for the 'blocks'
    // theme, plain emoji otherwise.
    if(childTheme(ch)==='blocks'){
      card.innerHTML=`<div class="kc-av" style="display:flex;align-items:center;justify-content:center;"><div style="width:74px;height:100%;">${blockyAvatarSvg(ch.color)}</div></div><div class="kc-name">${esc(ch.name)}</div><div class="kc-bal">🪙 <span data-bal="${ch.id}">…</span></div>`;
    }else{
      card.innerHTML=`<div class="kc-av">${ch.emoji}</div><div class="kc-name">${esc(ch.name)}</div><div class="kc-bal">🪙 <span data-bal="${ch.id}">…</span></div>`;
    }
    card.onclick=()=>selectChild(ch.id);
    c.appendChild(card);
    DB.get('cs_bal_'+ch.id).then(b=>{ const el=card.querySelector('[data-bal]'); if(el) el.textContent=(b??0); });
  });
}
async function selectChild(id){
  state.current=id; await DB.set('cs_current',id);
  await loadKid(id); renderBalance(); go('home');
  applyChildTheme(id);
}
// Generalized per-child visual theme (V6): each child can have their own
// world instead of only Ariel getting one. `theme` is looked up via
// childTheme() (falls back to the original hardcoded ariel=blocks/
// noa=unicorn/other=none for children saved before this field existed).
// Kept as one dispatcher so every call site (selectChild, child deletion,
// sign-in restore, cold-start restore) goes through the same logic instead
// of five copies of an if/else.
function applyChildTheme(id){
  const app=document.querySelector('.app');
  const ch=state.children.find(c=>c.id===id);
  const theme=childTheme(ch);
  app.classList.toggle('blocks-mode',theme==='blocks');
  app.classList.toggle('unicorn-mode',theme==='unicorn');
  if(theme==='none'){ removeThemeDecorations(); return; }
  addThemeDecorations(theme);
}
// Living background instead of a static image/nothing: for blocks-mode,
// slow pixel clouds drifting across a sky, a grass/dirt strip along the
// bottom, and a night palette (dark sky + moon + fixed stars, no drifting)
// once the child's own configured sleep time hits -- reusing
// currentPeriodKey()'s existing day/sleep logic rather than re-deriving it.
// unicorn-mode gets a lighter pastel-cloud/twinkling-star version, no night
// palette (kept simple -- see DESIGN-IMPROVEMENTS.md V6). Motion is
// intentionally very slow (90-120s per pass) so it reads as ambient, not
// distracting; it's fully killed by both calm mode and prefers-reduced-motion
// (see the `body.calm-mode #theme-deco *` rule in styles.css -- the global
// reduced-motion media query already covers this element via its universal
// selector).
function addThemeDecorations(theme){
  const isNight=theme==='blocks'&&currentPeriodKey()==='sleep';
  let deco=document.getElementById('theme-deco');
  if(deco && deco.dataset.theme===theme && deco.dataset.night===String(isNight)) return; // already correct, don't restart animations
  if(deco) deco.remove();
  deco=document.createElement('div');
  deco.id='theme-deco';
  deco.dataset.theme=theme;
  deco.dataset.night=String(isNight);
  // Absolutely positioned INSIDE .app (not document.body): .app itself has
  // an opaque !important background in theme mode and is full-width on a
  // phone screen, so a body-level layer behind it would never be visible on
  // the actual target device. Prepended as .app's first child so later
  // siblings (topbar/main/bottomnav, none of which set z-index) paint over it
  // purely by source order -- no z-index juggling needed.
  deco.style.cssText='position:absolute;inset:0;pointer-events:none;overflow:hidden;transition:background 1.5s;background:'+themeBgFor(theme,isNight)+';';
  if(theme==='blocks'){
    const cloud=(top,scale,dur,delay)=>`<div class="mc-cloud" style="top:${top}%;animation-duration:${dur}s;animation-delay:${delay}s;transform:scale(${scale});"></div>`;
    const star=(l,t)=>`<div class="mc-star" style="left:${l}%;top:${t}%;"></div>`;
    deco.innerHTML = isNight
      ? `<div class="mc-moon"></div>`+Array.from({length:18},(_, i)=>star((i*53.7)%100,(i*29.3)%60)).join('')+`<div class="mc-ground"></div>`
      : cloud(8,1,95,0)+cloud(18,.7,120,-30)+cloud(30,.85,110,-60)+`<div class="mc-ground"></div>`;
  }else if(theme==='unicorn'){
    const cloud=(top,scale,dur,delay)=>`<div class="uni-cloud" style="top:${top}%;animation-duration:${dur}s;animation-delay:${delay}s;transform:scale(${scale});"></div>`;
    const star=(l,t,d)=>`<div class="uni-star" style="left:${l}%;top:${t}%;animation-delay:${d}s;">${d%2?'✨':'⭐'}</div>`;
    deco.innerHTML = cloud(10,1,100,0)+cloud(22,.75,125,-40)+cloud(34,.9,115,-70)
      +Array.from({length:10},(_, i)=>star((i*37.3)%100,(i*17.7)%50,i)).join('');
  }
  const app=document.querySelector('.app');
  app.insertBefore(deco,app.firstChild);
}
function themeBgFor(theme,isNight){
  if(theme==='blocks') return isNight?'linear-gradient(180deg,#0B1130,#1B2550)':'linear-gradient(180deg,#87CEEB,#E0F6FF)';
  if(theme==='unicorn') return 'linear-gradient(180deg,#FFE3F3,#F3E9FF)';
  return 'transparent';
}
function removeThemeDecorations(){
  const deco=document.getElementById('theme-deco');
  if(deco) deco.remove();
}

/* ===== SCANNER ===== */
let stream=null, scanning=false;
// Set by goScanForChore() so the scan screen can tell the child exactly which
// task's code it's expecting, instead of a generic "aim the code" hint --
// cleared by openScan() (the plain scan nav/big-button entry points) so a
// stale hint from a previous chore doesn't linger once the child navigates to
// the scanner directly rather than via a specific chore tap.
let _scanIntentTaskId=null;
function openScan(){ _scanIntentTaskId=null; go('scan'); }
function applyScanIntentHint(){
  const hintEl=document.getElementById('scanHint'); if(!hintEl) return;
  const t=_scanIntentTaskId&&findTaskById(_scanIntentTaskId);
  hintEl.textContent=t?('סרוק את קוד ה-QR של: '+t.label+' '+(t.emoji||'')):'כוון את הקוד לתוך הריבוע';
}
const video=document.getElementById('scanVideo'), canvas=document.getElementById('scanCanvas');
async function startCamera(){
  const fb=document.getElementById('scanFallback'),fr=document.getElementById('scanFrame'),ln=document.getElementById('scanLine'),hi=document.getElementById('scanHint');
  let lastErr=null;
  try{
    // ideal (not exact) facingMode: an exact 'environment' constraint throws
    // OverconstrainedError outright on devices without a labeled back camera.
    // Higher ideal resolution helps jsQR decode small/far codes.
    try{
      stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}}});
    }catch(e1){
      lastErr=e1;
      // Second chance with the loosest possible constraint — some WebViews
      // and older devices reject anything more specific.
      stream=await navigator.mediaDevices.getUserMedia({video:true});
    }
    // Continuous autofocus where the hardware supports it — without this,
    // some phones lock focus at arm's length and the QR stays blurry forever.
    try{
      const track=stream.getVideoTracks()[0];
      const caps=track.getCapabilities?track.getCapabilities():{};
      if(caps.focusMode&&caps.focusMode.includes('continuous')){
        await track.applyConstraints({advanced:[{focusMode:'continuous'}]});
      }
    }catch(e){}
    video.srcObject=stream; await video.play();
    video.style.display='';fb.style.display='none';fr.style.display='';ln.style.display='';hi.style.display='';
    scanning=true; requestAnimationFrame(scanTick);
  }catch(e){
    lastErr=e;
    video.style.display='none';fb.style.display='block';fr.style.display='none';ln.style.display='none';hi.style.display='none';
    // Say WHY and offer a retry — "gallery only" with no explanation left the
    // parent unable to tell a denied permission from a missing camera.
    const detail=document.getElementById('scanFailDetail');
    if(detail){
      const code=lastErr&&lastErr.name||'';
      detail.textContent=code==='NotAllowedError'
        ? 'ההרשאה למצלמה נדחתה — אשר גישה למצלמה בהגדרות הדפדפן/האפליקציה ונסה שוב'
        : code==='NotFoundError' ? 'לא נמצאה מצלמה במכשיר הזה'
        : 'שגיאת מצלמה: '+(code||lastErr&&lastErr.message||'לא ידועה');
    }
  }
}
function stopCamera(){ scanning=false; if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; } }
function scanTick(){
  if(!scanning) return;
  if(video.readyState===video.HAVE_ENOUGH_DATA){
    const ctx=canvas.getContext('2d');
    canvas.width=video.videoWidth; canvas.height=video.videoHeight;
    ctx.drawImage(video,0,0,canvas.width,canvas.height);
    try{ const img=ctx.getImageData(0,0,canvas.width,canvas.height);
      const code=jsQR(img.data,img.width,img.height,{inversionAttempts:'dontInvert'});
      if(code&&code.data){ scanning=false; redeemToken(code.data); return; }
    }catch(e){}
  }
  requestAnimationFrame(scanTick);
}
document.getElementById('photoInput').addEventListener('change',e=>{
  const f=e.target.files[0]; if(!f) return;
  const img=new Image();
  img.onload=()=>{ const ctx=canvas.getContext('2d'); canvas.width=img.width; canvas.height=img.height; ctx.drawImage(img,0,0);
    const d=ctx.getImageData(0,0,canvas.width,canvas.height); const code=jsQR(d.data,d.width,d.height);
    if(code&&code.data) redeemToken(code.data); else toast('לא מצאתי קוד בתמונה 🔍'); URL.revokeObjectURL(img.src); };
  img.src=URL.createObjectURL(f); e.target.value='';
});
function toggleManual(){ const b=document.getElementById('manualBox'); b.style.display=b.style.display==='flex'?'none':'flex'; }
function redeemToken(raw){
  raw=(raw||'').trim();
  // Manual typing: accept the bare task id (what the QR screen now shows as
  // "הקוד להקלדה ידנית") — typing CSQR|chore_xyz by hand was never realistic.
  if(raw&&!raw.includes('|')&&findTaskById(raw)) raw='CSQR|'+raw;
  const p=raw.split('|');
  // Streak reward QR — claiming the prize is a parent-confirmed moment just like
  // marking a clean day, so it goes through the same PIN gate. The displayed
  // prize name/emoji always comes from the admin-configured streak settings,
  // never from the scanned token, so a hand-typed code can't spoof what was won.
  if(p[0]==='CSSTREAK'){
    stopCamera();
    const s=getStreak(p[1]);
    if(!s){ modalMsg('🤔','הקוד לא תקין','הקוד הזה לא שייך לאף אתגר קיים.'); return; }
    if(!curChild()||curChild().id!==s.childId){ modalMsg('🤔','לא מתאים','הפרס הזה לא משויך לפרופיל הזה.'); return; }
    if(s.current<s.goal){
      modalMsg('⏳','עוד לא הגעת ליעד!','השלמת '+s.current+' מתוך '+s.goal+' ימים. תמשיך להתאמץ! 💪');
      return;
    }
    modalPin(()=>{
      if(!s.wonAt) s.wonAt=Date.now();
      DB.set('cs_streaks',state.streaks);
      modalMsg(s.rewardEmoji,'🏆 הגיע הזמן לפרס!','השלמת '+s.goal+' ימים ברצף של '+s.title+'!\nהפרס שלך: '+s.rewardLabel+' '+s.rewardEmoji+'\nכל הכבוד!');
      coinBurst();
    });
    return;
  }
  // Regular task/action QR — validate the id against the real config (anti-forgery).
  // Points and daily-max come from the stored task, NOT from the scanned text, so a
  // hand-typed or edited code can't grant extra coins or raise its own limit.
  if(p[0]!=='CSQR'||p.length<2){ toast('הקוד לא תקין 🤔'); if(currentView==='scan'&&stream){ scanning=true; requestAnimationFrame(scanTick);} return; }
  const id=p[1];
  const task=findTaskById(id);
  if(!task){ stopCamera(); modalMsg('🤔','הקוד לא מתאים','הקוד הזה לא שייך לאף מטלה אמיתית.\nבקש מאמא או אבא קוד נכון.'); return; }
  if(!taskForChild(task,state.current)){ stopCamera(); modalMsg('🤔','לא המטלה שלך','המטלה הזאת שייכת לילד אחר במשפחה.'); return; }
  const label=task.label, pts=task.points, maxd=task.max;
  const k=cur(); ensureTodayKid(state.current);
  const used=k.daily.counts[id]||0;
  if(used>=maxd){ stopCamera(); modalMsg('🌟','כל הכבוד!','כבר השלמת את "'+label+'" '+maxd+' פעמים היום. נסה שוב מחר!'); return; }
  // Same friction floor as the daily-max check above: without it, re-scanning
  // the same code repeatedly banks a whole day's max in seconds for a task
  // never actually redone. Chores are now earned ONLY through this function
  // (see goScanForChore()) — there is no separate self-report tap-to-credit
  // path anymore, so this guard is the single anti-spam authority.
  const lastMark=k.daily.lastMark[id]||0;
  // A task allowed several times a day (max>1) can optionally set its own
  // real-world spacing (minGapMin) instead of the 1-minute anti-spam floor --
  // e.g. "sit on the toilet" allowed 3x/evening shouldn't credit twice for one
  // continuous bathroom visit a minute apart, so the parent can require a
  // real gap like 30 minutes between redemptions of that specific task.
  const gapMs=task.minGapMin>0?task.minGapMin*60000:CHORE_MIN_GAP_MS;
  if(Date.now()-lastMark<gapMs){
    stopCamera();
    const waitMsg=task.minGapMin>0?('אפשר לסמן את "'+label+'" שוב עוד '+task.minGapMin+' דקות 🙂'):('אפשר לסמן את "'+label+'" שוב עוד דקה 🙂');
    modalMsg('⏳','רגע קטן...',waitMsg); return;
  }
  k.daily.counts[id]=used+1; k.daily.lastMark[id]=Date.now(); DB.set('cs_daily_'+state.current,k.daily);
  k.taskTotal=(k.taskTotal||0)+1; DB.set('cs_taskt_'+state.current,k.taskTotal);
  stopCamera();
  addPoints(pts,label,'scan');
  renderFirstThen(); renderDayStrip();
  const emoji=task.emoji||'⭐';
  modalMsg('🎉','+'+pts+' מטבעות!','השלמת: '+label+' '+emoji);
}

/* ===== MATH ===== */
let mathCur=null, mathStr='';
function initMath(){
  ensureTodayKid(state.current);
  if(!state.math.enabled||state.math.ops.length===0){
    document.getElementById('mathDisabled').style.display='block';
    document.getElementById('mathActive').style.display='none'; return;
  }
  document.getElementById('mathDisabled').style.display='none';
  document.getElementById('mathActive').style.display='block';
  document.getElementById('mathTarget').textContent=state.math.daily;
  _mathStreak=0; // fresh per session/child, so one kid's run doesn't carry to another
  _mathCapModalShown=false; // re-announce the cap once per visit, not once per answer
  newProblem();
}
// Adaptive difficulty: the parent's maxNum is the CEILING; each child works up
// to it through 5 levels based on their own recent accuracy, so a quick solver
// gets harder problems and a struggling one isn't stuck failing. Level rises
// after 4 correct in a row, eases after 2 wrong in a row (tracked in
// _mathStreak), and persists per kid in cs_mathlvl_<id>.
let _mathStreak=0; // >0 = consecutive correct, <0 = consecutive wrong
let _mathCapModalShown=false; // see initMath()/mathCheck() -- one blocking modal per visit, then quiet toasts
function effectiveMaxNum(){
  const k=cur(); const tier=childMathTier(curChild());
  // The age band is the ceiling when there is one; otherwise the legacy
  // family-wide number (see childMathTier for why both paths exist).
  const N=tier?tier.maxNum:state.math.maxNum;
  const lvl=Math.max(1,Math.min(5,(k&&k.mathLevel)||1));
  // level 5 == the full band ceiling; lower levels use a fraction. Floor of 3
  // (not 5) so the youngest band can actually start below its own ceiling.
  return Math.max(3,Math.round(N*lvl/5));
}
// Which operations this child may actually get. The parent's global op chips
// still apply, but they can only ever NARROW the age band -- enabling ÷
// family-wide must not start handing division to a six-year-old. If the
// intersection is empty (parent enabled only ops the band forbids), the band
// wins, because a child with no solvable operations has a broken screen.
function effectiveMathOps(){
  const tier=childMathTier(curChild());
  if(!tier) return state.math.ops;
  const allowed=state.math.ops.filter(o=>tier.ops.includes(o));
  return allowed.length?allowed:tier.ops;
}
// A5 (ANDROID-APP-PLAN.md): silent in both directions, same reasoning as
// bumpLearningLevel above -- an announced level change turns an invisible
// difficulty knob into something the child can fixate on.
async function bumpMathLevel(dir){
  const k=cur(); if(!k) return;
  const next=Math.max(1,Math.min(5,(k.mathLevel||1)+dir));
  if(next!==k.mathLevel){
    k.mathLevel=next;
    await DB.set('cs_mathlvl_'+state.current,next);
  }
}
function newProblem(){
  const ops=effectiveMathOps(), op=ops[Math.floor(Math.random()*ops.length)]; let a,b,ans; const N=effectiveMaxNum();
  if(op==='+'){ a=rnd(0,N); b=rnd(0,N); ans=a+b; }
  else if(op==='-'){ a=rnd(0,N); b=rnd(0,a); ans=a-b; }
  else if(op==='×'){ const M=Math.min(12,Math.max(2,Math.floor(N/2))); a=rnd(2,M); b=rnd(2,M); ans=a*b; }
  else { b=rnd(2,Math.min(10,Math.max(2,Math.floor(N/2)))); ans=rnd(2,10); a=b*ans; }
  mathCur={op,a,b,ans}; mathStr='';
  document.getElementById('mathQ').textContent=a+' '+op+' '+b;
  document.getElementById('mathAns').value=''; updateMathProgress();
}
function rnd(lo,hi){ return Math.floor(Math.random()*(hi-lo+1))+lo; }
function mathKey(k){ if(k==='del') mathStr=mathStr.slice(0,-1); else if(mathStr.length<4) mathStr+=k; document.getElementById('mathAns').value=mathStr; }
function mathCheck(){
  if(mathStr==='') return;
  const k=cur();
  if(parseInt(mathStr)===mathCur.ans){
    // adaptive: 4 correct in a row -> level up
    _mathStreak=_mathStreak>0?_mathStreak+1:1;
    if(_mathStreak>=4){ bumpMathLevel(1); _mathStreak=0; }
    if(k.mathDaily.done>=state.math.daily){
      // Practicing past the daily coin cap is welcome -- but a BLOCKING modal
      // on every single extra correct answer punished exactly that. Say it
      // once per visit, then stay out of the way with a light toast.
      if(_mathCapModalShown) toast('נכון! ✓ (סיימת את המזכים להיום)');
      else { _mathCapModalShown=true; modalMsg('🏆','סיימת להיום!','פתרת את כל '+state.math.daily+' התרגילים המזכים. כל הכבוד!\nאפשר להמשיך להתאמן בכיף 😊'); }
      newProblem(); return;
    }
    k.mathDaily.done++; DB.set('cs_mathd_'+state.current,k.mathDaily);
    k.mathTotal=(k.mathTotal||0)+1; DB.set('cs_matht_'+state.current,k.mathTotal);
    addPoints(state.math.pts,'תרגיל חשבון','math',document.querySelector('.key.ok'));
    toast('נכון! +'+state.math.pts+' 🪙');
    if(k.mathDaily.done>=state.math.daily){ _mathCapModalShown=true; setTimeout(()=>modalMsg('🏆','כל הכבוד!','סיימת את כל התרגילים המזכים להיום!'),300); }
    newProblem();
  }else{
    // adaptive: 2 wrong in a row -> ease down so the child isn't stuck failing
    _mathStreak=_mathStreak<0?_mathStreak-1:-1;
    if(_mathStreak<=-2){ bumpMathLevel(-1); _mathStreak=0; }
    document.getElementById('mathAns').style.borderColor='var(--coral)'; toast('כמעט! נסה שוב 💪');
    mathStr=''; document.getElementById('mathAns').value='';
    setTimeout(()=>document.getElementById('mathAns').style.borderColor='',600);
  }
}
function updateMathProgress(){ const k=cur(); const d=k.mathDaily.done, t=state.math.daily;
  document.getElementById('mathDone').textContent=d; document.getElementById('mathFill').style.width=Math.min(100,(d/t)*100)+'%'; }

/* ===== LEARNING QUIZ ("מכרה הידע") ===== */
// Spaced-repetition boxes (Leitner, simplified): box 1 = due again tomorrow,
// box 4 = mastered (due again in a month). Wrong answer always resets to box 1
// so mistakes get seen again soon; right answer promotes one box at a time.
const LEARN_BOX_DAYS=[1,1,3,7,30]; // index by box (1..4); index 0 unused
function learnDueDays(box){ return LEARN_BOX_DAYS[Math.max(1,Math.min(4,box))]; }
function daysBetween(a,b){ return Math.round((dateToNum(b)-dateToNum(a))/86400000); }

let learnSession=null; // {questions:[], idx, correctCount, subjectFilter}
// Called on entering the learn view: reset to the pre-session state (fresh
// "start" button) so leaving mid-session and coming back doesn't show a stale
// question screen from a session that was abandoned.
function initLearningView(){
  learnSession=null;
  document.getElementById('learnActive').style.display='none';
  document.getElementById('learnSummary').style.display='none';
  const k=cur();
  const capped=k && k.learn.earnedToday.coins>=state.learning.dailyMaxCoins;
  document.getElementById('learnDisabled').style.display=capped?'':'none';
  document.getElementById('learnDisabled').innerHTML='<div class="empty"><span class="e-ic">😴</span>המכרה נסגר להיום! ⛏️😴<br>חזור מחר לעוד סיבוב.</div>';
  document.getElementById('learnStartBtn').style.display=capped?'none':'';
  renderLearnToolBar();
}
// Purely cosmetic progression (DESIGN-IMPROVEMENTS.md V7) -- driven by total
// correct answers across all subjects ever, never affects coins/minutes.
const LEARN_TOOLS=[
  {min:0,   emoji:'🪵',label:'מכוש עץ'},
  {min:25,  emoji:'🪨',label:'מכוש אבן'},
  {min:75,  emoji:'⚙️',label:'מכוש ברזל'},
  {min:150, emoji:'✨',label:'מכוש זהב'},
  {min:300, emoji:'💎',label:'מכוש יהלום'},
];
function currentTool(k){
  const total=Object.values((k&&k.learn&&k.learn.correctTotal)||{}).reduce((a,b)=>a+b,0);
  let idx=0;
  for(let i=0;i<LEARN_TOOLS.length;i++) if(total>=LEARN_TOOLS[i].min) idx=i;
  const cur=LEARN_TOOLS[idx], next=LEARN_TOOLS[idx+1];
  return {total,cur,next};
}
function renderLearnToolBar(){
  const el=document.getElementById('learnToolBar'); if(!el) return;
  const k=cur(); if(!k){ el.innerHTML=''; return; }
  const {total,cur:tool,next}=currentTool(k);
  if(!next){
    el.innerHTML=`<span class="tb-ic">${tool.emoji}</span><div class="tb-info"><div class="tb-lbl">${tool.label} — הכלי הכי טוב!</div><div class="tb-next">${total} תשובות נכונות בסה״כ</div></div>`;
    return;
  }
  const span=next.min-tool.min, pct=Math.min(100,Math.round((total-tool.min)/span*100));
  el.innerHTML=`<span class="tb-ic">${tool.emoji}</span><div class="tb-info"><div class="tb-lbl">${tool.label}</div><div class="tb-bar"><div class="tb-fill" style="width:${pct}%"></div></div><div class="tb-next">עוד ${next.min-total} תשובות נכונות ל${next.label} ${next.emoji}</div></div>`;
}

function subjectQuestionPool(subj){
  const custom=(state.learning.customQuestions||[]).filter(q=>q.subject===subj);
  return QUESTION_BANK.filter(q=>q.subject===subj).concat(custom);
}
// Picks 5 questions for a session: due-for-review questions first (by box
// schedule), then never-seen questions, restricted to the child's current
// level (and one level below, so review items don't vanish on level-up) for
// each enabled subject.
function pickSessionQuestions(){
  const k=cur(); if(!k) return [];
  const today=effectiveToday();
  const enabled=Object.keys(state.learning.subjects).filter(s=>state.learning.subjects[s]);
  let pool=[];
  enabled.forEach(subj=>{
    const lvl=(k.learnLevel&&k.learnLevel[subj])||1;
    pool=pool.concat(subjectQuestionPool(subj).filter(q=>q.level<=lvl));
  });
  const seenToday=new Set(); // avoid repeating the same question twice in one session
  const due=[], fresh=[];
  pool.forEach(q=>{
    const p=k.learn.progress[q.id];
    if(!p){ fresh.push(q); return; }
    const dueDays=learnDueDays(p.box);
    if(daysBetween(p.lastSeen,today)>=dueDays) due.push(q);
  });
  shuffleArr(due); shuffleArr(fresh);
  const picked=[];
  for(const q of due.concat(fresh)){
    if(picked.length>=5) break;
    if(seenToday.has(q.id)) continue;
    seenToday.add(q.id); picked.push(q);
  }
  return picked;
}
function shuffleArr(a){ for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

/* ---- read-aloud (TTS) for learning questions/answers ----
   The target child can't read Hebrew fluently and can't read English at all,
   so a quiz that's just text on screen is unusable to them without a parent
   narrating every question by hand. This speaks the question (word-by-word
   highlighted, via the SpeechSynthesisUtterance `boundary` event) and then
   each answer choice in turn (whole-button highlight, English words spoken
   with an English voice so they're pronounced correctly instead of read as
   Hebrew). Purely an accessibility aid: never touches scoring/crediting. */
const WEB_TTS_SUPPORTED=typeof window!=='undefined'&&'speechSynthesis' in window;
// AN1 (ANDROID-APP-PLAN.md): inside the Android WebView, a Hebrew voice for
// speechSynthesis depends on whatever voice pack happens to be installed and
// is often simply missing -- android/NativeGameBridge.kt exposes Android's
// own TextToSpeech engine instead, which is far more reliably available.
// Checked fresh each call (not cached) since the native engine's init is
// async and may not have finished yet the very first time this is checked.
function nativeTtsAvailable(){
  return !!(window.CoinQuestNative && typeof window.CoinQuestNative.ttsAvailable==='function' && window.CoinQuestNative.ttsAvailable());
}
function ttsEnabled(){ return (WEB_TTS_SUPPORTED||nativeTtsAvailable()) && state.learning.readAloud!==false; }
// Emoji are a purely visual icon vocabulary in this app's UI text (see A8) --
// reading "balloon emoji" or "raised fist emoji" out loud is just noise for a
// sighted child, not an accessibility need, so every TTS entry point strips
// them before speaking. \p{Extended_Pictographic} covers the individual
// symbols; U+FE0F (variation selector) and U+200D (ZWJ, glues multi-part
// sequences together) are stripped alongside it since they're not
// pictographic themselves but only ever appear attached to one.
const EMOJI_RE=/\p{Extended_Pictographic}|\uFE0F|\u200D/gu;
function stripEmojiForSpeech(text){
  return (text||'').replace(EMOJI_RE,'').replace(/\s+/g,' ').trim();
}
// Bumped by stopSpeaking() and by every new speakWithHighlight() call. A
// cancelled/interrupted utterance's `error` event still fires and would
// otherwise call finish()->onEnd, which for the question->choices chain
// means "answer clicked mid-narration" kept right on talking (cancel()
// doesn't stop a chain, only the current utterance) -- verified live: after
// calling stopSpeaking(), speechSynthesis.speaking was still true because the
// interrupted utterance's onerror advanced to the next queued step. Each
// call captures the generation at its own start; finish() only invokes onEnd
// if nothing newer (another stopSpeaking() or speak) has superseded it.
let _ttsGen=0;
function stopSpeaking(){
  _ttsGen++;
  if(window.CoinQuestNative&&typeof window.CoinQuestNative.ttsStop==='function'){ try{ window.CoinQuestNative.ttsStop(); }catch(e){} }
  if(WEB_TTS_SUPPORTED){ try{ speechSynthesis.cancel(); }catch(e){} }
}
function isLatinText(s){ return /^[A-Za-z]/.test((s||'').trim()); }
// Shared by both the native and Web Speech paths below: finds and highlights
// the .tts-word span containing charIndex (or the last word started so far,
// if charIndex lands inside a gap between words).
function highlightWordAt(el,words,charIndex){
  if(!el) return;
  let idx=words.findIndex(w=>charIndex>=w.start&&charIndex<w.end);
  if(idx<0) idx=words.reduce((best,w,i)=>w.start<=charIndex?i:best,-1);
  const spans=el.querySelectorAll('.tts-word');
  spans.forEach(s=>s.classList.remove('reading'));
  if(idx>=0&&spans[idx]) spans[idx].classList.add('reading');
}
// Speaks `text` while highlighting the word currently being said inside
// `el` (replaces el's content with one <span> per word). Calls onEnd exactly
// once, always -- including when TTS isn't supported/enabled, when the
// engine has no installed voice for the language, or when boundary/end
// events simply never arrive (a real cross-browser/cross-OEM gap, not
// hypothetical) -- via a duration-based safety-net timeout, same
// belt-and-suspenders pattern as coinFly()/coinBurst().
function speakWithHighlight(text,el,lang,onEnd){
  text=stripEmojiForSpeech(text);
  const myGen=++_ttsGen;
  const words=[]; const re=/\S+/g; let m;
  while((m=re.exec(text))) words.push({start:m.index,end:m.index+m[0].length,text:m[0]});
  if(el) el.innerHTML=words.map((w,i)=>`<span class="tts-word" data-i="${i}">${esc(w.text)}</span>`).join(' ');
  let done=false;
  const finish=()=>{
    if(done) return; done=true;
    if(el) el.querySelectorAll('.tts-word').forEach(s=>s.classList.remove('reading'));
    if(myGen!==_ttsGen) return; // superseded by a stopSpeaking()/newer speak -- don't continue the chain
    onEnd&&onEnd();
  };
  if(!ttsEnabled()){ finish(); return; }
  // ~110ms/word at rate 0.9 is a generous overestimate; +1.5s margin covers
  // startup latency. If the real speech finishes first, finish() already
  // ran and this is a no-op (the `done` guard) -- applies to both paths below.
  setTimeout(finish,Math.max(1500,words.length*650));
  const speakViaWebSpeech=()=>{
    if(!WEB_TTS_SUPPORTED){ finish(); return; }
    try{
      const utter=new SpeechSynthesisUtterance(text);
      // A6 (calm mode): a slower rate gives extra processing time on a
      // sensitive day, at the parent's discretion via the same toggle that
      // already dampens confetti/chime/background motion.
      utter.lang=lang||'he-IL'; utter.rate=state.calmMode?0.75:0.9;
      utter.onboundary=(ev)=>{
        if(done||!el||myGen!==_ttsGen) return;
        if(ev.name&&ev.name!=='word') return;
        highlightWordAt(el,words,ev.charIndex);
      };
      utter.onend=finish; utter.onerror=finish;
      speechSynthesis.speak(utter);
    }catch(e){ finish(); }
  };
  if(nativeTtsAvailable()){
    // Relayed back from Kotlin's UtteranceProgressListener (see
    // NativeGameBridge.kt). onRangeStart (per-word position) only exists on
    // API 26+; older devices still get onDone/onError via _nativeTtsEnd, so
    // speech plays but without a live word highlight -- graceful, not fatal.
    const uid='tts'+myGen;
    window._nativeTtsBoundary=(id,charIndex)=>{ if(id===uid&&!done&&myGen===_ttsGen) highlightWordAt(el,words,charIndex); };
    window._nativeTtsEnd=(id)=>{ if(id===uid) finish(); };
    try{
      // ttsSpeak returns false when the device's TTS engine has no installed
      // voice for this language (common for Hebrew -- many Android TTS
      // engines don't ship it and it must be downloaded separately in system
      // settings). Previously this just silently gave up (finish() with no
      // sound at all); fall back to the Web Speech engine instead, which at
      // least has a chance of a different installed voice/engine answering.
      if(!window.CoinQuestNative.ttsSpeak(text,lang||'he-IL',uid,state.calmMode?0.75:0.9)) speakViaWebSpeech();
    }catch(e){ speakViaWebSpeech(); }
    return;
  }
  speakViaWebSpeech();
}
// Reads the question (word-highlighted in `qEl`), then each answer button in
// `choiceEls` in turn (English words get an English voice via isLatinText so
// they're not mispronounced as Hebrew). No-op chain if TTS is off/unsupported
// -- callers don't need to branch on that themselves.
function speakQuestionThenChoices(qText,qEl,choiceEls){
  stopSpeaking();
  speakWithHighlight(qText,qEl,'he-IL',()=>{
    const speakOne=(i)=>{
      if(i>=choiceEls.length) return;
      const btn=choiceEls[i];
      btn.classList.add('tts-speaking');
      speakWithHighlight(btn.textContent,null,isLatinText(btn.textContent)?'en-US':'he-IL',()=>{
        btn.classList.remove('tts-speaking');
        speakOne(i+1);
      });
    };
    speakOne(0);
  });
}

function startLearningSession(){
  const k=cur(); if(!k||!state.learning.enabled) return;
  if(k.learn.earnedToday.coins>=state.learning.dailyMaxCoins){
    document.getElementById('learnDisabled').style.display='';
    document.getElementById('learnActive').style.display='none';
    document.getElementById('learnStartBtn').style.display='none';
    return;
  }
  const qs=pickSessionQuestions();
  if(!qs.length){
    document.getElementById('learnDisabled').style.display='';
    document.getElementById('learnActive').style.display='none';
    document.getElementById('learnStartBtn').style.display='none';
    document.getElementById('learnDisabled').innerHTML='<div class="empty"><span class="e-ic">📚</span>אין עוד שאלות זמינות כרגע. בקש מההורים להוסיף מקצועות בהגדרות!</div>';
    return;
  }
  learnSession={questions:qs, idx:0, correctCount:0};
  document.getElementById('learnDisabled').style.display='none';
  document.getElementById('learnActive').style.display='';
  document.getElementById('learnSummary').style.display='none';
  document.getElementById('learnStartBtn').style.display='none';
  renderLearningQuestion();
}
function renderLearningQuestion(){
  const s=learnSession; if(!s) return;
  const q=s.questions[s.idx];
  document.getElementById('learnProgress').textContent=`שאלה ${s.idx+1} מתוך ${s.questions.length}`;
  const dots=document.getElementById('learnDots');
  dots.innerHTML='';
  s.questions.forEach((_,i)=>{
    const d=document.createElement('span');
    d.className='learn-dot'+(i<s.idx?' done':i===s.idx?' active':'');
    dots.appendChild(d);
  });
  const qEl=document.getElementById('learnQ');
  qEl.textContent=q.q;
  const choicesWrap=document.getElementById('learnChoices');
  choicesWrap.innerHTML='';
  document.getElementById('learnTypedWrap').style.display=q.type==='typed-number'?'':'none';
  let choiceEls=[];
  if(q.type==='typed-number'){
    const inp=document.getElementById('learnTypedInput'); inp.value=''; inp.disabled=false;
    choicesWrap.style.display='none';
  }else{
    choicesWrap.style.display='';
    const choices=shuffleArr([...q.choices]);
    choiceEls=choices.map(c=>{
      const btn=document.createElement('button');
      btn.className='learn-choice-btn'; btn.textContent=c;
      btn.onclick=()=>answerLearningQuestion(q,c,btn);
      choicesWrap.appendChild(btn);
      return btn;
    });
  }
  if(ttsEnabled()) speakQuestionThenChoices(q.q,qEl,choiceEls);
}
function replayLearningQuestionAudio(){
  const s=learnSession; if(!s) return;
  const q=s.questions[s.idx];
  speakQuestionThenChoices(q.q,document.getElementById('learnQ'),[...document.querySelectorAll('#learnChoices .learn-choice-btn')]);
}
function submitTypedLearningAnswer(){
  const s=learnSession; if(!s) return;
  const q=s.questions[s.idx];
  const val=document.getElementById('learnTypedInput').value.trim();
  if(val==='') return;
  answerLearningQuestion(q,val,null);
}
// The ONLY place that checks correctness and credits coins — always against
// QUESTION_BANK/customQuestions, never trusting anything about which DOM
// button was clicked, same anti-cheat pattern as redeemToken.
// Works with OR without an active learnSession: the pre-game "learning gate"
// (beginGameLaunch/answerGateQuestion) calls this directly with no session
// running, so crediting/progress/adaptive-level bookkeeping must not depend
// on learnSession existing — only the session-specific bits (correctCount,
// auto-advance to the next question) are skipped when there's no session.
function answerLearningQuestion(q,given,btnEl){
  stopSpeaking(); // the child answered -- cut off any in-progress narration
  const s=learnSession; // may be null (gate-mode call) — guarded below
  const k=cur();
  const correct=String(given).trim()===String(q.answer).trim();
  const p=k.learn.progress[q.id]||{box:0,lastSeen:'',correct:0,wrong:0};
  const today=effectiveToday();
  if(correct){
    p.box=Math.min(4,(p.box||0)+1); p.correct=(p.correct||0)+1;
  }else{
    p.box=1; p.wrong=(p.wrong||0)+1;
  }
  p.lastSeen=today;
  k.learn.progress[q.id]=p;
  k.learn.correctTotal[q.subject]=(k.learn.correctTotal[q.subject]||0)+(correct?1:0);
  // adaptive difficulty bookkeeping (see bumpLearningLevel)
  k.learn.recent[q.subject]=k.learn.recent[q.subject]||[];
  k.learn.recent[q.subject].push(correct?1:0);
  if(k.learn.recent[q.subject].length>10) k.learn.recent[q.subject].shift();
  bumpLearningLevel(q.subject);
  if(correct){
    if(s) s.correctCount++;
    if(btnEl){ btnEl.classList.add('correct'); }
    if(k.learn.earnedToday.coins<state.learning.dailyMaxCoins){
      const n=Math.min(state.learning.coinsPerCorrect, state.learning.dailyMaxCoins-k.learn.earnedToday.coins);
      k.learn.earnedToday.coins+=n;
      // Choice mode: fly from the tapped answer button. Typed mode has no
      // btnEl (submitTypedLearningAnswer passes null) -- fall back to the
      // visible "✓ בדוק" submit button as the coin's launch point.
      const flySrc=btnEl||document.querySelector('#learnTypedWrap .btn.primary');
      addPoints(n,'מכרה הידע — '+subjLabel(q.subject),'learn',flySrc);
    }
    if(!state.calmMode) toast('נכון! +'+state.learning.coinsPerCorrect+' 🪙');
  }else{
    if(btnEl){ btnEl.classList.add('wrong'); }
    document.querySelectorAll('#learnChoices .learn-choice-btn').forEach(b=>{ if(b.textContent===String(q.answer)) b.classList.add('correct'); });
    toast('כמעט! התשובה הנכונה: '+q.answer);
  }
  DB.set('cs_learn_'+state.current,k.learn);
  if(!s) return; // gate-mode: caller (answerGateQuestion) drives its own advance/finish
  if(document.getElementById('learnTypedInput')) document.getElementById('learnTypedInput').disabled=true;
  document.querySelectorAll('#learnChoices .learn-choice-btn').forEach(b=>b.disabled=true);
  setTimeout(()=>{
    s.idx++;
    if(s.idx>=s.questions.length){ finishLearningSession(); } else { renderLearningQuestion(); }
  }, correct?900:1800);
}
function subjLabel(subj){ return {math:'חשבון',english:'אנגלית',science:'מדעים'}[subj]||subj; }
// Adaptive difficulty per subject, same 4-correct-up/2-wrong-down pattern as
// bumpMathLevel — kept separate (own state, own levels 1-3) since a child can
// be at different levels in math vs english vs science.
// A5 (ANDROID-APP-PLAN.md): silent in BOTH directions -- a declared level
// change ("you leveled up!"/"you dropped a level") turns an invisible
// difficulty knob into a scoreboard the child can fixate on or feel bad
// about, which is exactly what this adaptive system exists to avoid. The
// parent can always see the actual level in Admin Settings; the child never
// sees the number move.
function bumpLearningLevel(subj){
  const k=cur(); if(!k) return;
  const recent=k.learn.recent[subj]||[];
  const lastN=recent.slice(-4);
  if(lastN.length>=4 && lastN.every(v=>v===1)){
    const next=Math.min(3,(k.learnLevel[subj]||1)+1);
    if(next!==k.learnLevel[subj]){ k.learnLevel[subj]=next; DB.set('cs_learnlvl_'+state.current,k.learnLevel); }
    k.learn.recent[subj]=[];
  }
  const last2=recent.slice(-2);
  if(last2.length>=2 && last2.every(v=>v===0)){
    const next=Math.max(1,(k.learnLevel[subj]||1)-1);
    if(next!==k.learnLevel[subj]){ k.learnLevel[subj]=next; DB.set('cs_learnlvl_'+state.current,k.learnLevel); }
    k.learn.recent[subj]=[];
  }
}
function finishLearningSession(){
  const s=learnSession; if(!s) return;
  const k=cur();
  k.learn.earnedToday.sessions=(k.learn.earnedToday.sessions||0)+1;
  DB.set('cs_learn_'+state.current,k.learn);
  document.getElementById('learnActive').style.display='none';
  const summary=document.getElementById('learnSummary'); summary.style.display='';
  const perfect=s.correctCount===s.questions.length;
  // G5 (ANDROID-APP-PLAN.md): a perfect session is the "medium" celebration
  // tier -- bigger than an ordinary correct-answer coinFly, smaller than a
  // badge-unlock modal. Was sound-only (chime('celebrate') with no visual
  // match); coinBurst() gives it the confetti-burst the plan calls for
  // without needing a whole new effect.
  if(perfect && !state.calmMode){ try{ coinBurst(); chime('celebrate'); }catch(e){} }
  _lastLearnSessionSize=s.questions.length; _lastLearnCorrectCount=s.correctCount;
  const canMinutes=perfect && state.learning.minutesPerSession>0 && k.learn.earnedToday.minutes<state.learning.dailyMaxMinutes;
  if(perfect && canMinutes){
    // Perfect session + game-time reward enabled: let the child choose coins
    // vs. minutes instead of always granting both automatically.
    summary.innerHTML=`<div style="text-align:center;">
      <div style="font-size:2.6rem;">🏆</div>
      <h3>ענית נכון על ${s.correctCount} מתוך ${s.questions.length}! מפגש מושלם!</h3>
      <p>בחר את הבונוס שלך:</p>
      <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:10px;">
        <button class="btn primary" onclick="claimLearningBonus('coins')">🪙 קח ${state.learning.sessionBonus} מטבעות בונוס</button>
        <button class="btn mint" onclick="claimLearningBonus('minutes')">🎮 קח ${state.learning.minutesPerSession} דקות משחק</button>
      </div>
    </div>`;
  }else{
    let bonus=0;
    if(perfect && k.learn.earnedToday.coins<state.learning.dailyMaxCoins){
      bonus=Math.min(state.learning.sessionBonus, state.learning.dailyMaxCoins-k.learn.earnedToday.coins);
      if(bonus>0){ k.learn.earnedToday.coins+=bonus; addPoints(bonus,'בונוס מפגש מושלם 🌟','learn'); DB.set('cs_learn_'+state.current,k.learn); }
    }
    renderLearningSummaryFinal(s,bonus,0);
  }
  checkBadges();
  learnSession=null;
}
function renderLearningSummaryFinal(s,bonusCoins,bonusMinutes){
  const k=cur();
  const summary=document.getElementById('learnSummary');
  const {cur:tool}=currentTool(k);
  summary.innerHTML=`<div style="text-align:center;">
    <div style="font-size:2.6rem;">${s.correctCount===s.questions.length?'🏆':'⛏️'}</div>
    <h3>ענית נכון על ${s.correctCount} מתוך ${s.questions.length}!</h3>
    <p>הרווחת ${s.correctCount+bonusCoins} 🪙${bonusMinutes?' ו-'+bonusMinutes+' דקות משחק 🎮':''}</p>
    <p style="font-size:.85rem;color:var(--ink2);">${tool.emoji} הכלי שלך: ${tool.label}</p>
    ${k.learn.earnedToday.coins<state.learning.dailyMaxCoins
      ? '<button class="btn primary" onclick="startLearningSession()">עוד סיבוב! ⛏️</button>'
      : '<div class="empty"><span class="e-ic">😴</span>המכרה נסגר להיום — חזור מחר!</div>'}
    <button class="btn ghost" onclick="go(\'home\')">חזרה הביתה</button>
  </div>`;
  renderLearnToolBar();
}
// Reached only from the perfect-session choice screen above (session/idx
// state is already gone by then) — needs its own small closure over the
// last session's counts, kept on the button's onclick via a module var.
let _lastLearnSessionSize=0, _lastLearnCorrectCount=0;
async function claimLearningBonus(kind){
  const k=cur();
  const s={questions:{length:_lastLearnSessionSize},correctCount:_lastLearnCorrectCount};
  if(kind==='coins'){
    const bonus=Math.min(state.learning.sessionBonus, state.learning.dailyMaxCoins-k.learn.earnedToday.coins);
    if(bonus>0){ k.learn.earnedToday.coins+=bonus; addPoints(bonus,'בונוס מפגש מושלם 🌟','learn'); DB.set('cs_learn_'+state.current,k.learn); }
    renderLearningSummaryFinal(s,bonus,0);
  }else{
    const minutes=Math.min(state.learning.minutesPerSession, state.learning.dailyMaxMinutes-k.learn.earnedToday.minutes);
    if(minutes>0){
      k.learn.earnedToday.minutes+=minutes;
      k.gtime=(k.gtime||0)+minutes*60;
      await DB.set('cs_gtime_'+state.current,k.gtime);
      await DB.set('cs_learn_'+state.current,k.learn);
      toast('קיבלת '+minutes+' דקות משחק! 🎮');
    }
    renderLearningSummaryFinal(s,0,minutes);
  }
}

/* ===== CHORES (checkbox tasks) ===== */
// Per-child task assignment: tasks with no kids list (or an empty one, the
// pre-feature shape) belong to EVERYONE — so nothing changes for existing
// families until a parent actively narrows a task down.
function taskForChild(t,childId){ return !t.kids||!t.kids.length||t.kids.includes(childId); }
function renderChores(){
  const wrap=document.getElementById('choresList'); if(!wrap) return;
  wrap.innerHTML='';
  const k=cur(); if(!k) return;
  ensureTodayKid(state.current);
  // Period-aware for every child (see tasksDueNow) -- only the schedule
  // child's HOME view additionally swaps in the bedtime "time to sleep"
  // pseudo-task once past sleep_time (see getTasksForTimeOfDay).
  let tasks=tasksDueNow(state.current);
  if(childUsesSchedule(curChild())&&currentView==='home'){
    tasks=getTasksForTimeOfDay();
    // Friendly, period-true wording instead of a raw clock time -- "22:00"
    // with a daytime-sky emoji read as technical noise, and a child using
    // this all day orients by day-part words, not by 24h clock digits.
    const greeting=document.createElement('div');
    greeting.style.cssText='font-size:1.1rem;font-weight:800;color:#6B6585;margin-bottom:14px;text-align:center;';
    greeting.textContent={
      morning:'🌅 בוקר טוב! המטלות של עכשיו',
      afternoon:'☀️ צהריים טובים! המטלות של עכשיו',
      evening:'🌆 ערב טוב! המטלות של עכשיו',
      sleep:'🌙 לילה טוב! זמן לישון',
    }[currentPeriodKey()]||'🌤️ המטלות של עכשיו';
    wrap.appendChild(greeting);
  }
  if(tasks.length===0){ wrap.innerHTML='<div class="empty"><span class="e-ic">🧹</span>אין מטלות כרגע</div>'; return; }
  tasks.forEach(ch=>{
    const used=k.daily.counts[ch.id]||0;
    const full=used>=ch.max;
    const row=document.createElement('div'); row.className='chore-row'+(full?' done':'');
    row.innerHTML=`
      <button class="chore-check ${full?'full':''}" ${full?'disabled':''} onclick="goScanForChore('${ch.id}')">${full?'✓':(ch.photo?`<img src="${ch.photo}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`:ch.emoji)}</button>
      <div class="chore-info">
        <div class="ci-t">${esc(ch.label)}</div>
        <div class="ci-d">${full?'הושלם להיום ✅':(used+'/'+ch.max+' היום')}</div>
      </div>
      <div class="chore-pts">+${ch.points} 🪙</div>`;
    // Tapping the row's TEXT area reads the task name aloud -- for a child
    // who can't yet read the label reliably. The scan action stays on the big
    // icon button only, so hearing the name never accidentally opens the
    // scanner. Reuses the same read-aloud toggle as the learning questions.
    row.querySelector('.chore-info').onclick=()=>{ if(ttsEnabled()){ stopSpeaking(); speakWithHighlight(ch.label,null,'he-IL',null); } };
    wrap.appendChild(row);
  });
  renderJourneyMap();
}
// All of TODAY's tasks (every period, not just the current one -- unlike
// getTasksForTimeOfDay()) so the journey map below shows whole-day progress,
// not just what's due right now.
function todaysTaskList(){
  if(childUsesSchedule(curChild())){
    // Anytime tasks (no period) counted ONCE, then each period's own anchored
    // tasks -- periodTaskList() alone would repeat an anytime task 3x if
    // simply concatenated across all three periods.
    const anytime=state.chores.filter(t=>taskForChild(t,state.current)&&!t.period);
    return [...anytime,...periodTaskList('morning'),...periodTaskList('afternoon'),...periodTaskList('evening')];
  }
  return state.chores.filter(t=>taskForChild(t,state.current));
}
// G2 (ANDROID-APP-PLAN.md): a station per today's task, filled in as they're
// completed, with the child's own avatar sitting at "how far along" (by
// count, not tied to which specific tasks happen to be done -- a child can
// complete them in any order and the path still reads as steady progress)
// and a treasure chest at the end that opens once everything's done.
function renderJourneyMap(){
  const wrap=document.getElementById('journeyMapWrap'); if(!wrap) return;
  const k=cur();
  if(!k||currentView!=='home'){ wrap.innerHTML=''; return; }
  ensureTodayKid(state.current);
  const tasks=todaysTaskList();
  if(tasks.length===0){ wrap.innerHTML=''; return; }
  const c=curChild();
  const avatarIcon=esc((c&&c.emoji)||'🦊');
  const avatarHtml=`<div class="jm-avatar">${avatarIcon}</div>`;
  const doneFlags=tasks.map(t=>(k.daily.counts[t.id]||0)>=t.max);
  const doneCount=doneFlags.filter(Boolean).length;
  const allDone=doneCount===tasks.length;
  const pieces=[];
  tasks.forEach((t,i)=>{
    const done=doneFlags[i];
    const icon=t.photo?`<img src="${t.photo}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`:esc(t.emoji||'⭐');
    pieces.push(`<div class="jm-station ${done?'done':''}" title="${esc(t.label)}">${done?'✓':icon}</div>`);
    if(i+1===doneCount) pieces.push(avatarHtml);
    if(i<tasks.length-1) pieces.push(`<div class="jm-line ${done&&doneFlags[i+1]?'done':''}"></div>`);
  });
  if(doneCount===0) pieces.unshift(avatarHtml);
  wrap.innerHTML=`<div class="jm-wrap"><div class="jm-track">${pieces.join('')}</div>
    <div class="jm-chest ${allDone?'open':''}">${allDone?'🎉':'🎁'}</div></div>`;
}

/* ===== VISUAL DAY SCHEDULE + FIRST->THEN (for Ariel) ===== */
function currentPeriodKey(){
  const hour=new Date().getHours();
  if(!state.anchored) return 'morning';
  if(hour>=state.anchored.sleep_time||hour<5) return 'sleep';
  return getTimeOfDay(hour);
}
// Same bedtime window the day-schedule already uses (sleep_time..05:00), but
// applied to game LAUNCHES for every child, not just schedule children --
// banked minutes were previously spendable at 2am. Never destroys banked time
// (that would be a punishment for a rule the child didn't set); it only defers
// it to the morning, and a parent can turn the whole gate off.
function isPastBedtime(){
  if(!state.anchored) return false;
  const hour=new Date().getHours();
  return hour>=state.anchored.sleep_time||hour<5;
}
function gameBedtimeBlocked(){ return state.gameBedtime!==false && isPastBedtime(); }
function showBedtimeGameMsg(){
  modalMsg('🌙','המשחקים הולכים לישון','עכשיו זמן שינה, אז המשחקים נחים עד מחר בבוקר.\nכל הזמן ששמרת נשאר שלך — הוא מחכה לך ⏱️');
}
// Tasks marked `required` that must be done before the child is allowed to
// actually PLAY a game -- distinct from just being eligible to earn coins.
// Doesn't block earning/banking coins or buying game-time with them, only
// launching a game (beginGameLaunch), which is the exact moment "spent every
// banked coin on screen time without ever doing the required chores" would
// otherwise happen. A period-tagged required task only blocks once its
// window has actually STARTED today (order up to and including the current
// period, so a missed morning requirement still blocks play in the evening,
// not just during the morning itself); an anytime required task (no period)
// blocks all day until done.
// Surfaces pendingRequiredTasks() as a standing home-screen banner instead of
// only a modal that appears at the moment a game is blocked -- a required
// task (bathroom sitting, medicine) should be obvious BEFORE the child even
// tries to play, not just when they hit a wall.
function renderRequiredTaskAlert(){
  const wrap=document.getElementById('requiredTaskWrap'); if(!wrap) return;
  const k=cur(); if(!k){ wrap.innerHTML=''; return; }
  const missing=pendingRequiredTasks(state.current);
  if(!missing.length){ wrap.innerHTML=''; return; }
  const names=missing.map(t=>t.emoji+' '+esc(t.label)).join(', ');
  wrap.innerHTML=`<button class="req-alert" onclick="openScan()">
    <span class="ra-ic">🎯</span>
    <span class="ra-text"><div class="ra-title">קודם המטלות האלה, אחר כך משחקים!</div><div class="ra-sub">${names}</div></span>
    <span class="ra-arrow">›</span></button>`;
}
function pendingRequiredTasks(childId){
  const k=state.kid[childId]; if(!k) return [];
  const order=['morning','afternoon','evening'];
  const cur=currentPeriodKey();
  const curIdx=cur==='sleep'?order.length-1:order.indexOf(cur);
  return state.chores.filter(t=>{
    if(!t.required||!taskForChild(t,childId)) return false;
    if((k.daily.counts[t.id]||0)>=t.max) return false;
    if(!t.period) return true;
    const idx=order.indexOf(t.period);
    return idx>=0&&idx<=curIdx;
  });
}
// Tasks anchored to a SPECIFIC period only (strict match -- an "anytime" task
// with no period is deliberately excluded here so a caller that loops over
// every period, like renderFirstThen()'s remaining-tasks scan, doesn't see the
// same anytime task repeated once per period). Callers that want the full
// "what's relevant right now" set (anchored-to-now + anytime) should use
// getTasksForTimeOfDay() instead.
function periodTaskList(period){
  if(period==='sleep') return [{id:'night_sleep',label:'זמן שינה',emoji:'😴',points:2,max:1}];
  return state.chores.filter(t=>taskForChild(t,state.current)&&t.period===period);
}
function renderDayStrip(){
  const wrap=document.getElementById('dayStripWrap'); if(!wrap) return;
  if(!childUsesSchedule(curChild())||currentView!=='home'){ wrap.innerHTML=''; return; }
  const order=['morning','afternoon','evening','sleep'];
  const labels={morning:['🌅','בוקר'],afternoon:['☀️','צהריים'],evening:['🌆','ערב'],sleep:['🛏️','שינה']};
  const curIdx=order.indexOf(currentPeriodKey());
  let html='<div class="day-strip">';
  order.forEach((p,i)=>{
    const cls=i===curIdx?'now':(i<curIdx?'past':'');
    html+=`<div class="day-step ${cls}"><span class="ds-ic">${labels[p][0]}</span><span class="ds-lbl">${labels[p][1]}</span></div>`;
  });
  wrap.innerHTML=html+'</div>';
}
// Once-per-day, dismissible orientation card -- NOT a blocking interstitial
// screen the child has to get past (that would just be one more tap on the
// way to what they actually opened the app for). Gated by a per-child,
// device-local "last shown" date so it appears exactly once per real day,
// re-arms on the next calendar day, and never reappears just from switching
// views back to home.
async function maybeShowDailyGreeting(){
  const wrap=document.getElementById('dailyGreetingWrap'); if(!wrap) return;
  wrap.innerHTML=''; // always start clean -- avoids a stale card from whichever child was previously selected
  if(!cur()||!curChild()) return;
  const key='cs_greeted_'+state.current;
  const today=effectiveToday();
  const last=await DB.get(key);
  if(last===today) return;
  await DB.set(key,today);
  renderDailyGreetingCard();
}
function renderDailyGreetingCard(){
  const wrap=document.getElementById('dailyGreetingWrap'); if(!wrap) return;
  const c=curChild(), k=cur(); if(!c||!k) return;
  const tasks=todaysTaskList();
  const done=tasks.filter(t=>(k.daily.counts[t.id]||0)>=t.max).length;
  const hour=new Date().getHours();
  const dayGreet=hour<5?'לילה טוב':hour<12?'בוקר טוב':hour<18?'צהריים טובים':'ערב טוב';
  const sub=tasks.length===0?'אין מטלות היום — תיהנה! 😊'
    :done>=tasks.length?'כל המטלות של היום כבר בוצעו! כל הכבוד 🌟'
    :'היום יש לך '+tasks.length+' מטלות'+(done>0?' ('+done+' כבר בוצעו)':'')+' 🧹';
  wrap.innerHTML=`<div class="daily-greet-card">
    <button class="dg-close" onclick="document.getElementById('dailyGreetingWrap').innerHTML=''" title="סגור">✕</button>
    <div class="dg-title">${dayGreet}, ${esc(c.name)}! 👋</div>
    <div class="dg-sub">${sub}</div>
  </div>`;
}
// A1 (ANDROID-APP-PLAN.md): visible on every kid-facing screen now (moved to
// shared chrome in index.html), not just home -- explicitly hidden on
// parent/meta screens where it would be confusing clutter (picker/welcome
// have no "current child" context yet; admin is the parent's own screen).
// Shared with go()'s periodic refresh interval below so both agree on which
// views count as "kid-facing".
const FIRSTTHEN_HIDDEN_VIEWS=['picker','welcome','admin'];
function renderFirstThen(){
  const wrap=document.getElementById('firstThenWrap'); if(!wrap) return;
  const k=cur();
  if(!childUsesSchedule(curChild())||FIRSTTHEN_HIDDEN_VIEWS.includes(currentView)||!k){ wrap.innerHTML=''; return; }
  ensureTodayKid(state.current);
  const order=['morning','afternoon','evening','sleep'];
  const curIdx=order.indexOf(currentPeriodKey());
  // Anytime tasks (no period) are always due, listed once up front -- not
  // inside the period loop below, which would otherwise repeat them once per
  // remaining period.
  let remaining=state.chores.filter(t=>taskForChild(t,state.current)&&!t.period&&(k.daily.counts[t.id]||0)<t.max);
  for(let i=curIdx;i<order.length;i++){
    remaining.push(...periodTaskList(order[i]).filter(t=>(k.daily.counts[t.id]||0)<t.max));
  }
  if(remaining.length===0){
    wrap.innerHTML='<div class="ft-done">🎉 סיימת את כל המטלות של היום! כל הכבוד אריאל!</div>';
    return;
  }
  const first=remaining[0], then=remaining[1];
  const ftIcon=t=>t.photo?`<img class="ft-ic" src="${t.photo}" style="width:64px;height:64px;border-radius:16px;object-fit:cover;">`:`<span class="ft-ic">${t.emoji}</span>`;
  // The "קודם" box is a BUTTON when the task is scannable (a real chore, not
  // the sleep pseudo-task): the strip already tells the child what to do next
  // all day long -- tapping it should START doing it (jump straight to the
  // scanner, pre-hinted to this task), not just describe it.
  const firstTappable=!!findTaskById(first.id);
  const firstBox=`<div class="ft-lbl">קודם</div>${ftIcon(first)}<div class="ft-t">${esc(first.label)}</div>`;
  wrap.innerHTML=`<div class="ft-card">
    ${firstTappable
      ?`<button class="ft-box first ft-tap" onclick="goScanForChore('${first.id}')">${firstBox}<div class="ft-go">📷 סרוק ←</div></button>`
      :`<div class="ft-box first">${firstBox}</div>`}
    <div class="ft-arrow">←</div>
    <div class="ft-box then">${then
      ?`<div class="ft-lbl">אחר כך</div>${ftIcon(then)}<div class="ft-t">${esc(then.label)}</div>`
      :`<div class="ft-lbl">אחר כך</div><span class="ft-ic">🎉</span><div class="ft-t">סיימת!</div>`}</div>
  </div>`;
}

// Minimum real-world gap between two redemptions of the SAME chore (enforced
// in redeemToken, since scanning is now the only way a chore ever pays out --
// see goScanForChore() below): without this, the only guard was a pure daily
// COUNT (`used>=ch.max`), which is time-blind -- re-scanning the same code
// repeatedly would bank the full day's points for a task done once. Not meant
// to defeat a determined child re-scanning a real code after a real minute
// passed (no automated guard can prove real-world behavior) -- it's a
// friction floor against the specific "redeem the same code in 3 seconds"
// exploit.
const CHORE_MIN_GAP_MS=60000;
// Chores are earned ONLY by scanning the task's real, parent-generated QR
// code (see redeemToken) -- tapping the chore-check button on its own must
// never credit coins, or a child could just tap through the whole list
// without doing anything. This sends them straight to the scanner instead,
// with a hint (see applyScanIntentHint) showing exactly which task's code to
// look for -- consistent with the app's whole "make what's expected concrete
// and visible" design elsewhere (first-then, day strip, journey map).
function goScanForChore(id){
  const ch=findTaskById(id); if(!ch) return;
  if(!taskForChild(ch,state.current)) return; // not this child's task
  const k=cur(); ensureTodayKid(state.current);
  if((k.daily.counts[id]||0)>=ch.max) return; // already maxed -- button should be disabled anyway
  _scanIntentTaskId=id;
  go('scan');
}

/* ===== STREAK CHALLENGES (multiple daily-streak challenges, e.g. "clean day" / "good behavior") ===== */
function dateKey(d){ return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }
let currentStreakId=null;
function openStreakView(id){ if(!gate('streaks')) return; currentStreakId=id; go('streak'); }
function renderStreakBanner(){
  const wrap=document.getElementById('streakBannerWrap'); if(!wrap) return;
  wrap.innerHTML='';
  // A free home simply doesn't show premium chrome -- cleaner for the child
  // than a banner that opens a "go ask a parent" dead end when tapped.
  if(featureLocked('streaks')) return;
  const c=curChild(); if(!c) return;
  state.streaks.filter(s=>s.childId===c.id).forEach(s=>{
    const todayMarked = !!s.days[dateKey(new Date())];
    const pct=Math.min(100,(s.current/s.goal)*100);
    const banner=document.createElement('button');
    banner.className='streak-banner'; banner.onclick=()=>openStreakView(s.id);
    banner.innerHTML=`
      <span class="sb-flame">${s.icon||'🔥'}</span>
      <span class="sb-text">
        <div class="sb-title">${s.current} ימים ברצף · ${esc(s.title)}!</div>
        <div class="sb-sub">${todayMarked?'סימנת היום ✓ — כל הכבוד!':'עוד '+(s.goal-s.current)+' ימים ל'+esc(s.rewardLabel)+' '+s.rewardEmoji}</div>
        <div class="sb-bar"><div class="sb-fill" style="width:${pct}%"></div></div>
      </span>
      <span class="sb-arrow">›</span>`;
    wrap.appendChild(banner);
  });
}
function requestMarkCleanToday(id){
  // A challenge day reflects real-world behavior that a parent confirms — so marking
  // it requires the parent PIN. This stops the child from self-marking the streak
  // (and the prize) without anyone checking.
  modalPin(()=>{ markStreakCleanToday(id); });
}
async function markStreakCleanToday(id){
  const s=getStreak(id); if(!s) return;
  const k=dateKey(new Date());
  if(s.days[k]) return; // already marked today
  s.days[k]='clean';
  audit('אישר יום מוצלח באתגר "'+s.title+'"');
  const wasWon=!!s.wonAt;
  recomputeStreak(id);
  let justWon = !wasWon && !!s.wonAt;
  await DB.set('cs_streaks',state.streaks);
  scheduleSync();
  renderStreakBanner();
  if(currentView==='streak') renderStreakView();
  coinBurst();
  checkBadges();
  if(justWon){
    modalMsg(s.rewardEmoji,'🏆 ניצחת באתגר!','השלמת '+s.goal+' ימים ברצף של '+s.title+'!\nהפרס שלך: '+s.rewardLabel+' '+s.rewardEmoji+'\nכל הכבוד גדול/ה!');
  } else {
    toast(s.icon+' עוד '+s.dayWord+'! '+s.current+'/'+s.goal);
  }
}
function buildCalendar(year, month, days, editable, onTap, todayKeyStr){
  // returns {dowHtml, gridHtml}
  const dows=['א','ב','ג','ד','ה','ו','ש'];
  const dowHtml=dows.map(d=>'<div class="cal-dow">'+d+'</div>').join('');
  const first=new Date(year,month,1);
  const startOffset=first.getDay();
  const daysInMonth=new Date(year,month+1,0).getDate();
  let cells='';
  for(let i=0;i<startOffset;i++) cells+='<div class="cal-cell empty-cell"></div>';
  for(let d=1; d<=daysInMonth; d++){
    const key=year+'-'+(month+1)+'-'+d;
    const status=days[key];
    const cls=status==='clean'?'clean':status==='accident'?'accident':status==='frozen'?'frozen':'';
    const isToday=key===todayKeyStr;
    const editAttr=editable?` onclick="${onTap}('${key}')"`:'';
    cells+=`<div class="cal-cell ${cls} ${isToday?'today':''} ${editable?'editable':''}"${editAttr}>${d}</div>`;
  }
  return {dowHtml, gridHtml:cells};
}
function renderStreakView(){
  const s=getStreak(currentStreakId)||state.streaks[0]; if(!s) return;
  currentStreakId=s.id;
  // Fix title to show actual goal
  const titleEl=document.getElementById('streakViewTitle');
  if(titleEl) titleEl.textContent=(s.icon||'🌟')+' אתגר '+esc(s.title)+' · '+s.goal+' ימים';
  document.getElementById('streakHeroWrap').innerHTML=`
    <div class="streak-hero">
      <div class="sh-flame">${s.icon||'🔥'}</div>
      <div class="sh-num">${s.current}</div>
      <div class="sh-lbl">ימים ברצף · השיא: ${s.best}</div>
      <div class="sh-goal">${s.rewardEmoji} ${s.goal} ימים = ${esc(s.rewardLabel)}</div>
      <div class="streak-today-btn">${
        s.days[dateKey(new Date())]
          ? '<button class="btn ghost" disabled>✓ סימנת היום</button>'
          : '<button class="btn mint" onclick="requestMarkCleanToday(\''+s.id+'\')">✅ היום היה '+esc(s.dayWord)+'! (אישור הורה)</button>'
      }</div>
    </div>`;
  const now=new Date();
  const {dowHtml,gridHtml}=buildCalendar(now.getFullYear(), now.getMonth(), s.days, false, '', dateKey(now));
  document.getElementById('calMonthLabel').textContent=now.toLocaleDateString('he-IL',{month:'long',year:'numeric'});
  document.getElementById('calDow').innerHTML=dowHtml;
  document.getElementById('calGrid').innerHTML=gridHtml;
  const legend=document.getElementById('calLegendClean'); if(legend) legend.textContent=s.dayWord;
}

/* ===== GAME TIME (coins -> minutes wallet -> in-app game portal with enforced countdown) ===== */
function fmtGT(sec){
  sec=Math.max(0,Math.floor(sec));
  const m=Math.floor(sec/60), s=sec%60;
  return m+':'+String(s).padStart(2,'0');
}
function fmtGTLong(sec){
  sec=Math.max(0,Math.floor(sec));
  const m=Math.floor(sec/60);
  return m>0 ? m+' דקות' : sec+' שניות';
}
function renderGameTimeBanner(){
  const k=cur();
  // Always-visible topbar counter, separate from the home-only banner below --
  // "I bought time and can't tell if it landed" was exactly the confusion this
  // closes: a bank counter visible from every screen, not just home.
  const gtPill=document.getElementById('gtPill'), gtPillVal=document.getElementById('gtPillVal');
  if(gtPill&&gtPillVal){
    const hasPill=!!(k&&(k.gtime||0)>0);
    gtPill.style.display=hasPill?'flex':'none';
    if(hasPill) gtPillVal.textContent=fmtGT(k.gtime);
  }
  const wrap=document.getElementById('gameTimeWrap'); if(!wrap) return;
  wrap.innerHTML='';
  if(!k||!state.games.length) return;
  const has=(k.gtime||0)>0;
  const banner=document.createElement('button');
  banner.className='gt-banner'; banner.onclick=()=>go('games');
  banner.innerHTML=`
    <span class="sb-flame">🎮</span>
    <span class="sb-text">
      <div class="sb-title">${has?'יש לך '+fmtGTLong(k.gtime)+' משחק!':'המשחקים שלי'}</div>
      <div class="sb-sub">${has?'לחץ כדי לבחור משחק ולהתחיל':'המר מטבעות בחנות הפרסים כדי לקבל זמן משחק'}</div>
    </span>
    <span class="sb-arrow">›</span>`;
  wrap.appendChild(banner);
}
function renderGamesView(){
  const k=cur(); if(!k) return;
  applyEnforcedPackages(); // re-arm on every visit -- catches games added/removed since launch
  document.getElementById('gtWalletBig').textContent='⏱️ '+fmtGT(k.gtime||0);
  const list=document.getElementById('gamesList'); list.innerHTML='';
  if(!state.games.length){ list.innerHTML='<div class="empty"><span class="e-ic">🎮</span>אין משחקים עדיין — אמא או אבא יכולים להוסיף בהגדרות</div>'; return; }
  const has=(k.gtime||0)>0;
  const bedtime=gameBedtimeBlocked();
  const bedNote=document.getElementById('gtBedtimeNote');
  if(bedNote) bedNote.style.display=bedtime?'':'none';
  state.games.forEach(g=>{
    const row=document.createElement('button'); row.className='game-row';
    const nativeUnavailable=g.native&&!isNativeGameAvailable();
    // A real `disabled` attribute would look right but silently swallows
    // ALL clicks (native browser behavior) -- including the tap that's
    // supposed to explain WHY it's locked. Use a CSS-only look-disabled
    // class instead so the explanatory tap always works.
    if(!has||nativeUnavailable||bedtime) row.classList.add('locked');
    const statusIc=bedtime?'🌙':(nativeUnavailable?'📱':(has?'▶ שחק':'🔒'));
    row.innerHTML=`<span class="g-emoji">${g.emoji}</span><span class="g-label">${esc(g.label)}</span><span style="font-weight:800;color:var(--mint-d);">${statusIc}</span>`;
    row.onclick=()=>{
      // Bedtime first: telling a child to go finish chores (or to go buy more
      // time) is misleading when nothing can be launched right now anyway.
      if(bedtime){ showBedtimeGameMsg(); return; }
      if(nativeUnavailable){ modalMsg('📱','זמין רק באפליקציה','המשחק הזה עובד רק כשפותחים את כספת המטבעות מתוך אפליקציית האנדרואיד, לא בדפדפן.'); return; }
      if(!has){ toast('אין זמן משחק — המר מטבעות בפרסים 🎁'); return; }
      beginGameLaunch(g);
    };
    list.appendChild(row);
  });
}

/* ---- session engine ----
   Time is measured with performance.now() (monotonic — the device clock can't
   rewind it), drains only while the game is actually visible (backgrounding
   the app pauses the drain: bought time is never lost to an interruption,
   which matters a lot for a child who struggles with unexpected transitions),
   and the remaining balance is persisted every few seconds so closing the
   app mid-game can't mint time back. */
let _gt=null; // {gameId, baseMono, baseWallet, warned:{}, interval, paused}
// A2 (ANDROID-APP-PLAN.md): 5min/2min/30sec staged warnings -- enough lead
// time before a transition that it's never a surprise, matching the same
// "graduated, never abrupt" principle as GameTimeOverlayService's native
// calm-message buffer below.
const GT_WARN_STEPS=[300,120,30]; // seconds-left marks that trigger a warning
// ---- optional pre-game "learning gate" (L6) ----
// A non-blocking 3-question warm-up before a game session: always lets the
// child continue after answering (even if all 3 are wrong — this is a brain
// warm-up, not a test), so there's no cheating vector here worth guarding.
// coinsPerCorrect still applies via the normal answerLearningQuestion path.
let _gateSession=null; // {questions, idx, onDone}
function beginGameLaunch(g){
  // Also guarded in renderGamesView's row handler; repeated here because this
  // is the single funnel every launch path (web row, native row, gate resume)
  // goes through, so the rule can't be bypassed by a caller that forgot it.
  if(gameBedtimeBlocked()){ showBedtimeGameMsg(); return; }
  const missing=pendingRequiredTasks(state.current);
  if(missing.length){
    const names=missing.map(t=>t.emoji+' '+t.label).join(', ');
    modalConfirm('🎯','קודם המטלות!','כדי לשחק צריך קודם לסיים: '+names+'.\nלסרוק עכשיו?',()=>{ openScan(); });
    return;
  }
  const launch=()=> g.native ? startNativeGameSession(g) : startGameSession(g.id);
  if(!state.learning.gateEnabled || !state.learning.enabled){ launch(); return; }
  const qs=pickSessionQuestions().slice(0,3);
  if(!qs.length){ launch(); return; }
  _gateSession={questions:qs, idx:0, onDone:launch};
  renderGateQuestion();
}
function renderGateQuestion(){
  const s=_gateSession; if(!s) return;
  const q=s.questions[s.idx];
  const isTyped=q.type==='typed-number';
  modalContent.innerHTML=`<div style="text-align:center;">
    <div style="font-size:.8rem;color:var(--ink2);margin-bottom:6px;">⛏️ חימום מוח (${s.idx+1}/${s.questions.length})</div>
    <button class="tts-replay-btn" onclick="replayGateQuestionAudio()" title="הקרא שוב">🔊</button>
    <h3 style="margin-top:0;" id="gateQ">${esc(q.q)}</h3>
    <div style="display:flex;flex-direction:column;gap:8px;" id="gateChoices"></div>
  </div>`;
  const wrap=document.getElementById('gateChoices');
  if(isTyped){
    // Build via DOM (not an HTML string with an inline onclick): a text answer
    // run through JSON.stringify into a double-quoted onclick="" attribute
    // produced nested double-quotes that truncated the attribute and made the
    // whole button unclickable -- every non-numeric gate answer (English,
    // science) was broken. createElement + .onclick sidesteps all escaping.
    const inp=document.createElement('input');
    inp.type='number'; inp.id='gateTypedInput'; inp.placeholder='?';
    inp.style.cssText='width:100%;text-align:center;font-size:1.3rem;border:2px solid var(--line);border-radius:13px;padding:10px;margin-bottom:10px;';
    const btn=document.createElement('button');
    btn.className='btn primary'; btn.textContent='✓ בדוק';
    btn.onclick=()=>answerGateQuestion(inp.value);
    wrap.appendChild(inp); wrap.appendChild(btn);
  }else{
    shuffleArr([...q.choices]).forEach(c=>{
      const btn=document.createElement('button');
      btn.className='learn-choice-btn'; btn.textContent=c;
      btn.onclick=()=>answerGateQuestion(c);
      wrap.appendChild(btn);
    });
  }
  modalBg.classList.add('show');
  if(ttsEnabled()) speakQuestionThenChoices(q.q,document.getElementById('gateQ'),[...document.querySelectorAll('#gateChoices .learn-choice-btn')]);
}
function replayGateQuestionAudio(){
  const s=_gateSession; if(!s) return;
  const q=s.questions[s.idx];
  speakQuestionThenChoices(q.q,document.getElementById('gateQ'),[...document.querySelectorAll('#gateChoices .learn-choice-btn')]);
}
function answerGateQuestion(given){
  const s=_gateSession; if(!s) return;
  const q=s.questions[s.idx];
  answerLearningQuestion(q,given,null); // credits coins/progress exactly like a normal session
  s.idx++;
  if(s.idx>=s.questions.length){
    closeModal();
    const onDone=s.onDone; _gateSession=null;
    onDone();
  }else{
    setTimeout(renderGateQuestion, 900);
  }
}
// `bathroomSeconds`: set only by startBathroomSession() (parent-triggered,
// PIN-gated, capped at 10 minutes) for a game explicitly marked
// bathroomApproved -- runs the exact same overlay/countdown/exit-button UI as
// a normal wallet-backed session, but never reads or writes the coin wallet
// (see the `_gt.bathroom` guards in gtPersist/endGameSession). Deliberately
// NOT part of the coin economy: crediting leftover minutes back to the
// wallet would let a child start-then-immediately-cancel a bathroom session
// to mint free game time.
async function startGameSession(gameId,bathroomSeconds){
  const g=state.games.find(x=>x.id===gameId); if(!g) return;
  const bathroom=bathroomSeconds>0;
  const k=cur();
  if(!bathroom&&(!k||(k.gtime||0)<=0)) return;
  document.getElementById('gameFrame').src=g.url;
  document.getElementById('gameOverlay').style.display='block';
  document.getElementById('gtWarnBanner').style.display='none';
  document.getElementById('gameTimerChip').classList.remove('warning');
  _gt={gameId, baseMono:performance.now(), baseWallet:bathroom?bathroomSeconds:k.gtime, warned:{}, paused:false,
       lastPersist:performance.now(), interval:setInterval(gtTick,1000), bathroom};
  updateKeepScreenOn();
  gtTick();
  // Some sites refuse to be embedded (X-Frame-Options / frame-ancestors) —
  // the iframe then silently stays an empty same-origin document. Detect that
  // (a page that DID load is cross-origin, so contentDocument throws/returns
  // null) and bail out with a full time refund instead of draining the wallet
  // over a black screen.
  setTimeout(()=>{
    if(!_gt||_gt.gameId!==gameId) return;
    let blocked=false;
    try{ const d=document.getElementById('gameFrame').contentDocument; blocked=!!(d&&!d.body.childElementCount); }catch(e){ blocked=false; }
    if(blocked){
      _gt.baseMono=performance.now(); // zero the drain -> exact refund
      endGameSession(false);
      modalMsg('🚧','המשחק לא נפתח','האתר של המשחק הזה לא מאפשר פתיחה בתוך האפליקציה.\nהזמן שלך לא ירד! בקש מאמא או אבא לבחור משחק אחר בהגדרות.');
    }
  },8000);
}
function gtRemaining(){
  if(!_gt) return 0;
  if(_gt.paused) return _gt.baseWallet;
  return _gt.baseWallet-Math.floor((performance.now()-_gt.baseMono)/1000);
}
async function gtPersist(){
  if(!_gt||_gt.bathroom) return; // a bathroom session never touches the coin wallet
  const k=cur(); if(!k) return;
  k.gtime=Math.max(0,gtRemaining());
  await DB.set('cs_gtime_'+state.current,k.gtime);
}
function gtTick(){
  if(!_gt||_gt.paused) return;
  const left=gtRemaining();
  document.getElementById('gtClock').textContent=fmtGT(left);
  for(const w of GT_WARN_STEPS){
    if(left<=w&&!_gt.warned[w]&&left>0){
      _gt.warned[w]=true;
      const banner=document.getElementById('gtWarnBanner');
      banner.textContent=w>=60 ? '⏳ נשארו '+Math.round(w/60)+' דקות משחק' : '⏰ עוד רגע נגמר הזמן!';
      banner.style.display='block';
      setTimeout(()=>{ if(_gt) banner.style.display='none'; },6000);
      if(w<=60) document.getElementById('gameTimerChip').classList.add('warning');
      try{ chime(true); }catch(e){}
    }
  }
  // Persist every ~10s so a hard app-kill mid-game loses at most a few
  // seconds of drain (in the child's favor, never the parent's problem).
  if(performance.now()-_gt.lastPersist>10000){ _gt.lastPersist=performance.now(); gtPersist(); }
  if(left<=0) endGameSession(true);
}
async function endGameSession(expired){
  if(!_gt) return;
  const wasBathroom=_gt.bathroom;
  clearInterval(_gt.interval);
  await gtPersist(); // no-op for a bathroom session (see the guard inside)
  _gt=null;
  updateKeepScreenOn();
  document.getElementById('gameFrame').src='about:blank'; // actually stop the game
  document.getElementById('gameOverlay').style.display='none';
  renderGamesView(); renderGameTimeBanner();
  scheduleSync();
  if(expired){
    if(wasBathroom) modalMsg('🚽','הזמן נגמר','זמן המשחק לשירותים הסתיים. כל הכבוד! 🎉');
    else modalMsg('⏰','הזמן נגמר!','זמן המשחק שקנית הסתיים.\nאפשר להרוויח עוד מטבעות ולהמיר אותם לזמן משחק חדש! 💪');
  }
}
/* ---- native game sessions (a REAL purchased app, e.g. Minecraft) ----
   Enforcement runs entirely in the Android wrapper (android-app/.../
   GameTimeOverlayService.kt + GameTimeAccessibilityService.kt) because the
   WebView is backgrounded the whole time the native game is in the
   foreground — a JS countdown here would be throttled/paused by the OS and
   couldn't reliably enforce anything. This just hands off the current
   wallet balance and waits for the native callback below to report real
   usage; the wallet is only ever debited by what the native side reports,
   never by anything computed here. */
function isNativeGameAvailable(){ return typeof window.CoinQuestNative!=='undefined'; }
// Arms the native always-on wall: tells the device-owner layer which packages
// to keep suspended outside a paid session, on EVERY app launch -- not only
// when the first session ever starts (the old behavior, which left a fresh
// install with no wall at all until the child's first purchase). The native
// setEnforcedPackages now also immediately (re)asserts the suspend, so the
// game is blocked the moment the app knows about it. Guarded per method (not
// just per bridge) so Playwright's partial bridge mocks and older APKs without
// this method don't throw.
function applyEnforcedPackages(){
  if(!isNativeGameAvailable()||typeof window.CoinQuestNative.setEnforcedPackages!=='function') return;
  const csv=(state.games||[]).filter(g=>g.native&&g.androidPackage).map(g=>g.androidPackage).join(',');
  try{ window.CoinQuestNative.setEnforcedPackages(csv); }catch(e){}
}
// Parent-facing enforcement health check (Admin Settings). Enforcement now
// rests on two things: device-owner status (the OS-level power to suspend the
// game -- provisioned once via adb, and unlike the old accessibility service,
// NOT something Family Link or the child can silently switch off) and the
// floating-timer overlay permission. If either is missing the wall isn't fully
// there, so surface it to the parent. The overlay is re-grantable from the app;
// device-owner has to be re-provisioned from a computer, so we say so.
function renderEnforcementWarning(){
  const el=document.getElementById('enforcementWarning'); if(!el) return;
  const hasNativeGames=(state.games||[]).some(g=>g.native&&g.androidPackage);
  if(!isNativeGameAvailable()||!hasNativeGames){ el.style.display='none'; return; }
  const missing=[];
  try{
    // Enforcement is satisfied by ANY wall (usage access / device-owner /
    // accessibility); only warn when none is present.
    const usage=typeof window.CoinQuestNative.hasUsageAccess==='function'&&window.CoinQuestNative.hasUsageAccess();
    const owner=typeof window.CoinQuestNative.isDeviceOwner==='function'&&window.CoinQuestNative.isDeviceOwner();
    const acc=typeof window.CoinQuestNative.hasAccessibilityPermission==='function'&&window.CoinQuestNative.hasAccessibilityPermission();
    if(!usage&&!owner&&!acc) missing.push('אכיפה (גישה לשימוש)');
    if(typeof window.CoinQuestNative.hasOverlayPermission==='function'&&!window.CoinQuestNative.hasOverlayPermission()) missing.push('חלון צף');
  }catch(e){}
  if(missing.length===0){ el.style.display='none'; return; }
  el.style.display='block';
  el.querySelector('.ew-text').textContent='⚠️ אכיפת זמן המשחק כבויה — חסר: '+missing.join(' + ')+'. בלי זה הילד יכול לפתוח את המשחק בלי לקנות זמן.';
}
function openEnforcementSettings(){
  if(!isNativeGameAvailable()) return;
  try{
    // Grant overlay first if missing; otherwise, if no enforcement wall is
    // active, guide the usage-access grant (the parent-grantable, Family-Link-
    // compatible one). Device-owner is provisioned from a computer, not here.
    const usage=typeof window.CoinQuestNative.hasUsageAccess==='function'&&window.CoinQuestNative.hasUsageAccess();
    const owner=typeof window.CoinQuestNative.isDeviceOwner==='function'&&window.CoinQuestNative.isDeviceOwner();
    if(typeof window.CoinQuestNative.hasOverlayPermission==='function'&&!window.CoinQuestNative.hasOverlayPermission()) window.CoinQuestNative.requestOverlayPermission();
    else if(!usage&&!owner&&typeof window.CoinQuestNative.requestUsageAccess==='function') window.CoinQuestNative.requestUsageAccess();
    else if(!usage&&!owner&&typeof window.CoinQuestNative.requestAccessibilityPermission==='function') window.CoinQuestNative.requestAccessibilityPermission();
  }catch(e){}
}

/* ---- daily chore-reminder notification (AN5, native-only) ---- */
function updateChoreReminderCardVisibility(){
  const card=document.getElementById('choreReminderCard');
  if(card) card.style.display=isNativeGameAvailable()?'':'none';
}

/* ---- parent-device mode (native-only): this install has no child to
   enforce against, so let the parent turn off the background game-time
   watcher entirely on it. ---- */
function updateParentDeviceModeCardVisibility(){
  const card=document.getElementById('parentDeviceModeCard');
  if(!card) return;
  card.style.display=isNativeGameAvailable()?'':'none';
  if(!isNativeGameAvailable()) return;
  const on=typeof window.CoinQuestNative.isParentDeviceMode==='function'&&window.CoinQuestNative.isParentDeviceMode();
  const btn=document.getElementById('parentDeviceModeToggle');
  if(btn){ btn.textContent=on?'פעיל ✓ (לחץ לכיבוי)':'כבוי (לחץ להפעלה)'; btn.className='btn sm'+(on?' mint':''); }
}
function toggleParentDeviceMode(){
  if(!isNativeGameAvailable()||typeof window.CoinQuestNative.setParentDeviceMode!=='function') return;
  const wasOn=typeof window.CoinQuestNative.isParentDeviceMode==='function'&&window.CoinQuestNative.isParentDeviceMode();
  const turnOn=!wasOn;
  const apply=()=>{ window.CoinQuestNative.setParentDeviceMode(turnOn); updateParentDeviceModeCardVisibility(); toast(turnOn?'הפיקוח כובה במכשיר הזה ✓':'הפיקוח הופעל מחדש ✓'); };
  if(turnOn){
    modalConfirm('👨‍👩‍👧','זה המכשיר שלך?','זה יכבה לגמרי את הפיקוח על זמן משחק במכשיר הזה. השתמש בזה רק על המכשיר האישי של ההורה — לא על המכשיר של הילד/ה!',apply);
  }else{
    apply();
  }
}
function fillChoreReminderSettings(){
  const t=document.getElementById('choreReminderTime'); if(!t) return;
  const r=state.choreReminder||{enabled:false,hour:8,minute:0};
  t.value=String(r.hour).padStart(2,'0')+':'+String(r.minute).padStart(2,'0');
  const btn=document.getElementById('choreReminderToggle');
  if(btn) btn.textContent=r.enabled?'פעיל ✓ (לחץ לכיבוי)':'כבוי (לחץ להפעלה)';
}
// Pushes the current state.choreReminder to the native alarm, or cancels it
// if disabled. Called after any change AND once at startup so a reminder
// set on a previous install/session survives (AlarmManager registrations
// don't persist app updates the same way SharedPreferences-backed state does).
function applyChoreReminder(){
  if(!isNativeGameAvailable()) return;
  const r=state.choreReminder;
  if(r&&r.enabled) window.CoinQuestNative.scheduleChoreReminder(r.hour,r.minute);
  else if(typeof window.CoinQuestNative.cancelChoreReminder==='function') window.CoinQuestNative.cancelChoreReminder();
}
async function toggleChoreReminder(){
  const r=state.choreReminder||{enabled:false,hour:8,minute:0};
  r.enabled=!r.enabled; state.choreReminder=r;
  await DB.set('cs_chore_reminder',r);
  applyChoreReminder(); fillChoreReminderSettings();
  toast(r.enabled?'התזכורת הופעלה ✓':'התזכורת כבויה');
}
async function saveChoreReminderTime(){
  const t=document.getElementById('choreReminderTime'); if(!t||!t.value) return;
  const [h,m]=t.value.split(':').map(Number);
  const r=state.choreReminder||{enabled:false,hour:8,minute:0};
  r.hour=h; r.minute=m; state.choreReminder=r;
  await DB.set('cs_chore_reminder',r);
  applyChoreReminder();
  toast('שעת התזכורת נשמרה ✓');
}
async function startNativeGameSession(g){
  const k=cur(); if(!k) return;
  if(!isNativeGameAvailable()){
    modalMsg('📱','זמין רק באפליקציה','המשחק הזה עובד רק כשפותחים את כספת המטבעות מתוך אפליקציית האנדרואיד, לא בדפדפן.');
    return;
  }
  if(!window.CoinQuestNative.isPackageInstalled(g.androidPackage)){
    modalMsg('🤔','המשחק לא מותקן','לא מצאנו את '+g.label+' מותקן במכשיר. ודא שהוא הותקן מ-Google Play.');
    return;
  }
  // Enforcement can come from EITHER of two mechanisms, so the app works on
  // devices where one isn't achievable (notably MIUI, which blocks adb
  // device-owner provisioning without a Mi account):
  //  - Device Owner (best): the game is OS-suspended outside a paid session.
  //  - Accessibility service: blocks the game's foreground + detects leaving.
  // The floating-timer overlay permission is required in both cases. Overlay
  // and accessibility are parent-grantable from a prompt; device-owner is
  // provisioned from a computer, so if only that path is intended and it's
  // missing we still fall back to guiding the accessibility grant here.
  if(!window.CoinQuestNative.hasOverlayPermission()){
    modalConfirm('🔒','נדרשת הרשאה חד-פעמית','כדי להציג את מונה הזמן מעל המשחק, ההורה צריך לאשר פעם אחת הרשאת "חלון צף". לפתוח את ההגדרות עכשיו?',()=>{
      window.CoinQuestNative.requestOverlayPermission();
    });
    return;
  }
  const _usage=typeof window.CoinQuestNative.hasUsageAccess==='function'&&window.CoinQuestNative.hasUsageAccess();
  const _owner=typeof window.CoinQuestNative.isDeviceOwner==='function'&&window.CoinQuestNative.isDeviceOwner();
  const _acc=typeof window.CoinQuestNative.hasAccessibilityPermission==='function'&&window.CoinQuestNative.hasAccessibilityPermission();
  if(!_usage&&!_owner&&!_acc){
    modalConfirm('🔒','נדרשת הרשאה חד-פעמית','כדי לוודא שהזמן שנקנה נאכף — וכך שזה יעבוד יחד עם Family Link — ההורה צריך לאשר פעם אחת הרשאת "גישה לשימוש" (Usage access) לכספת המטבעות. לפתוח את ההגדרות עכשיו?',()=>{
      if(typeof window.CoinQuestNative.requestUsageAccess==='function') window.CoinQuestNative.requestUsageAccess();
      else if(typeof window.CoinQuestNative.requestAccessibilityPermission==='function') window.CoinQuestNative.requestAccessibilityPermission();
    });
    return;
  }
  const seconds=Math.floor(k.gtime||0);
  if(seconds<=0) return;
  // Pass the child id so the native side debits THIS child on session end, even
  // if a sibling's profile is switched to while the game runs in the foreground.
  const started=window.CoinQuestNative.startNativeSession(g.androidPackage,seconds,state.current);
  if(!started){ toast('לא הצלחתי להתחיל את המשחק'); return; }
  toast(g.emoji+' '+g.label+' נפתח! '+fmtGT(seconds)+' זמן משחק');
}
// Called by the Android bridge when a native session ends (timeout, or the
// child ending it early) — the ONLY source of truth for elapsed time, since
// nothing runs here in JS while the native game had focus. Global on
// purpose: a plain top-level function in a non-module script is reachable as
// window.onNativeGameSessionEnded, which is exactly what the Kotlin side
// calls via WebView.evaluateJavascript.
// childId is echoed back from the native side (see NativeGameBridge.notifyEnded)
// so the debit lands on the child who actually played, not on whoever is the
// active profile now. Older APKs called this with one argument -- fall back to
// state.current so a stale wrapper still debits (the old, if imperfect, behavior).
async function onNativeGameSessionEnded(consumedSeconds,childId){
  // Bathroom sessions (startBathroomSession) use this sentinel childId
  // specifically so this callback can recognize them and skip ALL wallet
  // handling -- they were never debited from anyone's coin wallet to begin
  // with (see startBathroomSession), so there's nothing to credit back either.
  if(childId===BATHROOM_SESSION_CHILD_ID){
    if(currentView==='games') renderGamesView();
    modalMsg('🚽','הזמן נגמר','זמן המשחק לשירותים הסתיים. כל הכבוד! 🎉');
    return;
  }
  const id=childId||state.current; if(!id) return;
  // Debit against the specific child. That child may not be the active profile
  // and may not be loaded in memory, so load them before touching the wallet.
  const k=state.kid[id]||await loadKid(id); if(!k) return;
  k.gtime=Math.max(0,(k.gtime||0)-Math.max(0,consumedSeconds|0));
  await DB.set('cs_gtime_'+id,k.gtime);
  // The native crash-backstop pref has now been applied -- clear it so the next
  // app launch's recovery check doesn't debit the same seconds a second time.
  if(window.CoinQuestNative&&typeof window.CoinQuestNative.clearPendingConsumed==='function'){
    try{ window.CoinQuestNative.clearPendingConsumed(); }catch(e){}
  }
  renderGameTimeBanner();
  if(currentView==='games') renderGamesView();
  scheduleSync();
  // Only surface UI for the currently-viewed child (a background debit on a
  // sibling shouldn't pop a modal at whoever is using the app now).
  if(id!==state.current) return;
  if(k.gtime<=0){
    modalMsg('⏰','הזמן נגמר!','זמן המשחק שקנית הסתיים.\nאפשר להרוויח עוד מטבעות ולהמיר אותם לזמן משחק חדש! 💪');
  }else{
    toast('סיימת לשחק — נשארו לך '+fmtGT(k.gtime)+' 🎮');
  }
}
// Startup crash-recovery: if a previous native session ended while the app
// process was dead, the onNativeGameSessionEnded callback never ran and the
// wallet was never debited. The overlay service persisted the consumed seconds
// (per tick) to native prefs; read + apply + clear them here, exactly once.
async function recoverPendingNativeConsume(){
  const N=window.CoinQuestNative;
  if(!N||typeof N.getPendingConsumedSeconds!=='function') return;
  let secs=0, id='';
  try{ secs=N.getPendingConsumedSeconds()|0; id=(N.getPendingConsumedChild&&N.getPendingConsumedChild())||''; }catch(e){ return; }
  if(secs<=0||!id) return;
  if(!state.children.some(c=>c.id===id)){ try{ N.clearPendingConsumed(); }catch(e){} return; }
  const k=state.kid[id]||await loadKid(id); if(!k){ return; }
  k.gtime=Math.max(0,(k.gtime||0)-secs);
  await DB.set('cs_gtime_'+id,k.gtime);
  try{ N.clearPendingConsumed(); }catch(e){}
  scheduleSync();
}

// Pause the drain while the app is backgrounded / screen off: the child only
// "spends" time actually spent playing. On return, restart the baseline.
document.addEventListener('visibilitychange',()=>{
  if(!_gt) return;
  if(document.hidden){
    const left=Math.max(0,gtRemaining());
    _gt.baseWallet=left; _gt.paused=true;
    gtPersist();
  } else {
    _gt.baseMono=performance.now(); _gt.paused=false;
  }
});

/* ===== REWARDS ===== */
function renderRewards(){
  renderBalance();
  const c=document.getElementById('rewardsList'); c.innerHTML='';
  if(state.rewards.length===0){ c.innerHTML='<div class="empty"><span class="e-ic">🎁</span>אין פרסים עדיין</div>'; return; }
  const bal=cur().balance;
  // The shop keeps a fixed, predictable order (no re-sorting by "closeness")
  // -- Ariel benefits from a list that never reshuffles under him. Instead,
  // the single unaffordable reward needing the FEWEST more coins gets a
  // one-time badge, so "almost there" is still obvious at a glance without
  // moving anything.
  const locked=state.rewards.filter(rw=>bal<rw.cost);
  const closestId=locked.length?locked.reduce((a,b)=>(b.cost-bal)<(a.cost-bal)?b:a).id:null;
  state.rewards.forEach(rw=>{
    const can=bal>=rw.cost;
    const pct=Math.min(100,Math.round((bal/rw.cost)*100));
    const row=document.createElement('div'); row.className='row';
    // G3 (ANDROID-APP-PLAN.md): a savings meter needs to read as "how close
    // am I" at a glance for a 7-year-old, not just a thin decorative bar --
    // the percentage number and a gold glow once it's genuinely close (70%+)
    // make the concrete "almost there" moment obvious without reading text.
    const closestBadge=rw.id===closestId?'<div class="rw-closest">⭐ הכי קרוב!</div>':'';
    row.innerHTML=`<div class="emoji">${rw.emoji}</div><div class="info">${closestBadge}<div class="t">${esc(rw.label)}</div><div class="d">${bal} / ${rw.cost} מטבעות</div>${can?'':`<div class="rw-progress${pct>=70?' near':''}"><div class="fill" style="width:${pct}%"></div></div><div class="rw-pct">${pct}%</div>`}</div>`;
    const btn=document.createElement('button');
    // Same lesson as renderGamesView's .locked rows: a real `disabled`
    // attribute swallows the tap that should EXPLAIN why it's locked. Keep
    // the button tappable and answer the child's actual question ("why
    // not?") with the concrete number still missing.
    btn.className='btn '+(can?'gold':'ghost')+' sm'; btn.textContent=can?'החלף':'אין מספיק';
    btn.onclick=()=>{ if(can) redeemReward(rw); else toast('חסרים עוד '+(rw.cost-bal)+' מטבעות 🪙 — אפשר להרוויח בסריקות ובתרגילים!'); };
    row.appendChild(btn); c.appendChild(row);
  });
}
function redeemReward(rw){
  if(cur().balance<rw.cost) return;
  modalConfirm('🎁','להחליף את "'+rw.label+'"?','זה יעלה '+rw.cost+' מטבעות.', async()=>{
    if(cur().balance<rw.cost){ toast('אין מספיק מטבעות 🪙'); renderRewards(); return; }
    await addPoints(-rw.cost,'פרס: '+rw.label,'spend'); renderRewards();
    if(rw.minutes){
      // Game-time package: credit the wallet immediately — no parent approval
      // step, the coins themselves are the approval (they were parent-verified
      // when earned). The child can start playing right away.
      const k=cur();
      k.gtime=(k.gtime||0)+rw.minutes*60;
      await DB.set('cs_gtime_'+state.current,k.gtime);
      renderGameTimeBanner();
      modalMsg('🎮','יש לך זמן משחק!','קיבלת '+rw.minutes+' דקות משחק.\nסה"כ עכשיו: '+fmtGT(k.gtime)+'.\nלחץ על "המשחקים שלי" במסך הבית כדי לשחק!');
    } else if(rw.cash){
      // Real-money reward: the parent isn't necessarily standing right here
      // (see renderChildrenAdmin's cash badge) -- keep a running "owed" tab
      // instead of a one-shot "show this to your parent" message that's easy
      // to forget, so it can be checked and paid out whenever the parent is
      // actually available, then reset in one place.
      const k=cur();
      k.cashOwed=(k.cashOwed||0)+rw.cash;
      await DB.set('cs_cash_'+state.current,k.cashOwed);
      modalMsg('💵','מזל טוב! 🎉','החלפת את: '+rw.label+'\nעכשיו ההורה חייב לך '+k.cashOwed+' ₪ — הראה להורה את המסך הזה מתישהו 😊');
    } else {
      modalMsg(rw.emoji,'מזל טוב! 🎉','החלפת את: '+rw.label+'\nהראה את המסך להורים.');
    }
  });
}

/* ===== HISTORY ===== */
function renderHistory(){
  renderBalance();
  const c=document.getElementById('historyList'); c.innerHTML='';
  const h=cur().history;
  if(h.length===0){ c.innerHTML='<div class="empty"><span class="e-ic">📜</span>עוד לא הרווחת מטבעות.<br>סרוק קוד או פתור תרגיל!</div>'; return; }
  h.forEach(x=>{
    const spend=x.points<0, ic=x.type==='scan'?'📷':x.type==='math'?'➗':x.type==='spend'?'🎁':x.type==='learn'?'⛏️':'⭐';
    const row=document.createElement('div'); row.className='row';
    row.innerHTML=`<div class="emoji">${ic}</div><div class="info"><div class="t">${esc(x.label)}</div><div class="d">${timeAgo(x.ts)}</div></div>
      <div class="pts" style="color:${spend?'var(--coral-d)':'var(--gold-d)'}">${spend?'':'+'}${x.points} <span class="mini"></span></div>`;
    c.appendChild(row);
  });
}

/* ===== ADMIN ===== */
function openAdmin(){ modalPin(()=>{ go('admin'); adminTab('children'); }); }
function exitAdmin(){ if(cur()) go('home'); else go('picker'); }
function adminTab(t){
  // Premium admin tabs open the (parent-facing, priced) paywall for a free
  // family -- otherwise a parent could configure streaks/events/badges that
  // the child-facing screens will never show, which reads as data loss.
  const tabFeature={streak:'streaks',events:'events',badges:'badges',report:'reports'}[t];
  if(tabFeature&&!gate(tabFeature)) return;
  document.querySelectorAll('.atab').forEach(b=>b.classList.toggle('active',b.dataset.atab===t));
  document.querySelectorAll('.admin-pane').forEach(p=>p.style.display='none');
  document.getElementById('pane-'+t).style.display='block';
  if(t==='children') renderChildrenAdmin();
  if(t==='chores') renderChoresAdmin();
  if(t==='streak') fillStreakAdmin();
  if(t==='actions') renderActionsAdmin();
  if(t==='qr') fillQRSelect();
  if(t==='math') fillMathConfig();
  if(t==='learn') fillLearningConfig();
  if(t==='rewards') renderRewardsAdmin();
  if(t==='games') renderGamesAdmin();
  if(t==='events') renderEventsAdmin();
  if(t==='badges') renderBadgesAdmin();
  if(t==='report') renderReportAdmin();
  if(t==='settings'){ fillAccountSettings(); fillCalmToggle(); fillChoreReminderSettings(); renderEnforcementWarning(); updateParentDeviceModeCardVisibility(); renderCalmPrefsAdmin(); fillChatAdmin(); refreshPaywallPrices(); renderPlanStatus(); warnIfDefaultPin(); }
}
// C11 (CALM-UPGRADE-PLAN): reused by the body-sensation chips (C8's log
// field) here in the parent report -- kept as its own constant rather than
// inline so it can't drift from the chip labels in index.html.
const CALM_BODY_NAMES={heart:'💓 הלב דופק מהר',fists:'✊ הידיים קפוצות',stomach:'🌀 הבטן מתהפכת',heavy:'🗿 הגוף כבד'};
async function renderCalmLogStats(){
  const el=document.getElementById('calmLogStats'); if(!el) return;
  const log=(await DB.get('cs_calmlog'))??[];
  if(!log.length){ el.innerHTML='<div class="card-sub">עדיין אין שימוש — זה בסדר גמור. הכלי מחכה לרגע שיצטרכו אותו.</div>'; return; }
  const TOOLS=CALM_TOOL_NAMES;
  const FEEL=['','😊','😕','😖','😡','😔'];
  const week=log.filter(e=>Date.now()-e.ts<7*24*3600*1000);
  const improved=log.filter(e=>e.before&&e.after&&e.after<e.before).length;
  const rated=log.filter(e=>e.before&&e.after).length;
  let html=`<div style="font-weight:800;margin-bottom:8px;">בשבוע האחרון: ${week.length} פעמים · ${rated?Math.round(improved/rated*100)+'% מהפעמים הרגיש יותר טוב אחרי':''}</div>`;
  // Per-child "what actually works" breakdown -- same effectiveness idea as
  // bestToolFor() (C5), surfaced here for the parent instead of only driving
  // the child-facing suggestion. A tool needs >=2 rated uses to be listed at
  // all (avoids a single lucky/unlucky session reading as a verdict) and
  // >=3 to be called out as THE standout in the headline line.
  state.children.forEach(ch=>{
    const mine=log.filter(e=>e.childId===ch.id&&e.before&&e.after&&e.tool);
    if(!mine.length) return;
    const byTool={};
    mine.forEach(e=>{ (byTool[e.tool]=byTool[e.tool]||[]).push(e.before-e.after); });
    const rows=Object.keys(byTool).map(tool=>{
      const arr=byTool[tool];
      return {tool,uses:arr.length,helpedPct:Math.round(arr.filter(d=>d>0).length/arr.length*100)};
    }).filter(r=>r.uses>=2).sort((a,b)=>b.helpedPct-a.helpedPct);
    if(!rows.length) return;
    const headline=rows.find(r=>r.uses>=3);
    html+=`<div style="margin-top:10px;padding-top:10px;border-top:2px solid var(--line);">`;
    if(headline) html+=`<div style="font-weight:800;font-size:.86rem;">💡 הכלי שהכי עוזר ל${esc(ch.name)}: ${TOOLS[headline.tool]||headline.tool}</div>`;
    rows.forEach(r=>{
      html+=`<div style="font-size:.78rem;color:var(--ink2);margin-top:2px;">${TOOLS[r.tool]||r.tool} — עזר ב-${r.helpedPct}% מ-${r.uses} פעמים</div>`;
    });
    const bodyCounts={};
    mine.forEach(e=>{ if(e.body) bodyCounts[e.body]=(bodyCounts[e.body]||0)+1; });
    const topBody=Object.keys(bodyCounts).sort((a,b)=>bodyCounts[b]-bodyCounts[a])[0];
    if(topBody) html+=`<div style="font-size:.78rem;color:var(--ink2);margin-top:4px;">התחושה הנפוצה לפני: ${CALM_BODY_NAMES[topBody]||topBody}</div>`;
    html+=`</div>`;
  });
  log.slice(0,6).forEach(e=>{
    const child=(state.children.find(c=>c.id===e.childId)||{}).name||'';
    html+=`<div style="display:flex;gap:8px;align-items:center;font-size:.82rem;padding:6px 0;border-bottom:1px solid var(--line);">
      <span style="flex:1;">${TOOLS[e.tool]||e.tool} · ${esc(child)}</span>
      <span>${e.before?FEEL[e.before]:'—'}←${e.after?FEEL[e.after]:'—'}</span>
      <span style="color:var(--muted);">${timeAgo(e.ts)}</span></div>`;
  });
  el.innerHTML=html;
}
async function renderErrLog(){
  const el=document.getElementById('errLogView'); if(!el) return;
  const log=(await DB.get('cs_errlog'))??[];
  if(!log.length){ el.innerHTML='<div class="card-sub">אין שגיאות 🎉</div>'; return; }
  el.innerHTML=log.slice(0,5).map(e=>
    `<div style="font-size:.74rem;padding:6px 0;border-bottom:1px solid var(--line);direction:ltr;text-align:left;font-family:monospace;">
      <b>${new Date(e.ts).toLocaleString('he-IL')}</b> [${esc(e.kind)}] ${esc(e.msg)}</div>`).join('')
    +(log.length>5?`<div class="card-sub" style="margin-top:6px;">ועוד ${log.length-5} ישנות יותר (בהעתקה מקבלים הכל)</div>`:'');
}
// Escape hatch for "the app is stuck showing something old" -- a real class
// of confusion this project has hit more than once (see sw.js's own
// CORE_LOGIC comment): Android's own "clear cache" button is ambiguous about
// whether it actually touches the Cache Storage API a service worker uses
// (some OEMs only clear the plain HTTP cache), so a parent following those
// steps can still be stuck on stale code with no way to tell. This does the
// one thing that's guaranteed to work: unregister the service worker AND
// delete every named cache it created, then hard-reload. Never touches
// family data (localStorage/IndexedDB state) -- only the SW + its caches.
function hardResetCache(){
  modalConfirm('🔄','לרענן הכל?','זה ימחק את המטמון המקומי של האפליקציה (לא את נתוני המשפחה) ויטען הכל מחדש מהשרת.',async()=>{
    try{
      if('serviceWorker' in navigator){
        const regs=await navigator.serviceWorker.getRegistrations();
        for(const r of regs) await r.unregister();
      }
      if('caches' in window){
        const keys=await caches.keys();
        for(const k of keys) await caches.delete(k);
      }
    }catch(e){ /* best-effort -- still reload even if something above failed */ }
    location.reload();
  });
}
async function copyErrLog(){
  const log=(await DB.get('cs_errlog'))??[];
  try{
    await navigator.clipboard.writeText(JSON.stringify(log,null,1));
    toast('הועתק ✓');
  }catch(e){ toast('ההעתקה נכשלה'); }
}
async function clearErrLog(){
  await DB.del('cs_errlog');
  renderErrLog(); toast('נוקה ✓');
}
function fillCalmToggle(){
  renderCalmLogStats();
  renderErrLog();
  const btn=document.getElementById('calmToggle'); if(!btn) return;
  btn.textContent=state.calmMode?'פעיל ✓':'כבוי';
  btn.className='btn sm '+(state.calmMode?'mint':'ghost');
}
// Downscale any chosen image to a small square-ish thumbnail (JPEG, ~160px)
// before storing — a full-res phone photo as a data URL would be megabytes,
// blowing up localStorage and every cloud sync. A real photo of the child
// doing the task is the evidence-based visual-schedule cue for kids on the
// spectrum, so this is worth the few KB.
function fileToThumb(file){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      const S=160, scale=Math.min(S/img.width,S/img.height,1);
      const w=Math.round(img.width*scale), h=Math.round(img.height*scale);
      const c=document.createElement('canvas'); c.width=w; c.height=h;
      c.getContext('2d').drawImage(img,0,0,w,h);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg',0.72));
    };
    img.onerror=reject;
    img.src=URL.createObjectURL(file);
  });
}
// Small round thumbnail (photo if set, else emoji) reused by the child views.
function taskIconHtml(task,size){
  const s=size||44;
  if(task.photo) return `<img src="${task.photo}" alt="" style="width:${s}px;height:${s}px;border-radius:50%;object-fit:cover;">`;
  return `<span style="font-size:${Math.round(s*0.62)}px;">${task.emoji}</span>`;
}
async function renderChildrenAdmin(){
  const c=document.getElementById('childrenAdmin'); c.innerHTML='';
  for(const ch of state.children){
    const k=await loadKid(ch.id);
    const row=document.createElement('div'); row.className='kid-admin'; row.style.setProperty('--kc',ch.color);
    // Real money "owed" tab (G-ish, elegant pending-cash affordance): only
    // shown once something is actually owed, so a parent who never uses cash
    // rewards sees no clutter. Clicking it opens the payout/reset confirm --
    // it's the one control for both "check how much" and "mark as paid".
    const cashBadge=k.cashOwed>0
      ? `<button class="ka-cash" title="שילמת? לחץ לאיפוס" onclick="adminPayOutCash('${ch.id}')">💵 ${k.cashOwed} ₪ ממתינים</button>`
      : '';
    row.innerHTML=`<div class="ka-av">${ch.emoji}</div>
      <div class="ka-info"><div class="ka-name">${esc(ch.name)}</div><div class="ka-bal">🪙 ${k.balance} מטבעות</div>${cashBadge}</div>
      <div class="ka-acts">
        <button class="icon-btn" title="ערוך" onclick="editChild('${ch.id}')">✏️</button>
        <button class="icon-btn" title="תקן יתרה" onclick="adminSetBalance('${ch.id}')">🪙</button>
        <button class="icon-btn" title="אפס" onclick="adminResetChild('${ch.id}')">♻️</button>
        <button class="icon-btn" title="מחק" onclick="adminDelChild('${ch.id}')">🗑️</button>
      </div>`;
    c.appendChild(row);
  }
  const sw=document.getElementById('newKidColorSwatches');
  if(sw) sw.innerHTML=colorSwatchesHtml('newKidColor',document.getElementById('newKidColor').value);
}
// Shared between add/edit -- this IS the "symbol" (the colored figure used
// for the blocky-theme avatar and the profile-bubble background) that was
// previously only ever auto-assigned by list position with no picker anywhere,
// while the emoji ("icon") field right next to it always had one. Same kind
// of per-child visual, same place a parent would expect to set it.
const KID_PALETTE=['#7C5CFC','#FF6B6B','#27C99A','#4DABF7','#F5B82E','#FF8FCB'];
function colorSwatchesHtml(inputId,selected){
  return KID_PALETTE.map(c=>`<button type="button" class="kid-swatch${c===selected?' sel':''}" data-color="${c}" style="background:${c};" onclick="pickKidColor('${inputId}','${c}',this)"></button>`).join('');
}
function pickKidColor(inputId,color,btn){
  document.getElementById(inputId).value=color;
  btn.parentElement.querySelectorAll('.kid-swatch').forEach(b=>b.classList.remove('sel'));
  btn.classList.add('sel');
}
async function addChild(){
  if(state.children.length>=FREE_MAX_CHILDREN&&!gate('multiChild')) return;
  const name=document.getElementById('newKidName').value.trim();
  if(!name){ toast('צריך שם'); return; }
  const emoji=document.getElementById('newKidEmoji').value.trim()||'🙂';
  const color=document.getElementById('newKidColor').value||KID_PALETTE[state.children.length%KID_PALETTE.length];
  // Age drives the math difficulty band (see MATH_TIERS); optional, and a
  // child without one simply keeps the family-wide math settings.
  const age=parseInt(document.getElementById('newKidAge').value);
  const kid={id:'k'+Date.now().toString(36),name,emoji,color};
  if(Number.isFinite(age)&&age>0) kid.age=age;
  state.children.push(kid);
  await DB.set('cs_children',state.children);
  document.getElementById('newKidName').value=''; document.getElementById('newKidEmoji').value='';
  document.getElementById('newKidColor').value=''; document.getElementById('newKidAge').value='';
  document.querySelectorAll('#newKidColorSwatches .kid-swatch').forEach(b=>b.classList.remove('sel'));
  renderChildrenAdmin(); toast('נוסף! ✓');
}
function editChild(id){
  const ch=state.children.find(c=>c.id===id);
  const usesSchedule=childUsesSchedule(ch);
  const theme=childTheme(ch);
  const themeOpt=(v,label)=>`<option value="${v}" ${theme===v?'selected':''}>${label}</option>`;
  modalContent.innerHTML=`<div class="m-emoji">${ch.emoji}</div><h3>עריכת ${esc(ch.name)}</h3>
    <div class="field" style="text-align:right;"><label>שם</label><input id="ecName" value="${esc(ch.name)}" style="width:100%;border:2px solid var(--line);border-radius:13px;padding:11px;font-family:inherit;"></div>
    <div class="field" style="text-align:right;"><label>אימוג'י</label><input id="ecEmoji" value="${ch.emoji}" maxlength="2" style="width:100%;border:2px solid var(--line);border-radius:13px;padding:11px;font-family:inherit;"></div>
    <div class="field" style="text-align:right;"><label>גיל (קובע את רמת תרגילי החשבון)</label>
      <input id="ecAge" type="number" min="3" max="18" value="${ch.age||''}" placeholder="לא הוגדר" style="width:100%;border:2px solid var(--line);border-radius:13px;padding:11px;font-family:inherit;">
    </div>
    <div class="field" style="text-align:right;"><label>צבע (הסמל/הדמות)</label>
      <input type="hidden" id="ecColor" value="${ch.color}">
      <div id="ecColorSwatches" style="display:flex;gap:8px;">${colorSwatchesHtml('ecColor',ch.color)}</div>
    </div>
    <div class="field" style="text-align:right;"><label>🎨 העולם שלו/ה באפליקציה</label>
      <select id="ecTheme" style="width:100%;border:2px solid var(--line);border-radius:13px;padding:11px;font-family:inherit;">
        ${themeOpt('none','ללא (ברירת מחדל)')}${themeOpt('blocks','⛏️ עולם הבלוקים')}${themeOpt('unicorn','🦄 חד-קרן')}
      </select>
    </div>
    <div class="field" style="display:flex;align-items:center;justify-content:space-between;">
      <label style="margin:0;">🕐 לוח יום ויזואלי (קודם→אחר כך)</label>
      <button class="btn sm ${usesSchedule?'mint':'ghost'}" id="ecSchedule" type="button">${usesSchedule?'פעיל ✓':'כבוי'}</button>
    </div>
    <div style="display:flex;gap:8px;margin-top:6px;"><button class="btn ghost" onclick="closeModal()">ביטול</button><button class="btn primary" id="ecOk">שמור</button></div>`;
  modalBg.classList.add('show');
  let scheduleOn=usesSchedule;
  document.getElementById('ecSchedule').onclick=()=>{
    scheduleOn=!scheduleOn;
    const b=document.getElementById('ecSchedule');
    b.textContent=scheduleOn?'פעיל ✓':'כבוי'; b.className='btn sm '+(scheduleOn?'mint':'ghost');
  };
  document.getElementById('ecOk').onclick=async()=>{
    ch.name=document.getElementById('ecName').value.trim()||ch.name;
    ch.emoji=document.getElementById('ecEmoji').value.trim()||ch.emoji;
    ch.color=document.getElementById('ecColor').value||ch.color;
    const newAge=parseInt(document.getElementById('ecAge').value);
    if(Number.isFinite(newAge)&&newAge>0) ch.age=newAge; else delete ch.age;
    ch.useSchedule=scheduleOn;
    ch.theme=document.getElementById('ecTheme').value;
    await DB.set('cs_children',state.children);
    if(id===state.current){ renderBalance(); renderDayStrip(); renderFirstThen(); renderChores(); applyChildTheme(id); }
    closeModal(); renderChildrenAdmin(); toast('נשמר ✓');
  };
}
async function adminSetBalance(id){
  const k=await loadKid(id), ch=state.children.find(c=>c.id===id);
  modalInput('🪙','תיקון יתרה','היתרה החדשה של '+ch.name+':',k.balance, async(v)=>{
    const n=parseInt(v); if(isNaN(n))return;
    audit('תיקן יתרה של '+ch.name+': '+k.balance+' → '+n);
    k.balance=n; await DB.set('cs_bal_'+id,n);
    if(id===state.current) renderBalance(); renderChildrenAdmin(); toast('עודכן ✓');
  });
}
async function adminResetChild(id){
  const ch=state.children.find(c=>c.id===id);
  modalConfirm('♻️','לאפס את '+ch.name+'?','היתרה וההיסטוריה של '+ch.name+' יימחקו.', async()=>{
    const k=await loadKid(id);
    k.balance=0; k.history=[]; k.daily={date:todayStr(),counts:{}}; k.mathDaily={date:todayStr(),done:0};
    await DB.set('cs_bal_'+id,0); await DB.set('cs_hist_'+id,[]); await DB.set('cs_daily_'+id,k.daily); await DB.set('cs_mathd_'+id,k.mathDaily);
    audit('איפס את '+ch.name+' (יתרה והיסטוריה)');
    if(id===state.current) renderBalance(); renderChildrenAdmin(); toast('אופס ✓');
  });
}
// Real-money reward payout confirmation + reset (see redeemReward's `cash`
// branch and the ka-cash badge in renderChildrenAdmin). Deliberately a single
// combined "did you pay them?" + reset action rather than separate check/
// reset controls -- the whole point is the parent doesn't need to remember
// to come back and clear it once they've actually handed over the money.
async function adminPayOutCash(id){
  const k=await loadKid(id), ch=state.children.find(c=>c.id===id); if(!k||!ch) return;
  modalConfirm('💵','שילמת ל'+ch.name+'?','זה יאפס את המונה של '+k.cashOwed+' ₪ שממתינים.', async()=>{
    audit('שילם ל'+ch.name+': '+k.cashOwed+' ₪');
    k.cashOwed=0; await DB.set('cs_cash_'+id,0);
    renderChildrenAdmin(); toast('סומן כשולם ✓');
  });
}
async function adminDelChild(id){
  if(state.children.length<=1){ toast('צריך לפחות ילד אחד'); return; }
  const ch=state.children.find(c=>c.id===id);
  modalConfirm('🗑️','למחוק את '+ch.name+'?','כל הנתונים של '+ch.name+' יימחקו לצמיתות.', async()=>{
    state.children=state.children.filter(c=>c.id!==id); await DB.set('cs_children',state.children);
    audit('מחק את הילד/ה '+ch.name);
    for(const p of ['cs_bal_','cs_hist_','cs_daily_','cs_mathd_','cs_badges_','cs_matht_','cs_taskt_','cs_rwt_','cs_gtime_','cs_mathlvl_','cs_learn_','cs_learnlvl_','cs_cash_']){
      await DB.del(p+id);
    }
    delete state.kid[id];
    if(state.current===id){ state.current=null; await DB.set('cs_current',null); }
    // The per-child theme/decorations are only ever removed by
    // applyChildTheme()'s no-theme branch — deleting the currently active
    // child profile bypassed that entirely and left the theme visually stuck
    // on for whoever's picked next.
    if(state.current===null){
      document.querySelector('.app').classList.remove('blocks-mode','unicorn-mode');
      removeThemeDecorations();
    }
    // Each streak challenge is assigned to one child via childId. Deleting
    // that child would otherwise leave childId pointing at a ghost id: the
    // streak silently vanishes from every UI (its guards all check
    // childId===curChild().id) and the admin dropdown shows a misleadingly
    // different child "selected" while the stored childId is still stale.
    let anyReassigned=false;
    (state.streaks||[]).forEach(s=>{
      if(s.childId===id){
        s.childId=state.children[0]?.id||null;
        s.current=0; s.best=0; s.days={}; s.wonAt=null;
        anyReassigned=true;
      }
    });
    if(anyReassigned) await DB.set('cs_streaks',state.streaks);
    renderChildrenAdmin(); toast('נמחק');
  });
}

/* ===== CHORES ADMIN ===== */
// Emoji chips showing WHICH children a task applies to; tapping toggles.
// Dim chip = child excluded. When every child is on, the kids field is
// removed entirely so the task stays in the "belongs to everyone" shape.
function kidChipsHtml(listName,i,t){
  return '<span style="display:inline-flex;gap:4px;">'+state.children.map(c=>{
    const on=taskForChild(t,c.id);
    return `<button title="${esc(c.name)}" onclick="toggleTaskKid('${listName}',${i},'${c.id}')" style="border:none;cursor:pointer;font-size:1rem;line-height:1;padding:3px 5px;border-radius:9px;background:${on?'#E7F8F0':'transparent'};opacity:${on?1:.28};">${c.emoji}</button>`;
  }).join('')+'</span>';
}
async function toggleTaskKid(listName,i,kidId){
  const arr=listName==='chores'?state.chores:state.actions;
  const t=arr[i]; if(!t) return;
  let kids=(t.kids&&t.kids.length)?[...t.kids]:state.children.map(c=>c.id);
  if(kids.includes(kidId)){
    if(kids.length===1){ toast('חייב להישאר לפחות ילד אחד למטלה'); return; }
    kids=kids.filter(k=>k!==kidId);
  }else kids.push(kidId);
  if(kids.length===state.children.length) delete t.kids; else t.kids=kids;
  await DB.set(listName==='chores'?'cs_chores':'cs_actions',arr);
  listName==='chores'?renderChoresAdmin():renderActionsAdmin();
  toast('עודכן ✓');
}
/* ---- Generic drag-to-reorder for plain admin lists (A3, ANDROID-APP-PLAN.md:
   a parent-controlled fixed order, not automatic sorting, matters for a
   child who relies on routine predictability). Same Pointer Events pattern
   as the anchored-tasks drag above, generalized to take the target array and
   a save callback instead of being anchored-specific -- added separately
   rather than refactoring the anchored version in place, so the
   already-working anchored drag stays untouched. ---- */
let _listDrag=null;
function startListDrag(ev,containerEl,array,index,onSaved){
  ev.preventDefault();
  const rows=[...containerEl.querySelectorAll('.admin-row')];
  const dragged=rows[index]; if(!dragged) return;
  const startRect=dragged.getBoundingClientRect();
  const others=rows.map((r,i)=>({i,midY:r.getBoundingClientRect().top+r.getBoundingClientRect().height/2})).filter(o=>o.i!==index);
  _listDrag={array,index,targetIndex:index,dragged,startY:ev.clientY,startTop:startRect.top,height:startRect.height,others,onSaved};
  dragged.classList.add('dragging');
  try{ dragged.setPointerCapture(ev.pointerId); }catch(e){}
  document.addEventListener('pointermove',onListDragMove);
  document.addEventListener('pointerup',onListDragEnd,{once:true});
  document.addEventListener('pointercancel',onListDragEnd,{once:true});
}
function onListDragMove(ev){
  const d=_listDrag; if(!d) return;
  const dy=ev.clientY-d.startY;
  d.dragged.style.transform='translateY('+dy+'px)';
  const draggedMidY=d.startTop+d.height/2+dy;
  let count=0;
  for(const o of d.others){ if(draggedMidY>o.midY) count++; }
  d.targetIndex=count;
}
async function onListDragEnd(){
  const d=_listDrag; if(!d) return;
  document.removeEventListener('pointermove',onListDragMove);
  d.dragged.classList.remove('dragging'); d.dragged.style.transform='';
  _listDrag=null; // clear before the await so a stray second pointerup can't double-apply
  if(d.targetIndex!==d.index){
    const [item]=d.array.splice(d.index,1);
    d.array.splice(d.targetIndex,0,item);
    await d.onSaved();
    toast('הסדר עודכן ✓');
  }
}
// G6 (ANDROID-APP-PLAN.md): curated icon set for the "add chore/action"
// forms, so a parent doesn't need to know how to open an emoji keyboard and
// a non-reading child gets a consistent, recognizable picture. Picking one
// just fills the existing free-text field -- a parent who wants a different
// emoji can still type one in directly.
const CURATED_TASK_EMOJIS=['🦷','🛏️','🎒','📚','🍽️','🧸','🚿','🚽','💊','🧦','👕','🐠','🌱','🧹','🗑️','⏰','📖','🎨','⚽','🚲'];
function renderEmojiPicker(pickerId,inputId){
  const wrap=document.getElementById(pickerId); if(!wrap||wrap.dataset.built) return;
  wrap.dataset.built='1';
  wrap.innerHTML=CURATED_TASK_EMOJIS.map(e=>`<button type="button" class="emoji-pick-btn" onclick="document.getElementById('${inputId}').value='${e}'">${e}</button>`).join('');
}

// Rich, categorized emoji gallery -- used anywhere an admin form only had a
// bare free-text emoji <input> with no picker at all (events, rewards, streak
// prizes, new-child avatar). Opens as its own modal (reusing the shared
// modalContent/modalBg the rest of the admin UI already uses), so it's only
// wired to inputs that live directly on an admin pane, NOT to inputs inside
// an already-open modal (e.g. editChild's form) -- opening it there would
// overwrite modalContent and lose the parent form underneath.
const EMOJI_CATEGORIES={
  'נפוץ':['⭐','🎉','✅','❤️','👍','🔥','🎯','🏆','💯','✨','🙌','😊','🎁','👏','💪','🙏'],
  'פרצופים':['😀','😃','😄','😁','😆','😅','🥰','😍','🤩','😎','🥳','😴','😢','😡','🤔','😇','🙃','😜','🤗','🤭'],
  'חיות':['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🦄','🐢','🐠','🐳','🦋','🐝','🕷️'],
  'אוכל':['🍎','🍌','🍇','🍓','🍒','🍉','🍕','🍔','🍟','🌭','🍿','🍩','🍪','🎂','🍦','🍫','🍬','🥤','🍭','🥗','🧁'],
  'פעילויות':['⚽','🏀','🏈','⚾','🎾','🏐','🎱','🏓','🚴','🏊','🎮','🎲','🧩','🎨','🎭','🎤','🎸','📚','✏️','🎒','🥋'],
  'עולם וטבע':['🚗','🚕','🚌','🚲','✈️','🚀','⛵','🏠','🏫','🏥','🏖️','⛰️','🌳','🌸','☀️','🌙','🌈','❄️','⛄','🌊'],
  'חגיגות':['🎁','🎈','🎊','🎉','🏆','🥇','🎖️','👑','💎','🔔','🕯️','🎀','💐','🧸','🪅','🎆'],
  'סמלים':['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💕','💖','💗','✅','❌','❓','❗','💤','⏰','📌'],
};
let _emojiPickerTarget=null;
function openEmojiPicker(inputId){
  _emojiPickerTarget=inputId;
  const cats=Object.keys(EMOJI_CATEGORIES);
  const tabsHtml=cats.map((c,i)=>`<button type="button" class="ep-tab${i===0?' active':''}" data-cat="${esc(c)}" onclick="switchEmojiCat('${esc(c)}',this)">${esc(c)}</button>`).join('');
  const gridsHtml=cats.map((c,i)=>`<div class="ep-grid emoji-picker" data-cat="${esc(c)}" style="${i===0?'':'display:none;'}">${EMOJI_CATEGORIES[c].map(e=>`<button type="button" class="emoji-pick-btn" onclick="pickEmoji('${e}')">${e}</button>`).join('')}</div>`).join('');
  modalContent.innerHTML=`<div class="m-emoji">😀</div><h3>בחר אימוג'י</h3>
    <div class="ep-tabs">${tabsHtml}</div>
    <div class="ep-grids">${gridsHtml}</div>
    <div style="display:flex;gap:8px;margin-top:14px;"><button class="btn ghost" onclick="closeModal()">סגור</button></div>`;
  modalBg.classList.add('show');
}
function switchEmojiCat(cat,btn){
  document.querySelectorAll('.ep-tab').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.ep-grid').forEach(g=>g.style.display=g.dataset.cat===cat?'':'none');
}
function pickEmoji(e){
  if(typeof _emojiPickerTarget==='function'){ _emojiPickerTarget(e); closeModal(); return; }
  const inp=document.getElementById(_emojiPickerTarget);
  if(inp) inp.value=e;
  closeModal();
}
// Variant for editing an emoji that isn't backed by a visible <input> -- e.g.
// an already-saved reward's emoji in its admin row, which (unlike the "add
// reward" form) has no input field to point openEmojiPicker() at.
function openEmojiPickerFor(onPick){ openEmojiPicker(onPick); }
// A task with no period is always available; one anchored to a period only
// shows during that window on a schedule child's home screen (see
// getTasksForTimeOfDay/periodTaskList). Single unified list -- see the
// cs_anchored_merged_v1 migration in loadState() for why this used to be two
// disconnected lists.
const CHORE_PERIOD_LABELS={'':'⏰ כל היום','morning':'🌅 בוקר','afternoon':'☀️ צהריים','evening':'🌆 ערב'};
function renderChoresAdmin(){
  renderEmojiPicker('newChoreEmojiPicker','newChoreEmoji');
  document.getElementById('sleepTime').value=state.anchored.sleep_time;
  const c=document.getElementById('choresAdmin'); c.innerHTML='';
  state.chores.forEach((ch,i)=>{
    const row=document.createElement('div'); row.className='admin-row';
    const icon=ch.photo?`<img src="${ch.photo}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;">`:`<span class="emoji">${ch.emoji}</span>`;
    const photoCtrl=ch.photo
      ? `<button class="icon-btn" title="הסר תמונה" onclick="removeChorePhoto(${i})">🖼️✖</button>`
      : `<label class="icon-btn" title="הוסף תמונה" style="cursor:pointer;">📷<input type="file" accept="image/*" capture="environment" style="display:none;" onchange="attachChorePhoto(${i},this)"></label>`;
    const periodSel=`<select style="border:2px solid var(--line);border-radius:10px;padding:5px 6px;font-family:inherit;font-size:.76rem;" onchange="updateChorePeriod(${i},this.value)">
      ${Object.entries(CHORE_PERIOD_LABELS).map(([v,l])=>`<option value="${v}" ${(ch.period||'')===v?'selected':''}>${l}</option>`).join('')}
    </select>`;
    const gapCtrl=ch.max>1
      ? `<input type="number" value="${ch.minGapMin||''}" min="0" placeholder="1 דק'" title="מרווח מינימלי בין פעמים (בדקות, ריק=רגיל)" style="width:64px;border:2px solid var(--line);border-radius:10px;padding:5px;text-align:center;font-family:inherit;font-size:.76rem;" onchange="updateChoreGap(${i},this.value)">`
      : '';
    // "Required" blocks actually PLAYING a game (not earning/banking coins)
    // until this task is done -- see pendingRequiredTasks()/beginGameLaunch().
    const requiredCtrl=`<label class="req-toggle" title="חובה לפני שאפשר לשחק"><input type="checkbox" ${ch.required?'checked':''} onchange="updateChoreRequired(${i},this.checked)"> 🎯 חובה למשחקים</label>`;
    row.innerHTML=`<span class="drag-handle" title="גרור לשינוי הסדר">⠿</span>${icon}
      <span class="t">${esc(ch.label)}<br><span style="font-size:.72rem;color:var(--muted);font-weight:400;">עד ${ch.max} פעמים ביום · </span>${kidChipsHtml('chores',i,ch)}
        <div style="margin-top:5px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">${periodSel}${gapCtrl}${photoCtrl}${requiredCtrl}</div></span>
      <input type="number" value="${ch.points}" min="1" style="width:62px;border:2px solid var(--line);border-radius:10px;padding:7px;text-align:center;font-family:inherit;font-weight:700;" onchange="updateChorePoints(${i},this.value)">
      <button class="icon-btn" onclick="delChore(${i})">🗑️</button>`;
    c.appendChild(row);
    row.querySelector('.drag-handle').addEventListener('pointerdown',ev=>
      startListDrag(ev,c,state.chores,i,async()=>{ await DB.set('cs_chores',state.chores); renderChoresAdmin(); }));
  });
}
async function updateChorePoints(i,v){ state.chores[i].points=parseInt(v)||1; await DB.set('cs_chores',state.chores); toast('עודכן ✓'); }
async function updateChorePeriod(i,v){
  if(v) state.chores[i].period=v; else delete state.chores[i].period;
  await DB.set('cs_chores',state.chores);
  if(state.chores[i].id&&cur()) { renderChores(); renderDayStrip(); renderFirstThen(); }
  toast('עודכן ✓');
}
async function updateChoreGap(i,v){
  const n=parseInt(v);
  if(n>0) state.chores[i].minGapMin=n; else delete state.chores[i].minGapMin;
  await DB.set('cs_chores',state.chores); toast('עודכן ✓');
}
async function updateChoreRequired(i,checked){
  if(checked) state.chores[i].required=true; else delete state.chores[i].required;
  await DB.set('cs_chores',state.chores); toast('עודכן ✓');
}
async function attachChorePhoto(i,input){
  const f=input.files&&input.files[0]; input.value=''; if(!f) return;
  try{
    state.chores[i].photo=await fileToThumb(f);
    await DB.set('cs_chores',state.chores);
    renderChoresAdmin(); toast('התמונה נוספה ✓');
  }catch(e){ toast('לא הצלחתי לטעון את התמונה'); }
}
async function removeChorePhoto(i){
  delete state.chores[i].photo;
  await DB.set('cs_chores',state.chores);
  renderChoresAdmin(); toast('התמונה הוסרה');
}
async function delChore(i){ await delWithUndo(state.chores,i,'cs_chores',renderChoresAdmin,'המטלה'); }
async function addChore(){
  if(state.chores.length>=FREE_MAX_CHORES&&!gate('moreChores')) return;
  const label=document.getElementById('newChoreLabel').value.trim(); if(!label){ toast('צריך שם למטלה'); return; }
  const emoji=document.getElementById('newChoreEmoji').value.trim()||'⭐';
  const points=parseInt(document.getElementById('newChorePoints').value)||5, max=parseInt(document.getElementById('newChoreMax').value)||1;
  const period=document.getElementById('newChorePeriod').value;
  const required=document.getElementById('newChoreRequired').checked;
  const task={id:'chore_'+Date.now().toString(36),label,emoji,points,max};
  if(period) task.period=period;
  if(required) task.required=true;
  state.chores.push(task); await DB.set('cs_chores',state.chores);
  document.getElementById('newChoreLabel').value=''; document.getElementById('newChoreEmoji').value='';
  document.getElementById('newChoreRequired').checked=false;
  renderChoresAdmin(); toast('נוסף! ✓');
}
async function updateSleepTime(){
  const time=parseInt(document.getElementById('sleepTime').value);
  if(time<20||time>23){ toast('בחר שעה בין 20-23'); return; }
  state.anchored.sleep_time=time;
  await DB.set('cs_anchored',state.anchored);
  toast('עודכן ✓');
}

/* ===== WEEKLY REPORT ===== */
async function renderReportAdmin(){
  const el=document.getElementById('reportContent'); if(!el) return;
  el.innerHTML='<div class="card-sub" style="text-align:center;">טוען...</div>';
  const weekAgo=Date.now()-7*24*3600*1000;
  let html='';
  for(const ch of state.children){
    const k=await loadKid(ch.id);
    const week=(k.history||[]).filter(h=>h.ts>=weekAgo);
    const earned=week.filter(h=>h.points>0).reduce((s,h)=>s+h.points,0);
    const spent=-week.filter(h=>h.points<0).reduce((s,h)=>s+h.points,0);
    const tasks=week.filter(h=>h.type==='chore'||h.type==='scan').length;
    const math=week.filter(h=>h.type==='math').length;
    const rewards=week.filter(h=>h.type==='spend').length;
    const learnCorrect=week.filter(h=>h.type==='learn').length;
    // Weak spots: questions this child got wrong more than right, still in a
    // low spaced-repetition box (i.e. not yet mastered) — worth practicing
    // together. Computed straight from k.learn.progress, no extra storage.
    const weakSpots=Object.entries(k.learn?.progress||{})
      .filter(([,p])=>(p.wrong||0)>(p.correct||0) && (p.box||0)<3)
      .map(([qid])=>QUESTION_BANK.find(q=>q.id===qid)||(state.learning.customQuestions||[]).find(q=>q.id===qid))
      .filter(Boolean).slice(0,3);
    // most-repeated earn labels this week (which routines actually happen)
    const byLabel={};
    week.filter(h=>h.points>0).forEach(h=>{ byLabel[h.label]=(byLabel[h.label]||0)+1; });
    const top=Object.entries(byLabel).sort((a,b)=>b[1]-a[1]).slice(0,3);
    const streakRows=state.streaks.filter(s=>s.childId===ch.id)
      .map(s=>`<div style="font-size:.82rem;">${s.icon||'🌟'} ${esc(s.title)}: רצף ${s.current} · שיא ${s.best} · יעד ${s.goal}</div>`).join('');
    html+=`<div class="card">
      <div class="card-h">${ch.emoji} ${esc(ch.name)}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0;text-align:center;">
        <div style="flex:1;min-width:70px;background:#FFF6E0;border-radius:14px;padding:10px 6px;"><div style="font-size:1.3rem;font-weight:900;color:var(--gold-d);">+${earned}</div><div style="font-size:.7rem;color:var(--ink2);">מטבעות הרוויח</div></div>
        <div style="flex:1;min-width:70px;background:#FDEBEC;border-radius:14px;padding:10px 6px;"><div style="font-size:1.3rem;font-weight:900;color:var(--coral-d);">-${spent}</div><div style="font-size:.7rem;color:var(--ink2);">מטבעות הוציא</div></div>
        <div style="flex:1;min-width:70px;background:#E7F8F0;border-radius:14px;padding:10px 6px;"><div style="font-size:1.3rem;font-weight:900;color:var(--mint-d);">${tasks}</div><div style="font-size:.7rem;color:var(--ink2);">מטלות הושלמו</div></div>
        <div style="flex:1;min-width:70px;background:#EDF3FF;border-radius:14px;padding:10px 6px;"><div style="font-size:1.3rem;font-weight:900;color:#4DABF7;">${math}</div><div style="font-size:.7rem;color:var(--ink2);">תרגילי חשבון</div></div>
        <div style="flex:1;min-width:70px;background:#F5F0FF;border-radius:14px;padding:10px 6px;"><div style="font-size:1.3rem;font-weight:900;color:var(--purple,#7C5CFC);">${rewards}</div><div style="font-size:.7rem;color:var(--ink2);">פרסים נקנו</div></div>
        <div style="flex:1;min-width:70px;background:#EFE7DC;border-radius:14px;padding:10px 6px;"><div style="font-size:1.3rem;font-weight:900;color:#8B5A3C;">${learnCorrect}</div><div style="font-size:.7rem;color:var(--ink2);">תשובות נכונות במכרה הידע</div></div>
      </div>
      ${top.length?'<div style="font-size:.82rem;font-weight:700;margin-bottom:4px;">מה חוזר הכי הרבה השבוע:</div>'+top.map(([l,n])=>`<div style="font-size:.82rem;color:var(--ink2);">· ${esc(l)} — ${n} פעמים</div>`).join(''):'<div class="card-sub">אין פעילות השבוע עדיין</div>'}
      ${streakRows?'<div style="margin-top:8px;">'+streakRows+'</div>':''}
      ${k.learnLevel?`<div style="margin-top:8px;font-size:.82rem;">⛏️ רמות למידה: חשבון ${k.learnLevel.math||1}/3 · אנגלית ${k.learnLevel.english||1}/3 · מדעים ${k.learnLevel.science||1}/3</div>`:''}
      ${weakSpots.length?'<div style="margin-top:8px;font-size:.82rem;font-weight:700;">💡 כדאי לתרגל ביחד:</div>'+weakSpots.map(q=>`<div style="font-size:.8rem;color:var(--ink2);">· ${esc(q.q)}</div>`).join(''):''}
    </div>`;
  }
  // calm-tools usage (family-wide, same source as the settings card)
  const log=(await DB.get('cs_calmlog'))??[];
  const calmWeek=log.filter(e=>e.ts>=weekAgo);
  if(calmWeek.length){
    const rated=calmWeek.filter(e=>e.before&&e.after);
    const improved=rated.filter(e=>e.after<e.before).length;
    html+=`<div class="card"><div class="card-h">🌿 כלי רגיעה השבוע</div>
      <div class="card-sub">${calmWeek.length} שימושים${rated.length?' · ב-'+Math.round(improved/rated.length*100)+'% מהפעמים הרגיש יותר טוב אחרי':''}</div></div>`;
  }
  // parent audit trail (synced — both parents see who did what)
  const alog=state.auditLog||[];
  if(alog.length){
    html+=`<div class="card"><div class="card-h">📝 יומן פעולות הורים</div>`+
      alog.slice(0,12).map(e=>`<div style="display:flex;gap:8px;font-size:.8rem;padding:5px 0;border-bottom:1px solid var(--line);">
        <span style="flex:1;">${esc(e.action)}</span>
        <span style="color:var(--muted);white-space:nowrap;">${esc((e.who||'').split('@')[0])} · ${timeAgo(e.ts)}</span></div>`).join('')+`</div>`;
  }
  el.innerHTML=html||'<div class="empty"><span class="e-ic">📊</span>אין נתונים עדיין</div>';
}

/* ===== STREAK ADMIN ===== */
let adminStreakId=null;
// `explicitId`: passed by the <select>'s own onchange (this.value -- the
// selection the user just picked, before adminStreakId itself has been
// updated to match) so it wins over whatever adminStreakId still holds.
// Callers that already set adminStreakId themselves first (addStreak,
// delStreak) call this with no argument, so THEIR choice wins instead of
// whatever the <select> happened to display previously.
function fillStreakAdmin(explicitId){
  const sel=document.getElementById('streakSel');
  sel.innerHTML='';
  state.streaks.forEach(st=>{ const o=document.createElement('option'); o.value=st.id; o.textContent=(st.icon||'🌟')+' '+st.title; sel.appendChild(o); });
  const requested=explicitId||adminStreakId;
  adminStreakId=requested&&getStreak(requested)?requested:state.streaks[0].id;
  sel.value=adminStreakId;
  const s=getStreak(adminStreakId);
  document.getElementById('streakTitle').value=s.title;
  document.getElementById('streakIcon').value=s.icon||'🌟';
  const childSel=document.getElementById('streakChildSel'); childSel.innerHTML='';
  state.children.forEach(c=>{ const o=document.createElement('option'); o.value=c.id; o.textContent=c.emoji+' '+c.name; if(c.id===s.childId) o.selected=true; childSel.appendChild(o); });
  document.getElementById('streakGoal').value=s.goal;
  document.getElementById('streakRewardEmoji').value=s.rewardEmoji;
  document.getElementById('streakRewardLabel').value=s.rewardLabel;
  const childName=(state.children.find(c=>c.id===s.childId)||{}).name||'—';
  document.getElementById('streakAdminStats').innerHTML=
    `<div style="font-size:2rem;font-weight:900;color:var(--gold-d);">${s.icon||'🔥'} ${s.current}</div>
     <div style="font-size:.82rem;color:var(--ink2);">רצף נוכחי של ${esc(childName)} · שיא: ${s.best} · מטרה: ${s.goal}</div>`;
  renderAdminCalendar();
  fillStreakFreezeStatus();
}
async function addStreak(){
  const s={id:'streak_'+Date.now().toString(36),title:'אתגר חדש',dayWord:'אתגר חדש',icon:'🌟',
    childId:(state.children[0]||{}).id||'',goal:14,rewardLabel:'פרס','rewardEmoji':'🎁',days:{},current:0,best:0,wonAt:null};
  state.streaks.push(s);
  await DB.set('cs_streaks',state.streaks);
  scheduleSync();
  adminStreakId=s.id;
  fillStreakAdmin();
  toast('אתגר נוסף — ערוך את הפרטים ושמור ✓');
}
async function delStreak(){
  if(state.streaks.length<=1){ toast('צריך לפחות אתגר רצף אחד'); return; }
  const s=getStreak(adminStreakId); if(!s) return;
  modalConfirm('🗑️','למחוק את "'+s.title+'"?','כל ההיסטוריה של האתגר הזה (הרצף הנוכחי, השיא, הלוח) תימחק לצמיתות.', async()=>{
    state.streaks=state.streaks.filter(x=>x.id!==adminStreakId);
    await DB.set('cs_streaks',state.streaks);
    scheduleSync();
    adminStreakId=null; // fillStreakAdmin falls back to state.streaks[0]
    fillStreakAdmin();
    toast('האתגר נמחק');
  });
}
async function saveStreakConfig(){
  const s=getStreak(adminStreakId); if(!s) return;
  s.title=document.getElementById('streakTitle').value.trim()||s.title;
  s.dayWord=s.title; // shown in child-facing copy ("today was a ___ day!") -- always matches the title, one field to manage instead of two
  s.icon=document.getElementById('streakIcon').value.trim()||'🌟';
  const newChildId=document.getElementById('streakChildSel').value;
  if(newChildId!==s.childId){
    // Reassigning to a different child must not hand them the previous
    // child's progress/calendar/win-flag — every UI that reads s.current/
    // s.best/s.days/s.wonAt has no per-child scoping of its own, it all
    // trusts s.childId to mean "this data belongs to that one child".
    s.current=0; s.best=0; s.days={}; s.wonAt=null;
  }
  s.childId=newChildId;
  s.goal=parseInt(document.getElementById('streakGoal').value)||30;
  s.rewardEmoji=document.getElementById('streakRewardEmoji').value.trim()||'🎮';
  s.rewardLabel=document.getElementById('streakRewardLabel').value.trim()||'פרס';
  await DB.set('cs_streaks',state.streaks);
  scheduleSync();
  fillStreakAdmin(); toast('נשמר ✓');
}
function renderAdminCalendar(){
  const s=getStreak(adminStreakId); if(!s) return;
  const now=new Date();
  const {dowHtml,gridHtml}=buildCalendar(now.getFullYear(), now.getMonth(), s.days, true, 'cycleAdminDay', dateKey(now));
  document.getElementById('adminCalMonthLabel').textContent=now.toLocaleDateString('he-IL',{month:'long',year:'numeric'});
  document.getElementById('adminCalDow').innerHTML=dowHtml;
  document.getElementById('adminCalGrid').innerHTML=gridHtml;
}
async function cycleAdminDay(key){
  const s=getStreak(adminStreakId); if(!s) return;
  const cur=s.days[key];
  // cycle: none -> clean -> accident -> none
  if(!cur) s.days[key]='clean';
  else if(cur==='clean') s.days[key]='accident';
  else delete s.days[key];
  recomputeStreak(adminStreakId);
  await DB.set('cs_streaks',state.streaks);
  scheduleSync();
  fillStreakAdmin();
  renderStreakBanner();
  if(currentView==='streak') renderStreakView();
}
function recomputeStreak(id){
  // recompute current streak by walking backward from today through consecutive marked clean days
  const s=getStreak(id); if(!s) return;
  let count=0, best=s.best||0;
  let cursor=new Date();
  // if today not marked yet, start counting from yesterday backward
  if(!s.days[dateKey(cursor)]){ cursor.setDate(cursor.getDate()-1); }
  while(true){
    const k=dateKey(cursor);
    // 'frozen' = a parent-granted grace day ("יום חסד") — bridges the streak
    // exactly like a clean day, so one hard/forgotten day doesn't wipe out
    // weeks of effort (which for this kid means a meltdown AND losing the
    // whole motivation loop).
    if(s.days[k]==='clean'||s.days[k]==='frozen'){ count++; cursor.setDate(cursor.getDate()-1); }
    else break;
  }
  s.current=count;
  if(s.current>best) best=s.current;
  s.best=best;
  if(s.current>=s.goal && !s.wonAt) s.wonAt=Date.now();
  // Note: wonAt is intentionally sticky once earned -- a streak that later drops
  // below goal keeps its "was won" record (the prize was already given), so it
  // is deliberately NOT cleared here.
}
/* -- streak freeze ("grace day"): bridge ONE recent missed day, max once per 14 days -- */
const FREEZE_COOLDOWN_MS=14*24*3600*1000;
function fillStreakFreezeStatus(){
  const s=getStreak(adminStreakId); if(!s) return;
  const btn=document.getElementById('streakFreezeBtn'), st=document.getElementById('streakFreezeStatus');
  if(!btn||!st) return;
  const left=s.freezeUsedAt?FREEZE_COOLDOWN_MS-(Date.now()-s.freezeUsedAt):0;
  if(left>0){
    btn.disabled=true; btn.style.opacity=.5;
    st.textContent='יהיה זמין שוב בעוד '+Math.ceil(left/86400000)+' ימים';
  }else{
    btn.disabled=false; btn.style.opacity=1;
    st.textContent='';
  }
}
async function applyStreakFreeze(){
  const s=getStreak(adminStreakId); if(!s) return;
  if(s.freezeUsedAt&&Date.now()-s.freezeUsedAt<FREEZE_COOLDOWN_MS){ toast('יום חסד כבר נוצל בשבועיים האחרונים'); return; }
  // find the most recent UNMARKED day among the 3 days before today —
  // accidents stay accidents (freeze forgives forgetting, not incidents)
  let target=null;
  for(let back=1;back<=3;back++){
    const d=new Date(); d.setDate(d.getDate()-back);
    const k=dateKey(d);
    if(!s.days[k]){ target=k; break; }
    if(s.days[k]==='clean'||s.days[k]==='frozen') continue;
    break; // hit an accident — nothing to bridge past it
  }
  if(!target){ toast('אין יום חסר לגשר — הרצף שלם 🎉'); return; }
  s.days[target]='frozen';
  s.freezeUsedAt=Date.now();
  audit('הפעיל יום חסד באתגר "'+s.title+'" ('+target+')');
  recomputeStreak(adminStreakId);
  await DB.set('cs_streaks',state.streaks);
  scheduleSync();
  fillStreakAdmin(); renderStreakBanner();
  if(currentView==='streak') renderStreakView();
  toast('🧊 יום החסד הופעל — הרצף ניצל!');
}
function adminReportAccidentToday(){
  modalConfirm('🚨','לדווח על תקרית היום?','הרצף יתאפס ל-0. ניתן עדיין לערוך ימים בלוח.', async()=>{
    const s=getStreak(adminStreakId); if(!s) return;
    const k=dateKey(new Date());
    s.days[k]='accident'; s.current=0;
    audit('דיווח תקרית באתגר "'+s.title+'"');
    await DB.set('cs_streaks',state.streaks);
    scheduleSync();
    fillStreakAdmin(); renderStreakBanner();
    if(currentView==='streak') renderStreakView();
    toast('עודכן — הרצף התאפס');
  });
}

function renderActionsAdmin(){
  renderEmojiPicker('newActEmojiPicker','newActEmoji');
  const c=document.getElementById('actionsAdmin'); c.innerHTML='';
  state.actions.forEach((a,i)=>{
    const row=document.createElement('div'); row.className='admin-row';
    row.innerHTML=`<span class="drag-handle" title="גרור לשינוי הסדר">⠿</span><span class="emoji">${a.emoji}</span><span class="t">${esc(a.label)}<br><span style="font-size:.72rem;color:var(--muted);font-weight:400;">עד ${a.max} פעמים ביום · </span>${kidChipsHtml('actions',i,a)}</span>
      <input type="number" value="${a.points}" min="1" style="width:62px;border:2px solid var(--line);border-radius:10px;padding:7px;text-align:center;font-family:inherit;font-weight:700;" onchange="updateActionPoints(${i},this.value)">
      <button class="icon-btn" onclick="delAction(${i})">🗑️</button>`;
    c.appendChild(row);
    row.querySelector('.drag-handle').addEventListener('pointerdown',ev=>
      startListDrag(ev,c,state.actions,i,async()=>{ await DB.set('cs_actions',state.actions); renderActionsAdmin(); }));
  });
}
async function updateActionPoints(i,v){ state.actions[i].points=parseInt(v)||1; await DB.set('cs_actions',state.actions); toast('עודכן ✓'); }
async function delAction(i){ await delWithUndo(state.actions,i,'cs_actions',renderActionsAdmin,'הפעולה'); }
async function addAction(){
  const label=document.getElementById('newActLabel').value.trim(); if(!label){ toast('צריך שם לפעולה'); return; }
  const emoji=document.getElementById('newActEmoji').value.trim()||'⭐';
  const points=parseInt(document.getElementById('newActPoints').value)||5, max=parseInt(document.getElementById('newActMax').value)||1;
  state.actions.push({id:'a'+Date.now().toString(36),label,emoji,points,max}); await DB.set('cs_actions',state.actions);
  document.getElementById('newActLabel').value=''; document.getElementById('newActEmoji').value=''; renderActionsAdmin(); toast('נוסף! ✓');
}
function fillQRSelect(){
  const s=document.getElementById('qrSelect'); s.innerHTML='';
  // Chores
  if(state.chores.length){
    const g=document.createElement('optgroup'); g.label='🧹 מטלות';
    state.chores.forEach(a=>{ const o=document.createElement('option'); o.value='chore|'+a.id; o.textContent=a.emoji+' '+a.label+' ('+a.points+' מטבעות)'; g.appendChild(o); });
    s.appendChild(g);
  }
  // Actions
  if(state.actions.length){
    const g=document.createElement('optgroup'); g.label='🏆 פעולות';
    state.actions.forEach(a=>{ const o=document.createElement('option'); o.value='action|'+a.id; o.textContent=a.emoji+' '+a.label+' ('+a.points+' מטבעות)'; g.appendChild(o); });
    s.appendChild(g);
  }
  document.getElementById('qrResult').style.display='none';
  document.getElementById('streakQrResult').style.display='none';
  const ssel=document.getElementById('qrStreakSelect'); ssel.innerHTML='';
  state.streaks.forEach(st=>{ const o=document.createElement('option'); o.value=st.id; o.textContent=(st.icon||'🌟')+' '+st.title; ssel.appendChild(o); });
}
// QR tokens are MINIMAL — id only. The redeem path always reads points/label
// from the stored config, never from the token (anti-forgery), so shipping
// the label inside the QR was pure downside: Hebrew+emoji tokens overflow
// qrcodejs's byte budget ("code length overflow", hit live with the
// good-behavior streak), and it made the manual-typing code unusably long.
let _lastQR=null; // {box, caption} of the last generated code, for image export
function makeQR(){
  const val=document.getElementById('qrSelect').value; if(!val) return;
  const [type,id]=val.split('|');
  const a=(type==='chore'?state.chores:state.actions).find(x=>x.id===id); if(!a) return;
  const token='CSQR|'+a.id;
  const box=document.getElementById('qrBox'); box.innerHTML='';
  new QRCode(box,{text:token,width:200,height:200,colorDark:'#2A2440',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
  document.getElementById('qrLabel').textContent=a.emoji+' '+a.label+' · '+a.points+' מטבעות';
  document.getElementById('qrToken').textContent='קוד להקלדה ידנית: '+a.id;
  document.getElementById('qrResult').style.display='block';
  _lastQR={boxId:'qrBox',caption:[a.emoji+' '+a.label, a.points+' מטבעות'],file:'qr-'+a.id};
}
function makeStreakQR(){
  const s=getStreak(document.getElementById('qrStreakSelect').value); if(!s) return;
  const token='CSSTREAK|'+s.id;
  const box=document.getElementById('streakQrBox'); box.innerHTML='';
  new QRCode(box,{text:token,width:200,height:200,colorDark:'#D99409',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
  document.getElementById('streakQrLabel').innerHTML=esc(s.rewardEmoji+' '+s.rewardLabel+' — פרס '+s.goal+' ימים ('+s.title+')')+
    '<br><span class="qr-token" style="font-size:.8rem;">קוד להקלדה ידנית: '+esc(token)+'</span>';
  document.getElementById('streakQrResult').style.display='block';
  _lastQR={boxId:'streakQrBox',caption:['🏆 פרס אתגר: '+s.title, s.rewardLabel+' — '+s.goal+' ימים'],file:'qr-streak-'+s.id};
}
// Compose the QR + a human caption onto one canvas and download as PNG, so a
// parent can print it or keep it on the computer ("what does this code give?"
// is readable on the image itself).
function downloadQRImage(boxId,captionLines,filename){
  const box=document.getElementById(boxId);
  const src=box.querySelector('canvas')||box.querySelector('img');
  if(!src){ toast('צור קודם קוד QR'); return; }
  const W=520,QS=380;
  const H=QS+90+captionLines.length*44;
  const c=document.createElement('canvas'); c.width=W; c.height=H;
  const ctx=c.getContext('2d');
  ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,W,H);
  ctx.imageSmoothingEnabled=false; // keep QR modules crisp when upscaling
  ctx.drawImage(src,(W-QS)/2,40,QS,QS);
  ctx.fillStyle='#2A2440'; ctx.textAlign='center';
  captionLines.forEach((line,i)=>{
    ctx.font=(i===0?'bold 30px':'24px')+' Arial, sans-serif';
    ctx.fillText(line,W/2,QS+80+i*44,W-40);
  });
  const a=document.createElement('a');
  a.href=c.toDataURL('image/png');
  a.download=(filename||'coin-quest-qr')+'.png';
  document.body.appendChild(a); a.click(); a.remove();
  toast('התמונה ירדה ✓');
}
function saveLastQR(which){
  if(!_lastQR||_lastQR.boxId!==which){ toast('צור קודם קוד QR'); return; }
  downloadQRImage(_lastQR.boxId,_lastQR.caption,_lastQR.file);
}
function fillMathConfig(){
  const m=state.math;
  document.getElementById('mathMax').value=m.maxNum; document.getElementById('mathPts').value=m.pts; document.getElementById('mathDaily').value=m.daily;
  document.getElementById('mathToggle').textContent=m.enabled?'פעיל ✓':'כבוי';
  document.getElementById('mathToggle').className='btn sm '+(m.enabled?'mint':'ghost');
  document.querySelectorAll('#opChips .chip').forEach(ch=>ch.classList.toggle('on',m.ops.includes(ch.dataset.op)));
  renderMathLevels();
}
async function renderMathLevels(){
  const el=document.getElementById('mathLevels'); if(!el) return;
  const rows=[];
  for(const ch of state.children){
    const lvl=(await DB.get('cs_mathlvl_'+ch.id))??1;
    const auto=tierForAge(ch.age);
    const tier=childMathTier(ch);
    const autoLabel=auto?('אוטומטי לפי גיל — '+auto.short):'אוטומטי לפי גיל (לא הוגדר גיל)';
    const opts=[`<option value="" ${ch.mathTier?'':'selected'}>${esc(autoLabel)}</option>`]
      .concat(MATH_TIERS.map(t=>`<option value="${t.id}" ${ch.mathTier===t.id?'selected':''}>${esc(t.label)}</option>`)).join('');
    // Shows the RESULT of the tier+ops resolution, not just the setting -- a
    // parent shouldn't have to reason about how the band and the global op
    // chips combine to know what their child will actually be asked.
    const effOps=tier?(state.math.ops.filter(o=>tier.ops.includes(o)).length?state.math.ops.filter(o=>tier.ops.includes(o)):tier.ops):state.math.ops;
    const effMax=tier?tier.maxNum:state.math.maxNum;
    rows.push(`<div style="padding:10px 0;border-bottom:1px solid var(--line);">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="font-weight:800;">${ch.emoji} ${esc(ch.name)}</span>
        <span style="font-size:.76rem;color:var(--muted);">${ch.age?('גיל '+ch.age):'גיל לא הוגדר — ערוך בלשונית 👧 ילדים'}</span>
      </div>
      <select style="width:100%;border:2px solid var(--line);border-radius:10px;padding:7px;font-family:inherit;font-size:.8rem;margin-bottom:6px;" onchange="setChildMathTier('${ch.id}',this.value)">${opts}</select>
      <div style="font-size:.76rem;color:var(--ink2);margin-bottom:6px;">בפועל: מספרים עד ${effMax} · פעולות ${effOps.join(' ')}</div>
      <div style="display:flex;align-items:center;gap:8px;font-size:.8rem;">
        <span style="flex:1;">${'⭐'.repeat(lvl)}${'·'.repeat(5-lvl)} רמה מסתגלת ${lvl}/5</span>
        <button class="icon-btn" title="אפס רמה" onclick="resetMathLevel('${ch.id}')">↺</button>
      </div></div>`);
  }
  el.innerHTML=rows.join('');
}
async function setChildMathTier(id,tierId){
  const ch=state.children.find(c=>c.id===id); if(!ch) return;
  if(tierId) ch.mathTier=tierId; else delete ch.mathTier;
  await DB.set('cs_children',state.children);
  // Reset the adaptive level with the band: level 4/5 of "up to 20" means
  // something completely different in "up to 200", and carrying it across
  // would drop a child straight into problems far past the new band's start.
  await DB.set('cs_mathlvl_'+id,1);
  if(state.kid[id]) state.kid[id].mathLevel=1;
  renderMathLevels(); toast('עודכן ✓');
}
async function resetMathLevel(id){
  await DB.set('cs_mathlvl_'+id,1);
  if(state.kid[id]) state.kid[id].mathLevel=1;
  renderMathLevels(); toast('הרמה אופסה ✓');
}
function fillLearningConfig(){
  document.getElementById('learnToggle').textContent=state.learning.enabled?'פעיל ✓':'כבוי';
  document.querySelectorAll('#learnSubjChips .chip').forEach(c=>c.classList.toggle('on',!!state.learning.subjects[c.dataset.subj]));
  document.getElementById('learnCoinsPerCorrect').value=state.learning.coinsPerCorrect;
  document.getElementById('learnSessionBonus').value=state.learning.sessionBonus;
  document.getElementById('learnDailyMaxCoins').value=state.learning.dailyMaxCoins;
  document.getElementById('learnMinutesPerSession').value=state.learning.minutesPerSession;
  document.getElementById('learnDailyMaxMinutes').value=state.learning.dailyMaxMinutes;
  document.getElementById('learnGateToggle').textContent=state.learning.gateEnabled?'פעיל ✓':'כבוי';
  document.getElementById('learnReadAloudToggle').textContent=state.learning.readAloud!==false?'פעיל ✓':'כבוי';
  renderTtsVoiceWarning();
  renderTtsDiagnostics();
  renderCustomQuestionsAdmin();
}
// Surfaces the actual root cause when quiz questions go silently unspoken:
// the native TTS engine is ready but has no Hebrew voice/language pack
// installed (a separate download on many Android TTS engines) -- previously
// this failed completely silently, reading as "the feature is just broken"
// rather than a one-time device setting the parent can fix themselves.
function renderTtsVoiceWarning(){
  const el=document.getElementById('ttsVoiceWarning'); if(!el) return;
  const missing=nativeTtsAvailable()
    &&typeof window.CoinQuestNative.hasVoiceForLanguage==='function'
    &&!window.CoinQuestNative.hasVoiceForLanguage('he-IL');
  el.style.display=missing?'block':'none';
}
function openTtsVoiceSettings(){
  if(window.CoinQuestNative&&typeof window.CoinQuestNative.openTtsSettings==='function') window.CoinQuestNative.openTtsSettings();
}
// The engine picker -- the screen that actually helps when the current engine
// has no Hebrew (see NativeGameBridge.openTtsEngineSettings). Falls back to
// the install-data screen on an APK built before that method existed, so the
// button still does something on a device that hasn't been updated yet.
function openTtsEngineSettings(){
  const n=window.CoinQuestNative; if(!n) return;
  if(typeof n.openTtsEngineSettings==='function') n.openTtsEngineSettings();
  else if(typeof n.openTtsSettings==='function') n.openTtsSettings();
}
/* ---- read-aloud diagnostics ----
   "There's just no speech" has at least four distinct causes that look
   identical from the outside: the read-aloud switch is off (and it's a SYNCED
   family setting, so joining another family can turn it off on a device that
   had it on), the installed APK predates the native TTS bridge, the Android
   engine has no Hebrew voice pack, or the device is simply muted. Reporting
   each layer separately turns "it's broken" into one specific thing to fix. */
function ttsDiagnostics(){
  const bridge=!!(window.CoinQuestNative&&typeof window.CoinQuestNative.ttsSpeak==='function');
  const engineReady=nativeTtsAvailable();
  const canAskVoice=bridge&&typeof window.CoinQuestNative.hasVoiceForLanguage==='function';
  const hebrewNative=canAskVoice?window.CoinQuestNative.hasVoiceForLanguage('he-IL'):null;
  let hebrewWeb=null;
  if(WEB_TTS_SUPPORTED){
    try{ hebrewWeb=speechSynthesis.getVoices().some(v=>/^he/i.test(v.lang||'')); }catch(e){ hebrewWeb=null; }
  }
  // Only present on an APK new enough to expose it (see ttsEngineInfo).
  let engines=[];
  try{
    if(bridge&&typeof window.CoinQuestNative.ttsEngineInfo==='function'){
      engines=(window.CoinQuestNative.ttsEngineInfo()||'').split(',').filter(Boolean).map(s=>{
        const isDefault=s.startsWith('*');
        const [name,label]=(isDefault?s.slice(1):s).split('|');
        return {name,label,isDefault};
      });
    }
  }catch(e){}
  return {bridge,engineReady,canAskVoice,hebrewNative,hebrewWeb,engines,
    readAloud:state.learning.readAloud!==false,
    webSupported:WEB_TTS_SUPPORTED,
    inApp:!!window.CoinQuestNative};
}
function renderTtsDiagnostics(){
  const el=document.getElementById('ttsDiag'); if(!el) return;
  const d=ttsDiagnostics();
  const row=(ok,label)=>`<div style="padding:2px 0;">${ok===null?'❔':(ok?'✅':'❌')} ${label}</div>`;
  let html='';
  html+=row(d.readAloud,'ההקראה מופעלת בהגדרות (המתג למעלה)');
  html+=row(d.inApp,'רץ בתוך אפליקציית האנדרואיד (לא בדפדפן)');
  html+=row(d.bridge,'גרסת האפליקציה תומכת בהקראה');
  if(d.bridge) html+=row(d.engineReady,'מנוע הדיבור של אנדרואיד מוכן');
  if(d.canAskVoice) html+=row(d.hebrewNative,'מותקן קול עברי במכשיר');
  if(!d.inApp||!d.bridge) html+=row(d.hebrewWeb,'קול עברי בדפדפן');
  // Naming the engine turns "no Hebrew voice" into something the parent can
  // act on -- Google's engine has no Hebrew at all, so seeing it named here
  // explains why the install-languages screen never lists Hebrew.
  if(d.engines&&d.engines.length){
    const cur=d.engines.find(e=>e.isDefault);
    if(cur) html+=`<div style="padding:2px 0;">🔧 מנוע הדיבור בשימוש: <b>${esc(cur.label||cur.name)}</b></div>`;
    if(d.engines.length>1) html+=`<div style="padding:2px 0;color:var(--muted);">מנועים נוספים מותקנים: ${esc(d.engines.filter(e=>!e.isDefault).map(e=>e.label||e.name).join(', '))}</div>`;
  }
  // Name the single most likely cause instead of leaving a parent to interpret
  // a checklist -- ordered by which failure actually blocks speech first.
  let verdict='';
  if(!d.readAloud) verdict='הסיבה: ההקראה כבויה. הפעילו את המתג "🔊 הקראת שאלות ותשובות בקול" למעלה.';
  else if(!d.inApp) verdict='נפתח בדפדפן ולא באפליקציה — ההקראה תלויה בקולות של הדפדפן ולרוב לא תעבוד בעברית.';
  else if(!d.bridge) verdict='הסיבה: גרסת האפליקציה המותקנת ישנה ואין בה תמיכה בהקראה. צריך להתקין את הגרסה העדכנית של האפליקציה במכשיר הזה.';
  else if(d.canAskVoice&&d.hebrewNative===false) verdict='הסיבה: אין קול עברי מותקן במכשיר. לחצו על "התקן קול עברי" למעלה.';
  else verdict='כל הבדיקות תקינות — אם עדיין אין קול, בדקו שעוצמת המדיה במכשיר אינה על אפס ושהמכשיר לא במצב שקט.';
  html+=`<div style="margin-top:7px;font-weight:800;">${verdict}</div>`;
  el.innerHTML=html;
}
// getVoices() is commonly empty on the first call and fills in asynchronously;
// without this the web-voice row would report a false ❌ on a device that does
// have a Hebrew voice.
if(WEB_TTS_SUPPORTED){
  try{ speechSynthesis.addEventListener('voiceschanged',()=>renderTtsDiagnostics()); }catch(e){}
}
// Speaks a fixed phrase through the very same path the quiz uses, so a
// "success" here genuinely means the quiz will speak too.
function testTtsNow(){
  const out=document.getElementById('ttsDiagResult');
  if(out){ out.textContent='מנגן...'; out.style.color='var(--ink2)'; }
  stopSpeaking();
  let ended=false;
  speakWithHighlight('שלום, אני קורא לך את השאלות',null,'he-IL',()=>{
    ended=true;
    if(out){ out.textContent='אם לא נשמע כלום — הבעיה היא בקול/עוצמת השמע במכשיר.'; out.style.color='var(--ink2)'; }
  });
  // ttsEnabled() short-circuits speakWithHighlight to an immediate finish, so
  // distinguish "played" from "refused to even try".
  setTimeout(()=>{
    if(ended&&!ttsEnabled()&&out){ out.textContent='ההקראה כבויה או לא נתמכת — ראו את הבדיקה למעלה.'; out.style.color='var(--coral-d)'; }
  },50);
}
// These toggles used to mutate state.learning in memory only -- a parent who
// flipped one and left without pressing "save" saw it take effect immediately
// but silently lose it on the next reload. Persist on every toggle, like every
// other standalone toggle in the app (calm mode, chore reminder, math ops).
async function persistLearning(){ await DB.set('cs_learning',state.learning); scheduleSync(); }
function toggleLearningEnabled(){ state.learning.enabled=!state.learning.enabled; persistLearning(); fillLearningConfig(); }
function toggleLearningSubject(subj){ state.learning.subjects[subj]=!state.learning.subjects[subj]; persistLearning(); fillLearningConfig(); }
function toggleLearningGate(){ state.learning.gateEnabled=!state.learning.gateEnabled; persistLearning(); fillLearningConfig(); }
function toggleLearningReadAloud(){ state.learning.readAloud=!(state.learning.readAloud!==false); if(!state.learning.readAloud) stopSpeaking(); persistLearning(); fillLearningConfig(); }
async function saveLearningConfig(){
  state.learning.coinsPerCorrect=Math.max(1,parseInt(document.getElementById('learnCoinsPerCorrect').value)||1);
  state.learning.sessionBonus=Math.max(0,parseInt(document.getElementById('learnSessionBonus').value)||0);
  state.learning.dailyMaxCoins=Math.max(1,parseInt(document.getElementById('learnDailyMaxCoins').value)||10);
  state.learning.minutesPerSession=Math.max(0,parseInt(document.getElementById('learnMinutesPerSession').value)||0);
  state.learning.dailyMaxMinutes=Math.max(0,parseInt(document.getElementById('learnDailyMaxMinutes').value)||0);
  if(!Object.values(state.learning.subjects).some(Boolean)){ toast('בחר לפחות מקצוע אחד'); return; }
  await DB.set('cs_learning',state.learning); scheduleSync(); toast('הגדרות נשמרו ✓');
}
// ---- custom parent-authored questions (L8) ----
function renderCustomQuestionsAdmin(){
  const el=document.getElementById('customQuestionsAdmin'); if(!el) return;
  const list=state.learning.customQuestions||[];
  if(!list.length){ el.innerHTML='<div class="card-sub">אין עדיין שאלות מותאמות אישית.</div>'; return; }
  el.innerHTML=list.map((q,i)=>`<div class="admin-row">
    <span class="t">${esc(q.q)}<br><span style="font-size:.72rem;color:var(--mint-d);font-weight:700;">${subjLabel(q.subject)} · תשובה: ${esc(q.answer)}</span></span>
    <button class="icon-btn" onclick="delCustomQuestion(${i})">🗑️</button>
  </div>`).join('');
}
async function addCustomQuestion(){
  const subject=document.getElementById('newLqSubject').value;
  const q=document.getElementById('newLqQ').value.trim();
  const answer=document.getElementById('newLqAnswer').value.trim();
  const w1=document.getElementById('newLqWrong1').value.trim();
  const w2=document.getElementById('newLqWrong2').value.trim();
  if(!q||!answer||!w1||!w2){ toast('מלא את כל השדות'); return; }
  const item={id:'lq'+Date.now().toString(36),subject,level:1,type:'choice',q,choices:[answer,w1,w2],answer};
  state.learning.customQuestions=state.learning.customQuestions||[];
  state.learning.customQuestions.push(item);
  await DB.set('cs_learning',state.learning); scheduleSync();
  document.getElementById('newLqQ').value=''; document.getElementById('newLqAnswer').value='';
  document.getElementById('newLqWrong1').value=''; document.getElementById('newLqWrong2').value='';
  renderCustomQuestionsAdmin(); toast('השאלה נוספה ✓');
}
async function delCustomQuestion(i){
  // customQuestions is nested inside cs_learning (not its own storage key),
  // same shape as anchored[period] — needs the persist override so undo
  // saves the whole state.learning object, not the bare array.
  await delWithUndo(state.learning.customQuestions,i,'cs_learning',renderCustomQuestionsAdmin,'השאלה',
    async()=>{ await DB.set('cs_learning',state.learning); });
}
async function persistMath(){ await DB.set('cs_math',state.math); scheduleSync(); }
function toggleMathEnabled(){ state.math.enabled=!state.math.enabled; persistMath(); fillMathConfig(); }
function toggleOp(op){ const i=state.math.ops.indexOf(op); if(i>=0) state.math.ops.splice(i,1); else state.math.ops.push(op); persistMath(); fillMathConfig(); }
async function saveMathConfig(){
  state.math.maxNum=parseInt(document.getElementById('mathMax').value)||20;
  state.math.pts=parseInt(document.getElementById('mathPts').value)||2;
  state.math.daily=parseInt(document.getElementById('mathDaily').value)||10;
  if(state.math.ops.length===0){ toast('בחר לפחות סוג תרגיל אחד'); return; }
  await DB.set('cs_math',state.math); scheduleSync(); toast('הגדרות נשמרו ✓');
}
function renderRewardsAdmin(){
  const c=document.getElementById('rewardsAdmin'); c.innerHTML='';
  state.rewards.forEach((r,i)=>{
    const row=document.createElement('div'); row.className='admin-row';
    const sub=r.minutes?`<br><span style="font-size:.72rem;color:var(--mint-d);font-weight:700;">🎮 ${r.minutes} דקות משחק אוטומטית</span>`
      :r.cash?`<br><span style="font-size:.72rem;color:var(--gold-d);font-weight:700;">💵 ${r.cash} ₪ (נכנס למונה "ממתין לתשלום")</span>`:'';
    row.innerHTML=`<button type="button" class="emoji" title="שנה אימוג'י" onclick="pickRewardEmoji(${i})" style="border:none;background:none;cursor:pointer;padding:0;font-size:inherit;">${r.emoji}</button><span class="t">${esc(r.label)}${sub}</span>
      <input type="number" value="${r.cost}" min="1" style="width:62px;border:2px solid var(--line);border-radius:10px;padding:7px;text-align:center;font-family:inherit;font-weight:700;" onchange="updateRewardCost(${i},this.value)">
      <button class="icon-btn" onclick="delReward(${i})">🗑️</button>`;
    c.appendChild(row);
  });
}
function pickRewardEmoji(i){
  openEmojiPickerFor(async(e)=>{
    state.rewards[i].emoji=e; await DB.set('cs_rewards',state.rewards);
    renderRewardsAdmin(); toast('עודכן ✓');
  });
}
async function updateRewardCost(i,v){ state.rewards[i].cost=parseInt(v)||1; await DB.set('cs_rewards',state.rewards); toast('עודכן ✓'); }
async function delReward(i){ await delWithUndo(state.rewards,i,'cs_rewards',renderRewardsAdmin,'הפרס'); }
async function addReward(){
  const label=document.getElementById('newRwLabel').value.trim(); if(!label){ toast('צריך שם לפרס'); return; }
  const emoji=document.getElementById('newRwEmoji').value.trim()||'🎁', cost=parseInt(document.getElementById('newRwCost').value)||30;
  const minutes=parseInt(document.getElementById('newRwMinutes').value)||0;
  const cash=parseFloat(document.getElementById('newRwCash').value)||0;
  const rw={id:'r'+Date.now().toString(36),label,emoji,cost};
  // A reward is either a game-time package OR a cash-out, never both -- minutes
  // takes priority if a parent somehow fills both fields.
  if(minutes>0) rw.minutes=minutes;
  else if(cash>0) rw.cash=cash;
  state.rewards.push(rw); await DB.set('cs_rewards',state.rewards);
  scheduleSync();
  document.getElementById('newRwLabel').value=''; document.getElementById('newRwEmoji').value=''; document.getElementById('newRwMinutes').value=''; document.getElementById('newRwCash').value='';
  renderRewardsAdmin(); toast('נוסף! ✓');
}

/* ===== GAMES ADMIN ===== */
async function toggleGameBedtime(){
  state.gameBedtime=!state.gameBedtime;
  await DB.set('cs_gamebedtime',state.gameBedtime);
  scheduleSync();
  fillGameBedtimeToggle();
}
function fillGameBedtimeToggle(){
  const btn=document.getElementById('gameBedtimeToggle'); if(!btn) return;
  const on=state.gameBedtime!==false;
  btn.textContent=on?'פעיל ✓':'כבוי';
  btn.className='btn sm '+(on?'mint':'ghost');
}
function renderGamesAdmin(){
  fillGameBedtimeToggle();
  const c=document.getElementById('gamesAdmin'); c.innerHTML='';
  if(!state.games.length) c.innerHTML='<div class="empty"><span class="e-ic">🎮</span>אין משחקים</div>';
  state.games.forEach((g,i)=>{
    const row=document.createElement('div'); row.className='admin-row';
    const sub=g.native
      ? '📱 אפליקציה אמיתית באנדרואיד · '+esc(g.androidPackage)
      : esc(g.url||'');
    row.innerHTML=`<span class="emoji">${g.emoji}</span><span class="t">${esc(g.label)}<br><span style="font-size:.68rem;color:var(--muted);font-weight:400;direction:ltr;display:inline-block;">${sub}</span>
        <div style="margin-top:5px;"><label class="req-toggle" style="color:var(--sky-d);"><input type="checkbox" ${g.bathroomApproved?'checked':''} onchange="updateGameBathroomApproved(${i},this.checked)"> 🚽 מאושר לזמן שירותים</label></div></span>
      <button class="icon-btn" onclick="delGame(${i})">🗑️</button>`;
    c.appendChild(row);
  });
  renderBathroomSessionAdmin();
  // per-child wallet adjustment
  const w=document.getElementById('gtAdminWallets'); w.innerHTML='';
  state.children.forEach(ch=>{
    const row=document.createElement('div'); row.className='admin-row';
    row.innerHTML=`<span class="emoji">${ch.emoji}</span><span class="t">${esc(ch.name)}<br><span style="font-size:.72rem;color:var(--muted);font-weight:400;" id="gtw_${ch.id}">—</span></span>
      <button class="btn sm ghost" onclick="adminAdjustGT('${ch.id}',5)">+5 דק'</button>
      <button class="btn sm ghost" onclick="adminAdjustGT('${ch.id}',-5)">-5 דק'</button>`;
    w.appendChild(row);
    DB.get('cs_gtime_'+ch.id).then(v=>{ const el=document.getElementById('gtw_'+ch.id); if(el) el.textContent='בארנק: '+fmtGT(v??0); });
  });
}
async function delGame(i){ await delWithUndo(state.games,i,'cs_games',renderGamesAdmin,'המשחק'); }
async function updateGameBathroomApproved(i,checked){
  if(checked) state.games[i].bathroomApproved=true; else delete state.games[i].bathroomApproved;
  await DB.set('cs_games',state.games);
  renderBathroomSessionAdmin(); toast('עודכן ✓');
}
// Sentinel childId used only by bathroom sessions (see onNativeGameSessionEnded) --
// never a real child id, so it can never accidentally match or debit a
// real wallet even if something else calls the native bridge unexpectedly.
const BATHROOM_SESSION_CHILD_ID='__bathroom__';
function renderBathroomSessionAdmin(){
  const wrap=document.getElementById('bathroomSessionAdmin'); if(!wrap) return;
  const approved=state.games.filter(g=>g.bathroomApproved);
  if(!approved.length){
    wrap.innerHTML='<div class="card-sub">סמן משחק אחד לפחות כ"מאושר לזמן שירותים" למעלה כדי להפעיל כאן.</div>';
    return;
  }
  wrap.innerHTML=`<select id="bathroomGameSelect" style="width:100%;border:2px solid var(--line);border-radius:13px;padding:11px;font-family:inherit;margin-bottom:10px;">
      ${approved.map(g=>`<option value="${g.id}">${g.emoji} ${esc(g.label)}</option>`).join('')}
    </select>
    <div class="inline-row" style="margin-bottom:12px;align-items:flex-end;">
      <div class="field"><label>דקות (עד 10)</label><input id="bathroomMinutes" type="number" value="10" min="1" max="10"></div>
      <button class="btn sky" style="flex:1;" onclick="startBathroomSession()">🚽 התחל עכשיו ל${curChild()?esc(curChild().name):'הילד/ה הפעיל/ה'}</button>
    </div>`;
}
// Parent-triggered (already behind the admin PIN gate), for the specific
// real-world moment of "go sit on the toilet now, here's a game to help" --
// grants up to 10 minutes of ONE explicitly bathroomApproved game to the
// currently active child, completely outside the coin economy (see the
// _gt.bathroom / BATHROOM_SESSION_CHILD_ID guards elsewhere). Not something
// the child can trigger themselves, and not deducted from or credited to
// any wallet -- it's a fixed, capped grant each time a parent starts one.
async function startBathroomSession(){
  const sel=document.getElementById('bathroomGameSelect'); if(!sel) return;
  const g=state.games.find(x=>x.id===sel.value);
  if(!g){ toast('סמן קודם משחק כמאושר לזמן שירותים'); return; }
  const minutes=Math.max(1,Math.min(10,parseInt(document.getElementById('bathroomMinutes').value)||10));
  const seconds=minutes*60;
  if(g.native){
    if(!isNativeGameAvailable()){ modalMsg('📱','זמין רק באפליקציה','המשחק הזה עובד רק כשפותחים את כספת המטבעות מתוך אפליקציית האנדרואיד.'); return; }
    if(!window.CoinQuestNative.isPackageInstalled(g.androidPackage)){ modalMsg('🤔','המשחק לא מותקן','לא מצאנו את '+g.label+' מותקן במכשיר.'); return; }
    if(!window.CoinQuestNative.hasOverlayPermission()){ modalMsg('🔒','נדרשת הרשאה','צריך לאשר הרשאת "חלון צף" בהגדרות המכשיר קודם (מסך המשחקים יבקש זאת בפעם הראשונה שמפעילים משחק רגיל).'); return; }
    exitAdmin();
    const started=window.CoinQuestNative.startNativeSession(g.androidPackage,seconds,BATHROOM_SESSION_CHILD_ID);
    if(!started){ toast('לא הצלחתי להתחיל את המשחק'); return; }
    toast('🚽 '+g.emoji+' '+g.label+' נפתח ל-'+minutes+' דקות');
  }else{
    exitAdmin();
    startGameSession(g.id,seconds);
  }
}
function toggleNewGameNative(){
  const native=document.getElementById('newGameNative').checked;
  document.getElementById('newGameUrlField').style.display=native?'none':'block';
  document.getElementById('newGamePkgField').style.display=native?'block':'none';
}
async function addGame(){
  const label=document.getElementById('newGameLabel').value.trim(); if(!label){ toast('צריך שם למשחק'); return; }
  const emoji=document.getElementById('newGameEmoji').value.trim()||'🎮';
  const native=document.getElementById('newGameNative').checked;
  let game;
  if(native){
    const pkg=document.getElementById('newGamePkg').value.trim();
    if(!pkg){ toast('צריך שם חבילה (package name)'); return; }
    game={id:'g'+Date.now().toString(36),label,emoji,native:true,androidPackage:pkg};
    document.getElementById('newGamePkg').value='';
  }else{
    const url=document.getElementById('newGameUrl').value.trim();
    if(!/^https:\/\//i.test(url)){ toast('הכתובת חייבת להתחיל ב-https://'); return; }
    game={id:'g'+Date.now().toString(36),label,emoji,url};
    document.getElementById('newGameUrl').value='';
  }
  state.games.push(game);
  await DB.set('cs_games',state.games);
  document.getElementById('newGameLabel').value=''; document.getElementById('newGameEmoji').value='';
  renderGamesAdmin(); toast('נוסף! ✓');
}
async function adminAdjustGT(childId,minutes){
  const v=Math.max(0,((await DB.get('cs_gtime_'+childId))??0)+minutes*60);
  const chName=(state.children.find(c=>c.id===childId)||{}).name||childId;
  audit((minutes>0?'הוסיף ':'הוריד ')+Math.abs(minutes)+' דקות משחק ל'+chName);
  await DB.set('cs_gtime_'+childId,v);
  if(state.kid[childId]) state.kid[childId].gtime=v;
  renderGamesAdmin(); toast('עודכן ✓');
}

/* ===== BADGES ADMIN ===== */
function fillBadgeMetricSelect(sel,selected){
  sel.innerHTML='';
  Object.entries(BADGE_METRICS).forEach(([key,m])=>{
    const o=document.createElement('option'); o.value=key; o.textContent=m.label;
    if(key===selected) o.selected=true;
    sel.appendChild(o);
  });
}
function onBdgMetricChange(){
  const metric=document.getElementById('newBdgMetric').value;
  document.getElementById('newBdgThresholdField').style.display=BADGE_METRICS[metric].kind==='goal'?'none':'block';
}
function renderBadgesAdmin(){
  const c=document.getElementById('badgesAdmin'); c.innerHTML='';
  state.badgeDefs.forEach((b,i)=>{
    const m=BADGE_METRICS[b.metric];
    const row=document.createElement('div'); row.className='admin-row';
    row.innerHTML=`<span class="emoji">${b.emoji}</span><span class="t">${esc(b.label)}<br><span style="font-size:.72rem;color:var(--muted);font-weight:400;">${esc(m?m.label:b.metric)}${m&&m.kind==='threshold'?' ≥ '+b.threshold:''}</span></span>`;
    if(m&&m.kind==='threshold'){
      const input=document.createElement('input');
      input.type='number'; input.min='1'; input.value=b.threshold;
      input.style.cssText='width:62px;border:2px solid var(--line);border-radius:10px;padding:7px;text-align:center;font-family:inherit;font-weight:700;';
      input.onchange=()=>updateBadgeThreshold(i,input.value);
      row.appendChild(input);
    }
    const del=document.createElement('button'); del.className='icon-btn'; del.textContent='🗑️'; del.onclick=()=>delBadgeDef(i);
    row.appendChild(del);
    c.appendChild(row);
  });
  fillBadgeMetricSelect(document.getElementById('newBdgMetric'));
  onBdgMetricChange();
}
async function updateBadgeThreshold(i,v){ state.badgeDefs[i].threshold=parseInt(v)||1; await DB.set('cs_badgedefs',state.badgeDefs); scheduleSync(); toast('עודכן ✓'); }
async function delBadgeDef(i){ await delWithUndo(state.badgeDefs,i,'cs_badgedefs',renderBadgesAdmin,'התג'); }
async function addBadgeDef(){
  const label=document.getElementById('newBdgLabel').value.trim(); if(!label){ toast('צריך שם לתג'); return; }
  const emoji=document.getElementById('newBdgEmoji').value.trim()||'⭐';
  const metric=document.getElementById('newBdgMetric').value;
  const threshold=BADGE_METRICS[metric].kind==='goal'?null:(parseInt(document.getElementById('newBdgThreshold').value)||1);
  state.badgeDefs.push({id:'bdg'+Date.now().toString(36),label,emoji,metric,threshold});
  await DB.set('cs_badgedefs',state.badgeDefs);
  scheduleSync();
  document.getElementById('newBdgLabel').value=''; document.getElementById('newBdgEmoji').value='';
  renderBadgesAdmin(); toast('נוסף! ✓');
}

// S2 (store-release prep): reject codes a child could guess in one or two
// tries (all-same-digit, or a run like 1234/4321/2345) — the PIN-lockout
// above only slows down brute force, it doesn't stop a lucky first guess.
function isWeakPin(pin){
  if(/^(\d)\1+$/.test(pin)) return true;
  const asc='0123456789', desc='9876543210';
  if(pin.length>=3 && (asc.includes(pin) || desc.includes(pin))) return true;
  return false;
}
/* ---- parent code hashing ----
   Salted so the stored value can't be matched against a rainbow table of bare
   4-digit strings. Two implementations because crypto.subtle only exists in a
   secure context (https/localhost) -- the fallback is weaker but still not
   plaintext, and the 'fb' prefix records which one produced a given hash so a
   device using one algorithm can still verify a hash made by the other. */
const PIN_SALT='coinquest-pin-v1:';
async function sha256Pin(v){
  const buf=new TextEncoder().encode(PIN_SALT+v);
  const d=await crypto.subtle.digest('SHA-256',buf);
  return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
function fallbackPinHash(v){
  const s=PIN_SALT+v; let h=5381;
  for(let i=0;i<s.length;i++) h=((h*33)^s.charCodeAt(i))>>>0;
  return 'fb'+h.toString(16);
}
async function hashPin(v){
  try{ if(window.crypto&&crypto.subtle) return await sha256Pin(v); }catch(e){}
  return fallbackPinHash(v);
}
// A device only switches to hash verification once a parent has actually set a
// family code; until then it keeps checking its own local plaintext code, so
// simply installing this update never changes how any device unlocks.
async function verifyPin(entered){
  if(state.pinHash){
    const h=state.pinHash.startsWith('fb')?fallbackPinHash(entered):await hashPin(entered);
    return h===state.pinHash;
  }
  return entered===state.pin;
}
// M4.2: '1234' is a fine bootstrap default for a private family build, but it
// must not survive into a shipped product where it's the documented, publicly
// known way into every un-configured install's parent area.
function usingDefaultPin(){ return !state.pinHash && state.pin==='1234'; }
function warnIfDefaultPin(){
  const el=document.getElementById('defaultPinWarning'); if(!el) return;
  el.style.display=(monetizationOn()&&usingDefaultPin())?'block':'none';
}
async function savePin(){
  const v=document.getElementById('setPin').value.trim();
  if(v.length<3){ toast('קוד קצר מדי'); return; }
  if(isWeakPin(v)){ toast('קוד קל מדי לניחוש — נסה קוד אחר 🙂'); return; }
  state.pin=v; await DB.set('cs_pin',v);
  // Setting the code here makes it the code for the WHOLE family: the hash
  // syncs, every other device adopts it, and their old local codes stop
  // working. That's the intended behaviour -- one parent code per family.
  state.pinHash=await hashPin(v); await DB.set('cs_pinhash',state.pinHash);
  scheduleSync(); document.getElementById('setPin').value='';
  toast('הקוד עודכן לכל מכשירי המשפחה ✓');
}

/* ===== BACKUP / RESTORE ===== */
function backupKeyList(){
  const keys=['cs_children','cs_current','cs_chores','cs_actions','cs_rewards','cs_math',
    'cs_streaks','cs_badgedefs','cs_anchored','cs_events','cs_pin','cs_pinhash','cs_calm','cs_games',
    'cs_games_v3','cs_games_v4','cs_games_v5','cs_gtime_seeded','cs_hwm_date','cs_calmlog',
    'cs_familyid','cs_learning','cs_auditlog','cs_chore_reminder'];
  for(const ch of state.children){
    for(const p of ['cs_bal_','cs_hist_','cs_daily_','cs_mathd_','cs_badges_','cs_matht_','cs_taskt_','cs_rwt_','cs_gtime_','cs_mathlvl_','cs_learn_','cs_learnlvl_','cs_cash_']){
      keys.push(p+ch.id);
    }
  }
  return keys;
}
async function exportBackup(){
  const data={};
  for(const k of backupKeyList()){
    const v=await DB.get(k);
    if(v!==null) data[k]=v;
  }
  // A fresh install may never have WRITTEN cs_children (defaults are used
  // in-memory without persisting) — but import validation requires it, and a
  // backup without the children list would be useless anyway.
  if(!data.cs_children) data.cs_children=state.children;
  const blob=new Blob([JSON.stringify({app:'coin-quest',version:1,exportedAt:new Date().toISOString(),data},null,1)],{type:'application/json'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  const d=new Date();
  a.download='coin-quest-backup-'+d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+'.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),5000);
  toast('קובץ הגיבוי ירד ✓ שמור אותו במקום בטוח');
}
async function importBackup(ev){
  const f=ev.target.files&&ev.target.files[0];
  ev.target.value='';
  if(!f) return;
  let parsed;
  try{ parsed=JSON.parse(await f.text()); }
  catch(e){ modalMsg('⚠️','קובץ לא תקין','זה לא קובץ גיבוי של כספת המטבעות.'); return; }
  if(!parsed||parsed.app!=='coin-quest'||!parsed.data||!Array.isArray(parsed.data.cs_children)){
    modalMsg('⚠️','קובץ לא תקין','זה לא קובץ גיבוי של כספת המטבעות.'); return;
  }
  const when=parsed.exportedAt?new Date(parsed.exportedAt).toLocaleDateString('he-IL'):'לא ידוע';
  const kids=parsed.data.cs_children.map(c=>c.name).join(', ');
  modalConfirm('💾','לשחזר מהגיבוי?','גיבוי מתאריך '+when+' עם הילדים: '+kids+'.\nכל הנתונים הנוכחיים במכשיר יוחלפו!', async()=>{
    for(const [k,v] of Object.entries(parsed.data)){
      // Only cs_* keys, and never the family/account linkage — restoring a
      // backup onto a device signed into a DIFFERENT family must not
      // cross-wire the two families' cloud records.
      if(!k.startsWith('cs_')||k==='cs_familyid') continue;
      await DB.set(k,v);
    }
    toast('שוחזר ✓ טוען מחדש...');
    setTimeout(()=>location.reload(),800);
  });
}
async function saveGroqKey(){ const v=document.getElementById('setGroqKey').value.trim(); if(!v){ toast('הכנס מפתח'); return; } GROQ_API_KEY=v; localStorage.setItem('cs_groq_key',v); document.getElementById('setGroqKey').value=''; toast('מפתח Groq נשמר ✓'); updateChatNavVisibility(); fillChatAdmin(); }
async function clearGroqKey(){
  modalConfirm('🗑️','למחוק את המפתח?','הצ\'אט עם איזי ייעלם מהמסך של הילד/ה. אפשר להזין מפתח חדש בכל עת.',()=>{
    GROQ_API_KEY=''; localStorage.removeItem('cs_groq_key');
    updateChatNavVisibility(); fillChatAdmin(); toast('נמחק ✓');
  });
}
function toggleChatEnabled(){
  localStorage.setItem('cs_chat_enabled',chatEnabled()?'0':'1');
  updateChatNavVisibility(); fillChatAdmin();
}
function saveChatCap(v){
  const n=parseInt(v);
  if(!Number.isFinite(n)||n<1){ toast('מספר לא תקין'); return; }
  localStorage.setItem('cs_chat_cap',String(n)); toast('נשמר ✓');
}
// Verifies the key AND the model in one real round-trip, so a parent finds out
// here -- not from a frustrated child -- that the key is wrong or the model id
// has been retired.
async function testChatConnection(){
  const el=document.getElementById('chatTestStatus'); if(!el) return;
  if(!GROQ_API_KEY){ el.textContent='אין מפתח שמור.'; el.style.color='var(--coral-d)'; return; }
  el.textContent='בודק...'; el.style.color='var(--ink2)';
  try{
    const r=await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_API_KEY},
      body:JSON.stringify({model:chatModel(),messages:[{role:'user',content:'שלום'}],max_tokens:5})
    });
    if(r.ok){ el.textContent='✅ הכול עובד (מודל: '+chatModel()+')'; el.style.color='var(--mint-d)'; return; }
    let msg='שגיאה '+r.status;
    try{ const e=await r.json(); if(e?.error?.message) msg=e.error.message; }catch(e){}
    // Offer the self-heal explicitly rather than waiting for a child to hit it.
    if(/model/i.test(msg)&&chatModel()!==CHAT_MODEL_FALLBACK){
      localStorage.setItem('cs_chat_model',CHAT_MODEL_FALLBACK);
      el.textContent='המודל הישן הוסר — עברנו אוטומטית ל-'+CHAT_MODEL_FALLBACK+'. לחץ/י שוב לבדיקה.';
      el.style.color='var(--gold-d)'; return;
    }
    el.textContent='❌ '+msg; el.style.color='var(--coral-d)';
  }catch(e){ el.textContent='❌ אין חיבור לאינטרנט'; el.style.color='var(--coral-d)'; }
}
// Parent-facing transcript. Flagged turns (crisis/blocked/PII) are pulled to
// the top as a summary AND highlighted in place -- the whole point of keeping
// this log is that a parent shouldn't have to scroll a week of chat to notice
// the one message that mattered.
const CHAT_FLAG_LABELS={crisis:'🚨 נושא רגיש — כדאי לדבר',blocked:'⚠️ נושא חסום',pii:'🛑 ניסה לשתף פרטים אישיים','blocked-output':'⚠️ תשובה נחסמה',cap:'מכסה יומית',error:'שגיאת שירות'};
async function renderChatLogAdmin(){
  const el=document.getElementById('chatLogAdmin'); if(!el) return;
  let html='';
  for(const ch of state.children){
    const log=(await DB.get('cs_chatlog_'+ch.id))??[];
    if(!log.length) continue;
    const alerts=log.filter(e=>e.flag==='crisis'||e.flag==='pii'||e.flag==='blocked');
    html+=`<div style="margin-top:12px;padding-top:10px;border-top:2px solid var(--line);">
      <div style="font-weight:800;">${esc(ch.name)} · ${log.length} הודעות</div>`;
    if(alerts.length){
      html+=`<div style="background:#FFE9E4;border-radius:12px;padding:8px 10px;margin:6px 0;font-size:.8rem;font-weight:700;color:#8a3410;">
        ${alerts.length} הודעות שדורשות תשומת לב — מסומנות למטה</div>`;
    }
    log.slice(-20).reverse().forEach(e=>{
      const who=e.role==='child'?esc(ch.name):'איזי';
      const flagTxt=e.flag?CHAT_FLAG_LABELS[e.flag]||e.flag:'';
      const hot=e.flag==='crisis'||e.flag==='pii';
      html+=`<div style="font-size:.8rem;padding:5px 0;border-bottom:1px solid var(--line);${hot?'background:#FFF3F0;border-radius:8px;padding:6px 8px;':''}">
        <b>${who}:</b> ${esc(e.text)}
        ${flagTxt?`<span style="color:${hot?'#c0392b':'var(--muted)'};font-weight:700;"> · ${esc(flagTxt)}</span>`:''}
        <span style="color:var(--muted);"> · ${timeAgo(e.ts)}</span></div>`;
    });
    html+='</div>';
  }
  el.innerHTML=html||'<div class="card-sub">עדיין לא היו שיחות.</div>';
}
async function clearChatLog(){
  modalConfirm('🗑️','למחוק את היסטוריית השיחות?','כל השיחות של כל הילדים במכשיר הזה יימחקו.',async()=>{
    for(const ch of state.children) await DB.del('cs_chatlog_'+ch.id);
    renderChatLogAdmin(); toast('נמחק ✓');
  });
}
function fillChatAdmin(){
  const st=document.getElementById('groqKeyStatus');
  if(st){
    st.textContent=GROQ_API_KEY?'✅ מפתח שמור':'לא הוזן מפתח — הצ\'אט מוסתר מהילד/ה';
    st.style.color=GROQ_API_KEY?'var(--mint-d)':'var(--muted)';
  }
  const tg=document.getElementById('chatEnabledToggle');
  if(tg){
    tg.textContent=chatEnabled()?'פעיל ✓':'כבוי';
    tg.className='btn sm '+(chatEnabled()?'mint':'ghost');
    tg.style.display=GROQ_API_KEY?'':'none';
  }
  const cap=document.getElementById('chatCapInput');
  if(cap) cap.value=chatDailyCap();
  renderChatLogAdmin();
}
// S8a (store-release prep): this is a genuinely unmoderated third-party AI
// chat -- keep the nav tab itself hidden from the child's bottom nav until a
// parent has actually configured a key in Admin Settings, instead of showing
// an inviting chat tab that (with no key set) can only ever reply "ask your
// parent". Purely a visibility toggle -- sendChatMessage's own `!GROQ_API_KEY`
// guard above still exists as defense in depth.
function updateChatNavVisibility(){
  const btn=document.querySelector('[data-nav="chat"]');
  // Key present AND not explicitly switched off -- a parent can hide the
  // assistant for a while (a rough week, a consequence, a holiday) without
  // having to delete and re-enter the API key to get it back.
  if(btn) btn.style.display=chatEnabled()?'':'none';
}

/* ===== MODALS ===== */
const modalBg=document.getElementById('modalBg'), modalContent=document.getElementById('modalContent');
function closeModal(){
  modalBg.classList.remove('show');
  stopSpeaking();
  // Hiding the modal via CSS doesn't remove focus from an input inside it --
  // the input (e.g. modalPin's numeric PIN field) stays focused even though
  // it's now invisible, so the on-screen keyboard stays open on mobile,
  // covering part of the screen until the child/parent manually dismisses
  // it. Blur whatever's focused inside the modal so the keyboard closes with it.
  if(document.activeElement&&modalContent.contains(document.activeElement)) document.activeElement.blur();
}
modalBg.addEventListener('click',e=>{ if(e.target===modalBg) closeModal(); });
function modalMsg(emoji,title,text){ modalContent.innerHTML=`<div class="m-emoji">${emoji}</div><h3>${esc(title)}</h3><p style="white-space:pre-line;">${esc(text)}</p><button class="btn primary" onclick="closeModal()">יאללה!</button>`; modalBg.classList.add('show'); }
function modalConfirm(emoji,title,text,onYes){
  modalContent.innerHTML=`<div class="m-emoji">${emoji}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>
    <div style="display:flex;gap:8px;"><button class="btn ghost" onclick="closeModal()">ביטול</button><button class="btn primary" id="mYes">כן</button></div>`;
  modalBg.classList.add('show'); document.getElementById('mYes').onclick=()=>{ closeModal(); onYes(); };
}
function modalInput(emoji,title,text,val,onOk){
  modalContent.innerHTML=`<div class="m-emoji">${emoji}</div><h3>${esc(title)}</h3><p>${esc(text)}</p>
    <input id="mInput" style="width:100%;border:2px solid var(--line);border-radius:13px;padding:12px;text-align:center;font-size:1.3rem;font-weight:800;font-family:inherit;" type="number" value="${val}">
    <div style="display:flex;gap:8px;margin-top:14px;"><button class="btn ghost" onclick="closeModal()">ביטול</button><button class="btn primary" id="mOk">אישור</button></div>`;
  modalBg.classList.add('show'); document.getElementById('mOk').onclick=()=>{ const v=document.getElementById('mInput').value; closeModal(); onOk(v); };
}
// _pinLockUntil persists in localStorage: a purely in-memory lockout was
// defeated by simply reloading the page, which reset the brute-force cooldown
// to zero. _pinFails stays in memory (a reload is a fresh attempt window; the
// lockout deadline is the part that must survive).
let _pinFails=0, _pinLockUntil=Number(localStorage.getItem('cs_pin_lock')||0)||0;
function setPinLock(until){ _pinLockUntil=until; try{ localStorage.setItem('cs_pin_lock',String(until)); }catch(e){} }
function modalPin(onOk){
  const remain=_pinLockUntil-Date.now();
  if(remain>0){
    modalMsg('⏳','חכה קצת','יותר מדי ניסיונות שגויים.\nנסה שוב בעוד '+Math.ceil(remain/1000)+' שניות.');
    return;
  }
  modalContent.innerHTML=`<div class="m-emoji">🔒</div><h3>אזור הורים</h3><p>הזן את קוד ההורים</p>
    <input id="mPin" class="pin-input" style="width:100%;border:2px solid var(--line);border-radius:13px;padding:12px;font-family:inherit;" type="number" placeholder="••••">
    <div style="display:flex;gap:8px;margin-top:14px;"><button class="btn ghost" onclick="closeModal()">ביטול</button><button class="btn primary" id="mPinOk">כניסה</button></div>`;
  modalBg.classList.add('show'); setTimeout(()=>document.getElementById('mPin').focus(),100);
  // Lock out after repeated wrong guesses, with growing cooldowns, so the PIN
  // can't be brute-forced by rapid tapping. Persisted-per-session (in memory),
  // not tied to the PIN value itself.
  const ok=async()=>{
    const v=document.getElementById('mPin').value.trim();
    if(await verifyPin(v)){ _pinFails=0; setPinLock(0); closeModal(); onOk(); }
    else{
      _pinFails++;
      if(_pinFails>=5){ setPinLock(Date.now()+Math.min(300000,10000*Math.pow(2,_pinFails-5))); closeModal(); modalMsg('⏳','יותר מדי ניסיונות','חכה קצת ונסה שוב.'); return; }
      toast('קוד שגוי 🔒'); document.getElementById('mPin').value='';
    }
  };
  document.getElementById('mPinOk').onclick=ok;
  document.getElementById('mPin').addEventListener('keyup',e=>{ if(e.key==='Enter') ok(); });
}
document.getElementById('gearBtn').onclick=openAdmin;

/* ===== CALM MODE + BREAK BUTTON ===== */
// The break button is deliberately NOT PIN-gated and does not touch coins/state —
// a child needs self-regulation tools available instantly, with zero friction and
// zero economic effect (so it can never be confused with, or abused as, a reward).
//
// The toolkit follows established child self-regulation practice:
// - Feelings check-in before/after (Zones-of-Regulation style) — naming the
//   feeling is itself regulating, and the delta is logged for the parent.
// - Paced "balloon" breathing (4-2-6: exhale longer than inhale activates the
//   parasympathetic response) with a JS-driven visual so ball/text/count
//   never desync.
// - Progressive muscle relaxation ("squeeze a lemon") — tense/release cycles.
// - 5-4-3-2-1 sensory grounding, adapted to ages 6-9.
// - Synthesized ocean/rain soundscapes (filtered noise — far closer to the
//   white-noise machines used in sensory rooms than musical tones; fully
//   offline, no audio files).
let _breathTimer=null, _calmNoise=null, _calmActive=null, _muscleTimer=null;
let _calmSession=null; // {before, tool, ts}
const CALM_PANES=['calmIntro','calmMenu','calmBreathe','calmSound','calmGround','calmMuscle','calmHeavy','calmTrace','calmVisual','calmAfter'];
// Shared display names for cs_calmlog tool ids -- used by the parent-facing
// stats (renderCalmLogStats) and by calmPickFeeling's personalized-suggestion
// path (bestToolFor), so a new tool only needs to be added here once.
const CALM_TOOL_NAMES={breathe:'🎈 נשימת בלון',muscle:'🍋 סוחטים לימון',heavy:'🦸 כוח-על',ground:'🖐️ משחק החושים',ocean:'🌊 גלים בים',rain:'🌧️ גשם שקט',heartbeat:'💓 פעימות לב',purr:'🐱 גרגור חתול',visual:'✨ מסך מרגיע',trace:'🌈 נשימת קשת'};

// C7 (CALM-UPGRADE-PLAN): voice guidance for each exercise, gated by its own
// mute toggle -- separate from state.learning.readAloud, since a parent
// might want narration off for math/learning but still want it here (or the
// reverse). Device-local (like the parent PIN), loaded lazily when the modal
// opens rather than in the main loadState() bootstrap, matching how other
// device-local settings (e.g. fillCalmToggle) are read on demand.
let _calmTtsOn=true;
function calmTtsEnabled(){ return _calmTtsOn!==false && ttsEnabled(); }
async function toggleCalmTts(){
  _calmTtsOn=!_calmTtsOn;
  await DB.set('cs_calmtts',_calmTtsOn);
  updateCalmTtsBtn();
  if(!_calmTtsOn) stopSpeaking();
}
function updateCalmTtsBtn(){
  const b=document.getElementById('calmTtsBtn'); if(!b) return;
  b.textContent=_calmTtsOn?'🔊':'🔇';
}
// C9 (CALM-UPGRADE-PLAN): the full catalog of top-level calm tools a parent
// can toggle/reorder per child. heartbeat/purr are deliberately excluded --
// those live as in-panel switches under ocean/rain (see C6), never their
// own top-level tile, so they're not part of this list either.
const CALM_TOOLS_ALL=[
  {id:'breathe',emoji:'🎈',label:'נשימת בלון'},
  {id:'trace',emoji:'🌈',label:'נשימת קשת'},
  {id:'muscle',emoji:'🍋',label:'סוחטים לימון'},
  {id:'heavy',emoji:'🦸',label:'כוח-על'},
  {id:'ground',emoji:'🖐️',label:'משחק החושים'},
  {id:'ocean',emoji:'🌊',label:'גלים בים'},
  {id:'rain',emoji:'🌧️',label:'גשם שקט'},
  {id:'visual',emoji:'✨',label:'מסך מרגיע'},
];
function calmToolsForChild(childId){
  const prefs=(state.calmPrefs||{})[childId];
  if(!prefs||!prefs.tools||!prefs.tools.length) return CALM_TOOLS_ALL.map(t=>t.id);
  return prefs.tools;
}
function renderCalmTiles(){
  const wrap=document.getElementById('calmTilesWrap'); if(!wrap) return;
  const ids=calmToolsForChild(state.current);
  wrap.innerHTML=ids.map(id=>{
    const t=CALM_TOOLS_ALL.find(x=>x.id===id); if(!t) return '';
    return `<button class="calm-tile" id="tile-${t.id}" onclick="openCalmActivity('${t.id}')"><span class="t-ic">${t.emoji}</span>${esc(t.label)}</button>`;
  }).join('');
}
// C9 admin: per-child checkbox+reorder list in Settings. A parent curates
// which tools show (and in what order) for each kid -- also trims choice
// overload in the moment a child is already dysregulated.
function renderCalmPrefsAdmin(){
  const c=document.getElementById('calmPrefsAdmin'); if(!c) return;
  c.innerHTML=state.children.map(ch=>{
    const ids=calmToolsForChild(ch.id);
    const rows=ids.map((id,i)=>{
      const t=CALM_TOOLS_ALL.find(x=>x.id===id); if(!t) return '';
      return `<div class="cp-row">
        <span class="cp-label">${t.emoji} ${esc(t.label)}</span>
        <button class="icon-btn" title="למעלה" onclick="moveCalmTool('${ch.id}','${id}',-1)" ${i===0?'disabled':''}>▲</button>
        <button class="icon-btn" title="למטה" onclick="moveCalmTool('${ch.id}','${id}',1)" ${i===ids.length-1?'disabled':''}>▼</button>
        <button class="icon-btn" title="הסר" onclick="toggleCalmTool('${ch.id}','${id}',false)" ${ids.length<=2?'disabled':''}>🗑️</button>
      </div>`;
    }).join('');
    const missing=CALM_TOOLS_ALL.filter(t=>!ids.includes(t.id));
    const addRow=missing.length?`<div class="field" style="margin-top:8px;"><select onchange="if(this.value){toggleCalmTool('${ch.id}',this.value,true);this.value='';}" style="width:100%;border:2px solid var(--line);border-radius:10px;padding:8px;font-family:inherit;">
      <option value="">➕ הוסף כלי...</option>
      ${missing.map(t=>`<option value="${t.id}">${t.emoji} ${esc(t.label)}</option>`).join('')}
    </select></div>`:'';
    return `<div class="cp-child"><div class="cp-child-h">${ch.emoji} ${esc(ch.name)}</div>${rows}${addRow}</div>`;
  }).join('');
}
async function moveCalmTool(childId,toolId,dir){
  const ids=calmToolsForChild(childId).slice();
  const i=ids.indexOf(toolId), j=i+dir;
  if(i<0||j<0||j>=ids.length) return;
  [ids[i],ids[j]]=[ids[j],ids[i]];
  await saveCalmPrefs(childId,ids);
}
async function toggleCalmTool(childId,toolId,add){
  let ids=calmToolsForChild(childId).slice();
  if(add){ if(!ids.includes(toolId)) ids.push(toolId); }
  else{
    if(ids.length<=2){ toast('צריך לפחות 2 כלים'); return; }
    ids=ids.filter(id=>id!==toolId);
  }
  await saveCalmPrefs(childId,ids);
}
async function saveCalmPrefs(childId,ids){
  state.calmPrefs=state.calmPrefs||{};
  state.calmPrefs[childId]={tools:ids};
  await DB.set('cs_calmprefs',state.calmPrefs);
  renderCalmPrefsAdmin();
  toast('נשמר ✓');
}
// C10 (CALM-UPGRADE-PLAN): a one-time, per-child social story -- a standard
// evidence-based technique for autism -- explaining what this screen is and
// that using it is a sign of strength, not a problem. Shown once ever per
// child (synced like any other per-child flag, so it doesn't reappear on a
// second device either), before the normal feeling check-in.
const CALM_INTRO_CARDS=[
  '🌿 זה המקום השקט שלך. אפשר לבוא לכאן מתי שרוצים — זה תמיד בסדר.',
  '💪 כשמרגישים כעס או עצב בגוף, יש כאן כלים שעוזרים להרגיש טוב יותר.',
  '🧑‍🤝‍🧑 לבוא לכאן זה סימן של כוח, לא של בעיה. גיבורים יודעים מתי לנוח.',
];
let _introStep=0;
async function maybeShowCalmIntro(){
  const seen=await DB.get('cs_calmintro_'+state.current);
  if(seen){ showCalmMenu(); return; }
  _introStep=0;
  renderCalmIntroStep();
}
function renderCalmIntroStep(){
  calmShowPane('calmIntro');
  const txt=CALM_INTRO_CARDS[_introStep];
  document.getElementById('calmIntroTxt').textContent=txt;
  document.getElementById('calmIntroNextBtn').textContent=_introStep<CALM_INTRO_CARDS.length-1?'הבא ←':'התחלה 🌿';
  if(calmTtsEnabled()) speakWithHighlight(txt,null,'he-IL',null);
}
async function calmIntroNext(){
  _introStep++;
  if(_introStep>=CALM_INTRO_CARDS.length){ await finishCalmIntro(); return; }
  renderCalmIntroStep();
}
async function skipCalmIntro(){ await finishCalmIntro(); }
async function finishCalmIntro(){
  stopSpeaking();
  await DB.set('cs_calmintro_'+state.current,true);
  showCalmMenu();
}
async function openCalmBreak(){
  _calmSession={before:null, tool:null, body:null, ts:Date.now()};
  const bodyRow=document.getElementById('calmBodyRow'); if(bodyRow) bodyRow.style.display='none';
  document.querySelectorAll('.body-chip').forEach(c=>c.classList.remove('sel'));
  _calmTtsOn=(await DB.get('cs_calmtts'))??true;
  updateCalmTtsBtn();
  renderCalmTiles();
  document.getElementById('calmModal').classList.add('show');
  await maybeShowCalmIntro();
}
// C12 (CALM-UPGRADE-PLAN): a soft cross-fade instead of a hard display swap
// between panes -- a jarring instant cut doesn't fit a screen whose whole
// point is calm. The double-rAF forces the browser to paint opacity:0 first
// (same trick startBreathing() uses to reset the ball) so the fade-in
// actually plays instead of the transition being skipped. Automatically
// becomes instant under prefers-reduced-motion via the existing global
// `transition-duration:.01ms` override -- no extra guard needed here.
function calmShowPane(id){
  CALM_PANES.forEach(p=>{
    const el=document.getElementById(p);
    if(p===id){
      el.style.display='block'; el.style.opacity='0';
      requestAnimationFrame(()=>requestAnimationFrame(()=>{ el.style.opacity='1'; }));
    }else{
      el.style.display='none'; el.style.opacity='';
    }
  });
  document.getElementById('calmBackBtn').style.display=(id==='calmMenu'||id==='calmAfter'||id==='calmIntro')?'none':'block';
  document.getElementById('calmBackRow').style.display=(id==='calmAfter'||id==='calmIntro')?'none':'flex';
}
function showCalmMenu(){
  stopCalmActivity();
  calmShowPane('calmMenu');
}
// C5 (CALM-UPGRADE-PLAN): learns from THIS child's own cs_calmlog history --
// Zones of Regulation stresses matching tools to what actually works for a
// specific kid, not a generic map. Requires >=2 rated sessions that started
// at this same feeling level so one lucky session can't dominate the pick;
// returns null (falls back to the static map below) otherwise.
async function bestToolFor(level){
  const log=(await DB.get('cs_calmlog'))??[];
  const mine=log.filter(e=>e.childId===state.current&&e.before===level&&e.after&&e.tool);
  const scores={};
  mine.forEach(e=>{ (scores[e.tool]=scores[e.tool]||[]).push(e.before-e.after); }); // positive = calmer after
  let best=null, bestAvg=0;
  for(const t in scores){
    const arr=scores[t]; if(arr.length<2) continue;
    const avg=arr.reduce((a,b)=>a+b,0)/arr.length;
    if(avg>bestAvg){ best=t; bestAvg=avg; }
  }
  return best;
}
// Feeling → suggested tool: anger/tension responds best to motor discharge
// (heavy work) and paced breathing; anxiety/unease to grounding; the
// suggestion is a highlight, never a restriction — the child always chooses.
async function calmPickFeeling(level){
  if(_calmSession) _calmSession.before=level;
  // Matched by data-level, not DOM position -- C8 reordered the buttons
  // visually (green/blue/yellow/orange/red) so position no longer lines up
  // with the numeric feeling level.
  document.querySelectorAll('#feelRowBefore .feel-btn').forEach(b=>b.style.outline=(+b.dataset.level===level)?'3px solid var(--mint)':'none');
  document.querySelectorAll('.calm-tile').forEach(t=>t.classList.remove('suggested'));
  // C8: optional body-sensation chips -- reset any previous pick each time a
  // (possibly different) feeling is chosen, and reveal the row.
  document.querySelectorAll('.body-chip').forEach(c=>c.classList.remove('sel'));
  const bodyRow=document.getElementById('calmBodyRow'); if(bodyRow) bodyRow.style.display='block';
  const staticSug={1:'visual',2:'ground',3:'breathe',4:'heavy',5:'ocean'}[level];
  const personal=await bestToolFor(level);
  const sug=personal||staticSug;
  const el=document.getElementById('tile-'+sug);
  if(el) el.classList.add('suggested');
  document.getElementById('calmSuggest').textContent=personal
    ? 'בפעם שעברה '+CALM_TOOL_NAMES[personal]+' עזר לך הכי הרבה — רוצה שוב?'
    : {
        1:'איזה כיף! אפשר פשוט ליהנות ממשהו נעים ✨',
        2:'בוא ננסה את משחק החושים — הוא עוזר כשמשהו לא נעים',
        3:'נשימת בלון עוזרת הכי מהר כשעצבניים',
        4:'כשכועסים ממש חזק — הגוף צריך לעבוד! נסה את כוח-העל 🦸',
        5:'כשעצובים או עייפים — צליל נעים וחיבוק עוזרים 💙',
      }[level];
}
// C8: which body sensation goes with the feeling -- optional, logged for the
// parent (see cs_calmlog's `body` field), never required to pick a tool.
function calmPickBody(b){
  if(_calmSession) _calmSession.body=b;
  document.querySelectorAll('.body-chip').forEach(c=>c.classList.toggle('sel',c.dataset.body===b));
}
function openCalmActivity(kind){
  stopCalmActivity();
  _calmActive=kind;
  if(_calmSession&&!_calmSession.tool) _calmSession.tool=kind;
  if(kind==='breathe'){ calmShowPane('calmBreathe'); startBreathing(); }
  else if(kind==='ocean'||kind==='rain'||kind==='heartbeat'||kind==='purr'){
    calmShowPane('calmSound');
    document.querySelectorAll('.calm-timer-btn').forEach(b=>b.classList.toggle('sel',+b.dataset.min===0));
    const info={
      ocean:['🌊','גלים בים... שומעים את הים עולה ויורד'],
      rain:['🌧️','גשם שקט על החלון...'],
      heartbeat:['💓','פעימות לב רגועות...'],
      purr:['🐱','גרגור חתול רך...'],
    }[kind];
    document.getElementById('calmSoundIcon').textContent=info[0];
    document.getElementById('calmSoundLabel').textContent=info[1];
    document.querySelectorAll('.calm-sound-switch').forEach(b=>b.classList.toggle('sel',b.dataset.sound===kind));
    startCalmNoise(kind);
  }
  else if(kind==='ground'){ calmShowPane('calmGround'); startGrounding(); }
  else if(kind==='muscle'){ calmShowPane('calmMuscle'); startMuscle(); }
  else if(kind==='heavy'){ calmShowPane('calmHeavy'); startHeavy(); }
  else if(kind==='trace'){ calmShowPane('calmTrace'); startTrace(); }
  else if(kind==='visual'){ calmShowPane('calmVisual'); renderCalmBubbles(); }
}
function stopCalmActivity(){
  clearInterval(_breathTimer); _breathTimer=null;
  clearInterval(_muscleTimer); _muscleTimer=null;
  stopTrace();
  stopCalmNoise();
  stopSpeaking();
  _calmActive=null;
}

/* -- paced balloon breathing: inhale 4s, hold 2s, exhale 6s -- */
function startBreathing(){
  const ball=document.getElementById('breathBall'), txt=document.getElementById('breathTxt'),
        cnt=document.getElementById('breathCount'), cyc=document.getElementById('breathCycles');
  const PHASES=[
    {label:'שאיפה... מנפחים את הבלון 🎈', secs:4, from:.6, to:1.15},
    {label:'עוצרים... מחזיקים את האוויר ✋', secs:2, from:1.15, to:1.15},
    {label:'נשיפה ארוכה... מוציאים הכל 💨', secs:6, from:1.15, to:.6},
  ];
  let phase=0, sec=0, cycles=0;
  const applyPhase=()=>{
    const p=PHASES[phase];
    txt.textContent=p.label;
    ball.style.transition='transform '+p.secs+'s '+(phase===2?'ease-out':'ease-in-out');
    ball.style.transform='scale('+p.to+')';
    calmBreathTone(phase);
    calmBreathHaptic(phase);
    // C7: narrate only the first cycle -- after that the child has the
    // rhythm from the tone/ball/haptics, and repeating the same sentence
    // every 4-12s forever would just be noise.
    if(cycles===0&&calmTtsEnabled()) speakWithHighlight(p.label,null,'he-IL',null);
  };
  ball.style.transition='none'; ball.style.transform='scale(.6)';
  requestAnimationFrame(()=>requestAnimationFrame(applyPhase));
  cnt.textContent=PHASES[0].secs; cyc.textContent='מנפחים בלון בבטן 🎈 — לאט לאט';
  _breathTimer=setInterval(()=>{
    sec++;
    const p=PHASES[phase];
    if(sec>=p.secs){
      sec=0; phase=(phase+1)%3;
      if(phase===0){ cycles++; cyc.textContent=cycles>=3?'כל הכבוד! אפשר להמשיך כמה שרוצים 🌟':'מנפחים בלון בבטן 🎈 — לאט לאט'; }
      applyPhase();
    }
    cnt.textContent=PHASES[phase].secs-sec;
  },1000);
}
// A soft tone per phase — auditory cue keeps the pace even with eyes closed.
function calmBreathTone(phase){
  try{
    actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    if(actx.state==='suspended') actx.resume();
    const o=actx.createOscillator(), g=actx.createGain();
    o.type='sine'; o.frequency.value=[330,392,262][phase];
    g.gain.setValueAtTime(0,actx.currentTime);
    g.gain.linearRampToValueAtTime(0.05,actx.currentTime+0.05);
    g.gain.linearRampToValueAtTime(0,actx.currentTime+0.5);
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime+0.55);
  }catch(e){}
}
// C1 (CALM-UPGRADE-PLAN): rhythm through the fingertips, not just eyes/ears --
// works with eyes closed and doesn't need auditory processing, both of which
// matter a lot mid-meltdown. Deliberately NOT guarded by state.calmMode (that
// guard exists to suppress EXCITEMENT haptics like coinFly/mascotReact; this
// vibration IS the calming tool itself, the same way the breathing tone above
// isn't muted either).
function calmBreathHaptic(phase){
  if(!navigator.vibrate) return;
  try{
    if(phase===0) navigator.vibrate([40,120,40,120,40,120,40]); // inhale: short rising pulses
    else if(phase===1) navigator.vibrate(0); // hold: silence
    else navigator.vibrate([200,300,150,350,100,400]); // exhale: long, slowing pulses
  }catch(e){}
}

/* -- 5-4-3-2-1 sensory grounding, adapted for a young child -- */
const GROUND_STEPS=[
  {n:5, txt:'מצא 5 דברים שאתה רואה מסביב 👀', done:'מצאתי! ✓'},
  {n:4, txt:'גע ב-4 דברים ותרגיש אותם 🖐️', done:'נגעתי! ✓'},
  {n:3, txt:'הקשב… מהם 3 קולות שאתה שומע? 👂', done:'שמעתי! ✓'},
  {n:2, txt:'מצא 2 ריחות (או 2 דברים שאתה אוהב להריח) 👃', done:'מצאתי! ✓'},
  {n:1, txt:'דבר אחד שאתה אוהב בעצמך 💚', done:'סיימתי! ✓'},
];
let _groundStep=0;
function startGrounding(){ _groundStep=0; renderGroundStep(); }
function renderGroundStep(){
  const s=GROUND_STEPS[_groundStep];
  document.getElementById('groundNum').textContent=s.n;
  document.getElementById('groundTxt').textContent=s.txt;
  document.getElementById('groundNextBtn').textContent=s.done;
  if(calmTtsEnabled()) speakWithHighlight(s.txt,null,'he-IL',null);
}
function calmGroundNext(){
  if(_groundStep>=GROUND_STEPS.length){ startGrounding(); return; } // "again?" tap restarts
  if(_groundStep<GROUND_STEPS.length-1){ _groundStep++; renderGroundStep(); }
  else{
    _groundStep=GROUND_STEPS.length;
    document.getElementById('groundNum').textContent='🌟';
    document.getElementById('groundTxt').textContent='כל הכבוד! עשית את כל משחק החושים';
    document.getElementById('groundNextBtn').textContent='עוד פעם? 🔄';
  }
}

/* -- progressive muscle relaxation: tense 5s, release 10s, per body area -- */
const MUSCLE_STEPS=[
  {ic:'🍋', tense:'דמיין לימון בכל יד — סחט אותו חזק חזק!', release:'עכשיו שחרר... תן לידיים ליפול רפויות'},
  {ic:'🐢', tense:'תהיה צב! הרם כתפיים עד האוזניים', release:'הצב יוצא... הורד כתפיים לאט ותרגיש כמה נעים'},
  {ic:'🪰', tense:'זבוב על האף! כווץ את כל הפנים חזק', release:'הזבוב עף... שחרר את הפנים לגמרי'},
  {ic:'🏖️', tense:'דרוך על החול! לחץ עם הרגליים חזק ברצפה', release:'שחרר... הרגליים רכות וכבדות'},
];
function startMuscle(){
  let step=0, inTense=true, sec=0;
  const TENSE=5, RELEASE=10;
  const ic=document.getElementById('muscleIc'), txt=document.getElementById('muscleTxt'),
        fill=document.getElementById('muscleFill'), hint=document.getElementById('muscleHint');
  const apply=()=>{
    const s=MUSCLE_STEPS[step];
    ic.textContent=s.ic;
    txt.textContent=inTense?s.tense:s.release;
    hint.textContent=inTense?'חזק! עוד '+(TENSE-sec)+' שניות':'לאט... תרגיש את ההבדל';
    if(calmTtsEnabled()) speakWithHighlight(txt.textContent,null,'he-IL',null);
  };
  apply();
  _muscleTimer=setInterval(()=>{
    sec++;
    const dur=inTense?TENSE:RELEASE;
    fill.style.width=Math.min(100,(sec/dur)*100)+'%';
    if(sec>=dur){
      sec=0;
      if(inTense){ inTense=false; }
      else{
        inTense=true; step++;
        if(step>=MUSCLE_STEPS.length){
          clearInterval(_muscleTimer); _muscleTimer=null;
          ic.textContent='😌'; txt.textContent='כל הגוף רגוע עכשיו. כל הכבוד!';
          hint.textContent=''; fill.style.width='100%';
          return;
        }
      }
    }
    apply();
  },1000);
}

// C2 (CALM-UPGRADE-PLAN): proprioceptive "heavy work" -- wall pushes, chair
// presses, isometric holds, a self-hug for deep pressure -- is the OT-backed
// #1 recommendation for discharging anger/big physical energy, a category
// the toolkit didn't have at all before this (breathing/muscle-release are
// calming but not discharging). Reuses _muscleTimer -- stopCalmActivity()
// already clears it, and only one of startMuscle/startHeavy ever runs at once.
const HEAVY_STEPS=[
  {ic:'🧱', txt:'לך לקיר ודחוף אותו הכי חזק שאתה יכול — כאילו אתה מזיז את הבית!', secs:10},
  {ic:'🪑', txt:'שב על כיסא, שים ידיים בצדדים ולחץ למטה להרים את עצמך', secs:8},
  {ic:'🤲', txt:'הצמד את כפות הידיים חזק אחת לשנייה מול החזה', secs:8},
  {ic:'🤗', txt:'חבק את עצמך חזק חזק — לחיצה גדולה של אלוף', secs:10},
];
function startHeavy(){
  let step=0, sec=0;
  const ic=document.getElementById('heavyIc'), txt=document.getElementById('heavyTxt'),
        fill=document.getElementById('heavyFill'), hint=document.getElementById('heavyHint');
  const apply=()=>{
    const s=HEAVY_STEPS[step];
    ic.textContent=s.ic; txt.textContent=s.txt;
    hint.textContent='דחוף/לחץ חזק! עוד '+(s.secs-sec)+' שניות';
    fill.style.width='0%';
    if(calmTtsEnabled()) speakWithHighlight(s.txt,null,'he-IL',null);
  };
  apply();
  _muscleTimer=setInterval(()=>{
    sec++;
    const s=HEAVY_STEPS[step];
    fill.style.width=Math.min(100,(sec/s.secs)*100)+'%';
    hint.textContent='דחוף/לחץ חזק! עוד '+Math.max(0,s.secs-sec)+' שניות';
    if(sec>=s.secs){
      sec=0; step++;
      if(step>=HEAVY_STEPS.length){
        clearInterval(_muscleTimer); _muscleTimer=null;
        ic.textContent='😌'; txt.textContent='וואו! פרקת את כל הכוח. איך ההרגשה?';
        hint.textContent=''; fill.style.width='100%';
        return;
      }
      apply();
    }
  },1000);
}

// C4 (CALM-UPGRADE-PLAN): finger-trace breathing -- the child follows a dot
// along a drawn arc with their own finger instead of only watching a ball
// scale up/down. The motor+visual channel together helps kids who find a
// purely visual cue (the balloon) hard to track when already dysregulated.
// Inhale 4s forward along the arc, exhale 6s back -- no hold, unlike the
// balloon (a held breath is harder to track visually against a moving path).
let _traceAnim=null;
function startTrace(){
  const path=document.getElementById('traceArcPath'), dot=document.getElementById('traceDot'),
        txt=document.getElementById('traceTxt');
  if(!path||!dot) return;
  const total=path.getTotalLength();
  let dir=1, cycles=0, startTs=null; // dir: 1=inhale (forward along the arc), -1=exhale (back)
  const DUR={'1':4000,'-1':6000};
  const setLabel=()=>{
    txt.textContent=dir===1?'שאיפה — עקוב עם האצבע אחרי הכדור 👆':'נשיפה ארוכה... חזרה לאט לאט';
    if(cycles===0&&calmTtsEnabled()) speakWithHighlight(txt.textContent,null,'he-IL',null);
  };
  const placeAt=(t)=>{ const pt=path.getPointAtLength(t*total); dot.setAttribute('cx',pt.x); dot.setAttribute('cy',pt.y); };
  setLabel();
  try{ navigator.vibrate&&navigator.vibrate(30); }catch(e){}
  // C12: this dot's motion is driven by JS (setAttribute per rAF frame), not
  // a CSS animation/transition -- the global prefers-reduced-motion rule
  // (which only forces animation/transition DURATIONS to ~0) has no effect
  // on it. Jump straight to each endpoint and hold via setTimeout instead of
  // animating every frame; the exercise still works (label/TTS/vibration
  // cues), just without continuous motion.
  if(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches){
    placeAt(dir===1?1:0);
    const tick=()=>{
      dir=-dir; if(dir===1) cycles++;
      placeAt(dir===1?1:0);
      setLabel();
      try{ navigator.vibrate&&navigator.vibrate(30); }catch(e){}
      _traceAnim=setTimeout(tick,DUR[dir]);
    };
    _traceAnim=setTimeout(tick,DUR[dir]);
    return;
  }
  const step=(ts)=>{
    if(!startTs) startTs=ts;
    let frac=(ts-startTs)/DUR[dir];
    if(frac>1) frac=1;
    placeAt(dir===1?frac:1-frac);
    if(frac>=1){
      dir=-dir; if(dir===1) cycles++;
      startTs=ts;
      setLabel();
      try{ navigator.vibrate&&navigator.vibrate(30); }catch(e){}
    }
    _traceAnim=requestAnimationFrame(step);
  };
  _traceAnim=requestAnimationFrame(step);
}
function stopTrace(){
  if(_traceAnim){ cancelAnimationFrame(_traceAnim); clearTimeout(_traceAnim); _traceAnim=null; }
}

// C3 (CALM-UPGRADE-PLAN): a purely passive "calm screen" gives the hands
// nothing to do -- an interactive pop-it-style fidget (pop + soft tone +
// tiny vibration + a fresh bubble reborn elsewhere) channels restless energy
// through the fingertips instead, the same digital-fidget category as
// Haptic Box. No goal/count target on purpose -- it's a fidget, not a game.
let _bubbleCount=0;
function renderCalmBubbles(){
  const box=document.getElementById('calmVisualBox'); box.innerHTML='';
  _bubbleCount=0;
  updateBubbleCount();
  for(let i=0;i<10;i++) spawnBubble(box);
}
function spawnBubble(box){
  const b=document.createElement('div'); b.className='calm-bubble';
  const size=20+Math.random()*40;
  b.style.width=size+'px'; b.style.height=size+'px';
  b.style.left=(Math.random()*85)+'%'; b.style.top=(Math.random()*70)+'%';
  b.style.animationDuration=(5+Math.random()*4)+'s';
  b.style.animationDelay=(Math.random()*3)+'s';
  b.onclick=()=>popBubble(b,box);
  box.appendChild(b);
}
function popBubble(b,box){
  if(b.classList.contains('popping')) return; // ignore a double-tap mid-pop
  b.classList.add('popping');
  try{ navigator.vibrate&&navigator.vibrate(15); }catch(e){}
  calmPopTone();
  _bubbleCount++; updateBubbleCount();
  setTimeout(()=>{
    b.remove();
    if(_calmActive==='visual') spawnBubble(box); // still on this screen -- respawn
  },400);
}
function updateBubbleCount(){
  const el=document.getElementById('bubbleCount'); if(el) el.textContent=_bubbleCount;
}
function calmPopTone(){
  try{
    actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    if(actx.state==='suspended') actx.resume();
    const o=actx.createOscillator(), g=actx.createGain();
    o.type='sine';
    o.frequency.setValueAtTime(500,actx.currentTime);
    o.frequency.exponentialRampToValueAtTime(200,actx.currentTime+0.15);
    g.gain.setValueAtTime(0.06,actx.currentTime);
    g.gain.linearRampToValueAtTime(0.0001,actx.currentTime+0.15);
    o.connect(g); g.connect(actx.destination);
    o.start(); o.stop(actx.currentTime+0.16);
  }catch(e){}
}

/* -- soundscapes: filtered-noise synthesis (offline, no audio files) -- */
// C6 (CALM-UPGRADE-PLAN): heartbeat doesn't fit the shared noise-buffer model
// below (it's a rhythmic double-thump, not continuous filtered noise), so it
// gets its own path; ocean/rain/purr all share the same brown-noise buffer
// with different filter/LFO settings.
function startCalmNoise(kind){
  stopCalmNoise();
  try{
    actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    // Mobile browsers auto-suspend an AudioContext on backgrounding and it
    // stays suspended silently; resume() here runs inside the tap gesture.
    if(actx.state==='suspended') actx.resume();
    if(kind==='heartbeat'){ startHeartbeat(); return; }
    // 4s looped brown-noise buffer — the 1/f² spectrum is the "deep" noise
    // used in sensory-room sound machines (white noise reads as harsh hiss).
    const len=actx.sampleRate*4, buf=actx.createBuffer(1,len,actx.sampleRate);
    const d=buf.getChannelData(0);
    let last=0;
    for(let i=0;i<len;i++){ const w=Math.random()*2-1; last=(last+0.02*w)/1.02; d[i]=last*3.5; }
    const src=actx.createBufferSource(); src.buffer=buf; src.loop=true;
    const filter=actx.createBiquadFilter();
    const master=actx.createGain();
    const lfo=actx.createOscillator(), lfoGain=actx.createGain();
    if(kind==='ocean'){
      // waves = deep rumble whose loudness swells and recedes ~every 9s
      filter.type='lowpass'; filter.frequency.value=420; master.gain.value=0.12;
      lfo.frequency.value=0.11; lfoGain.gain.value=0.08;
    }else if(kind==='rain'){
      // rain = brighter patter, steady with a slight natural flutter
      filter.type='bandpass'; filter.frequency.value=1800; filter.Q.value=0.6; master.gain.value=0.07;
      lfo.frequency.value=0.5; lfoGain.gain.value=0.012;
    }else{
      // purr = warm low rumble with a fast buzz (the cat's actual purr rate)
      filter.type='lowpass'; filter.frequency.value=150; master.gain.value=0.1;
      lfo.frequency.value=25; lfoGain.gain.value=0.03;
    }
    lfo.connect(lfoGain); lfoGain.connect(master.gain);
    lfo.start();
    src.connect(filter); filter.connect(master); master.connect(actx.destination);
    src.start();
    _calmNoise={nodes:[src,lfo],master};
    if(kind==='purr'){
      // second, slower LFO layered on top -- the gentle rise/fall of the
      // purring cat's own breathing, under the fast buzz above.
      const lfo2=actx.createOscillator(), lfo2Gain=actx.createGain();
      lfo2.frequency.value=0.4; lfo2Gain.gain.value=0.02;
      lfo2.connect(lfo2Gain); lfo2Gain.connect(master.gain);
      lfo2.start();
      _calmNoise.nodes.push(lfo2);
    }
  }catch(e){
    document.getElementById('calmSoundLabel').textContent='⚠️ הקול לא זמין במכשיר הזה כרגע';
  }
}
// A resting heart rate ~66bpm, "lub-dub" double-thump per beat.
function startHeartbeat(){
  const beat=()=>{
    try{
      const thump=(delay,peak)=>{
        const o=actx.createOscillator(), g=actx.createGain();
        o.type='sine'; o.frequency.value=55;
        g.gain.setValueAtTime(0,actx.currentTime+delay);
        g.gain.linearRampToValueAtTime(peak,actx.currentTime+delay+0.05);
        g.gain.linearRampToValueAtTime(0,actx.currentTime+delay+0.18);
        o.connect(g); g.connect(actx.destination);
        o.start(actx.currentTime+delay); o.stop(actx.currentTime+delay+0.2);
      };
      thump(0,0.22); thump(0.22,0.14); // lub, dub
    }catch(e){}
  };
  beat();
  _calmNoise={interval:setInterval(beat,900),nodes:[]};
}
// C6: optional auto-stop, useful at bedtime -- clearing any PREVIOUS timer
// first means switching sounds (which calls stopCalmNoise -> here) never
// leaves a stale timer silently cutting off the newly-chosen sound early.
let _calmSoundTimeout=null;
function setCalmSoundTimer(minutes){
  if(_calmSoundTimeout){ clearTimeout(_calmSoundTimeout); _calmSoundTimeout=null; }
  document.querySelectorAll('.calm-timer-btn').forEach(b=>b.classList.toggle('sel',+b.dataset.min===minutes));
  if(minutes>0){
    _calmSoundTimeout=setTimeout(()=>{
      stopCalmNoise();
      const lbl=document.getElementById('calmSoundLabel'); if(lbl) lbl.textContent='הצליל נגמר בשקט... לילה טוב 🌙';
      document.querySelectorAll('.calm-timer-btn').forEach(b=>b.classList.remove('sel'));
    },minutes*60000);
  }
}
function stopCalmNoise(){
  if(_calmSoundTimeout){ clearTimeout(_calmSoundTimeout); _calmSoundTimeout=null; }
  if(_calmNoise&&_calmNoise.interval){ clearInterval(_calmNoise.interval); _calmNoise=null; return; }
  if(!_calmNoise) return;
  _calmNoise.nodes.forEach(n=>{ try{ n.stop(); }catch(e){} });
  _calmNoise=null;
}
// Back-compat: startCalmMusic name is referenced by older notes/tests.
function startCalmMusic(){ startCalmNoise('ocean'); }
function stopCalmMusic(){ stopCalmNoise(); }

/* -- close flow: quick after check-in, log for the parent -- */
function requestCloseCalm(){
  stopCalmActivity();
  // Only ask "how do you feel now" if a before-feeling was given and a tool
  // was actually used — otherwise close instantly (zero friction).
  if(_calmSession&&_calmSession.before&&_calmSession.tool){ calmShowPane('calmAfter'); }
  else calmFinish(null);
}
async function calmFinish(after){
  document.getElementById('calmModal').classList.remove('show');
  stopCalmActivity();
  if(_calmSession&&_calmSession.tool){
    const log=(await DB.get('cs_calmlog'))??[];
    log.unshift({ts:_calmSession.ts, childId:state.current, before:_calmSession.before, after:after, tool:_calmSession.tool, body:_calmSession.body||null, secs:Math.round((Date.now()-_calmSession.ts)/1000)});
    if(log.length>60) log.length=60;
    await DB.set('cs_calmlog',log);
  }
  _calmSession=null;
  document.querySelectorAll('#feelRowBefore .feel-btn').forEach(b=>b.style.outline='none');
  document.querySelectorAll('.calm-tile').forEach(t=>t.classList.remove('suggested'));
  document.querySelectorAll('.body-chip').forEach(c=>c.classList.remove('sel'));
  const bodyRow=document.getElementById('calmBodyRow'); if(bodyRow) bodyRow.style.display='none';
  document.getElementById('calmSuggest').textContent='בחר מה יעזור לך עכשיו';
}
function closeCalmBreak(){ calmFinish(null); }
document.getElementById('breakBtn').onclick=openCalmBreak;
function applyCalmModeClass(){
  document.querySelector('.app').classList.toggle('calm-mode',!!state.calmMode);
  // #mc-deco lives outside .app (a fixed full-viewport background layer), so
  // `.app.calm-mode` selectors can't reach it -- mirror the flag onto body
  // too, purely so styles.css can freeze its cloud-drift animation.
  document.body.classList.toggle('calm-mode',!!state.calmMode);
}
async function toggleCalmMode(){
  state.calmMode=!state.calmMode;
  await DB.set('cs_calm',state.calmMode);
  applyCalmModeClass();
  const btn=document.getElementById('calmToggle');
  if(btn){ btn.textContent=state.calmMode?'פעיל ✓':'כבוי'; btn.className='btn sm '+(state.calmMode?'mint':'ghost'); }
}

/* ===== FX ===== */
// Flies one coin from a starting point to the balance pill in the topbar
// (#balTop, always on-screen once a child profile is active) -- a targeted,
// legible version of coinBurst() for the moment a specific action earns
// coins. `from` is a DOMRect, NOT a live element -- callers must snapshot
// getBoundingClientRect() before any re-render can detach/move the element
// (e.g. answerLearningQuestion's renderLearningQuestion() rebuilds the choice
// buttons via innerHTML='' right after the tap, so capturing the rect late
// would always see a detached, zero-size element). Falls back to coinBurst() if the rect is
// missing/empty, and is a no-op under reduced-motion (same as coinBurst()).
function coinFly(from){
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const target=document.getElementById('balTop');
  if(!from||!target){ coinBurst(); return; }
  const to=target.getBoundingClientRect();
  if(from.width===0&&from.height===0){ coinBurst(); return; } // detached/hidden element
  const coin=document.createElement('div');
  coin.textContent='🪙';
  coin.style.cssText='position:fixed;z-index:150;pointer-events:none;font-size:1.6rem;will-change:transform,opacity;';
  coin.style.left=(from.left+from.width/2-14)+'px';
  coin.style.top=(from.top+from.height/2-14)+'px';
  document.body.appendChild(coin);
  const dx=(to.left+to.width/2)-(from.left+from.width/2), dy=(to.top+to.height/2)-(from.top+from.height/2);
  const anim=coin.animate([
    {transform:'translate(0,0) scale(1)',opacity:1,offset:0},
    {transform:`translate(${dx*.5}px,${dy*.5-60}px) scale(1.15)`,opacity:1,offset:.55},
    {transform:`translate(${dx}px,${dy}px) scale(.3)`,opacity:.6,offset:1},
  ],{duration:650,easing:'cubic-bezier(.3,.1,.3,1)'});
  let cleaned=false;
  const cleanup=()=>{ if(cleaned) return; cleaned=true; coin.remove(); try{ target.animate([{transform:'scale(1.3)'},{transform:'scale(1)'}],{duration:260,easing:'ease-out'}); }catch(e){} };
  anim.onfinish=cleanup;
  setTimeout(cleanup,1200); // safety-net cleanup, same pattern as coinBurst()
}
function coinBurst(){
  // OS-level "reduce motion" is a stronger opt-out than calm mode: skip the
  // whole particle burst rather than just shrinking it (matches the CSS
  // @media rule — decorative motion is cut, not merely dampened).
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const E=['🪙','⭐','✨','🌟','💫'];
  const n=state.calmMode?4:12; // fewer particles in calm mode — less visual intensity
  for(let i=0;i<n;i++){
    const s=document.createElement('div'); s.className='burst'; s.textContent=E[Math.floor(Math.random()*E.length)];
    s.style.left=(50+(Math.random()*30-15))+'%'; s.style.top='30%'; document.body.appendChild(s);
    const dx=(Math.random()*260-130), dy=-(Math.random()*180+80), rot=Math.random()*720-360;
    const anim=s.animate([{transform:'translate(0,0) rotate(0) scale(1)',opacity:1},{transform:`translate(${dx}px,${dy}px) rotate(${rot}deg) scale(.4)`,opacity:0}],{duration:900+Math.random()*400,easing:'cubic-bezier(.2,.8,.3,1)'});
    anim.onfinish=()=>s.remove();
    setTimeout(()=>s.remove(),2000); // safety-net cleanup if onfinish never fires
  }
}
let actx=null;
// `mode` keeps the original boolean contract (true='spend'/low tone,
// false='success') and adds 'celebrate' -- a longer 4-note arpeggio reserved
// for badge unlocks and perfect learning sessions, so those moments sound
// distinctly bigger than an ordinary +1 coin without needing a new asset
// (still pure Web Audio, no files -- see DESIGN-IMPROVEMENTS.md V9). A wrong
// answer never calls chime() at all, by design, everywhere in the app --
// mistakes stay silent, never a harsh/buzzer sound.
function chime(mode){
  try{ actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    // See the matching comment in startCalmMusic(): resume a browser-suspended
    // context (e.g. after screen lock) so coin-earn sounds don't silently stop
    // working. Safe no-op if already running.
    if(actx.state==='suspended') actx.resume();
    // 'scan' -- a completed real-world task -- gets its own bright, quick
    // rising chime (sine, not triangle: a cleaner "ding" than the softer
    // earn/spend tones), so it reads as a distinct, memorable anchor rather
    // than the same generic tone every other coin gain uses.
    if(mode==='scan'){
      const vol=state.calmMode?0.08:0.2;
      [660,880].forEach((f,i)=>{ const o=actx.createOscillator(),g=actx.createGain(); o.type='sine'; o.frequency.value=f; o.connect(g); g.connect(actx.destination);
        const t=actx.currentTime+i*0.1; g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(vol,t+.015); g.gain.exponentialRampToValueAtTime(.001,t+.3); o.start(t); o.stop(t+.32); });
      return;
    }
    const notes=mode==='celebrate'?[523,659,784,1047]:(mode?[392,330]:[523,659,784]);
    const vol=state.calmMode?0.07:0.18; // quieter in calm mode — less sensory intensity
    notes.forEach((f,i)=>{ const o=actx.createOscillator(),g=actx.createGain(); o.type='triangle'; o.frequency.value=f; o.connect(g); g.connect(actx.destination);
      const t=actx.currentTime+i*0.09; g.gain.setValueAtTime(0,t); g.gain.linearRampToValueAtTime(vol,t+.02); g.gain.exponentialRampToValueAtTime(.001,t+.22); o.start(t); o.stop(t+.24); });
  }catch(e){}
}
let toastTimer=null;
function toast(msg){ const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2200); }
// Toast with an UNDO button — for deletions, which used to be instantly
// permanent (one mis-tap on a phone = data gone). The undo callback restores
// the captured snapshot; the toast stays up longer than a normal one.
// Parent-action audit trail (backlog #14): who changed what, visible to both
// parents via sync. Answers "רגע, מי נתן לו 50 מטבעות?" in a two-parent home.
// Whole-list last-write-wins on a concurrent append is acceptable for a log.
async function audit(action){
  try{
    const log=(await DB.get('cs_auditlog'))??[];
    log.unshift({ts:Date.now(),who:(typeof authUser!=='undefined'&&authUser&&authUser.email)||'מכשיר מקומי',action});
    if(log.length>50) log.length=50;
    state.auditLog=log; // buildSyncPayload reads from state
    await DB.set('cs_auditlog',log);
  }catch(e){}
}
// Shared delete-with-undo for the admin lists: capture item+position, delete,
// offer restore at the same spot.
async function delWithUndo(arr,i,storageKey,rerender,label,persist){
  // persist override: for arrays nested inside a bigger stored object
  // (e.g. anchored[period] inside cs_anchored), saving the bare array to the
  // storage key would corrupt the stored shape.
  const save=persist||(async()=>{ await DB.set(storageKey,arr); });
  const [item]=arr.splice(i,1);
  if(item===undefined) return;
  await save();
  rerender();
  audit('מחק '+label+': '+(item.label||item.name||''));
  undoToast(label+' נמחק',async()=>{
    arr.splice(Math.min(i,arr.length),0,item);
    await save();
    rerender();
    audit('שחזר '+label+': '+(item.label||item.name||''));
  });
}
function undoToast(msg,onUndo){
  const t=document.getElementById('toast');
  t.textContent='';
  const span=document.createElement('span'); span.textContent=msg+' ';
  const btn=document.createElement('button');
  btn.textContent='↩️ בטל';
  btn.style.cssText='border:none;background:rgba(255,255,255,.22);color:#fff;border-radius:14px;padding:4px 12px;margin-inline-start:8px;font-family:inherit;font-weight:800;font-size:.88rem;cursor:pointer;';
  btn.onclick=async()=>{ clearTimeout(toastTimer); t.classList.remove('show'); await onUndo(); toast('שוחזר ✓'); };
  t.appendChild(span); t.appendChild(btn);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>t.classList.remove('show'),8000);
}

/* ===== UTILS ===== */
function esc(s){ return (s+'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function timeAgo(ts){ const s=Math.floor((Date.now()-ts)/1000);
  if(s<60) return 'הרגע'; if(s<3600) return 'לפני '+Math.floor(s/60)+' דק׳'; if(s<86400) return 'לפני '+Math.floor(s/3600)+' שעות'; return 'לפני '+Math.floor(s/86400)+' ימים'; }

/* ===== TIME-BASED TASKS ===== */
function getTimeOfDay(hour){
  if(hour>=5&&hour<12) return 'morning';
  if(hour>=12&&hour<17) return 'afternoon';
  if(hour>=17&&hour<21) return 'evening';
  return 'night';
}
// Every task due for THIS child right now: anchored-to-the-current-period
// tasks PLUS every "anytime" task (no period set) -- a task simply isn't
// restricted unless the parent anchored it to a specific window. Applies to
// every child, schedule or not: period is a per-task property independent of
// whether a child has the visual day-schedule UI turned on (useSchedule only
// controls whether the day-strip/first-then widgets are shown). No sleep
// special-case here -- that's exclusive to the schedule home view, see
// getTasksForTimeOfDay().
function tasksDueNow(childId){
  const timeOfDay=getTimeOfDay(new Date().getHours());
  return state.chores.filter(t=>taskForChild(t,childId)&&(!t.period||t.period===timeOfDay));
}
// Schedule child's home screen only: same as tasksDueNow, but after
// sleep_time (or before 5am) the whole list is replaced by a single "time to
// sleep" pseudo-task -- the bedtime-cutoff concept only makes sense with the
// visual day-schedule UI, so non-schedule children never get it.
function getTasksForTimeOfDay(){
  const hour=new Date().getHours();
  if(!state.anchored) return [];
  if(hour>=state.anchored.sleep_time||hour<5) return [{id:'night_sleep',label:'זמן שינה',emoji:'😴',points:2,max:1}];
  return tasksDueNow(state.current);
}

/* ===== GEMINI CHAT + MIC + TTS ===== */
let GROQ_API_KEY='';
let chatHistory=[];
let micRecognition=null;
let isMicRecording=false;
let currentSpeech=null;

/* ---- "איזי" the assistant: config ----
   The API key and every setting here are DEVICE-LOCAL (localStorage), never
   synced: a key pushed into the family cloud record would be readable by any
   device that ever joins the family, and the chat log is the most private
   thing in the app -- it stays on the device the child actually typed it on,
   reviewable by a parent there, and never leaves for Firebase. */
const CHAT_MODEL_DEFAULT='llama-3.3-70b-versatile';
// Groq retires models on its own schedule; a hard-coded id that gets
// decommissioned would turn the whole feature into an error message with no
// clue why. On a model-specific failure we retry once with this and remember
// the switch, so the assistant keeps working without a parent touching it.
const CHAT_MODEL_FALLBACK='openai/gpt-oss-120b';
const CHAT_DAILY_CAP_DEFAULT=30;
const CHAT_LOG_MAX=60;
function chatKeySet(){ return !!GROQ_API_KEY; }
function chatEnabled(){ return chatKeySet() && localStorage.getItem('cs_chat_enabled')!=='0'; }
function chatModel(){ return localStorage.getItem('cs_chat_model')||CHAT_MODEL_DEFAULT; }
function chatDailyCap(){ const n=parseInt(localStorage.getItem('cs_chat_cap')); return Number.isFinite(n)&&n>0?n:CHAT_DAILY_CAP_DEFAULT; }

/* ---- safety layer ----
   A general-purpose LLM is not a children's product, and a system prompt is a
   request, not a guarantee. These patterns run BEFORE anything is sent, so the
   most sensitive things a child could type never reach a third-party server at
   all, and the child gets a steady, caring, human answer instead of whatever
   the model would improvise.

   CRISIS: self-harm, or someone hurting them. Never routed to the model --
   answered with a fixed message pointing at a trusted adult, and surfaced to
   the parent in the log. Deliberately mentions adults beyond the parent
   (teacher/family) rather than only "tell mum or dad".
   BLOCKED: adult/violent/substance topics -- gently redirected, also logged.
   PII: teaches "don't share where you live" rather than silently allowing it. */
const CHAT_CRISIS_PATTERNS=[
  /להרוג את עצמ/i,/לפגוע בעצמ/i,/לא רוצה לחיות/i,/רוצה למות/i,/שאמות/i,/להתאבד/i,/אתאבד/i,
  /מכה אותי/i,/מרביץ לי/i,/פוגע ב/i,/נוגע לי/i,/הטריד/i,/מפחיד אותי כל/i,
  /kill myself/i,/hurt myself/i,/want to die/i,/suicide/i,/abuse/i
];
const CHAT_BLOCKED_PATTERNS=[
  /סמים|קוקאין|מריחואנה|drugs|cocaine/i,
  /אקדח|רובה|נשק|לדקור|סכין|gun|weapon|stab/i,
  /סקס|מין|עירום|פורנו|sex|porn|nude/i,
  /אלכוהול|וודקה|בירה|שיכור|alcohol|vodka|beer|drunk/i
];
const CHAT_PII_PATTERNS=[
  /\b0\d{1,2}-?\d{7}\b/,               // Israeli phone number
  /\b\d{9}\b/,                          // ID-length digit run
  /גר ב(רחוב|כתובת)|הכתובת שלי|רחוב .+ \d+/i
];
function chatSafetyCheck(text){
  if(CHAT_CRISIS_PATTERNS.some(re=>re.test(text))) return 'crisis';
  if(CHAT_BLOCKED_PATTERNS.some(re=>re.test(text))) return 'blocked';
  if(CHAT_PII_PATTERNS.some(re=>re.test(text))) return 'pii';
  return null;
}
const CHAT_SAFE_REPLIES={
  crisis:'אני שמח מאוד שסיפרת לי, וזה נשמע ממש קשה 💙\nהדבר הזה גדול מדי בשבילי — חשוב שתספר/י על זה עכשיו למבוגר שאת/ה סומך/ת עליו: אמא, אבא, מורה, או מישהו אחר במשפחה. הם ירצו לעזור לך.\nאני כאן איתך בינתיים, ואפשר גם ללחוץ על הכפתור הירוק 🌿 למעלה כדי להירגע יחד.',
  blocked:'זה נושא למבוגרים, ואני לא הכתובת בשבילו 🙂\nאם מעניין אותך לדעת — שאל/י את אמא או אבא, הם יסבירו טוב ממני.\nרוצה שנדבר על משהו אחר? אני יודע המון דברים מעניינים!',
  pii:'רגע! 🛑 פרטים כמו כתובת, טלפון או תעודת זהות הם סוד — לא משתפים אותם באינטרנט, גם לא איתי.\nבוא/י נדבר על משהו אחר 😊'
};
// Defense in depth on the way back: the prompt asks the model to stay
// child-appropriate, this makes sure a bad generation never reaches the screen.
function chatOutputAllowed(reply){ return !CHAT_BLOCKED_PATTERNS.some(re=>re.test(reply)); }

/* ---- per-child persistence + daily budget (both device-local) ---- */
function chatLogKey(){ return 'cs_chatlog_'+state.current; }
async function chatLogGet(){ return (await DB.get(chatLogKey()))??[]; }
async function chatLogAdd(entry){
  const log=await chatLogGet();
  log.push(entry);
  if(log.length>CHAT_LOG_MAX) log.splice(0,log.length-CHAT_LOG_MAX);
  await DB.set(chatLogKey(),log);
}
async function chatUsedToday(){
  const u=(await DB.get('cs_chatused_'+state.current))??{date:'',n:0};
  return u.date===effectiveToday()?u.n:0;
}
async function chatBumpUsed(){
  const n=(await chatUsedToday())+1;
  await DB.set('cs_chatused_'+state.current,{date:effectiveToday(),n});
  return n;
}
// Grounds the assistant in what's actually happening in the child's app right
// now, so "מה אני צריך לעשות?" / "כמה מטבעות יש לי?" get a real answer instead
// of a guess. Deliberately minimal -- first name and app state only, no
// surname, no birthday, nothing that identifies the family to the provider.
function chatAppContext(){
  const k=cur(), c=curChild(); if(!k||!c) return '';
  const period={morning:'בוקר',afternoon:'צהריים',evening:'ערב',sleep:'לילה (זמן שינה)'}[currentPeriodKey()]||'';
  const due=tasksDueNow(state.current).filter(t=>(k.daily.counts[t.id]||0)<t.max).map(t=>t.label);
  return `מידע עדכני מהאפליקציה (השתמש בו רק אם הילד/ה שואל/ת על זה):
- עכשיו ${period}.
- מטבעות בארנק: ${k.balance}.
- זמן משחק שנשאר: ${Math.round((k.gtime||0)/60)} דקות.
- מטלות שנשארו לעכשיו: ${due.length?due.join(', '):'אין, הכול הושלם'}.`;
}

function displayMessage(text,isUser){
  const wrap=document.createElement('div');
  wrap.style.cssText='display:flex;align-items:flex-end;gap:6px;'+(isUser?'flex-direction:row-reverse;':'flex-direction:row;');
  const bubble=document.createElement('div');
  bubble.className=isUser?'chat-bubble-user':'chat-bubble-ai';
  bubble.textContent=text;
  wrap.appendChild(bubble);
  if(!isUser){
    const speakBtn=document.createElement('button');
    speakBtn.className='chat-speak-btn';
    speakBtn.title='האזן לתשובה';
    speakBtn.textContent='🔊';
    speakBtn.onclick=()=>speakText(text,speakBtn);
    wrap.appendChild(speakBtn);
  }
  const msgs=document.getElementById('chatMessages');
  msgs.appendChild(wrap);
  msgs.scrollTop=msgs.scrollHeight;
}

function speakText(text,btn){
  // Stop whatever's currently playing (web OR native) first. If the tapped
  // button was the one playing, this tap just means "stop".
  const wasThisPlaying=btn.textContent==='⏹️';
  if(currentSpeech){window.speechSynthesis.cancel();currentSpeech=null;}
  if(window.CoinQuestNative&&typeof window.CoinQuestNative.ttsStop==='function'){ try{ window.CoinQuestNative.ttsStop(); }catch(e){} }
  document.querySelectorAll('.chat-speak-btn.playing').forEach(b=>{b.classList.remove('playing');b.textContent='🔊';});
  if(wasThisPlaying) return;
  text=stripEmojiForSpeech(text);
  // Prefer Android's own TTS engine: inside the WebView a Hebrew speechSynthesis
  // voice is frequently just not installed, so the web path below stays silent
  // (this is exactly why the native bridge exists -- see AN1).
  if(nativeTtsAvailable()){
    const uid='chat'+Date.now();
    btn.classList.add('playing'); btn.textContent='⏹️';
    const reset=()=>{ btn.classList.remove('playing'); btn.textContent='🔊'; };
    window._nativeTtsEnd=(id)=>{ if(id===uid) reset(); };
    try{ if(!window.CoinQuestNative.ttsSpeak(text,'he-IL',uid,state.calmMode?0.75:0.9)) reset(); }
    catch(e){ reset(); }
    return;
  }
  const utt=new SpeechSynthesisUtterance(text);
  utt.lang='he-IL';
  utt.rate=0.85;
  utt.pitch=1.1;
  const voices=window.speechSynthesis.getVoices().filter(v=>v.lang.startsWith('he'));
  if(voices.length) utt.voice=voices[0];
  utt.onstart=()=>{btn.classList.add('playing');btn.textContent='⏹️';};
  utt.onend=()=>{btn.classList.remove('playing');btn.textContent='🔊';currentSpeech=null;};
  currentSpeech=utt;
  window.speechSynthesis.speak(utt);
}

function toggleMic(){
  if(isMicRecording){stopMic();return;}
  if(!('webkitSpeechRecognition' in window||'SpeechRecognition' in window)){toast('הדפדפן לא תומך בהקלטה 😕');return;}
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  micRecognition=new SR();
  micRecognition.lang='he-IL';
  micRecognition.continuous=false;
  micRecognition.interimResults=true;
  micRecognition.onstart=()=>{
    isMicRecording=true;
    document.getElementById('micBtn').classList.add('recording');
    document.getElementById('micBtn').textContent='⏹️';
    document.getElementById('micStatus').textContent='🎤 מקשיב...';
  };
  micRecognition.onresult=(e)=>{
    const transcript=Array.from(e.results).map(r=>r[0].transcript).join('');
    document.getElementById('chatInput').value=transcript;
  };
  micRecognition.onend=()=>{
    isMicRecording=false;
    document.getElementById('micBtn').classList.remove('recording');
    document.getElementById('micBtn').textContent='🎤';
    document.getElementById('micStatus').textContent='';
    const val=document.getElementById('chatInput').value.trim();
    if(val) sendChatMessage();
  };
  micRecognition.onerror=(e)=>{
    stopMic();
    document.getElementById('micStatus').textContent='';
    if(e.error!=='aborted') toast('שגיאת מיקרופון: '+e.error);
  };
  micRecognition.start();
}
function stopMic(){
  if(micRecognition){micRecognition.stop();micRecognition=null;}
  isMicRecording=false;
  document.getElementById('micBtn').classList.remove('recording');
  document.getElementById('micBtn').textContent='🎤';
  document.getElementById('micStatus').textContent='';
}

let _chatBusy=false;
async function sendChatMessage(){
  if(_chatBusy) return; // block concurrent sends (rapid tapping / double-fire spam)
  const input=document.getElementById('chatInput');
  const text=input.value.trim();
  if(!text) return;
  if(!chatEnabled()){ displayMessage('הצ\'אט כבוי כרגע. אמא או אבא יכולים להפעיל אותו בהגדרות 🙂',false); return; }
  _chatBusy=true;
  input.value='';
  displayMessage(text,true);
  await chatLogAdd({ts:Date.now(),role:'child',text});

  // --- safety gate: never leaves the device on a crisis/blocked/PII match ---
  const flag=chatSafetyCheck(text);
  if(flag){
    const reply=CHAT_SAFE_REPLIES[flag];
    displayMessage(reply,false);
    await chatLogAdd({ts:Date.now(),role:'izzy',text:reply,flag});
    if(flag==='crisis'){
      // Make it trivially easy to move from "I said something heavy" to a
      // regulating activity, without forcing it on them.
      const wrap=document.createElement('div');
      wrap.innerHTML='<button class="btn mint sm" style="margin:4px 0 0;" onclick="openCalmBreak()">🌿 בוא/י נירגע יחד</button>';
      document.getElementById('chatMessages').appendChild(wrap);
    }
    const sb=document.querySelectorAll('.chat-speak-btn');
    if(sb.length) speakText(reply,sb[sb.length-1]);
    _chatBusy=false;
    return;
  }

  // --- daily budget: a runaway loop of taps shouldn't burn a parent's credit ---
  const used=await chatUsedToday();
  if(used>=chatDailyCap()){
    const capMsg='דיברנו הרבה היום! 😊 נמשיך מחר — אני אהיה כאן.';
    displayMessage(capMsg,false);
    await chatLogAdd({ts:Date.now(),role:'izzy',text:capMsg,flag:'cap'});
    _chatBusy=false;
    return;
  }
  await chatBumpUsed();

  const childName=curChild()?.name||'אריאל';
  const thinkingWrap=document.createElement('div');
  thinkingWrap.style.cssText='display:flex;align-items:flex-start;gap:6px;';
  thinkingWrap.innerHTML='<div class="chat-bubble-ai" style="color:var(--muted);">✨ חושב...</div>';
  document.getElementById('chatMessages').appendChild(thinkingWrap);
  document.getElementById('chatMessages').scrollTop=document.getElementById('chatMessages').scrollHeight;
  try{
    // Hebrew is a lower-resource language for most hosted LLMs (including this
    // one), so answer quality/fluency here has a real ceiling that no prompt
    // wording alone fixes -- being explicit about "fluent, natural Hebrew (not
    // a stiff translation)" measurably helps, but a parent who finds it still
    // lacking may want to swap in a different provider's API key instead
    // (would need its own request/response wiring, not just this prompt).
    const systemPrompt=`אתה "איזי", עוזר חכם, סבלני ואוהב, שמדבר עם ילד/ה בשם ${childName} (בן/בת 7 בערך), שנמצא/ת על הספקטרום האוטיסטי בתפקוד גבוה. אתה חלק מאפליקציה משפחתית בשם "כספת המטבעות".

חוקים שאסור לשבור:
- תמיד פנה בשם הפרטי: ${childName}. אסור "בני", "יקירי", "מותק" או כינויים אחרים.
- עברית תקנית, שוטפת וטבעית בלבד — לא תרגום מילולי מאנגלית, לא ניסוח מאולץ.
- תשובות קצרות מאוד: 2-3 משפטים. משפטים קצרים, מילים ברמת כיתה א'-ב'.
- 1-2 אימוג'ים לכל היותר.
- שאלה אחת לכל היותר בסוף תשובה — לא להציף.
- אם אינך בטוח בעובדה: אמור זאת בפשטות ("אני לא בטוח") במקום לנחש.
- אתה תוכנה, לא אדם. אם שואלים — אמור זאת בפשטות ובלי דרמה.
- לעולם אל תבקש פרטים אישיים (כתובת, טלפון, בית ספר, סיסמאות).
- אל תיתן עצות רפואיות, תזונתיות, או על תרופות. הפנה להורים.
- אל תבטיח פרסים, מטבעות או זמן משחק — רק ההורים קובעים אותם.
- נושאים למבוגרים (אלימות, סמים, מין): סרב בעדינות והפנה להורים.

איך לענות לפי מצב:
- משועמם/ת: הצע פעילות יצירתית קונקרטית אחת (ציור, לגו, משחק דמיון, ניסוי פשוט) — לא אוכל, לא מסכים.
- עצוב/כועס/מתוסכל: קודם כל שקף את הרגש ("זה נשמע ממש מעצבן"), רק אחר כך הצע צעד אחד קטן. הזכר שאפשר ללחוץ על הכפתור הירוק 🌿 באפליקציה כדי להירגע (יש שם נשימות, בועות ותרגילים).
- שאלת ידע: הסבר מדויק, מעניין, עם דוגמה אחת מהחיים.
- שאלה על האפליקציה (מטלות, מטבעות, זמן משחק): השתמש במידע העדכני שקיבלת.
- קושי חברתי: תן צעד מעשי אחד ופשוט, בלי הטפות.

${chatAppContext()}`;
    // Recent turns only: enough for continuity, bounded so a long day of
    // chatting can't grow the request (and its cost) without limit.
    const messages=[
      {role:'system',content:systemPrompt},
      ...chatHistory.slice(-10).map(m=>({role:m.isUser?'user':'assistant',content:m.text})),
      {role:'user',content:text}
    ];
    if(!GROQ_API_KEY){ thinkingWrap.remove(); displayMessage('⚙️ הכנס מפתח Groq בהגדרות הורים (לשונית הגדרות)',false); return; }
    const callGroq=(model)=>fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_API_KEY},
      body:JSON.stringify({model,messages,max_tokens:220,temperature:0.4})
    });
    let response=await callGroq(chatModel());
    // A decommissioned/renamed model id answers 400/404 with "model" in the
    // message. Retry once on the fallback and REMEMBER it, so the feature
    // self-heals instead of dying the day Groq retires a model.
    if(!response.ok&&(response.status===400||response.status===404)&&chatModel()!==CHAT_MODEL_FALLBACK){
      let looksLikeModelIssue=false;
      try{ const e=await response.clone().json(); looksLikeModelIssue=/model/i.test(e?.error?.message||''); }catch(e){}
      if(looksLikeModelIssue){
        const retry=await callGroq(CHAT_MODEL_FALLBACK);
        if(retry.ok){ localStorage.setItem('cs_chat_model',CHAT_MODEL_FALLBACK); response=retry; }
      }
    }
    // A non-2xx (bad/expired key, rate limit, server error) can still carry a
    // non-JSON or empty body; guard so response.json() doesn't throw an opaque
    // "Unexpected token" that surfaces to the child as a scary raw error.
    if(!response.ok){
      let msg='שגיאת שרת ('+response.status+')';
      try{ const err=await response.json(); if(err&&err.error&&err.error.message) msg=err.error.message; }catch(e){}
      console.error('Groq HTTP error:',msg);
      thinkingWrap.remove();
      // The child never sees the raw provider error (it's English, technical,
      // and sometimes leaks key/billing details) -- it goes to the console and
      // the parent-facing log instead.
      displayMessage('אופס, לא הצלחתי לענות כרגע 😔 נסה/י שוב עוד רגע.',false);
      await chatLogAdd({ts:Date.now(),role:'izzy',text:'[שגיאת שירות] '+msg,flag:'error'});
      return;
    }
    const data=await response.json();
    if(data.error){
      console.error('Groq error:',data.error);
      thinkingWrap.remove();
      displayMessage('אופס, לא הצלחתי לענות כרגע 😔 נסה/י שוב עוד רגע.',false);
      await chatLogAdd({ts:Date.now(),role:'izzy',text:'[שגיאת שירות] '+data.error.message,flag:'error'});
      return;
    }
    let reply=data.choices?.[0]?.message?.content||'לא הצלחתי לענות, נסה/י שוב 😔';
    let outFlag=null;
    if(!chatOutputAllowed(reply)){ reply=CHAT_SAFE_REPLIES.blocked; outFlag='blocked-output'; }
    chatHistory.push({text,isUser:true},{text:reply,isUser:false});
    thinkingWrap.remove();
    displayMessage(reply,false);
    await chatLogAdd({ts:Date.now(),role:'izzy',text:reply,flag:outFlag});
    const speakBtns=document.querySelectorAll('.chat-speak-btn');
    if(speakBtns.length) speakText(reply,speakBtns[speakBtns.length-1]);
  }catch(e){
    console.error('Chat error:',e);
    thinkingWrap.remove();
    displayMessage('אין חיבור לאינטרנט 😓 נסה/י שוב!',false);
  }finally{
    _chatBusy=false;
  }
}

/* ---- chat view lifecycle: restore history, starter chips, cap notice ---- */
// Starter prompts matter more here than in a general chatbot: initiating an
// open-ended conversation is exactly the step that's hardest for the child
// this app is built around. One tap sends a complete, well-formed question.
const CHAT_STARTERS=[
  {ic:'🎨',label:'אני משועמם',text:'אני משועמם, מה אפשר לעשות?'},
  {ic:'😔',label:'יום קשה',text:'היה לי יום קשה היום'},
  {ic:'🦖',label:'ספר לי משהו',text:'ספר לי משהו מעניין על דינוזאורים'},
  {ic:'📋',label:'מה נשאר לי?',text:'מה נשאר לי לעשות היום?'},
];
async function initChatView(){
  const msgs=document.getElementById('chatMessages'); if(!msgs) return;
  msgs.innerHTML='';
  chatHistory=[];
  const log=await chatLogGet();
  // Replay the tail of the persisted conversation so closing the app doesn't
  // wipe the thread mid-topic (and so a parent glancing at the screen sees the
  // same thing the child does).
  log.slice(-12).forEach(e=>{
    displayMessage(e.text,e.role==='child');
    chatHistory.push({text:e.text,isUser:e.role==='child'});
  });
  if(!log.length){
    displayMessage('שלום '+(curChild()?.name||'')+'! אני איזי 🤖\nאפשר לשאול אותי כל דבר, או ללחוץ על אחד הכפתורים למטה.',false);
  }
  const chips=document.getElementById('chatStarters');
  if(chips){
    chips.innerHTML='';
    CHAT_STARTERS.forEach(s=>{
      const b=document.createElement('button');
      b.className='chat-chip'; b.innerHTML=`<span>${s.ic}</span> ${esc(s.label)}`;
      b.onclick=()=>{ document.getElementById('chatInput').value=s.text; sendChatMessage(); };
      chips.appendChild(b);
    });
  }
  const left=chatDailyCap()-(await chatUsedToday());
  const note=document.getElementById('chatCapNote');
  if(note){
    note.style.display=left<=5?'':'none';
    note.textContent=left>0?('נשארו '+left+' הודעות להיום 🙂'):'דיברנו הרבה היום — נמשיך מחר! 😊';
  }
}

/* ===== FIREBASE AUTO-SYNC (family data, keyed by state.familyId) ===== */
let fbSyncTimer=null, fbSyncing=false, fbPendingPush=false;
// Pushes are suspended until the initial load + pull settles, so a slow pull on
// a mobile connection can't be clobbered by an early push of pre-pull state.
let syncReady=false;

function showSyncStatus(msg,color){
  const el=document.getElementById('syncStatus');
  if(el){ el.textContent=msg; el.style.color=color||'var(--mint)'; }
}
function familyRef(){ return state.familyId?fbDb.ref('families/'+state.familyId+'/data'):null; }

function buildSyncPayload(){
  // The parent code itself is NEVER uploaded -- only a salted hash of it. The
  // family node is readable by every member, and in this app a member can be
  // the CHILD's own Google account, so a plaintext parent code sitting there
  // would be readable by exactly the person it exists to keep out. The hash
  // is enough to make every device accept the same code without any device
  // (or the cloud) ever holding the code in a readable form.
  const payload={pinHash:state.pinHash||null,
    entitlement:state.entitlement||null, trialStartedAt:state.trialStartedAt||null,
    children:state.children,chores:state.chores,actions:state.actions,
    rewards:state.rewards,math:state.math,streaks:state.streaks,badgeDefs:state.badgeDefs,
    anchored:state.anchored,events:state.events||[],hwmDate:_hwmDate,calmMode:state.calmMode,
    gameBedtime:state.gameBedtime,
    games:state.games,auditLog:state.auditLog||[],learning:state.learning,kids:{}};
  for(const ch of state.children){
    const k=state.kid[ch.id];
    if(k){
      payload.kids[ch.id]={balance:k.balance,history:k.history,daily:k.daily,mathDaily:k.mathDaily,
        badges:k.badges,mathTotal:k.mathTotal,taskTotal:k.taskTotal,rewardsTotal:k.rewardsTotal,
        cashOwed:k.cashOwed||0,
        gtime:k.gtime||0,mathLevel:k.mathLevel||1,learn:k.learn,learnLevel:k.learnLevel||{math:1,english:1,science:1}};
    }
  }
  return payload;
}

async function pushToFirebase(){
  const ref=familyRef(); if(!ref) return;
  if(fbSyncing){
    // A push is already in flight (e.g. a slow connection). Don't just drop
    // this one silently — nothing else would ever retry it otherwise, and
    // whatever changed since the in-flight push started would stay
    // local-only indefinitely. Remember to push again once it finishes.
    fbPendingPush=true;
    return;
  }
  if(!syncFullPush&&syncDirty.size===0) return; // nothing changed on this device
  fbSyncing=true;
  // Claim the dirty set up front: edits made WHILE this push is in flight
  // re-mark their sections and get their own later push, instead of being
  // wrongly cleared as "already sent".
  const sections=[...syncDirty]; const wasFull=syncFullPush;
  syncDirty.clear(); syncFullPush=false;
  try{
    // A kid section can be dirty for a child whose data was never loaded into
    // memory this session (e.g. the admin +/- game-minutes buttons write
    // straight to storage). buildSyncPayload only serializes loaded kids, so
    // load them first — otherwise the update below would write null and
    // DELETE that child's cloud record.
    for(const s of sections){
      if(s.startsWith('kids/')){
        const id=s.slice(5);
        if(!state.kid[id]&&state.children.some(c=>c.id===id)) await loadKid(id);
      }
    }
    const payload=buildSyncPayload();
    if(wasFull){
      // First seed of a brand-new family: write the whole tree.
      await ref.set(payload);
    }else{
      const upd={};
      for(const s of sections){
        if(s.startsWith('kids/')){
          const id=s.slice(5);
          // null for a child that no longer exists => removes them in RTDB
          upd[s]=payload.kids[id]??null;
        }else{
          upd[s]=payload[s]??null;
        }
      }
      await ref.update(upd);
    }
    showSyncStatus('✅ מסונכרן '+new Date().toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'}),'var(--mint)');
  }catch(e){
    // Put the failed sections back so the retry actually retries them.
    sections.forEach(s=>syncDirty.add(s));
    if(wasFull) syncFullPush=true;
    showSyncStatus('⚠️ שגיאת שמירה','var(--coral)');
  }
  fbSyncing=false;
  if(fbPendingPush){ fbPendingPush=false; scheduleSync(); }
}

// Applies a full family-data snapshot (from either a one-time pull or the
// live listener below) to local state+storage. Shared so the two paths can
// never drift apart.
async function applyRemoteSnapshot(data){
  // Every pulled section is persisted locally via DB.set, which marks it
  // dirty — but those writes are cloud ECHOES, not local edits. Without
  // restoring the pre-pull dirty set afterward, every pull would schedule a
  // full push of everything it just downloaded, re-clobbering any newer
  // concurrent edit from another device (the exact race sectioned sync
  // exists to prevent).
  const dirtyBeforePull=new Set(syncDirty);
  try{
    if(!data||typeof data!=='object') return false;
    if(data.children){ state.children=data.children; await DB.set('cs_children',data.children); }
    if(data.chores){ state.chores=data.chores; await DB.set('cs_chores',data.chores); }
    if(data.actions){ state.actions=data.actions; await DB.set('cs_actions',data.actions); }
    if(data.rewards){ state.rewards=data.rewards; await DB.set('cs_rewards',data.rewards); }
    if(data.math){ state.math=data.math; await DB.set('cs_math',data.math); }
    if(data.streaks){
      state.streaks=data.streaks;
      // Firebase RTDB drops empty objects/arrays on write, so streak.days can
      // come back undefined even though we wrote {}. Restore it, or code like
      // renderStreakBanner's s.days[dateKey(new Date())] crashes on load.
      state.streaks.forEach(s=>{ if(!s.days||typeof s.days!=='object') s.days={}; });
      await DB.set('cs_streaks',state.streaks);
    } else if(data.streak){
      // Legacy single-challenge cloud data from before multi-streak support —
      // wrap it as the "clean day" challenge and keep the default second one.
      const legacy=data.streak;
      if(!legacy.days||typeof legacy.days!=='object') legacy.days={};
      state.streaks=[{...legacy,id:'clean',title:'יום נקי',dayWord:'יום נקי',icon:'🧼'}, {...DEFAULT_STREAKS[1]}];
      await DB.set('cs_streaks',state.streaks);
    }
    if(data.badgeDefs){ state.badgeDefs=data.badgeDefs; await DB.set('cs_badgedefs',data.badgeDefs); }
    if(data.anchored){
      // Anchored tasks now live in state.chores, tagged with a `period` (see
      // the cs_anchored_merged_v1 migration in loadState()) -- state.anchored
      // only ever holds sleep_time going forward. A device still running an
      // older build could still push the legacy per-period-array shape here;
      // discard it rather than restoring dead arrays nothing reads anymore
      // (getTasksForTimeOfDay/periodTaskList read state.chores now), which
      // would otherwise silently resurrect the exact disconnected-list bug
      // this migration fixed.
      state.anchored={sleep_time:data.anchored.sleep_time??state.anchored.sleep_time??20};
      await DB.set('cs_anchored',state.anchored);
    }
    if(data.events){ state.events=data.events; await DB.set('cs_events',data.events); syncNativeEventReminders(); }
    if(data.games){
      // Defense in depth alongside the cs_games_v5 migration above: a device
      // that hasn't picked up this code yet could still push the old
      // classic.minecraft.net iframe entry back into a family that already
      // migrated it away.
      state.games=data.games.filter(g=>!/classic\.minecraft\.net/.test(g.url||''));
      await DB.set('cs_games',state.games);
    }
    if(data.auditLog){ state.auditLog=data.auditLog; await DB.set('cs_auditlog',data.auditLog); }
    // Use !==undefined (not truthiness) so an explicit false — calm mode
    // turned OFF on another device — still overwrites a local true.
    if(data.calmMode!==undefined){
      state.calmMode=data.calmMode; await DB.set('cs_calm',data.calmMode); applyCalmModeClass();
      fillCalmToggle();
    }
    if(data.gameBedtime!==undefined){
      state.gameBedtime=data.gameBedtime; await DB.set('cs_gamebedtime',data.gameBedtime);
      fillGameBedtimeToggle();
    }
    // Only the HASH of the parent code travels (see buildSyncPayload/savePin),
    // never the code itself. Adopting it makes every family device accept the
    // same parent code. A device that has never had one set stays on its own
    // local code until a parent explicitly sets one somewhere -- so upgrading
    // can't silently change (and lock someone out of) an existing device.
    if(data.pinHash){
      state.pinHash=data.pinHash; await DB.set('cs_pinhash',data.pinHash);
    }
    if(data.entitlement){
      state.entitlement=data.entitlement; await DB.set('cs_entitlement',data.entitlement);
    }
    // Earliest wins: a second device joining the family must not restart (or
    // extend) the trial by pushing its own later start date.
    if(data.trialStartedAt&&(!state.trialStartedAt||data.trialStartedAt<state.trialStartedAt)){
      state.trialStartedAt=data.trialStartedAt; await DB.set('cs_trial_started',data.trialStartedAt);
    }
    // The high-water-mark date IS synced so wiping/reinstalling the app on one
    // device can't roll back the anti-clock-tamper guard for the whole family.
    if(data.hwmDate){
      const remote=dateToNum(data.hwmDate);
      if(_hwmDate==null||remote>dateToNum(_hwmDate)){ _hwmDate=data.hwmDate; await DB.set('cs_hwm_date',_hwmDate); }
    }
    if(data.kids){
      // Sanity-bound whatever comes back: security rules (database.rules.json)
      // already require auth + matching familyId before any read/write is
      // even accepted, but this is still defense in depth against a
      // corrupted or buggy-client-written balance (e.g. NaN, Infinity, or a
      // huge/negative number) — the rules don't validate the VALUES written,
      // only WHO can write them.
      for(const [id,kid] of Object.entries(data.kids)){
        if(!kid||typeof kid!=='object') continue;
        // If THIS device has a local edit for this kid that hasn't been
        // pushed yet (e.g. a reward just redeemed, adding game-time minutes,
        // a split-second before pushToFirebase's own network round-trip
        // finishes), an incoming snapshot here is necessarily older than
        // that edit — applying it would silently revert the fresh purchase
        // back to its pre-purchase value. The one exception already handled
        // below (an active game session, via `_gt`) isn't enough: it only
        // covers gtime while actively draining, not a reward just bought.
        // Skip the whole kid rather than merge field-by-field; the pending
        // local push will correct the cloud, and its own echo (this same
        // listener firing again) will apply cleanly once nothing is dirty.
        if(dirtyBeforePull.has('kids/'+id)) continue;
        const balOk=Number.isFinite(kid.balance);
        kid.balance=balOk?Math.max(0,Math.min(1000000,Math.round(kid.balance))):0;
        if(!Array.isArray(kid.history)) kid.history=[];
        // Every map/array below can be dropped by Firebase when empty, which
        // would later crash reads like k.daily.counts[id] or k.badges.map(...).
        // Restore all of them to the same defaults loadKid() uses.
        if(!kid.daily||typeof kid.daily!=='object') kid.daily={date:'',counts:{},lastMark:{}};
        if(!kid.daily.counts||typeof kid.daily.counts!=='object') kid.daily.counts={};
        if(!kid.daily.lastMark||typeof kid.daily.lastMark!=='object') kid.daily.lastMark={};
        if(!kid.mathDaily||typeof kid.mathDaily!=='object') kid.mathDaily={date:'',done:0};
        if(!Array.isArray(kid.badges)) kid.badges=[];
        if(!Number.isFinite(kid.mathTotal)) kid.mathTotal=0;
        if(!Number.isFinite(kid.taskTotal)) kid.taskTotal=0;
        if(!Number.isFinite(kid.rewardsTotal)) kid.rewardsTotal=0;
        kid.cashOwed=Number.isFinite(kid.cashOwed)?Math.max(0,Math.min(100000,Math.round(kid.cashOwed*100)/100)):0;
        // Game-time wallet: bounded to a sane range (0..24h) for the same
        // corrupted/forged-value reasons as balance above. If a game session
        // is live on THIS device right now, the local draining value wins —
        // a pull of stale cloud data mustn't refund time mid-game.
        kid.gtime=Number.isFinite(kid.gtime)?Math.max(0,Math.min(86400,Math.round(kid.gtime))):0;
        if(_gt&&id===state.current) kid.gtime=Math.max(0,gtRemaining());
        state.kid[id]=kid;
        await DB.set('cs_bal_'+id,kid.balance);
        await DB.set('cs_hist_'+id,kid.history);
        await DB.set('cs_daily_'+id,kid.daily);
        await DB.set('cs_mathd_'+id,kid.mathDaily);
        await DB.set('cs_badges_'+id,kid.badges);
        await DB.set('cs_matht_'+id,kid.mathTotal);
        await DB.set('cs_taskt_'+id,kid.taskTotal);
        await DB.set('cs_rwt_'+id,kid.rewardsTotal);
        await DB.set('cs_cash_'+id,kid.cashOwed);
        await DB.set('cs_gtime_'+id,kid.gtime);
        kid.mathLevel=Number.isFinite(kid.mathLevel)?Math.max(1,Math.min(5,kid.mathLevel)):1;
        await DB.set('cs_mathlvl_'+id,kid.mathLevel);
        if(!kid.learn||typeof kid.learn!=='object') kid.learn={progress:{},earnedToday:{date:'',coins:0,minutes:0,sessions:0},recent:{math:[],english:[],science:[]},correctTotal:{math:0,english:0,science:0}};
        if(!kid.learn.progress||typeof kid.learn.progress!=='object') kid.learn.progress={};
        if(!kid.learn.earnedToday||typeof kid.learn.earnedToday!=='object') kid.learn.earnedToday={date:'',coins:0,minutes:0,sessions:0};
        if(!kid.learn.recent||typeof kid.learn.recent!=='object') kid.learn.recent={math:[],english:[],science:[]};
        if(!kid.learn.correctTotal||typeof kid.learn.correctTotal!=='object') kid.learn.correctTotal={math:0,english:0,science:0};
        await DB.set('cs_learn_'+id,kid.learn);
        if(!kid.learnLevel||typeof kid.learnLevel!=='object') kid.learnLevel={math:1,english:1,science:1};
        await DB.set('cs_learnlvl_'+id,kid.learnLevel);
      }
    }
    if(data.learning){ state.learning=data.learning; await DB.set('cs_learning',data.learning); }
    syncDirty=dirtyBeforePull; // drop the echo-dirt, keep real pre-pull edits
    return true;
  }catch(e){ return false; }
}
async function pullFromFirebase(){
  const ref=familyRef(); if(!ref) return false;
  try{
    const snap=await ref.once('value');
    return await applyRemoteSnapshot(snap.val());
  }catch(e){ return false; }
}

// ---- live cross-device sync ----
// A parent's edit on one device used to only reach a second parent's screen
// once THEY happened to tap "sync now" or relaunch the app — the family
// could easily be looking at stale data for a while. A persistent RTDB
// listener (instead of the one-shot .once() pull above) pushes every remote
// change to every other signed-in device within moments, with no polling.
let _liveSyncRef=null, _liveSyncHandler=null;
function attachLiveSync(){
  detachLiveSync();
  const ref=familyRef(); if(!ref) return;
  _liveSyncRef=ref;
  _liveSyncHandler=ref.on('value',async snap=>{
    // Fires for OUR OWN writes too (Firebase echoes every write back over the
    // same connection) — applyRemoteSnapshot is idempotent and cheap, and
    // scheduleSync()/pushToFirebase() already no-op when nothing is actually
    // dirty, so re-applying our own echo is harmless, not a feedback loop.
    const applied=await applyRemoteSnapshot(snap.val());
    if(applied) refreshUIAfterRemoteChange();
  });
}
function detachLiveSync(){
  if(_liveSyncRef&&_liveSyncHandler) _liveSyncRef.off('value',_liveSyncHandler);
  _liveSyncRef=null; _liveSyncHandler=null;
}
// Re-render whatever's currently on screen so a change from another parent's
// device (or another tab) shows up without the user having to navigate away
// and back. Deliberately conservative in the admin screens: a parent who is
// mid-edit there shouldn't have their unsaved typing wiped out by a remote
// update redrawing the pane out from under them — state/storage are already
// current by the time they do navigate, which is what actually matters.
function refreshUIAfterRemoteChange(){
  try{
    if(!cur()) return;
    renderBalance();
    if(currentView==='home'){ renderChores(); renderStreakBanner(); renderGameTimeBanner(); renderEventsHome(); renderDayStrip(); renderFirstThen(); renderBadgesBanner(); renderRequiredTaskAlert(); }
    else if(currentView==='rewards') renderRewards();
    else if(currentView==='history') renderHistory();
    else if(currentView==='streak') renderStreakView();
    else if(currentView==='badges') renderBadgesView();
    else if(currentView==='games') renderGamesView();
  }catch(e){ console.error('refreshUIAfterRemoteChange failed',e); }
}

async function forceSyncNow(){
  showSyncStatus('⏳ מסנכרן...','#F5B82E');
  // Flush any edit still waiting on the debounce timer BEFORE pulling.
  // Otherwise pullFromFirebase would overwrite state with the (older) cloud
  // snapshot and silently discard an edit made moments ago that just hadn't
  // reached the cloud yet.
  if(fbSyncTimer){ clearTimeout(fbSyncTimer); fbSyncTimer=null; await pushToFirebase(); }
  // pull first, then push (merge: remote wins on load)
  const pulled=await pullFromFirebase();
  await pushToFirebase();
  if(pulled){ renderBalance(); renderChores(); renderStreakBanner(); }
  return pulled;
}

function scheduleSync(){
  if(!syncReady||!state.familyId) return; // suspended during load; no-op in local-only mode
  clearTimeout(fbSyncTimer);
  fbSyncTimer=setTimeout(pushToFirebase,3000);
}

/* ===== ACCOUNTS: Google sign-in, family auto-provisioning, invite codes =====
   One Google account = one family. A family is an opaque familyId; users/{uid}
   maps a signed-in account to the familyId it belongs to (role owner|member),
   so a second parent can join the SAME family via an invite code without ever
   sharing a Google login. See the security rules doc for how this is enforced
   server-side (auth.uid must resolve to $familyId via users/{uid}/familyId). */
function hasExistingLocalData(){
  return localStorage.getItem('cs_children')!==null || localStorage.getItem('cs_bal_ariel')!==null;
}
// Resets BOTH the persisted cache and the in-memory `state` object back to
// defaults. Persisting alone isn't enough: buildSyncPayload() and everything
// else always reads live `state.*`, so a stale in-memory value would still
// leak into a freshly-created family even after clearing storage underneath it.
// Called (a) on sign-out, so the next account on this device never inherits
// the previous one's cache, and (b) when the user explicitly says cached local
// data ISN'T theirs when creating a new family (e.g. a shared/handed-down
// device previously used in local-only mode by someone else).
async function clearLocalFamilyData(){
  for(const ch of state.children){
    for(const p of ['cs_bal_','cs_hist_','cs_daily_','cs_mathd_','cs_badges_','cs_matht_','cs_taskt_','cs_rwt_','cs_gtime_','cs_mathlvl_','cs_learn_','cs_learnlvl_','cs_cash_']){
      await DB.del(p+ch.id);
    }
  }
  state.children=DEFAULT_CHILDREN; state.current=null; state.kid={};
  state.chores=DEFAULT_CHORES; state.actions=DEFAULT_ACTIONS; state.rewards=DEFAULT_REWARDS;
  state.math=DEFAULT_MATH; state.streaks=DEFAULT_STREAKS.map(s=>({...s,days:{}})); state.badgeDefs=DEFAULT_BADGE_DEFS;
  state.anchored=DEFAULT_ANCHORED_TASKS; state.events=[]; state.familyId=null;
  state.games=DEFAULT_GAMES; state.learning=DEFAULT_LEARNING; state.auditLog=[]; state.pin='1234'; state.pinHash=null;
  // Entitlement and trial are FAMILY property, not device property -- leaving
  // them behind here would carry one family's paid licence (or spent trial)
  // into whatever family this device signs into next.
  state.entitlement=null; state.trialStartedAt=null;
  // Delete rather than write defaults back: hasExistingLocalData() treats a
  // present key as "this device has real data" regardless of its content, so
  // writing DEFAULT_CHILDREN etc back here would leave the keys present and
  // make every future createNewFamily() wrongly think there's still data to
  // confirm. In-memory `state` above already has sane defaults for immediate
  // use; storage should end up genuinely empty, matching a device that was
  // never set up at all.
  for(const k of ['cs_children','cs_current','cs_chores','cs_actions','cs_rewards','cs_math',
    'cs_streak','cs_streaks','cs_badgedefs','cs_anchored','cs_events','cs_hwm_date','cs_familyid',
    'cs_pinhash','cs_entitlement','cs_trial_started',
    'cs_games','cs_games_v2','cs_games_v3','cs_games_v4','cs_gtime_seeded']){
    await DB.del(k);
  }
  _hwmDate=null; _hwmAdvanceMono=performance.now();
}
function randomId(len){
  const chars='abcdefghjkmnpqrstuvwxyz23456789';
  let s=''; for(let i=0;i<len;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function randomInviteCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars (0/O, 1/I)
  let s=''; for(let i=0;i<6;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}
function isMobileBrowser(){
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
// Set right before calling the native sign-in bridge so the callbacks below
// (invoked by Kotlin via evaluateJavascript, with no argument of their own
// carrying it) know which status line to update.
let _nativeSignInStatusElId=null;
async function signInWithGoogle(statusElId){
  // statusElId lets this be called both from the welcome screen (#welcomeStatus)
  // and from Admin Settings (#settingsAuthStatus) for a parent upgrading from
  // local-only mode without ever seeing the welcome screen again.
  const statusEl=()=>document.getElementById(statusElId||'welcomeStatus');
  // Inside the Android wrapper, Google's OAuth endpoint flatly rejects the
  // web sign-in flow with "Error 403: disallowed_useragent" -- it detects
  // the request came from a WebView and blocks it, by policy, regardless of
  // user-agent spoofing. The real fix is doing the sign-in natively (Play
  // Services account picker) and handing the resulting ID token to Firebase
  // here via signInWithCredential -- see onNativeGoogleSignIn below and
  // MainActivity.startNativeGoogleSignIn/NativeGameBridge.nativeGoogleSignIn.
  if(isNativeGameAvailable()&&typeof window.CoinQuestNative.nativeGoogleSignIn==='function'){
    _nativeSignInStatusElId=statusElId;
    if(statusEl()) statusEl().textContent='⏳ נפתח חלון ההתחברות של גוגל...';
    try{ window.CoinQuestNative.nativeGoogleSignIn(); }
    catch(e){ if(statusEl()) statusEl().textContent='שגיאת התחברות: '+(e&&e.message||'נסה שוב'); }
    return;
  }
  const provider=new firebase.auth.GoogleAuthProvider();
  // MOBILE: full-page redirect. Real-device testing showed the popup flow
  // strands the user on a white firebaseapp.com tab — on mobile the "popup"
  // is a new tab, and Chrome Android can discard/throttle the opener tab so
  // the OAuth handler's postMessage handshake back to it never completes.
  // The redirect flow is a plain top-level navigation with no opener
  // dependency. Its own historical failure mode ("missing initial state",
  // when sessionStorage doesn't survive the round-trip) is surfaced loudly
  // by the getRedirectResult handler at startup rather than hidden.
  if(isMobileBrowser()){
    // The redirect result only survives the round-trip when the app runs on
    // the SAME origin as authDomain (coin-quest-app.firebaseapp.com). On any
    // other host (github.io, web.app), hop there first; #signin makes the
    // sign-in resume automatically, so it stays a one-tap flow for the user.
    if(location.hostname!=='coin-quest-app.firebaseapp.com'){
      if(statusEl()) statusEl().textContent='⏳ עובר לכתובת המאובטחת להתחברות...';
      location.href='https://coin-quest-app.firebaseapp.com/#signin';
      return;
    }
    if(statusEl()) statusEl().textContent='⏳ עובר לדף ההתחברות של Google...';
    try{
      localStorage.setItem('cs_auth_redirect_pending','1');
      await fbAuth.signInWithRedirect(provider);
      return; // page is navigating away
    }catch(e){
      localStorage.removeItem('cs_auth_redirect_pending');
      if(statusEl()) statusEl().textContent='שגיאת התחברות: '+(e&&e.message||'נסה שוב');
      return;
    }
  }
  // DESKTOP: popup (kept — it avoids losing in-memory app state to a
  // navigation, and the opener-tab problem above doesn't apply).
  if(statusEl()) statusEl().textContent='⏳ מתחבר... (אם החלון שנפתח נשאר לבן, סגור אותו וחזור לכאן)';
  // signInWithPopup's promise can simply never settle — never resolve, never
  // reject — if the popup itself hangs blank (a known mobile-Chrome failure
  // mode: storage-partitioning/third-party-cookie blocking can prevent the
  // OAuth handler page's postMessage handshake back to this tab from ever
  // completing). In that case NO catch branch below would ever run and the
  // status line would say "מתחבר..." forever with zero visible error. Race
  // against a timeout so this always resolves to a visible message.
  const timeout=new Promise((_,rej)=>setTimeout(()=>rej({code:'app/popup-timeout'}),20000));
  try{
    await Promise.race([fbAuth.signInWithPopup(provider), timeout]);
    // NOTE: signInWithPopup resolving successfully only means the OAuth
    // handshake worked. The actual app takeover (reading users/{uid},
    // pulling family data, etc.) happens in handleSignedInUser(), which is
    // invoked asynchronously and independently by the onAuthStateChanged
    // listener below/elsewhere — NOT by this function. That call is
    // detached from this try/catch, so it has its OWN try/catch and its
    // own visible-error handling; don't assume "no error here" means the
    // sign-in fully completed.
    if(statusEl()) statusEl().textContent='';
  }catch(e){
    if(e&&e.code==='auth/popup-closed-by-user'){
      if(statusEl()) statusEl().textContent='';
    }else if(e&&e.code==='auth/popup-blocked'){
      if(statusEl()) statusEl().textContent='הדפדפן חסם את חלון ההתחברות. אפשר חלונות קופצים לאתר הזה ונסה שוב.';
    }else if(e&&e.code==='app/popup-timeout'){
      // Promise.race doesn't cancel signInWithPopup or close the popup, so
      // the stuck popup window may still be open — tell the user to close it.
      if(statusEl()) statusEl().textContent='ההתחברות נתקעה. סגור את החלון שנפתח (אם יש כזה) ונסה שוב, או בדוק שהדפדפן לא חוסם עוגיות של צד שלישי.';
    }else{
      if(statusEl()) statusEl().textContent='שגיאת התחברות: '+(e&&e.message||'נסה שוב');
    }
  }finally{
    // Belt-and-suspenders: guarantee some view is visible. Safe to call
    // unconditionally — it only acts if literally zero views are active.
    ensureActiveView();
  }
}
// Called by MainActivity.googleSignInLauncher (via evaluateJavascript) once
// the native account picker returns a real Google ID token. signInCredential
// triggers the SAME onAuthStateChanged -> handleSignedInUser() path as the
// browser-based signInWithPopup/signInWithRedirect above, so nothing about
// family-loading/onboarding needs to be duplicated here.
async function onNativeGoogleSignIn(idToken){
  const statusEl=document.getElementById(_nativeSignInStatusElId||'welcomeStatus');
  try{
    const credential=firebase.auth.GoogleAuthProvider.credential(idToken);
    await fbAuth.signInWithCredential(credential);
    if(statusEl) statusEl.textContent='';
  }catch(e){
    if(statusEl) statusEl.textContent='שגיאת התחברות: '+(e&&e.message||'נסה שוב');
  }
}
// Called the same way when the native picker fails or the parent cancels it
// (message is '' for a plain cancel -- not an error worth showing).
function onNativeGoogleSignInError(message){
  const statusEl=document.getElementById(_nativeSignInStatusElId||'welcomeStatus');
  if(statusEl) statusEl.textContent=message||'';
}
function continueLocalOnly(){
  localStorage.setItem('cs_local_only','1');
  go('picker');
}

/* ===== DEMO MODE (backlog #24: try the app with zero signup / zero footprint) =====
   Forces the storage backend to pure in-memory (the same `mem` fallback DB
   already uses when localStorage is unavailable) so nothing a demo visitor
   does ever touches this device's real localStorage or any Firebase family —
   a reload is a full, clean reset. Seeded with a few days of realistic
   history/progress so a first-time visitor sees what the app looks like
   after actual use, not an empty new install. */
let demoMode=false;
function seedDemoData(){
  const now=Date.now(), today=todayStr();
  state.kid['ariel']={
    balance:47,
    history:[
      {ts:now-1000*60*30,  points:5,  label:'צחצוח שיניים',                type:'chore'},
      {ts:now-1000*60*90,  points:2,  label:'תרגיל חשבון',                 type:'math'},
      {ts:now-1000*60*200, points:8,  label:'פינוי אוכל אחרי שמסיימים',    type:'chore'},
      {ts:now-1000*3600*5, points:-30,label:'פרס: 30 דקות מסך',            type:'spend'},
      {ts:now-1000*3600*24,points:10, label:'סידור החדר',                  type:'chore'},
    ],
    daily:{date:today,counts:{chore_teeth:1}}, mathDaily:{date:today,done:3},
    badges:[{id:'first_coin',ts:now-1000*3600*24*3}],
    mathTotal:14, taskTotal:22, rewardsTotal:2, gtime:0, mathLevel:2,
    learn:{progress:{},earnedToday:{date:today,coins:4,minutes:0,sessions:1},recent:{math:[1,1],english:[1,0],science:[1,1,1,1]},correctTotal:{math:12,english:6,science:9}},
    learnLevel:{math:2,english:1,science:1},
  };
  state.kid['noa']={
    balance:18,
    history:[
      {ts:now-1000*60*40,  points:3, label:'לשבת בשירותים', type:'chore'},
      {ts:now-1000*3600*3, points:2, label:'תרגיל חשבון',   type:'math'},
    ],
    daily:{date:today,counts:{}}, mathDaily:{date:today,done:1},
    badges:[], mathTotal:5, taskTotal:6, rewardsTotal:0, gtime:0, mathLevel:1,
    learn:{progress:{},earnedToday:{date:today,coins:0,minutes:0,sessions:0},recent:{math:[],english:[],science:[]},correctTotal:{math:0,english:0,science:0}},
    learnLevel:{math:1,english:1,science:1},
  };
  const clean=getStreak('clean');
  if(clean){
    clean.childId='ariel'; clean.best=9; clean.wonAt=null; clean.days={};
    for(let i=1;i<=6;i++){ const d=new Date(); d.setDate(d.getDate()-i); clean.days[dateKey(d)]='clean'; }
    recomputeStreak('clean'); // derives `current` from the days above, not hand-set
  }
}
async function enterDemoMode(){
  backend='mem'; demoMode=true;
  await loadState(); // fresh `mem` -> every DB.get resolves null -> pure defaults
  seedDemoData();
  state.current=null;
  document.body.classList.add('demo-active');
  document.getElementById('demoBanner').style.display='block';
  syncReady=true; // no familyId ever set in demo mode, so scheduleSync stays a no-op
  goHomeOrPicker();
}
function exitDemoMode(){
  // A full reload is the simplest correct reset: demoMode/backend/mem are
  // page-lifetime state, so relaunching the app fresh restores whatever this
  // device's REAL local-only/cloud data was, untouched by the demo.
  location.reload();
}
async function signOutOfAccount(){
  modalConfirm('🚪','להתנתק?','תוכל להתחבר שוב בכל עת עם אותו חשבון Google ולראות את כל המידע שלך.', async()=>{
    detachLiveSync();
    // Clear the local cache before reloading — otherwise a DIFFERENT account
    // signing in on this same device afterward could inherit this family's
    // data (e.g. via createNewFamily's "seed from existing local data" path).
    await clearLocalFamilyData();
    await fbAuth.signOut();
    location.reload();
  });
}

/* ===== ACCOUNT DELETION (S5, store-release requirement) =====
   Google Play requires (a) an in-app path to delete the account and its
   data, and (b) a way to request the same without opening the app --
   see delete-account.html, linked from privacy.html, for (b). This app has
   no backend, so both paths ultimately do the same client-side removal;
   the web page exists for someone who uninstalled the app but still wants
   their data gone. Offered from Admin Settings (already PIN-gated), with an
   extra type-to-confirm step since there is no undo -- this deletes the
   WHOLE family's data, not just the signed-in parent's own login, since
   that's what "delete my account" means for a shared family app with no
   solo-user concept below the family level. */
function confirmDeleteAccount(){
  if(!authUser){ toast('אין חשבון מחובר במכשיר הזה'); return; }
  modalContent.innerHTML=`<div class="m-emoji">⚠️</div><h3>למחוק את המשפחה וכל הנתונים?</h3>
    <p style="font-size:.9rem;">פעולה זו מוחקת לצמיתות מהענן את כל הילדים, המטלות, ההיסטוריה, המטבעות והתגים של המשפחה הזו — גם עבור הורה שני, אם יש. אי אפשר לבטל את זה.</p>
    <p style="font-size:.85rem;font-weight:700;margin-bottom:4px;">כדי לאשר, הקלד/י כאן את המילה: מחק</p>
    <input id="delConfirmText" style="width:100%;border:2px solid var(--coral);border-radius:13px;padding:11px;font-family:inherit;text-align:center;">
    <div style="display:flex;gap:8px;margin-top:10px;"><button class="btn ghost" onclick="closeModal()">ביטול</button><button class="btn coral" id="delConfirmBtn">מחק לצמיתות</button></div>`;
  modalBg.classList.add('show');
  document.getElementById('delConfirmBtn').onclick=()=>{
    if(document.getElementById('delConfirmText').value.trim()!=='מחק'){ toast('הקלד/י בדיוק "מחק" כדי לאשר'); return; }
    closeModal();
    deleteAccountAndFamily();
  };
  setTimeout(()=>{ const el=document.getElementById('delConfirmText'); if(el) el.focus(); },100);
}
async function deleteAccountAndFamily(){
  toast('⏳ מוחק...');
  const user=authUser;
  try{
    detachLiveSync();
    const familyId=state.familyId;
    if(familyId){
      // Order matters for the security rules: families/$familyId requires
      // users/{uid}.familyId to still resolve to it, so the family node
      // must be removed BEFORE users/{uid} — deleting users/{uid} first
      // would make this device unable to prove membership for the next call.
      try{
        const code=(await fbDb.ref('families/'+familyId+'/inviteCode').once('value')).val();
        if(code) await fbDb.ref('inviteCodes/'+code).remove();
      }catch(e){ /* best-effort -- an orphaned invite code just fails to resolve later, no data leak */ }
      await fbDb.ref('families/'+familyId).remove();
    }
    await fbDb.ref('users/'+user.uid).remove();
    await clearLocalFamilyData();
    try{
      await user.delete();
    }catch(e){
      // All family/account DATA is already gone at this point regardless --
      // only the Google-linked auth record itself needs a very recent
      // sign-in to delete. Rather than lose the cleanup already done, just
      // tell the parent it needs one more fresh sign-in + retry.
      if(e&&e.code==='auth/requires-recent-login'){
        toast('הנתונים נמחקו. כדי למחוק גם את רשומת ההתחברות עצמה, התחבר/י שוב ונסה/י שוב מהגדרות.');
      }
    }
    await fbAuth.signOut().catch(()=>{});
    toast('המשפחה נמחקה ✓');
    location.reload();
  }catch(e){
    console.error('deleteAccountAndFamily failed',e);
    toast('⚠️ שגיאה במחיקה: '+authErrorText(e));
  }
}

// Race any promise against a timeout so a Realtime Database call that never
// resolves AND never rejects (e.g. the socket can't reach the DB, or an auth
// token isn't accepted) can't silently stall the whole sign-in forever.
function withTimeout(promise, ms, label){
  return Promise.race([
    promise,
    new Promise((_,rej)=>setTimeout(()=>{ const e=new Error('הפעולה נתקעה ('+label+', '+(ms/1000)+' שניות)'); e.code='app/timeout'; rej(e); }, ms))
  ]);
}
// Persistent, visible status on the welcome screen. Unlike a toast it does NOT
// auto-hide, so if the flow stalls the user can still read exactly where.
function authStep(msg,color){
  const el=document.getElementById('welcomeStatus');
  if(el){ el.textContent=msg; el.style.color=color||'var(--ink2)'; }
}
function authErrorText(e){
  return (e&&e.code?('['+e.code+'] '):'')+(e&&e.message||'שגיאה לא ידועה');
}

async function handleSignedInUser(user){
  authUser=user;
  // Reaching this function at all means we now have a real authenticated
  // session — stop treating this device as local-only from here on (matters
  // when a parent links an account later from Admin Settings, not just on
  // first-ever load).
  localStorage.removeItem('cs_local_only');
  syncReady=false; // suspend pushes while we read + pull, so nothing clobbers the cloud mid-load
  try{
    authStep('⏳ בודק את החשבון שלך...','#F5B82E');
    const rec=(await withTimeout(fbDb.ref('users/'+user.uid).once('value'),15000,'קריאת חשבון')).val();
    if(rec&&rec.familyId){
      state.familyId=rec.familyId;
      await DB.set('cs_familyid',state.familyId);
      authStep('⏳ טוען את המשפחה שלך...','#F5B82E');
      await withTimeout(pullFromFirebase(),15000,'טעינת נתוני משפחה');
      attachLiveSync();
      showSyncStatus('✅ מחובר כ-'+(user.email||''),'var(--mint)');
      if(state.current&&state.children.find(c=>c.id===state.current)){
        await loadKid(state.current); renderBalance(); go('home');
        applyChildTheme(state.current);
      }else{ state.current=null; go('picker'); }
    }else{
      authStep('');
      showOnboardChoice();
    }
  }catch(e){
    // Any failure here (permission-denied, a stalled read, etc.) must NEVER be
    // a silent hang: this runs detached from signInWithGoogle()'s try/catch
    // (it's invoked from the onAuthStateChanged listener), so surface it loudly
    // and stay on a usable screen instead of a blank/idle one.
    console.error('handleSignedInUser failed', e);
    go('welcome');
    authStep('שגיאה בטעינה: '+authErrorText(e)+' — ודא שכללי האבטחה של Firebase פורסמו ונסה שוב','var(--coral)');
    toast('⚠️ שגיאת התחברות');
  }finally{
    // Load settled (success or fail) — now allow edits to auto-push to the cloud.
    syncReady=true;
    // If the user interacted with the app WHILE syncReady was false (e.g. marked
    // a chore during the pull on a slow connection), DB.set's scheduleSync()
    // call was a silent no-op at that moment and nothing else retries it —
    // flush now so that edit isn't lost. Harmless no-op push if nothing changed.
    scheduleSync();
  }
}

function showOnboardChoice(){
  modalContent.innerHTML=`<div class="m-emoji">👋</div><h3>ברוך הבא!</h3><p>זו הפעם הראשונה שלך כאן. איך תרצה להתחיל?</p>
    <button class="btn primary" id="obNew" style="margin-bottom:8px;">🆕 יצירת משפחה חדשה</button>
    <button class="btn ghost" id="obJoin">🔗 הצטרפות עם קוד הזמנה</button>`;
  modalBg.classList.add('show');
  document.getElementById('obNew').onclick=createNewFamily;
  document.getElementById('obJoin').onclick=showJoinFamily;
}
function showJoinFamily(){
  modalContent.innerHTML=`<div class="m-emoji">🔗</div><h3>הצטרפות למשפחה</h3><p>הזן את קוד ההזמנה שקיבלת מההורה השני</p>
    <input id="joinCode" style="width:100%;border:2px solid var(--line);border-radius:13px;padding:12px;text-align:center;font-size:1.4rem;font-weight:800;letter-spacing:3px;font-family:inherit;" maxlength="6" placeholder="ABC123">
    <div style="display:flex;gap:8px;margin-top:14px;"><button class="btn ghost" onclick="showOnboardChoice()">חזרה</button><button class="btn primary" id="joinOk">הצטרף</button></div>`;
  modalBg.classList.add('show');
  document.getElementById('joinOk').onclick=doJoinFamily;
  setTimeout(()=>document.getElementById('joinCode').focus(),100);
}
async function doJoinFamily(){
  const code=document.getElementById('joinCode').value.trim().toUpperCase();
  if(!code){ toast('הזן קוד'); return; }
  const btn=document.getElementById('joinOk'); if(btn){ btn.disabled=true; btn.textContent='⏳ מצטרף...'; }
  try{
    const familyId=(await withTimeout(fbDb.ref('inviteCodes/'+code).once('value'),15000,'בדיקת קוד')).val();
    if(!familyId){ toast('קוד לא נמצא 🤔'); if(btn){ btn.disabled=false; btn.textContent='הצטרף'; } return; }
    await withTimeout(fbDb.ref('users/'+authUser.uid).set({familyId,role:'member',email:authUser.email||'',name:authUser.displayName||''}),15000,'שמירת חשבון');
    state.familyId=familyId; await DB.set('cs_familyid',familyId);
    closeModal();
    await withTimeout(pullFromFirebase(),15000,'טעינת נתונים');
    attachLiveSync();
    toast('הצטרפת למשפחה! ✓');
    go('picker');
  }catch(e){
    console.error('doJoinFamily failed', e);
    if(btn){ btn.disabled=false; btn.textContent='הצטרף'; }
    toast('⚠️ שגיאה: '+authErrorText(e));
  }
}
async function createNewFamily(){
  const btn=document.getElementById('obNew'); if(btn){ btn.disabled=true; }
  let seedFromLocal=false;
  if(hasExistingLocalData()){
    // Cached local data existing on this device does NOT necessarily belong to
    // whoever is signing up right now — it could be a previous account's
    // leftover cache, or another person's local-only session on a shared
    // device. Ask before silently seeding a brand-new family with it.
    const kidNames=(state.children||[]).map(c=>esc(c.name)).join(', ')||'—';
    modalContent.innerHTML=`<div class="m-emoji">🤔</div><h3>מצאנו נתונים במכשיר הזה</h3>
      <p>ילדים שמורים: ${kidNames}.<br>האם אלה הנתונים של המשפחה שלך?</p>
      <button class="btn primary" id="ncYes" style="margin-bottom:8px;">✅ כן, אלה הנתונים שלי</button>
      <button class="btn ghost" id="ncNo">🆕 לא, משפחה חדשה וריקה</button>`;
    modalBg.classList.add('show');
    seedFromLocal=await new Promise(resolve=>{
      document.getElementById('ncYes').onclick=()=>resolve(true);
      document.getElementById('ncNo').onclick=()=>resolve(false);
    });
    if(!seedFromLocal) await clearLocalFamilyData();
  }
  if(btn){ btn.textContent='⏳ יוצר משפחה...'; }
  try{
    const familyId='fam_'+randomId(14);
    await withTimeout(fbDb.ref('users/'+authUser.uid).set({familyId,role:'owner',email:authUser.email||'',name:authUser.displayName||''}),15000,'יצירת חשבון');
    state.familyId=familyId; await DB.set('cs_familyid',familyId);
    attachLiveSync();
    closeModal();
    if(seedFromLocal){
      // The user confirmed this cached local data is genuinely theirs — carry
      // it into the new cloud family instead of wiping it with an empty wizard.
      syncFullPush=true; // brand-new family: seed the entire tree, not just dirty sections
      await withTimeout(pushToFirebase(),15000,'שמירת נתונים');
      toast('המשפחה נוצרה עם הנתונים הקיימים במכשיר זה ✓');
      go('picker');
    }else{
      showSetupWizard();
    }
  }catch(e){
    console.error('createNewFamily failed', e);
    go('welcome');
    authStep('שגיאה ביצירת המשפחה: '+authErrorText(e)+' — ודא שכללי האבטחה של Firebase פורסמו','var(--coral)');
    toast('⚠️ שגיאה: '+authErrorText(e));
  }
}

let wizKids=[], wizPinVal='';
function showSetupWizard(){ wizKids=[]; wizPinVal=''; renderWizard(); modalBg.classList.add('show'); }
function renderWizard(){
  modalContent.innerHTML=`<div class="m-emoji">🎉</div><h3>הקמת המשפחה שלך</h3>
    <div class="field" style="text-align:right;"><label>קוד הורים (PIN) — רק אתה תדע אותו</label>
      <input id="wizPin" type="number" value="${esc(wizPinVal)}" placeholder="קוד לא מובן מאליו (לא 1234)" style="width:100%;border:2px solid var(--line);border-radius:13px;padding:11px;font-family:inherit;text-align:center;font-size:1.2rem;font-weight:800;">
    </div>
    <div class="field" style="text-align:right;margin-top:10px;margin-bottom:4px;"><label>הילדים שלך</label></div>
    <div id="wizKidsList" style="margin-bottom:10px;">${
      wizKids.length===0
        ? '<div class="card-sub" style="text-align:center;">עדיין לא הוספת ילדים</div>'
        : wizKids.map((k,i)=>`<div class="admin-row"><span class="emoji">${k.emoji}</span><span class="t">${esc(k.name)}</span><button class="icon-btn" onclick="removeWizKid(${i})">🗑️</button></div>`).join('')
    }</div>
    <div class="inline-row" style="margin-bottom:12px;">
      <div class="field"><input id="wizKidName" placeholder="שם הילד/ה"></div>
      <div class="field" style="max-width:70px;"><input id="wizKidEmoji" placeholder="🦄" maxlength="2"></div>
    </div>
    <button class="btn mint sm" id="wizAddKid" style="width:100%;margin-bottom:14px;">➕ הוסף ילד/ה</button>
    <div style="display:flex;gap:8px;"><button class="btn ghost" onclick="closeModal()">בטל</button><button class="btn primary" id="wizFinish">סיום והתחלה! 🚀</button></div>`;
  document.getElementById('wizPin').addEventListener('input',e=>{ wizPinVal=e.target.value; });
  document.getElementById('wizAddKid').onclick=()=>{
    const name=document.getElementById('wizKidName').value.trim();
    if(!name){ toast('צריך שם'); return; }
    const emoji=document.getElementById('wizKidEmoji').value.trim()||'🙂';
    wizKids.push({name,emoji});
    renderWizard();
  };
  document.getElementById('wizFinish').onclick=finishWizard;
}
function removeWizKid(i){ wizKids.splice(i,1); renderWizard(); }
async function finishWizard(){
  const pin=wizPinVal.trim();
  if(pin.length<3){ toast('בחר קוד הורים עם לפחות 3 ספרות'); return; }
  if(isWeakPin(pin)){ toast('קוד קל מדי לניחוש — נסה קוד אחר 🙂'); return; }
  if(wizKids.length===0){ toast('הוסף לפחות ילד אחד'); return; }
  const palette=['#7C5CFC','#FF6B6B','#27C99A','#4DABF7','#F5B82E','#FF8FCB'];
  state.children=wizKids.map((k,i)=>({id:'k'+Date.now().toString(36)+i,name:k.name,emoji:k.emoji,color:palette[i%palette.length]}));
  state.pin=pin;
  await DB.set('cs_children',state.children);
  await DB.set('cs_pin',pin);
  // A genuinely new family starts its free trial here -- and explicitly gets
  // NO 'legacy' entitlement, which is what separates it from a pre-existing
  // family being grandfathered in loadState().
  if(!state.trialStartedAt){
    state.trialStartedAt=Date.now();
    await DB.set('cs_trial_started',state.trialStartedAt);
  }
  // Establish the family-wide code from the start, so a second device joining
  // this family later adopts it instead of keeping its own (see savePin).
  state.pinHash=await hashPin(pin); await DB.set('cs_pinhash',state.pinHash);
  syncFullPush=true; // brand-new family from the wizard: seed the entire tree
  await pushToFirebase();
  closeModal();
  toast('המשפחה מוכנה! ברוכים הבאים 🎉');
  go('picker');
}

/* ---- AN8: parent-facing "a newer version exists" check (sideloaded family
   flavor only -- Play installs auto-update through the Store itself) ---- */
const APP_UPDATE_CHECK_URL='https://github.com/hershkom/coin-quest-app/releases/download/latest-family/version.json';
let _appUpdateInfo=null;
async function checkForAppUpdate(){
  if(!isNativeGameAvailable()||typeof window.CoinQuestNative.getVersionCode!=='function') return;
  // At most once/day -- a background check on every cold start would be
  // wasteful and, on a flaky connection, a pointless repeated failure.
  const last=Number(localStorage.getItem('cs_update_check_ts')||0);
  if(Date.now()-last<24*3600*1000) return;
  localStorage.setItem('cs_update_check_ts',String(Date.now()));
  try{
    const res=await fetch(APP_UPDATE_CHECK_URL,{cache:'no-store'});
    if(!res.ok) return;
    const info=await res.json();
    const local=window.CoinQuestNative.getVersionCode();
    if(local>=0&&Number(info.versionCode)>local){ _appUpdateInfo=info; updateAppUpdateBanner(); }
  }catch(e){ /* offline or unreachable -- silently skip, not worth bothering a parent about */ }
}
// Shown regardless of Google-account sign-in state (it's about the APK
// itself, not the cloud family) -- kept separate from fillAccountSettings()
// so a background update check doesn't also re-trigger that function's
// Firebase reads every time it resolves.
function updateAppUpdateBanner(){
  const banner=document.getElementById('appUpdateBanner');
  if(!banner) return;
  if(_appUpdateInfo){
    banner.style.display='block';
    banner.querySelector('.au-text').textContent='📦 גרסה חדשה זמינה ('+(_appUpdateInfo.versionName||'')+')';
  }else{
    banner.style.display='none';
  }
}
async function fillAccountSettings(){
  updateAppUpdateBanner();
  const el=document.getElementById('accountStatus'); if(!el) return;
  const inviteBox=document.getElementById('accountInviteBox');
  if(!authUser){
    el.innerHTML='🔒 לא מחובר לחשבון Google — המידע נשמר רק במכשיר הזה';
    document.getElementById('signInBox').style.display='block';
    document.getElementById('settingsAuthStatus').textContent='';
    document.getElementById('forceSyncBtn').style.display='none';
    document.getElementById('signOutBtn').style.display='none';
    document.getElementById('deleteAccountBtn').style.display='none';
    inviteBox.style.display='none';
    return;
  }
  el.innerHTML='✅ מחובר כ-<b>'+esc(authUser.email||authUser.displayName||'')+'</b>'+
    (_liveSyncRef?'<div style="font-size:.78rem;color:var(--mint-d);font-weight:700;margin-top:4px;">🟢 עדכונים חיים בין מכשירים</div>':'');
  document.getElementById('signInBox').style.display='none';
  document.getElementById('forceSyncBtn').style.display='block';
  document.getElementById('signOutBtn').style.display='block';
  document.getElementById('deleteAccountBtn').style.display='block';
  // Family identity + the escape hatch out of the wrong family. Rendered BEFORE
  // the network reads below, and never behind them: these two controls are what
  // a parent needs precisely when the cloud reads are failing (wrong family =
  // permission-denied on the family node), and an unguarded await here used to
  // abort the rest of this function, leaving no way to fix the problem at all.
  const fidBox=document.getElementById('familyIdBox');
  const swBtn=document.getElementById('switchFamilyBtn');
  if(fidBox){
    fidBox.style.display=state.familyId?'block':'none';
    const short=document.getElementById('familyIdShort');
    if(short) short.textContent=state.familyId||'—';
  }
  if(swBtn) swBtn.style.display='block';
  // Owner-only invite code. Wrapped so a denied/offline read degrades to "no
  // code shown" instead of taking the whole settings screen down with it.
  try{
    const rec=(await fbDb.ref('users/'+authUser.uid).once('value')).val();
    if(rec&&rec.role==='owner'&&state.familyId){
      let code=(await fbDb.ref('families/'+state.familyId+'/inviteCode').once('value')).val();
      if(!code){
        code=randomInviteCode();
        await fbDb.ref('inviteCodes/'+code).set(state.familyId);
        await fbDb.ref('families/'+state.familyId+'/inviteCode').set(code);
      }
      document.getElementById('inviteCodeText').textContent=code;
      inviteBox.style.display='block';
    }else{
      inviteBox.style.display='none';
    }
  }catch(e){
    console.error('invite code lookup failed', e);
    inviteBox.style.display='none';
  }
}
function copyInviteCode(){
  const code=document.getElementById('inviteCodeText').textContent;
  if(navigator.clipboard) navigator.clipboard.writeText(code).then(()=>toast('הקוד הועתק! 📋')).catch(()=>{});
}

/* ---- joining a DIFFERENT family after the account is already linked ----
   The invite-code flow used to live only inside first-run onboarding, which
   is shown solely when users/{uid} has no familyId yet. So the moment an
   account created (or joined) a family -- including a child's own Google
   account that tapped "create a new family" on their own device -- it was
   permanently stuck there: the app had no screen anywhere that could re-point
   an existing account at another family. That's what made a parent's invite
   code unusable on the child's device.

   Firebase's rules already allow it (users/$uid is writable by that uid), so
   this is purely the missing UI + a safe switch sequence. */
function showSwitchFamily(){
  if(!authUser){ toast('צריך להתחבר עם חשבון Google קודם'); return; }
  modalContent.innerHTML=`<div class="m-emoji">🔗</div><h3>הצטרפות למשפחה אחרת</h3>
    <p style="font-size:.88rem;">הזן/י את קוד ההזמנה שמופיע אצל ההורה במסך הזה (אזור הורים ← 🔧 הגדרות).</p>
    <div style="background:#FFE9E4;border-radius:12px;padding:10px;font-size:.82rem;font-weight:700;color:#8a3410;margin-bottom:12px;text-align:right;">
      ⚠️ כל הנתונים שנמצאים כרגע במכשיר הזה (מטבעות, מטלות, היסטוריה) יוחלפו בנתונים של המשפחה שאליה מצטרפים.
    </div>
    <input id="switchCode" style="width:100%;border:2px solid var(--line);border-radius:13px;padding:12px;text-align:center;font-size:1.4rem;font-weight:800;letter-spacing:3px;font-family:inherit;" maxlength="6" placeholder="ABC123">
    <div style="display:flex;gap:8px;margin-top:14px;"><button class="btn ghost" onclick="closeModal()">ביטול</button><button class="btn primary" id="switchOk">הצטרף</button></div>`;
  modalBg.classList.add('show');
  document.getElementById('switchOk').onclick=doSwitchFamily;
  setTimeout(()=>document.getElementById('switchCode').focus(),100);
}
async function doSwitchFamily(){
  const code=document.getElementById('switchCode').value.trim().toUpperCase();
  if(!code){ toast('הזן קוד'); return; }
  const btn=document.getElementById('switchOk'); if(btn){ btn.disabled=true; btn.textContent='⏳ בודק...'; }
  try{
    const newFamilyId=(await withTimeout(fbDb.ref('inviteCodes/'+code).once('value'),15000,'בדיקת קוד')).val();
    if(!newFamilyId){ toast('קוד לא נמצא 🤔'); if(btn){ btn.disabled=false; btn.textContent='הצטרף'; } return; }
    if(newFamilyId===state.familyId){ toast('המכשיר כבר במשפחה הזאת ✓'); closeModal(); return; }
    // ORDER IS SAFETY-CRITICAL. Every DB.del/DB.set below marks state dirty and
    // schedules a push; if pushes were still live, clearing local data could
    // upload an EMPTY payload -- to the old family, or worse, to the new one,
    // wiping the family we're trying to join. Suspending sync and detaching the
    // live listener first makes scheduleSync() a no-op for the whole sequence
    // (it early-returns on !syncReady), and the reload at the end rebuilds all
    // in-memory state from scratch rather than trusting a hand-patched state.
    syncReady=false;
    detachLiveSync();
    await withTimeout(fbDb.ref('users/'+authUser.uid).set({familyId:newFamilyId,role:'member',email:authUser.email||'',name:authUser.displayName||''}),15000,'עדכון חשבון');
    await clearLocalFamilyData();               // also nulls state.familyId / cs_familyid
    await DB.set('cs_familyid',newFamilyId);    // so the reload below starts in the right family
    toast('מצטרף למשפחה... 🔄');
    setTimeout(()=>location.reload(),700);
  }catch(e){
    console.error('doSwitchFamily failed', e);
    syncReady=true; // switch aborted -- let normal syncing resume
    if(btn){ btn.disabled=false; btn.textContent='הצטרף'; }
    toast('⚠️ שגיאה: '+authErrorText(e));
  }
}

/* ===== DAILY EVENTS ===== */
let shownReminderIds=new Set();

// Events compare their date against these strings, and the date comes from an
// <input type="date"> which ALWAYS emits zero-padded ISO (2026-07-05). If these
// helpers returned unpadded values (2026-7-5), every e.date===today / e.date>=today
// check would silently fail and no dated event would ever show or remind. Keep
// them zero-padded, and normalize any stored date on read via normEvDate() so a
// value saved by an older unpadded build still matches.
function todayDateStr(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function normEvDate(s){
  const p=(s||'').split('-');
  if(p.length!==3) return s||'';
  return p[0]+'-'+String(+p[1]).padStart(2,'0')+'-'+String(+p[2]).padStart(2,'0');
}

async function loadEvents(){ return (await DB.get('cs_events'))||[]; }
async function saveEvents(evs){ state.events=evs; await DB.set('cs_events',evs); syncNativeEventReminders(); }
// Hand the native side (see NativeGameBridge.syncEventReminders) the full list
// of still-future event reminders so it can post real OS notifications even when
// the app isn't open -- the in-page checkEventReminders poll only ever fires
// while a screen is showing. No-op in a plain browser. Trigger time is the
// event's datetime minus its reminderMins lead.
function syncNativeEventReminders(){
  if(!isNativeGameAvailable()||typeof window.CoinQuestNative.syncEventReminders!=='function') return;
  const now=Date.now();
  const list=(state.events||[]).map(ev=>{
    const d=normEvDate(ev.date); const p=d.split('-').map(Number); const t=(ev.time||'').split(':').map(Number);
    if(p.length!==3||t.length<2) return null;
    const when=new Date(p[0],p[1]-1,p[2],t[0],t[1],0,0).getTime()-(ev.reminderMins||30)*60000;
    if(!(when>now)) return null; // already passed -- nothing to schedule
    return {id:ev.id,at:when,title:ev.title||'',emoji:ev.emoji||'📅'};
  }).filter(Boolean);
  try{ window.CoinQuestNative.syncEventReminders(JSON.stringify(list)); }catch(e){}
}

function resizeImageToBase64(file, maxPx, cb){
  const reader=new FileReader();
  reader.onload=e=>{
    const img=new Image();
    img.onload=()=>{
      const scale=Math.min(1,maxPx/Math.max(img.width,img.height));
      const w=Math.round(img.width*scale), h=Math.round(img.height*scale);
      const canvas=document.createElement('canvas'); canvas.width=w; canvas.height=h;
      canvas.getContext('2d').drawImage(img,0,0,w,h);
      cb(canvas.toDataURL('image/jpeg',0.75));
    };
    img.src=e.target.result;
  };
  reader.readAsDataURL(file);
}

document.getElementById('newEvImage').addEventListener('change',e=>{
  const f=e.target.files[0]; if(!f) return;
  resizeImageToBase64(f,600,b64=>{
    document.getElementById('newEvPreviewImg').src=b64;
    document.getElementById('newEvPreview').style.display='block';
    document.getElementById('newEvImage').dataset.b64=b64;
  });
});

async function addEvent(){
  const title=document.getElementById('newEvTitle').value.trim(); if(!title){ toast('צריך כותרת לאירוע'); return; }
  const emoji=document.getElementById('newEvEmoji').value.trim()||'📅';
  const time=document.getElementById('newEvTime').value; if(!time){ toast('בחר שעה לאירוע'); return; }
  const dateVal=normEvDate(document.getElementById('newEvDate').value||todayDateStr());
  const reminderMins=parseInt(document.getElementById('newEvReminder').value)||30;
  const image=document.getElementById('newEvImage').dataset.b64||'';
  const evs=await loadEvents();
  evs.push({id:'ev'+Date.now().toString(36),title,emoji,time,reminderMins,image,date:dateVal});
  await saveEvents(evs);
  document.getElementById('newEvTitle').value='';
  document.getElementById('newEvEmoji').value='';
  document.getElementById('newEvDate').value='';
  document.getElementById('newEvTime').value='';
  document.getElementById('newEvImage').value='';
  document.getElementById('newEvImage').dataset.b64='';
  document.getElementById('newEvPreview').style.display='none';
  renderEventsAdmin(); renderEventsHome();
  toast('אירוע נוסף! ✓');
}

async function deleteEvent(id){
  const evs=(await loadEvents()).filter(e=>e.id!==id);
  await saveEvents(evs); renderEventsAdmin(); renderEventsHome();
}

function getMinutesUntil(timeStr){
  const [h,m]=timeStr.split(':').map(Number);
  const now=new Date(), target=new Date();
  target.setHours(h,m,0,0);
  return Math.round((target-now)/60000);
}

function renderEventsHome(){
  const wrap=document.getElementById('eventsWrap'); if(!wrap) return;
  if(featureLocked('events')){ wrap.innerHTML=''; return; } // free home: no premium chrome
  loadEvents().then(allEvs=>{
    const today=todayDateStr();
    const tomorrow=new Date(); tomorrow.setDate(tomorrow.getDate()+1);
    const tomorrowStr=tomorrow.getFullYear()+'-'+String(tomorrow.getMonth()+1).padStart(2,'0')+'-'+String(tomorrow.getDate()).padStart(2,'0');
    allEvs.forEach(e=>{ e.date=normEvDate(e.date); });
    const evs=allEvs.filter(e=>e.date===today||e.date===tomorrowStr).sort((a,b)=>a.date===b.date?a.time.localeCompare(b.time):a.date.localeCompare(b.date));
    if(!evs.length){ wrap.innerHTML=''; return; }
    let html='<div class="section-title">📅 האירועים של היום</div>';
    evs.forEach(ev=>{
      // getMinutesUntil is time-of-day only — meaningless for tomorrow's events
      // (it would mark a 9:00 tomorrow event as "passed" at 10:00 today). Only
      // compute the live countdown/status badge for TODAY's events.
      const isToday=ev.date===today;
      const mins=isToday?getMinutesUntil(ev.time):null;
      const passed=isToday&&mins<-5, imminent=isToday&&mins>=0&&mins<=30;
      const badgeTxt=!isToday?ev.time:(passed?'עבר':(imminent&&mins<=0?'עכשיו!':(imminent?'בעוד '+mins+' דק׳':ev.time)));
      const badgeCls=!isToday?'later':(passed?'':(mins<=0?'now':(imminent?'soon':'later')));
      const mediaHtml=ev.image
        ?`<img src="${ev.image}" class="ev-img">`
        :`<div class="ev-emoji">${ev.emoji}</div>`;
      const dateLabel=ev.date===today?'היום':ev.date===tomorrowStr?'מחר':formatDateHe(ev.date);
      html+=`<div class="event-card ${passed?'passed':''} ${imminent?'imminent':''}">
        ${mediaHtml}
        <div class="ev-info">
          <div class="ev-title">${esc(ev.title)}</div>
          <div class="ev-time">📆 ${dateLabel} · 🕐 ${ev.time}</div>
          ${badgeCls?`<span class="ev-badge ${badgeCls}">${badgeTxt}</span>`:''}
        </div>
      </div>`;
    });
    wrap.innerHTML=html;
  });
}

function formatDateHe(dateStr){
  const [y,m,d]=dateStr.split('-');
  const months=['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  return d+' ב'+months[parseInt(m)-1];
}
async function renderEventsAdmin(){
  const c=document.getElementById('eventsList'); if(!c) return;
  // Stop a parent from accidentally picking a date that's already passed --
  // such an event would silently never show/remind (dead on arrival), with no
  // feedback that anything was wrong.
  const dateInput=document.getElementById('newEvDate'); if(dateInput) dateInput.min=todayDateStr();
  const evs=await loadEvents();
  const today=todayDateStr();
  evs.forEach(e=>{ e.date=normEvDate(e.date); });
  const upcoming=evs.filter(e=>e.date>=today).sort((a,b)=>a.date===b.date?a.time.localeCompare(b.time):a.date.localeCompare(b.date));
  if(!upcoming.length){ c.innerHTML='<div class="empty"><span class="e-ic">📅</span>אין אירועים קרובים</div>'; return; }
  c.innerHTML='';
  upcoming.forEach(ev=>{
    const row=document.createElement('div'); row.className='admin-row';
    const thumb=ev.image?`<img src="${ev.image}" style="width:40px;height:40px;border-radius:10px;object-fit:cover;">`:`<span style="font-size:1.6rem;">${ev.emoji}</span>`;
    const dateLabel=ev.date===today?'היום':formatDateHe(ev.date);
    row.innerHTML=`${thumb}<span class="t">${esc(ev.title)}<br><span style="font-size:.72rem;color:var(--muted);font-weight:400;">${dateLabel} · ${ev.time} · תזכורת ${ev.reminderMins} דק׳ לפני</span></span>
      <button class="icon-btn" onclick="deleteEvent('${ev.id}')">🗑️</button>`;
    c.appendChild(row);
  });
}

let shownReminders=new Set();
function checkEventReminders(){
  loadEvents().then(evs=>{
    const today=todayDateStr();
    evs.filter(e=>normEvDate(e.date)===today).forEach(ev=>{
      const mins=getMinutesUntil(ev.time);
      const shouldAlert=(mins>=0&&mins<=ev.reminderMins)||(mins>=-2&&mins<0);
      if(shouldAlert&&!shownReminders.has(ev.id)){
        shownReminders.add(ev.id);
        showEventReminder(ev,mins);
      }
    });
  });
}

function showEventReminder(ev,minsLeft){
  const mediaEl=document.getElementById('ermMedia');
  if(ev.image){
    mediaEl.innerHTML=`<img src="${ev.image}" class="erm-img">`;
  } else {
    mediaEl.innerHTML=`<div class="erm-emoji">${ev.emoji}</div>`;
  }
  document.getElementById('ermTitle').textContent=ev.title;
  const name=curChild()?.name||'';
  if(minsLeft<=0){
    document.getElementById('ermTime').textContent='⏰ עכשיו!';
    document.getElementById('ermMsg').textContent=(name?name+', ':'')+' הגיע הזמן! '+ev.emoji;
  } else {
    document.getElementById('ermTime').textContent='בעוד '+minsLeft+' דקות ('+ev.time+')';
    document.getElementById('ermMsg').textContent=(name?name+', ':'')+'תכין/י את עצמך! 😊';
  }
  document.getElementById('eventReminderModal').classList.add('show');
}

function closeEventReminder(){
  document.getElementById('eventReminderModal').classList.remove('show');
}

/* ===== INIT ===== */
function goHomeOrPicker(){
  if(state.current&&state.children.find(c=>c.id===state.current)){
    loadKid(state.current).then(()=>{
      renderBalance(); go('home');
      applyChildTheme(state.current);
    });
  }else{ state.current=null; go('picker'); }
}
// Last-resort global safety net: if ANY uncaught exception or unhandled
// promise rejection reaches here (a bug in code we didn't anticipate,
// a third-party script, etc.), never leave the user staring at a blank
// screen with no feedback. This is intentionally broad/generic since it
// exists to catch things the more specific try/catches above did not.
// Persist the last errors on-device (cs_errlog, capped) so a "זה לא עובד"
// report from a real user is debuggable after the fact — before this, a
// production error left zero trace anywhere. Shown in Admin Settings.
async function recordError(kind,msg,stack){
  try{
    const log=(await DB.get('cs_errlog'))??[];
    log.unshift({ts:Date.now(),kind,msg:String(msg||'').slice(0,300),stack:String(stack||'').slice(0,500),ver:document.getElementById('appVersionTag')?.textContent||''});
    if(log.length>30) log.length=30;
    await DB.set('cs_errlog',log);
  }catch(e){}
}
window.addEventListener('error', (ev)=>{
  console.error('Uncaught error', ev.error||ev.message);
  recordError('error',(ev.error&&ev.error.message)||ev.message,ev.error&&ev.error.stack);
  ensureActiveView();
  toast('⚠️ שגיאה: '+((ev.error&&ev.error.message)||ev.message||'נסה לרענן את הדף'));
});
window.addEventListener('unhandledrejection', (ev)=>{
  console.error('Unhandled promise rejection', ev.reason);
  recordError('rejection',ev.reason&&ev.reason.message||ev.reason,ev.reason&&ev.reason.stack);
  ensureActiveView();
  toast('⚠️ שגיאה: '+((ev.reason&&ev.reason.message)||'נסה לרענן את הדף'));
});
(async function(){
  try{
    GROQ_API_KEY=localStorage.getItem('cs_groq_key')||'';
    updateChatNavVisibility();
    updateChoreReminderCardVisibility();
    updateParentDeviceModeCardVisibility();
    checkForAppUpdate(); // fire-and-forget: never blocks startup on a network round-trip
    await detectBackend();
    await loadState();
    applyCalmModeClass();
    applyChoreReminder();
    applyEnforcedPackages(); // arm the native game wall from the very first launch
    recoverPendingNativeConsume(); // debit any session that ended while the app was dead
    syncNativeEventReminders(); // arm OS-level event notifications for while the app is closed
    setInterval(checkEventReminders, 60000);
    checkEventReminders();

    const localOnly=localStorage.getItem('cs_local_only')==='1';

    // Returning from the mobile signInWithRedirect round-trip: resolve the
    // pending result BEFORE the auth listener drives navigation, and surface
    // any failure loudly — the historical redirect bug ("missing initial
    // state") failed silently, which is exactly what made it undebuggable.
    // The flag lives in localStorage (not sessionStorage) because surviving
    // the cross-origin round-trip is the whole point.
    // Arrived from the GitHub Pages copy with a sign-in intent (see the
    // same-origin hop in signInWithGoogle) — resume the flow automatically.
    if(location.hash==='#signin'){
      history.replaceState(null,'',location.pathname+location.search);
      go('welcome');
      setTimeout(()=>signInWithGoogle(),400);
    }
    if(localStorage.getItem('cs_auth_redirect_pending')==='1'){
      localStorage.removeItem('cs_auth_redirect_pending');
      authStep('⏳ מסיים התחברות...');
      try{
        const res=await withTimeout(fbAuth.getRedirectResult(),15000,'התחברות Google');
        // Success — onAuthStateChanged below takes over. No result (user
        // backed out of the Google page) — clear the "finishing..." status
        // so the welcome screen isn't stuck implying work is still happening.
        if(!res||!res.user) authStep('');
      }catch(e){
        go('welcome');
        if(e&&e.code==='auth/missing-initial-state'){
          authStep('ההתחברות לא הושלמה כי הדפדפן לא שמר את מצב ההתחברות. נסה שוב, ואם זה חוזר — פתח את האתר בכרום רגיל (לא מתוך אפליקציה אחרת) ונסה שוב.','var(--coral)');
        }else{
          authStep('שגיאת התחברות: '+authErrorText(e)+' — נסה שוב.','var(--coral)');
        }
      }
    }

    // ONE persistent listener drives every sign-in, both the initial check on
    // load and any later sign-in triggered from Admin Settings (a parent
    // upgrading from local-only mode without ever seeing the welcome screen).
    // Deliberately not a one-shot promise + a second ongoing listener: two
    // separate registrations would both fire for the very first auth state
    // and call handleSignedInUser twice concurrently.
    let firstAuthCheckDone=false;
    fbAuth.onAuthStateChanged(async(u)=>{
      try{
        if(u){
          if(u.uid!==authUser?.uid) await handleSignedInUser(u);
        }else if(!firstAuthCheckDone&&!localOnly){
          // No persisted session on first load, and not in local-only mode.
          syncReady=true;
          go('welcome');
        }
      }catch(e){
        // Belt-and-suspenders: handleSignedInUser already catches its own
        // errors, but this listener callback's promise is otherwise
        // unobserved by any caller, so a throw here (or one from a future
        // edit that forgets the inner try/catch) would again be a silent
        // unhandled rejection. Never let that happen invisibly.
        console.error('onAuthStateChanged handler failed', e);
        ensureActiveView();
        toast('⚠️ שגיאה בהתחברות: '+(e&&e.message||'נסה שוב'));
      }finally{
        firstAuthCheckDone=true;
      }
    });

    if(localOnly){
      syncReady=true; // no familyId yet; pushes stay no-ops unless/until an account gets linked
      goHomeOrPicker();
    }
    // If not local-only, the listener above handles first-load navigation.
  }catch(e){
    // Startup itself failed (detectBackend/loadState threw, etc.) before any
    // go() call ever happened — without this, the page would be stuck on
    // whatever the raw HTML rendered (no .view has "active" yet at this
    // point), i.e. exactly the silent blank-screen symptom.
    console.error('App init failed', e);
    ensureActiveView();
    const el=document.getElementById('welcomeStatus');
    if(el) el.textContent='שגיאה בטעינת האפליקציה: '+(e&&e.message||'נסה לרענן את הדף');
    toast('⚠️ שגיאה בטעינת האפליקציה');
  }
})();
