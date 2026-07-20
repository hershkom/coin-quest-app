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
  cs_hwm_date:'hwmDate',cs_auditlog:'auditLog',cs_learning:'learning'};
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
  {id:'money', label:'שקל אחד', emoji:'💵', cost:20},
  {id:'movie', label:'ערב סרט', emoji:'🍿', cost:80},
];
const DEFAULT_MATH={enabled:true, ops:['+','-'], maxNum:20, pts:2, daily:10};
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
];
const DEFAULT_STREAKS=[
  {id:'clean',    title:'יום נקי',       dayWord:'יום נקי',      icon:'🧼', childId:'ariel', goal:30, rewardLabel:'Nintendo Switch 2', rewardEmoji:'🎮', days:{}, current:0, best:0, wonAt:null},
  {id:'behavior', title:'התנהגות טובה', dayWord:'התנהגות טובה', icon:'😊', childId:'ariel', goal:14, rewardLabel:'יום כיף',           rewardEmoji:'🎉', days:{}, current:0, best:0, wonAt:null},
];
function getStreak(id){ return state.streaks.find(s=>s.id===id); }
const DEFAULT_ANCHORED_TASKS={
  morning:[{id:'at_m1',label:'צחצוח שיניים',emoji:'🦷',points:5,max:2},{id:'at_m2',label:'לשבת בשירותים',emoji:'🚽',points:3,max:6},{id:'at_m3',label:'לקחת תרופה',emoji:'💊',points:3,max:1}],
  afternoon:[{id:'at_a1',label:'פינוי אוכל',emoji:'🍽️',points:8,max:3},{id:'at_a2',label:'צחצוח שיניים',emoji:'🦷',points:5,max:2}],
  evening:[{id:'at_e1',label:'צחצוח שיניים',emoji:'🦷',points:5,max:2},{id:'at_e2',label:'אמבטיה',emoji:'🛁',points:5,max:1},{id:'at_e3',label:'קריאה לפני שינה',emoji:'📖',points:3,max:1}],
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
  const k=cur(); if(!k){ wrap.innerHTML=''; return; }
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
  state.calmMode=(await DB.get('cs_calm'))    ??false;
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
  // Look up a task/action by id across every configured list. Used to validate
  // scanned/typed QR codes against the real config so forged ids are rejected.
  if(!id) return null;
  let t=state.chores.find(x=>x.id===id) || state.actions.find(x=>x.id===id);
  if(t) return t;
  if(state.anchored){
    for(const period of ['morning','afternoon','evening']){
      const f=(state.anchored[period]||[]).find(x=>x.id===id);
      if(f) return f;
    }
  }
  return null;
}

/* ===== BALANCE / EARN ===== */
function renderBalance(){
  const c=curChild(), k=cur();
  if(c){
    document.getElementById('psName').textContent=c.name;
    const psAv=document.getElementById('psAvatar');
    if(c.id==='ariel'){
      psAv.innerHTML='<svg viewBox="0 0 64 128" style="width:100%;height:100%;filter:drop-shadow(0 2px 4px rgba(0,0,0,.2));">'
        +'<rect x="16" y="0" width="32" height="32" fill="#8B5A3C"/>'
        +'<rect x="20" y="8" width="6" height="8" fill="#4444FF"/>'
        +'<rect x="38" y="8" width="6" height="8" fill="#4444FF"/>'
        +'<rect x="24" y="20" width="16" height="2" fill="#000"/>'
        +'<rect x="12" y="32" width="40" height="32" fill="#00CCCC"/>'
        +'<rect x="0" y="32" width="12" height="32" fill="#D4A373"/>'
        +'<rect x="52" y="32" width="12" height="32" fill="#D4A373"/>'
        +'<rect x="16" y="64" width="14" height="32" fill="#4A3FA5"/>'
        +'<rect x="34" y="64" width="14" height="32" fill="#4A3FA5"/>'
        +'<rect x="16" y="96" width="14" height="8" fill="#222"/>'
        +'<rect x="34" y="96" width="14" height="8" fill="#222"/>'
        +'</svg>';
    }else{
      psAv.textContent=c.emoji;
    }
    psAv.style.background=c.color;
    document.getElementById('childName').textContent=c.name;
    const heroAv=document.getElementById('heroAv');
    if(c.id==='ariel'){
      heroAv.innerHTML='<svg viewBox="0 0 64 128" style="width:74px;height:100%;filter:drop-shadow(0 2px 4px rgba(0,0,0,.2));">'
        +'<rect x="16" y="0" width="32" height="32" fill="#8B5A3C"/>'
        +'<rect x="20" y="8" width="6" height="8" fill="#4444FF"/>'
        +'<rect x="38" y="8" width="6" height="8" fill="#4444FF"/>'
        +'<rect x="24" y="20" width="16" height="2" fill="#000"/>'
        +'<rect x="12" y="32" width="40" height="32" fill="#00CCCC"/>'
        +'<rect x="0" y="32" width="12" height="32" fill="#D4A373"/>'
        +'<rect x="52" y="32" width="12" height="32" fill="#D4A373"/>'
        +'<rect x="16" y="64" width="14" height="32" fill="#4A3FA5"/>'
        +'<rect x="34" y="64" width="14" height="32" fill="#4A3FA5"/>'
        +'<rect x="16" y="96" width="14" height="8" fill="#222"/>'
        +'<rect x="34" y="96" width="14" height="8" fill="#222"/>'
        +'<rect x="50" y="35" width="4" height="20" fill="#1a7d1a"/>'
        +'<rect x="48" y="32" width="8" height="4" fill="#888"/>'
        +'</svg>';
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
  }
}
// srcEl (optional): the button/element the child actually tapped to earn
// this. When given, a single coin visibly flies from there to the balance
// pill instead of the generic full-screen burst -- ties the reward directly
// to the action that caused it (DESIGN-IMPROVEMENTS.md V4).
async function addPoints(n,label,type,srcEl){
  // Snapshot the rect NOW, synchronously, before any awaits below -- a
  // caller's own re-render (e.g. markChore -> renderChores()) can run before
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
  chime(type==='spend');
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
    renderChores(); renderStreakBanner(); renderGameTimeBanner(); renderEventsHome(); renderDayStrip(); renderBadgesBanner();
  }
  renderFirstThen(); // A1: now runs for every view renderFirstThen() itself allows, not just home
  // A1: the schedule-refresh interval used to only run on the home view --
  // now it follows the child to any screen (still only ever re-renders
  // home-specific elements like the chore list if home is what's actually
  // showing), so the "now -> then" strip stays correct even if a child
  // spends a while on e.g. the math screen across a period boundary.
  if(childUsesSchedule(curChild())&&!FIRSTTHEN_HIDDEN_VIEWS.includes(v)){
    clockInterval=setInterval(()=>{
      if(currentView==='home'){ renderChores(); renderDayStrip(); }
      renderFirstThen();
      // Catch the day->night decoration switch across the sleep-time
      // boundary, same cadence as the schedule refresh above.
      if(document.querySelector('.app').classList.contains('blocks-mode')) addThemeDecorations('blocks');
    },45000);
  }
  if(v==='scan') startCamera();
  if(v==='math') initMath();
  if(v==='rewards') renderRewards();
  if(v==='history') renderHistory();
  if(v==='streak') renderStreakView();
  if(v==='badges') renderBadgesView();
  if(v==='games') renderGamesView();
  if(v==='learn') initLearningView();
  updateKeepScreenOn();
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
    if(ch.id==='ariel'){
      card.innerHTML=`<div class="kc-av" style="display:flex;align-items:center;justify-content:center;">
        <svg viewBox="0 0 64 128" style="width:74px;height:100%;filter:drop-shadow(0 2px 4px rgba(0,0,0,.2));">
          <!-- Head -->
          <rect x="16" y="0" width="32" height="32" fill="#8B5A3C"/>
          <!-- Eyes -->
          <rect x="20" y="8" width="6" height="8" fill="#4444FF"/>
          <rect x="38" y="8" width="6" height="8" fill="#4444FF"/>
          <!-- Mouth -->
          <rect x="24" y="20" width="16" height="2" fill="#000"/>
          <!-- Body -->
          <rect x="12" y="32" width="40" height="32" fill="#00CCCC"/>
          <!-- Left Arm -->
          <rect x="0" y="32" width="12" height="32" fill="#D4A373"/>
          <!-- Right Arm -->
          <rect x="52" y="32" width="12" height="32" fill="#D4A373"/>
          <!-- Legs -->
          <rect x="16" y="64" width="14" height="32" fill="#4A3FA5"/>
          <rect x="34" y="64" width="14" height="32" fill="#4A3FA5"/>
          <!-- Shoes -->
          <rect x="16" y="96" width="14" height="8" fill="#222"/>
          <rect x="34" y="96" width="14" height="8" fill="#222"/>
          <!-- Sword in hand -->
          <rect x="50" y="35" width="4" height="20" fill="#1a7d1a"/>
          <rect x="48" y="32" width="8" height="4" fill="#888"/>
        </svg>
      </div><div class="kc-name">${esc(ch.name)}</div><div class="kc-bal">🪙 <span data-bal="${ch.id}">…</span></div>`;
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
  k.daily.counts[id]=used+1; DB.set('cs_daily_'+state.current,k.daily);
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
  newProblem();
}
// Adaptive difficulty: the parent's maxNum is the CEILING; each child works up
// to it through 5 levels based on their own recent accuracy, so a quick solver
// gets harder problems and a struggling one isn't stuck failing. Level rises
// after 4 correct in a row, eases after 2 wrong in a row (tracked in
// _mathStreak), and persists per kid in cs_mathlvl_<id>.
let _mathStreak=0; // >0 = consecutive correct, <0 = consecutive wrong
function effectiveMaxNum(){
  const k=cur(); const N=state.math.maxNum;
  const lvl=Math.max(1,Math.min(5,(k&&k.mathLevel)||1));
  // level 5 == full parent cap; lower levels use a fraction, min 5
  return Math.max(5,Math.round(N*lvl/5));
}
async function bumpMathLevel(dir){
  const k=cur(); if(!k) return;
  const next=Math.max(1,Math.min(5,(k.mathLevel||1)+dir));
  if(next!==k.mathLevel){
    k.mathLevel=next;
    await DB.set('cs_mathlvl_'+state.current,next);
    if(dir>0) toast('כל הכבוד! התרגילים נהיים קצת יותר מאתגרים 📈');
  }
}
function newProblem(){
  const m=state.math, op=m.ops[Math.floor(Math.random()*m.ops.length)]; let a,b,ans; const N=effectiveMaxNum();
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
    if(k.mathDaily.done>=state.math.daily){ modalMsg('🏆','סיימת להיום!','פתרת את כל '+state.math.daily+' התרגילים המזכים. כל הכבוד!'); newProblem(); return; }
    k.mathDaily.done++; DB.set('cs_mathd_'+state.current,k.mathDaily);
    k.mathTotal=(k.mathTotal||0)+1; DB.set('cs_matht_'+state.current,k.mathTotal);
    addPoints(state.math.pts,'תרגיל חשבון','math',document.querySelector('.key.ok'));
    toast('נכון! +'+state.math.pts+' 🪙');
    if(k.mathDaily.done>=state.math.daily){ setTimeout(()=>modalMsg('🏆','כל הכבוד!','סיימת את כל התרגילים המזכים להיום!'),300); }
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
  if(nativeTtsAvailable()){
    // Relayed back from Kotlin's UtteranceProgressListener (see
    // NativeGameBridge.kt). onRangeStart (per-word position) only exists on
    // API 26+; older devices still get onDone/onError via _nativeTtsEnd, so
    // speech plays but without a live word highlight -- graceful, not fatal.
    const uid='tts'+myGen;
    window._nativeTtsBoundary=(id,charIndex)=>{ if(id===uid&&!done&&myGen===_ttsGen) highlightWordAt(el,words,charIndex); };
    window._nativeTtsEnd=(id)=>{ if(id===uid) finish(); };
    try{
      if(!window.CoinQuestNative.ttsSpeak(text,lang||'he-IL',uid,state.calmMode?0.75:0.9)) finish();
    }catch(e){ finish(); }
    return;
  }
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
// button was clicked, same anti-cheat pattern as markChore/redeemToken.
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
function bumpLearningLevel(subj){
  const k=cur(); if(!k) return;
  const recent=k.learn.recent[subj]||[];
  const lastN=recent.slice(-4);
  if(lastN.length>=4 && lastN.every(v=>v===1)){
    const next=Math.min(3,(k.learnLevel[subj]||1)+1);
    if(next!==k.learnLevel[subj]){ k.learnLevel[subj]=next; DB.set('cs_learnlvl_'+state.current,k.learnLevel); toast('עלית לרמה '+next+' ב'+subjLabel(subj)+'! ⛏️📈'); }
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
  if(perfect && !state.calmMode){ try{ chime('celebrate'); }catch(e){} }
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
  // Use time-based tasks if current view is home and this child has the schedule enabled
  let tasks=state.chores.filter(t=>taskForChild(t,state.current));
  if(childUsesSchedule(curChild())&&currentView==='home'){
    tasks=getTasksForTimeOfDay();
    const timeHour=new Date().getHours();
    const hour=String(timeHour).padStart(2,'0');
    const greeting=document.createElement('div');
    greeting.style.cssText='font-size:1.1rem;font-weight:800;color:#6B6585;margin-bottom:14px;text-align:center;';
    greeting.textContent=hour+':00 - 🌤️ מטלות כרגע';
    wrap.appendChild(greeting);
  }
  if(tasks.length===0){ wrap.innerHTML='<div class="empty"><span class="e-ic">🧹</span>אין מטלות כרגע</div>'; return; }
  tasks.forEach(ch=>{
    const used=k.daily.counts[ch.id]||0;
    const full=used>=ch.max;
    const row=document.createElement('div'); row.className='chore-row'+(full?' done':'');
    row.innerHTML=`
      <button class="chore-check ${full?'full':''}" ${full?'disabled':''} onclick="markChore('${ch.id}',this)">${full?'✓':(ch.photo?`<img src="${ch.photo}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">`:ch.emoji)}</button>
      <div class="chore-info">
        <div class="ci-t">${esc(ch.label)}</div>
        <div class="ci-d">${full?'הושלם להיום ✅':(used+'/'+ch.max+' היום')}</div>
      </div>
      <div class="chore-pts">+${ch.points} 🪙</div>`;
    wrap.appendChild(row);
  });
}

/* ===== VISUAL DAY SCHEDULE + FIRST->THEN (for Ariel) ===== */
function currentPeriodKey(){
  const hour=new Date().getHours();
  if(!state.anchored) return 'morning';
  if(hour>=state.anchored.sleep_time||hour<5) return 'sleep';
  return getTimeOfDay(hour);
}
function periodTaskList(period){
  if(period==='sleep') return [{id:'night_sleep',label:'זמן שינה',emoji:'😴',points:2,max:1}];
  return (state.anchored&&state.anchored[period])||[];
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
  let remaining=[];
  for(let i=curIdx;i<order.length;i++){
    remaining.push(...periodTaskList(order[i]).filter(t=>(k.daily.counts[t.id]||0)<t.max));
  }
  if(remaining.length===0){
    wrap.innerHTML='<div class="ft-done">🎉 סיימת את כל המטלות של היום! כל הכבוד אריאל!</div>';
    return;
  }
  const first=remaining[0], then=remaining[1];
  const ftIcon=t=>t.photo?`<img class="ft-ic" src="${t.photo}" style="width:64px;height:64px;border-radius:16px;object-fit:cover;">`:`<span class="ft-ic">${t.emoji}</span>`;
  wrap.innerHTML=`<div class="ft-card">
    <div class="ft-box first"><div class="ft-lbl">קודם</div>${ftIcon(first)}<div class="ft-t">${esc(first.label)}</div></div>
    <div class="ft-arrow">←</div>
    <div class="ft-box then">${then
      ?`<div class="ft-lbl">אחר כך</div>${ftIcon(then)}<div class="ft-t">${esc(then.label)}</div>`
      :`<div class="ft-lbl">אחר כך</div><span class="ft-ic">🎉</span><div class="ft-t">סיימת!</div>`}</div>
  </div>`;
}

// Minimum real-world gap between two marks of the SAME chore: without this,
// the only guard was a pure daily COUNT (`used>=ch.max`), which is time-blind
// -- a child could tap "brushed teeth" twice in the same second and bank the
// full day's points for a task never actually done. This doesn't require any
// new admin config: it's a floor under every chore's existing max, not a
// per-chore setting. Not meant to defeat a determined child waiting a minute
// between fake taps (no UI checkbox can prove real-world behavior) -- it's a
// friction floor against the specific "mark everything in 3 seconds" exploit.
const CHORE_MIN_GAP_MS=60000;
function markChore(id,btnEl){
  const ch=findTaskById(id); if(!ch) return;
  if(!taskForChild(ch,state.current)) return; // not this child's task
  const k=cur(); ensureTodayKid(state.current);
  const used=k.daily.counts[id]||0;
  if(used>=ch.max) return;
  const lastMark=k.daily.lastMark[id]||0;
  if(Date.now()-lastMark<CHORE_MIN_GAP_MS){ toast('רגע קטן... 🙂 אפשר לסמן שוב עוד דקה'); return; }
  k.daily.counts[id]=used+1; k.daily.lastMark[id]=Date.now(); DB.set('cs_daily_'+state.current,k.daily);
  k.taskTotal=(k.taskTotal||0)+1; DB.set('cs_taskt_'+state.current,k.taskTotal);
  addPoints(ch.points, ch.label, 'chore', btnEl);
  renderChores(); renderFirstThen(); renderDayStrip();
}

/* ===== STREAK CHALLENGES (multiple daily-streak challenges, e.g. "clean day" / "good behavior") ===== */
function dateKey(d){ return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }
let currentStreakId=null;
function openStreakView(id){ currentStreakId=id; go('streak'); }
function renderStreakBanner(){
  const wrap=document.getElementById('streakBannerWrap'); if(!wrap) return;
  wrap.innerHTML='';
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
  const wrap=document.getElementById('gameTimeWrap'); if(!wrap) return;
  wrap.innerHTML='';
  const k=cur(); if(!k||!state.games.length) return;
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
  document.getElementById('gtWalletBig').textContent='⏱️ '+fmtGT(k.gtime||0);
  const list=document.getElementById('gamesList'); list.innerHTML='';
  if(!state.games.length){ list.innerHTML='<div class="empty"><span class="e-ic">🎮</span>אין משחקים עדיין — אמא או אבא יכולים להוסיף בהגדרות</div>'; return; }
  const has=(k.gtime||0)>0;
  state.games.forEach(g=>{
    const row=document.createElement('button'); row.className='game-row';
    const nativeUnavailable=g.native&&!isNativeGameAvailable();
    // A real `disabled` attribute would look right but silently swallows
    // ALL clicks (native browser behavior) -- including the tap that's
    // supposed to explain WHY it's locked. Use a CSS-only look-disabled
    // class instead so the explanatory tap always works.
    if(!has||nativeUnavailable) row.classList.add('locked');
    const statusIc=nativeUnavailable?'📱':(has?'▶ שחק':'🔒');
    row.innerHTML=`<span class="g-emoji">${g.emoji}</span><span class="g-label">${esc(g.label)}</span><span style="font-weight:800;color:var(--mint-d);">${statusIc}</span>`;
    row.onclick=()=>{
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
  const choicesHtml=isTyped
    ? `<input type="number" id="gateTypedInput" style="width:100%;text-align:center;font-size:1.3rem;border:2px solid var(--line);border-radius:13px;padding:10px;margin-bottom:10px;" placeholder="?">
       <button class="btn primary" onclick="answerGateQuestion(document.getElementById('gateTypedInput').value)">✓ בדוק</button>`
    : shuffleArr([...q.choices]).map(c=>`<button class="learn-choice-btn" onclick="answerGateQuestion(${JSON.stringify(c)})">${esc(c)}</button>`).join('');
  modalContent.innerHTML=`<div style="text-align:center;">
    <div style="font-size:.8rem;color:var(--ink2);margin-bottom:6px;">⛏️ חימום מוח (${s.idx+1}/${s.questions.length})</div>
    <button class="tts-replay-btn" onclick="replayGateQuestionAudio()" title="הקרא שוב">🔊</button>
    <h3 style="margin-top:0;" id="gateQ">${esc(q.q)}</h3>
    <div style="display:flex;flex-direction:column;gap:8px;" id="gateChoices">${choicesHtml}</div>
  </div>`;
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
async function startGameSession(gameId){
  const k=cur(), g=state.games.find(x=>x.id===gameId);
  if(!k||!g||(k.gtime||0)<=0) return;
  document.getElementById('gameFrame').src=g.url;
  document.getElementById('gameOverlay').style.display='block';
  document.getElementById('gtWarnBanner').style.display='none';
  document.getElementById('gameTimerChip').classList.remove('warning');
  _gt={gameId, baseMono:performance.now(), baseWallet:k.gtime, warned:{}, paused:false,
       lastPersist:performance.now(), interval:setInterval(gtTick,1000)};
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
  if(!_gt) return;
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
  clearInterval(_gt.interval);
  await gtPersist();
  _gt=null;
  updateKeepScreenOn();
  document.getElementById('gameFrame').src='about:blank'; // actually stop the game
  document.getElementById('gameOverlay').style.display='none';
  renderGamesView(); renderGameTimeBanner();
  scheduleSync();
  if(expired){
    modalMsg('⏰','הזמן נגמר!','זמן המשחק שקנית הסתיים.\nאפשר להרוויח עוד מטבעות ולהמיר אותם לזמן משחק חדש! 💪');
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

/* ---- daily chore-reminder notification (AN5, native-only) ---- */
function updateChoreReminderCardVisibility(){
  const card=document.getElementById('choreReminderCard');
  if(card) card.style.display=isNativeGameAvailable()?'':'none';
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
  if(!window.CoinQuestNative.hasOverlayPermission()||!window.CoinQuestNative.hasAccessibilityPermission()){
    modalConfirm('🔒','נדרשת הרשאה חד-פעמית','כדי לוודא שהזמן שנקנה נאכף בפועל, ההורה צריך לאשר פעם אחת חלון-צף והרשאת נגישות. לפתוח את ההגדרות עכשיו?',()=>{
      if(!window.CoinQuestNative.hasOverlayPermission()) window.CoinQuestNative.requestOverlayPermission();
      else window.CoinQuestNative.requestAccessibilityPermission();
    });
    return;
  }
  const seconds=Math.floor(k.gtime||0);
  if(seconds<=0) return;
  const started=window.CoinQuestNative.startNativeSession(g.androidPackage,seconds);
  if(!started){ toast('לא הצלחתי להתחיל את המשחק'); return; }
  toast(g.emoji+' '+g.label+' נפתח! '+fmtGT(seconds)+' זמן משחק');
}
// Called by the Android bridge when a native session ends (timeout, or the
// child ending it early) — the ONLY source of truth for elapsed time, since
// nothing runs here in JS while the native game had focus. Global on
// purpose: a plain top-level function in a non-module script is reachable as
// window.onNativeGameSessionEnded, which is exactly what the Kotlin side
// calls via WebView.evaluateJavascript.
async function onNativeGameSessionEnded(consumedSeconds){
  const k=cur(); if(!k) return;
  k.gtime=Math.max(0,(k.gtime||0)-Math.max(0,consumedSeconds|0));
  await DB.set('cs_gtime_'+state.current,k.gtime);
  renderGameTimeBanner();
  if(currentView==='games') renderGamesView();
  scheduleSync();
  if(k.gtime<=0){
    modalMsg('⏰','הזמן נגמר!','זמן המשחק שקנית הסתיים.\nאפשר להרוויח עוד מטבעות ולהמיר אותם לזמן משחק חדש! 💪');
  }else{
    toast('סיימת לשחק — נשארו לך '+fmtGT(k.gtime)+' 🎮');
  }
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
  state.rewards.forEach(rw=>{
    const can=bal>=rw.cost;
    const pct=Math.min(100,Math.round((bal/rw.cost)*100));
    const row=document.createElement('div'); row.className='row';
    row.innerHTML=`<div class="emoji">${rw.emoji}</div><div class="info"><div class="t">${esc(rw.label)}</div><div class="d">${bal} / ${rw.cost} מטבעות</div>${can?'':`<div class="rw-progress"><div class="fill" style="width:${pct}%"></div></div>`}</div>`;
    const btn=document.createElement('button');
    btn.className='btn '+(can?'gold':'ghost')+' sm'; btn.textContent=can?'החלף':'אין מספיק'; btn.disabled=!can; btn.onclick=()=>redeemReward(rw);
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
    const spend=x.points<0, ic=x.type==='scan'?'📷':x.type==='math'?'➗':x.type==='spend'?'🎁':'⭐';
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
  document.querySelectorAll('.atab').forEach(b=>b.classList.toggle('active',b.dataset.atab===t));
  document.querySelectorAll('.admin-pane').forEach(p=>p.style.display='none');
  document.getElementById('pane-'+t).style.display='block';
  if(t==='children') renderChildrenAdmin();
  if(t==='chores') renderChoresAdmin();
  if(t==='anchored') renderAnchoredAdmin();
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
  if(t==='settings'){ fillAccountSettings(); fillCalmToggle(); fillChoreReminderSettings(); }
}
async function renderCalmLogStats(){
  const el=document.getElementById('calmLogStats'); if(!el) return;
  const log=(await DB.get('cs_calmlog'))??[];
  if(!log.length){ el.innerHTML='<div class="card-sub">עדיין אין שימוש — זה בסדר גמור. הכלי מחכה לרגע שיצטרכו אותו.</div>'; return; }
  const TOOLS={breathe:'🎈 נשימת בלון',muscle:'🍋 סוחטים לימון',ground:'🖐️ משחק החושים',ocean:'🌊 גלים בים',rain:'🌧️ גשם שקט',visual:'✨ מסך מרגיע'};
  const FEEL=['','😊','😕','😖','😡'];
  const week=log.filter(e=>Date.now()-e.ts<7*24*3600*1000);
  const improved=log.filter(e=>e.before&&e.after&&e.after<e.before).length;
  const rated=log.filter(e=>e.before&&e.after).length;
  let html=`<div style="font-weight:800;margin-bottom:8px;">בשבוע האחרון: ${week.length} פעמים · ${rated?Math.round(improved/rated*100)+'% מהפעמים הרגיש יותר טוב אחרי':''}</div>`;
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
function renderAnchoredAdmin(){
  const a=state.anchored;
  ['morning','afternoon','evening'].forEach(period=>{
    const c=document.getElementById('anchored'+period.charAt(0).toUpperCase()+period.slice(1));
    c.innerHTML='';
    a[period].forEach((task,i)=>{
      const row=document.createElement('div'); row.className='admin-row';
      const icon=task.photo?`<img src="${task.photo}" style="width:34px;height:34px;border-radius:50%;object-fit:cover;">`:`<span class="emoji">${task.emoji}</span>`;
      const photoCtrl=task.photo
        ? `<button class="icon-btn" title="הסר תמונה" onclick="removeAnchoredPhoto('${period}',${i})">🖼️✖</button>`
        : `<label class="icon-btn" title="הוסף תמונה" style="cursor:pointer;">📷<input type="file" accept="image/*" capture="environment" style="display:none;" onchange="attachAnchoredPhoto('${period}',${i},this)"></label>`;
      row.innerHTML=`<span class="drag-handle" title="גרור לשינוי הסדר">⠿</span>${icon}<span class="t">${esc(task.label)}</span>
        ${photoCtrl}
        <input type="number" value="${task.points}" min="1" style="width:50px;border:2px solid var(--line);border-radius:10px;padding:6px;text-align:center;font-family:inherit;" onchange="updateAnchoredPoints('${period}',${i},this.value)">
        <button class="icon-btn" onclick="delAnchoredTask('${period}',${i})">🗑️</button>`;
      c.appendChild(row);
      row.querySelector('.drag-handle').addEventListener('pointerdown',ev=>startAnchoredDrag(ev,period,i));
    });
  });
  document.getElementById('sleepTime').value=a.sleep_time;
}
async function attachAnchoredPhoto(period,i,input){
  const f=input.files&&input.files[0]; input.value='';
  if(!f) return;
  const task=state.anchored[period][i]; if(!task) return;
  try{
    task.photo=await fileToThumb(f);
    await DB.set('cs_anchored',state.anchored);
    renderAnchoredAdmin();
    toast('התמונה נוספה ✓');
  }catch(e){ toast('לא הצלחתי לטעון את התמונה'); }
}
async function removeAnchoredPhoto(period,i){
  const task=state.anchored[period][i]; if(!task) return;
  delete task.photo;
  await DB.set('cs_anchored',state.anchored);
  renderAnchoredAdmin(); toast('התמונה הוסרה');
}

/* ---- Drag-to-reorder anchored tasks. Pointer Events (not the HTML5 Drag API)
   so this works on touch (mobile) as well as mouse — the admin panel is used
   from a phone as much as a desktop. Only the small grip handle is
   draggable, not the whole row, so it doesn't fight with the points input or
   delete button next to it. The underlying array is only reordered on
   pointerup; during the drag we just move the row visually and compute where
   it would land, to avoid the complexity/fragility of live-reflowing every
   sibling row on each pointermove. ---- */
let _anchoredDrag=null;
function startAnchoredDrag(ev,period,index){
  ev.preventDefault();
  const list=document.getElementById('anchored'+period.charAt(0).toUpperCase()+period.slice(1));
  const rows=[...list.querySelectorAll('.admin-row')];
  const dragged=rows[index];
  const startRect=dragged.getBoundingClientRect();
  const others=rows.map((r,i)=>({i,midY:r.getBoundingClientRect().top+r.getBoundingClientRect().height/2})).filter(o=>o.i!==index);
  _anchoredDrag={period,index,targetIndex:index,dragged,startY:ev.clientY,startTop:startRect.top,height:startRect.height,others};
  dragged.classList.add('dragging');
  try{ dragged.setPointerCapture(ev.pointerId); }catch(e){}
  document.addEventListener('pointermove',onAnchoredDragMove);
  document.addEventListener('pointerup',onAnchoredDragEnd,{once:true});
  document.addEventListener('pointercancel',onAnchoredDragEnd,{once:true});
}
function onAnchoredDragMove(ev){
  const d=_anchoredDrag; if(!d) return;
  const dy=ev.clientY-d.startY;
  d.dragged.style.transform='translateY('+dy+'px)';
  const draggedMidY=d.startTop+d.height/2+dy;
  let count=0;
  for(const o of d.others){ if(draggedMidY>o.midY) count++; }
  d.targetIndex=count;
}
async function onAnchoredDragEnd(){
  const d=_anchoredDrag; if(!d) return;
  document.removeEventListener('pointermove',onAnchoredDragMove);
  d.dragged.classList.remove('dragging'); d.dragged.style.transform='';
  if(d.targetIndex!==d.index){
    const arr=state.anchored[d.period];
    const [item]=arr.splice(d.index,1);
    arr.splice(d.targetIndex,0,item);
    await DB.set('cs_anchored',state.anchored);
    toast('הסדר עודכן ✓');
  }
  _anchoredDrag=null;
  renderAnchoredAdmin();
}

async function addAnchoredTask(period){
  const label=prompt('שם המטלה:');
  const emoji=prompt('אימוג\'י:','🎯');
  const points=parseInt(prompt('נקודות:','5'))||5;
  const max=parseInt(prompt('מקסימום ביום:','1'))||1;
  state.anchored[period].push({id:'at_'+Date.now(),label,emoji,points,max});
  await DB.set('cs_anchored',state.anchored);
  renderAnchoredAdmin();
  toast('נוסף ✓');
}
async function updateAnchoredPoints(period,i,v){
  state.anchored[period][i].points=parseInt(v)||1;
  await DB.set('cs_anchored',state.anchored);
  toast('עודכן ✓');
}
async function delAnchoredTask(period,i){
  await delWithUndo(state.anchored[period],i,'cs_anchored',renderAnchoredAdmin,'המשימה',
    async()=>{ await DB.set('cs_anchored',state.anchored); });
}
async function updateSleepTime(){
  const time=parseInt(document.getElementById('sleepTime').value);
  if(time<20||time>23){ toast('בחר שעה בין 20-23'); return; }
  state.anchored.sleep_time=time;
  await DB.set('cs_anchored',state.anchored);
  toast('עודכן ✓');
}
async function renderChildrenAdmin(){
  const c=document.getElementById('childrenAdmin'); c.innerHTML='';
  for(const ch of state.children){
    const k=await loadKid(ch.id);
    const row=document.createElement('div'); row.className='kid-admin'; row.style.setProperty('--kc',ch.color);
    row.innerHTML=`<div class="ka-av">${ch.emoji}</div>
      <div class="ka-info"><div class="ka-name">${esc(ch.name)}</div><div class="ka-bal">🪙 ${k.balance} מטבעות</div></div>
      <div class="ka-acts">
        <button class="icon-btn" title="ערוך" onclick="editChild('${ch.id}')">✏️</button>
        <button class="icon-btn" title="תקן יתרה" onclick="adminSetBalance('${ch.id}')">🪙</button>
        <button class="icon-btn" title="אפס" onclick="adminResetChild('${ch.id}')">♻️</button>
        <button class="icon-btn" title="מחק" onclick="adminDelChild('${ch.id}')">🗑️</button>
      </div>`;
    c.appendChild(row);
  }
}
async function addChild(){
  const name=document.getElementById('newKidName').value.trim();
  if(!name){ toast('צריך שם'); return; }
  const emoji=document.getElementById('newKidEmoji').value.trim()||'🙂';
  const palette=['#7C5CFC','#FF6B6B','#27C99A','#4DABF7','#F5B82E','#FF8FCB'];
  const color=palette[state.children.length%palette.length];
  state.children.push({id:'k'+Date.now().toString(36),name,emoji,color});
  await DB.set('cs_children',state.children);
  document.getElementById('newKidName').value=''; document.getElementById('newKidEmoji').value='';
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
async function adminDelChild(id){
  if(state.children.length<=1){ toast('צריך לפחות ילד אחד'); return; }
  const ch=state.children.find(c=>c.id===id);
  modalConfirm('🗑️','למחוק את '+ch.name+'?','כל הנתונים של '+ch.name+' יימחקו לצמיתות.', async()=>{
    state.children=state.children.filter(c=>c.id!==id); await DB.set('cs_children',state.children);
    audit('מחק את הילד/ה '+ch.name);
    for(const p of ['cs_bal_','cs_hist_','cs_daily_','cs_mathd_','cs_badges_','cs_matht_','cs_taskt_','cs_rwt_','cs_gtime_','cs_mathlvl_']){
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
function renderChoresAdmin(){
  const c=document.getElementById('choresAdmin'); c.innerHTML='';
  state.chores.forEach((ch,i)=>{
    const row=document.createElement('div'); row.className='admin-row';
    row.innerHTML=`<span class="emoji">${ch.emoji}</span><span class="t">${esc(ch.label)}<br><span style="font-size:.72rem;color:var(--muted);font-weight:400;">עד ${ch.max} פעמים ביום · </span>${kidChipsHtml('chores',i,ch)}</span>
      <input type="number" value="${ch.points}" min="1" style="width:62px;border:2px solid var(--line);border-radius:10px;padding:7px;text-align:center;font-family:inherit;font-weight:700;" onchange="updateChorePoints(${i},this.value)">
      <button class="icon-btn" onclick="delChore(${i})">🗑️</button>`;
    c.appendChild(row);
  });
}
async function updateChorePoints(i,v){ state.chores[i].points=parseInt(v)||1; await DB.set('cs_chores',state.chores); toast('עודכן ✓'); }
async function delChore(i){ await delWithUndo(state.chores,i,'cs_chores',renderChoresAdmin,'המטלה'); }
async function addChore(){
  const label=document.getElementById('newChoreLabel').value.trim(); if(!label){ toast('צריך שם למטלה'); return; }
  const emoji=document.getElementById('newChoreEmoji').value.trim()||'⭐';
  const points=parseInt(document.getElementById('newChorePoints').value)||5, max=parseInt(document.getElementById('newChoreMax').value)||1;
  state.chores.push({id:'chore_'+Date.now().toString(36),label,emoji,points,max}); await DB.set('cs_chores',state.chores);
  document.getElementById('newChoreLabel').value=''; document.getElementById('newChoreEmoji').value=''; renderChoresAdmin(); toast('נוסף! ✓');
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
function fillStreakAdmin(){
  const sel=document.getElementById('streakSel');
  const selectedBefore=document.getElementById('streakSel').value;
  sel.innerHTML='';
  state.streaks.forEach(st=>{ const o=document.createElement('option'); o.value=st.id; o.textContent=(st.icon||'🌟')+' '+st.title; sel.appendChild(o); });
  adminStreakId=selectedBefore&&getStreak(selectedBefore)?selectedBefore:(adminStreakId&&getStreak(adminStreakId)?adminStreakId:state.streaks[0].id);
  sel.value=adminStreakId;
  const s=getStreak(adminStreakId);
  document.getElementById('streakTitle').value=s.title;
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
async function saveStreakConfig(){
  const s=getStreak(adminStreakId); if(!s) return;
  s.title=document.getElementById('streakTitle').value.trim()||s.title;
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
  if(s.current<s.goal) s.wonAt=s.wonAt;
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
  const c=document.getElementById('actionsAdmin'); c.innerHTML='';
  state.actions.forEach((a,i)=>{
    const row=document.createElement('div'); row.className='admin-row';
    row.innerHTML=`<span class="emoji">${a.emoji}</span><span class="t">${esc(a.label)}<br><span style="font-size:.72rem;color:var(--muted);font-weight:400;">עד ${a.max} פעמים ביום · </span>${kidChipsHtml('actions',i,a)}</span>
      <input type="number" value="${a.points}" min="1" style="width:62px;border:2px solid var(--line);border-radius:10px;padding:7px;text-align:center;font-family:inherit;font-weight:700;" onchange="updateActionPoints(${i},this.value)">
      <button class="icon-btn" onclick="delAction(${i})">🗑️</button>`;
    c.appendChild(row);
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
    rows.push(`<div style="display:flex;align-items:center;gap:8px;font-size:.82rem;padding:3px 0;">
      <span>${ch.emoji} ${esc(ch.name)}</span>
      <span style="flex:1;">${'⭐'.repeat(lvl)}${'·'.repeat(5-lvl)} רמה ${lvl}/5</span>
      <button class="icon-btn" title="אפס רמה" onclick="resetMathLevel('${ch.id}')">↺</button></div>`);
  }
  el.innerHTML=rows.join('');
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
  renderCustomQuestionsAdmin();
}
function toggleLearningEnabled(){ state.learning.enabled=!state.learning.enabled; fillLearningConfig(); }
function toggleLearningSubject(subj){ state.learning.subjects[subj]=!state.learning.subjects[subj]; fillLearningConfig(); }
function toggleLearningGate(){ state.learning.gateEnabled=!state.learning.gateEnabled; fillLearningConfig(); }
function toggleLearningReadAloud(){ state.learning.readAloud=!(state.learning.readAloud!==false); if(!state.learning.readAloud) stopSpeaking(); fillLearningConfig(); }
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
function toggleMathEnabled(){ state.math.enabled=!state.math.enabled; fillMathConfig(); }
function toggleOp(op){ const i=state.math.ops.indexOf(op); if(i>=0) state.math.ops.splice(i,1); else state.math.ops.push(op); fillMathConfig(); }
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
    row.innerHTML=`<span class="emoji">${r.emoji}</span><span class="t">${esc(r.label)}${r.minutes?`<br><span style="font-size:.72rem;color:var(--mint-d);font-weight:700;">🎮 ${r.minutes} דקות משחק אוטומטית</span>`:''}</span>
      <input type="number" value="${r.cost}" min="1" style="width:62px;border:2px solid var(--line);border-radius:10px;padding:7px;text-align:center;font-family:inherit;font-weight:700;" onchange="updateRewardCost(${i},this.value)">
      <button class="icon-btn" onclick="delReward(${i})">🗑️</button>`;
    c.appendChild(row);
  });
}
async function updateRewardCost(i,v){ state.rewards[i].cost=parseInt(v)||1; await DB.set('cs_rewards',state.rewards); toast('עודכן ✓'); }
async function delReward(i){ await delWithUndo(state.rewards,i,'cs_rewards',renderRewardsAdmin,'הפרס'); }
async function addReward(){
  const label=document.getElementById('newRwLabel').value.trim(); if(!label){ toast('צריך שם לפרס'); return; }
  const emoji=document.getElementById('newRwEmoji').value.trim()||'🎁', cost=parseInt(document.getElementById('newRwCost').value)||30;
  const minutes=parseInt(document.getElementById('newRwMinutes').value)||0;
  const rw={id:'r'+Date.now().toString(36),label,emoji,cost};
  if(minutes>0) rw.minutes=minutes;
  state.rewards.push(rw); await DB.set('cs_rewards',state.rewards);
  scheduleSync();
  document.getElementById('newRwLabel').value=''; document.getElementById('newRwEmoji').value=''; document.getElementById('newRwMinutes').value=''; renderRewardsAdmin(); toast('נוסף! ✓');
}

/* ===== GAMES ADMIN ===== */
function renderGamesAdmin(){
  const c=document.getElementById('gamesAdmin'); c.innerHTML='';
  if(!state.games.length) c.innerHTML='<div class="empty"><span class="e-ic">🎮</span>אין משחקים</div>';
  state.games.forEach((g,i)=>{
    const row=document.createElement('div'); row.className='admin-row';
    const sub=g.native
      ? '📱 אפליקציה אמיתית באנדרואיד · '+esc(g.androidPackage)
      : esc(g.url||'');
    row.innerHTML=`<span class="emoji">${g.emoji}</span><span class="t">${esc(g.label)}<br><span style="font-size:.68rem;color:var(--muted);font-weight:400;direction:ltr;display:inline-block;">${sub}</span></span>
      <button class="icon-btn" onclick="delGame(${i})">🗑️</button>`;
    c.appendChild(row);
  });
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
async function savePin(){
  const v=document.getElementById('setPin').value.trim();
  if(v.length<3){ toast('קוד קצר מדי'); return; }
  if(isWeakPin(v)){ toast('קוד קל מדי לניחוש — נסה קוד אחר 🙂'); return; }
  state.pin=v; await DB.set('cs_pin',v); scheduleSync(); document.getElementById('setPin').value=''; toast('הקוד עודכן ✓');
}

/* ===== BACKUP / RESTORE ===== */
function backupKeyList(){
  const keys=['cs_children','cs_current','cs_chores','cs_actions','cs_rewards','cs_math',
    'cs_streaks','cs_badgedefs','cs_anchored','cs_events','cs_pin','cs_calm','cs_games',
    'cs_games_v3','cs_games_v4','cs_gtime_seeded','cs_hwm_date','cs_calmlog','cs_familyid'];
  for(const ch of state.children){
    for(const p of ['cs_bal_','cs_hist_','cs_daily_','cs_mathd_','cs_badges_','cs_matht_','cs_taskt_','cs_rwt_','cs_gtime_','cs_mathlvl_']){
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
async function saveGroqKey(){ const v=document.getElementById('setGroqKey').value.trim(); if(!v){ toast('הכנס מפתח'); return; } GROQ_API_KEY=v; localStorage.setItem('cs_groq_key',v); document.getElementById('setGroqKey').value=''; document.getElementById('groqKeyStatus').textContent='✅ מפתח שמור'; toast('מפתח Groq נשמר ✓'); updateChatNavVisibility(); }
// S8a (store-release prep): this is a genuinely unmoderated third-party AI
// chat -- keep the nav tab itself hidden from the child's bottom nav until a
// parent has actually configured a key in Admin Settings, instead of showing
// an inviting chat tab that (with no key set) can only ever reply "ask your
// parent". Purely a visibility toggle -- sendChatMessage's own `!GROQ_API_KEY`
// guard above still exists as defense in depth.
function updateChatNavVisibility(){
  const btn=document.querySelector('[data-nav="chat"]');
  if(btn) btn.style.display=GROQ_API_KEY?'':'none';
}

/* ===== MODALS ===== */
const modalBg=document.getElementById('modalBg'), modalContent=document.getElementById('modalContent');
function closeModal(){ modalBg.classList.remove('show'); stopSpeaking(); }
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
let _pinFails=0, _pinLockUntil=0;
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
  const ok=()=>{
    const v=document.getElementById('mPin').value.trim();
    if(v===state.pin){ _pinFails=0; closeModal(); onOk(); }
    else{
      _pinFails++;
      if(_pinFails>=5){ _pinLockUntil=Date.now()+Math.min(300000,10000*Math.pow(2,_pinFails-5)); closeModal(); modalMsg('⏳','יותר מדי ניסיונות','חכה קצת ונסה שוב.'); return; }
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
const CALM_PANES=['calmMenu','calmBreathe','calmSound','calmGround','calmMuscle','calmVisual','calmAfter'];

function openCalmBreak(){
  _calmSession={before:null, tool:null, ts:Date.now()};
  document.getElementById('calmModal').classList.add('show');
  showCalmMenu();
}
function calmShowPane(id){
  CALM_PANES.forEach(p=>document.getElementById(p).style.display=p===id?'block':'none');
  document.getElementById('calmBackBtn').style.display=(id==='calmMenu'||id==='calmAfter')?'none':'block';
  document.getElementById('calmBackRow').style.display=(id==='calmAfter')?'none':'flex';
}
function showCalmMenu(){
  stopCalmActivity();
  calmShowPane('calmMenu');
}
// Feeling → suggested tool: anger/tension responds best to motor discharge
// (muscle work) and paced breathing; anxiety/unease to grounding; the
// suggestion is a highlight, never a restriction — the child always chooses.
function calmPickFeeling(level){
  if(_calmSession) _calmSession.before=level;
  document.querySelectorAll('.calm-tile').forEach(t=>t.classList.remove('suggested'));
  const sug={1:'visual',2:'ground',3:'breathe',4:'muscle'}[level];
  const el=document.getElementById('tile-'+sug);
  if(el) el.classList.add('suggested');
  document.getElementById('calmSuggest').textContent={
    1:'איזה כיף! אפשר פשוט ליהנות ממשהו נעים ✨',
    2:'בוא ננסה את משחק החושים — הוא עוזר כשמשהו לא נעים',
    3:'נשימת בלון עוזרת הכי מהר כשעצבניים',
    4:'כשכועסים חזק — לסחוט לימונים זה הכי טוב! ולנשום',
  }[level];
  document.querySelectorAll('#feelRowBefore .feel-btn').forEach((b,i)=>b.style.outline=(i+1)===level?'3px solid var(--mint)':'none');
}
function openCalmActivity(kind){
  stopCalmActivity();
  _calmActive=kind;
  if(_calmSession&&!_calmSession.tool) _calmSession.tool=kind;
  if(kind==='breathe'){ calmShowPane('calmBreathe'); startBreathing(); }
  else if(kind==='ocean'){ calmShowPane('calmSound'); document.getElementById('calmSoundIcon').textContent='🌊'; document.getElementById('calmSoundLabel').textContent='גלים בים... שומעים את הים עולה ויורד'; startCalmNoise('ocean'); }
  else if(kind==='rain'){ calmShowPane('calmSound'); document.getElementById('calmSoundIcon').textContent='🌧️'; document.getElementById('calmSoundLabel').textContent='גשם שקט על החלון...'; startCalmNoise('rain'); }
  else if(kind==='ground'){ calmShowPane('calmGround'); startGrounding(); }
  else if(kind==='muscle'){ calmShowPane('calmMuscle'); startMuscle(); }
  else if(kind==='visual'){ calmShowPane('calmVisual'); renderCalmBubbles(); }
}
function stopCalmActivity(){
  clearInterval(_breathTimer); _breathTimer=null;
  clearInterval(_muscleTimer); _muscleTimer=null;
  stopCalmNoise();
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

function renderCalmBubbles(){
  const box=document.getElementById('calmVisualBox'); box.innerHTML='';
  for(let i=0;i<7;i++){
    const b=document.createElement('div'); b.className='calm-bubble';
    const size=20+Math.random()*40;
    b.style.width=size+'px'; b.style.height=size+'px';
    b.style.left=(Math.random()*85)+'%'; b.style.top=(Math.random()*70)+'%';
    b.style.animationDuration=(5+Math.random()*4)+'s';
    b.style.animationDelay=(Math.random()*3)+'s';
    box.appendChild(b);
  }
}

/* -- soundscapes: filtered-noise synthesis (offline, no audio files) -- */
function startCalmNoise(kind){
  stopCalmNoise();
  try{
    actx=actx||new (window.AudioContext||window.webkitAudioContext)();
    // Mobile browsers auto-suspend an AudioContext on backgrounding and it
    // stays suspended silently; resume() here runs inside the tap gesture.
    if(actx.state==='suspended') actx.resume();
    // 4s looped brown-noise buffer — the 1/f² spectrum is the "deep" noise
    // used in sensory-room sound machines (white noise reads as harsh hiss).
    const len=actx.sampleRate*4, buf=actx.createBuffer(1,len,actx.sampleRate);
    const d=buf.getChannelData(0);
    let last=0;
    for(let i=0;i<len;i++){ const w=Math.random()*2-1; last=(last+0.02*w)/1.02; d[i]=last*3.5; }
    const src=actx.createBufferSource(); src.buffer=buf; src.loop=true;
    const filter=actx.createBiquadFilter();
    const master=actx.createGain();
    if(kind==='ocean'){
      // waves = deep rumble whose loudness swells and recedes ~every 9s
      filter.type='lowpass'; filter.frequency.value=420;
      master.gain.value=0.12;
      const lfo=actx.createOscillator(), lfoGain=actx.createGain();
      lfo.frequency.value=0.11; lfoGain.gain.value=0.08;
      lfo.connect(lfoGain); lfoGain.connect(master.gain);
      lfo.start();
      src.connect(filter); filter.connect(master); master.connect(actx.destination);
      src.start();
      _calmNoise={nodes:[src,lfo],master};
    }else{
      // rain = brighter patter, steady with a slight natural flutter
      filter.type='bandpass'; filter.frequency.value=1800; filter.Q.value=0.6;
      master.gain.value=0.07;
      const lfo=actx.createOscillator(), lfoGain=actx.createGain();
      lfo.frequency.value=0.5; lfoGain.gain.value=0.012;
      lfo.connect(lfoGain); lfoGain.connect(master.gain);
      lfo.start();
      src.connect(filter); filter.connect(master); master.connect(actx.destination);
      src.start();
      _calmNoise={nodes:[src,lfo],master};
    }
  }catch(e){
    document.getElementById('calmSoundLabel').textContent='⚠️ הקול לא זמין במכשיר הזה כרגע';
  }
}
function stopCalmNoise(){
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
    log.unshift({ts:_calmSession.ts, childId:state.current, before:_calmSession.before, after:after, tool:_calmSession.tool, secs:Math.round((Date.now()-_calmSession.ts)/1000)});
    if(log.length>60) log.length=60;
    await DB.set('cs_calmlog',log);
  }
  _calmSession=null;
  document.querySelectorAll('#feelRowBefore .feel-btn').forEach(b=>b.style.outline='none');
  document.querySelectorAll('.calm-tile').forEach(t=>t.classList.remove('suggested'));
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
// (e.g. markChore's renderChores() rebuilds the whole list via innerHTML=''
// right after the tap, so capturing the rect late would always see a
// detached, zero-size element). Falls back to coinBurst() if the rect is
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
function getTasksForTimeOfDay(){
  const now=new Date();
  const hour=now.getHours();
  const timeOfDay=getTimeOfDay(hour);
  if(!state.anchored) return [];
  if(hour>=state.anchored.sleep_time||hour<5) return [{id:'night_sleep',label:'זמן שינה',emoji:'😴',points:2,max:1}];
  return state.anchored[timeOfDay]||[];
}

/* ===== GEMINI CHAT + MIC + TTS ===== */
let GROQ_API_KEY='';
let chatHistory=[];
let micRecognition=null;
let isMicRecording=false;
let currentSpeech=null;

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
  if(currentSpeech){window.speechSynthesis.cancel();currentSpeech=null;document.querySelectorAll('.chat-speak-btn.playing').forEach(b=>{b.classList.remove('playing');b.textContent='🔊';});if(btn.textContent==='⏹️'){return;}}
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
  _chatBusy=true;
  input.value='';
  displayMessage(text,true);
  const childName=curChild()?.name||'אריאל';
  const thinkingWrap=document.createElement('div');
  thinkingWrap.style.cssText='display:flex;align-items:flex-start;gap:6px;';
  thinkingWrap.innerHTML='<div class="chat-bubble-ai" style="color:var(--muted);">✨ חושב...</div>';
  document.getElementById('chatMessages').appendChild(thinkingWrap);
  document.getElementById('chatMessages').scrollTop=document.getElementById('chatMessages').scrollHeight;
  try{
    const systemPrompt=`אתה "איזי", עוזר חכם ואוהב לילד בשם ${childName} בן 7, שנמצא על הספקטרום האוטיסטי בתפקוד גבוה.

חוקים שאסור לשבור:
- תמיד קרא לילד בשמו: ${childName}. אסור לומר "בני", "יקירי", או כינויים אחרים.
- ענה תמיד בעברית בלבד.
- תשובות קצרות: 2-3 משפטים בלבד.
- השתמש ב-1-2 emojis רלוונטיים בלבד.
- מילים פשוטות ברמת כיתה א'-ב'.

כשהילד משועמם: הצע פעילות יצירתית כמו ציור, בניית לגו, משחק דמיון — לא אוכל.
כשהילד עצוב/כועס: הכר ברגש שלו קודם ("זה נשמע קשה"), ואז הצע פתרון אחד פשוט.
כשהילד שואל שאלת ידע: תסביר בצורה מעניינת עם דוגמה מהחיים.
אל תיתן עצות על אכילה, ממתקים, או דברים לא בריאים.`;
    const messages=[
      {role:'system',content:systemPrompt},
      ...chatHistory.slice(-10).map(m=>({role:m.isUser?'user':'assistant',content:m.text})),
      {role:'user',content:text}
    ];
    if(!GROQ_API_KEY){ thinkingWrap.remove(); displayMessage('⚙️ הכנס מפתח Groq בהגדרות הורים (לשונית הגדרות)',false); return; }
    const response=await fetch('https://api.groq.com/openai/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+GROQ_API_KEY},
      body:JSON.stringify({model:'llama-3.3-70b-versatile',messages,max_tokens:200,temperature:0.6})
    });
    const data=await response.json();
    if(data.error){
      console.error('Groq error:',data.error);
      thinkingWrap.remove();
      displayMessage('שגיאה: '+data.error.message,false);
      return;
    }
    const reply=data.choices?.[0]?.message?.content||'לא הצלחתי לענות, נסה שנית 😔';
    chatHistory.push({text,isUser:true},{text:reply,isUser:false});
    thinkingWrap.remove();
    displayMessage(reply,false);
    const speakBtns=document.querySelectorAll('.chat-speak-btn');
    if(speakBtns.length) speakText(reply,speakBtns[speakBtns.length-1]);
  }catch(e){
    console.error('Chat error:',e);
    thinkingWrap.remove();
    displayMessage('אין חיבור לאינטרנט 😓 נסה שנית!',false);
  }finally{
    _chatBusy=false;
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
  // The parent PIN is intentionally NOT included — it's a device-local admin
  // lock, not family data, and syncing it would let it leak to whichever
  // device last set it rather than staying under each device's own control.
  const payload={children:state.children,chores:state.chores,actions:state.actions,
    rewards:state.rewards,math:state.math,streaks:state.streaks,badgeDefs:state.badgeDefs,
    anchored:state.anchored,events:state.events||[],hwmDate:_hwmDate,calmMode:state.calmMode,
    games:state.games,auditLog:state.auditLog||[],learning:state.learning,kids:{}};
  for(const ch of state.children){
    const k=state.kid[ch.id];
    if(k){
      payload.kids[ch.id]={balance:k.balance,history:k.history,daily:k.daily,mathDaily:k.mathDaily,
        badges:k.badges,mathTotal:k.mathTotal,taskTotal:k.taskTotal,rewardsTotal:k.rewardsTotal,
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
      state.anchored=data.anchored;
      // Firebase drops empty period arrays; renderAnchoredAdmin does a[period].forEach.
      for(const p of ['morning','afternoon','evening']) if(!Array.isArray(state.anchored[p])) state.anchored[p]=[];
      await DB.set('cs_anchored',state.anchored);
    }
    if(data.events){ state.events=data.events; await DB.set('cs_events',data.events); }
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
    // PIN is never synced (see buildSyncPayload). The high-water-mark date IS
    // synced so wiping/reinstalling the app on one device can't roll back the
    // anti-clock-tamper guard for the whole family.
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
    if(currentView==='home'){ renderChores(); renderStreakBanner(); renderGameTimeBanner(); renderEventsHome(); renderDayStrip(); renderFirstThen(); renderBadgesBanner(); }
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
    for(const p of ['cs_bal_','cs_hist_','cs_daily_','cs_mathd_','cs_badges_','cs_matht_','cs_taskt_','cs_rwt_','cs_gtime_','cs_mathlvl_']){
      await DB.del(p+ch.id);
    }
  }
  state.children=DEFAULT_CHILDREN; state.current=null; state.kid={};
  state.chores=DEFAULT_CHORES; state.actions=DEFAULT_ACTIONS; state.rewards=DEFAULT_REWARDS;
  state.math=DEFAULT_MATH; state.streaks=DEFAULT_STREAKS.map(s=>({...s,days:{}})); state.badgeDefs=DEFAULT_BADGE_DEFS;
  state.anchored=DEFAULT_ANCHORED_TASKS; state.events=[]; state.familyId=null;
  state.games=DEFAULT_GAMES;
  // Delete rather than write defaults back: hasExistingLocalData() treats a
  // present key as "this device has real data" regardless of its content, so
  // writing DEFAULT_CHILDREN etc back here would leave the keys present and
  // make every future createNewFamily() wrongly think there's still data to
  // confirm. In-memory `state` above already has sane defaults for immediate
  // use; storage should end up genuinely empty, matching a device that was
  // never set up at all.
  for(const k of ['cs_children','cs_current','cs_chores','cs_actions','cs_rewards','cs_math',
    'cs_streak','cs_streaks','cs_badgedefs','cs_anchored','cs_events','cs_hwm_date','cs_familyid',
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
async function signInWithGoogle(statusElId){
  // statusElId lets this be called both from the welcome screen (#welcomeStatus)
  // and from Admin Settings (#settingsAuthStatus) for a parent upgrading from
  // local-only mode without ever seeing the welcome screen again.
  const statusEl=()=>document.getElementById(statusElId||'welcomeStatus');
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
}
function copyInviteCode(){
  const code=document.getElementById('inviteCodeText').textContent;
  if(navigator.clipboard) navigator.clipboard.writeText(code).then(()=>toast('הקוד הועתק! 📋')).catch(()=>{});
}

/* ===== DAILY EVENTS ===== */
let shownReminderIds=new Set();

function todayDateStr(){ const d=new Date(); return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }

async function loadEvents(){ return (await DB.get('cs_events'))||[]; }
async function saveEvents(evs){ state.events=evs; await DB.set('cs_events',evs); }

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
  const dateVal=document.getElementById('newEvDate').value||todayDateStr();
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
  loadEvents().then(allEvs=>{
    const today=todayDateStr();
    const tomorrow=new Date(); tomorrow.setDate(tomorrow.getDate()+1);
    const tomorrowStr=tomorrow.getFullYear()+'-'+(tomorrow.getMonth()+1)+'-'+tomorrow.getDate();
    const evs=allEvs.filter(e=>e.date===today||e.date===tomorrowStr).sort((a,b)=>a.date===b.date?a.time.localeCompare(b.time):a.date.localeCompare(b.date));
    if(!evs.length){ wrap.innerHTML=''; return; }
    let html='<div class="section-title">📅 האירועים של היום</div>';
    evs.forEach(ev=>{
      const mins=getMinutesUntil(ev.time);
      const passed=mins<-5, imminent=mins>=0&&mins<=30;
      const badgeTxt=passed?'עבר':(imminent&&mins<=0?'עכשיו!':(imminent?'בעוד '+mins+' דק׳':ev.time));
      const badgeCls=passed?'':(mins<=0?'now':(imminent?'soon':'later'));
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
  const evs=await loadEvents();
  const today=todayDateStr();
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
    evs.filter(e=>e.date===today).forEach(ev=>{
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
    checkForAppUpdate(); // fire-and-forget: never blocks startup on a network round-trip
    await detectBackend();
    await loadState();
    applyCalmModeClass();
    applyChoreReminder();
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
