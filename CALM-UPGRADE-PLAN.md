# CALM-UPGRADE-PLAN — שדרוג משמעותי לכלי הרגיעה (🌿)

מסמך משימות מפורט, בנוי כך שכל משימה ניתנת לביצוע עצמאי ע"י מודל פשוט.
כל משימה: רציונל מחקרי קצר → קבצים מדויקים → מה בדיוק לבנות (כולל מחרוזות עברית מוכנות) → קריטריוני קבלה → בדיקה.

## רקע — מה קיים היום (אל תשבור את זה)

הקוד: `app.js` סקשן `/* ===== CALM MODE + BREAK BUTTON ===== */` (סביב שורה 3615), ה-HTML: מודאל `#calmModal` בסוף `index.html` (סביב שורה 805), עיצוב: `styles.css` (מחלקות `calm-*`, `feel-*`, `breath-*`, `ground-*`, `muscle-*`).

קיים היום: check-in רגשי (4 רמות) לפני/אחרי + לוג `cs_calmlog` להורה · נשימת בלון 4-2-6 · הרפיית שרירים "סוחטים לימון" (4 תחנות) · עיגון חושי 5-4-3-2-1 · רעש-חום מסונן (ים/גשם) · בועות פסיביות · TTS קיים (`speakText`/native bridge) · `navigator.vibrate` זמין ב-wrapper.

עקרונות מקודשים (אין לשנות): כפתור 🌿 לעולם לא נעול ב-PIN, אפס חיכוך, אפס קשר לכלכלת המטבעות (שלא יהפוך לפרס/עונש), הכל אופליין, שקט חושית (ללא אנימציות אגרסיביות), עברית פשוטה לגיל 6–9.

הראיות המרכזיות מהמחקר: משוב הפטי (רטט) לקצב נשימה · עבודה פרופריוצפטיבית/"עבודה כבדה" (דחיפת קיר, לחיצות כיסא) ולחץ עמוק (חיבוק עצמי) מרגיעים מדידות · Zones of Regulation (צבע→כלי מותאם) · פידג'ט דיגיטלי אינטראקטיבי עם הפטיקה · התאמה אישית של סל הכלים לילד.

---

## C1 — נשימה מודרכת ברטט (Haptic Breathing) ⭐ עדיפות עליונה

**רציונל:** אפליקציות רגיעה מובילות (Haptic Calm, Haptic Box) מעבירות את קצב הנשימה דרך קצות האצבעות — עובד גם בעיניים עצומות וגם כשעיבוד שמיעתי קשה, חזק במיוחד לילדים על הספקטרום.

**קבצים:** `app.js` בלבד (פונקציות `startBreathing`, `calmBreathTone`).

**מה לבנות:**
1. פונקציה חדשה `calmBreathHaptic(phase)` ליד `calmBreathTone`:
   - phase 0 (שאיפה): `navigator.vibrate([40,120,40,120,40,120,40])` — סדרת פעימות קצרות עולות לאורך 4 שניות.
   - phase 1 (החזקה): `navigator.vibrate(0)` — שקט.
   - phase 2 (נשיפה): `navigator.vibrate([200,300,150,350,100,400])` — פעימות מתארכות ודועכות.
   - עטוף ב-`try{}catch(e){}` וב-`if(!navigator.vibrate) return;`.
2. קרא לה מתוך `applyPhase()` ב-`startBreathing`, מיד אחרי `calmBreathTone(phase)`.
3. **חשוב:** הרטט כאן מותר גם ב-calm mode (זה כלי הרגיעה עצמו, לא אפקט חגיגה) — אל תוסיף את הגארד `!state.calmMode` שקיים ב-addPoints.

**קבלה:** במכשיר אנדרואיד מרגישים קצב רטט שונה בשאיפה/נשיפה; בדסקטופ אין שגיאות קונסול.
**בדיקה:** Playwright — לוודא ש-`startBreathing` רץ בלי חריגות כש-`navigator.vibrate` לא קיים (mock undefined).

---

## C2 — כלי חדש: "כוח-על" (עבודה כבדה פרופריוצפטיבית) ⭐ עדיפות עליונה

**רציונל:** דחיפת קיר, לחיצות כיסא ונשיאת חפצים כבדים הן ההמלצה מספר 1 של מרפאות בעיסוק לוויסות חושי — פורקות עוררות פיזית שנשימה לבדה לא פורקת. חסר לגמרי בערכה הנוכחית, והוא הכלי הכי מתאים לרמה "כועס מאוד".

**קבצים:** `index.html` (פאנל חדש + אריח), `app.js` (לוגיקה), `styles.css` (אם צריך — לשכפל סגנון `calmMuscle`).

**מה לבנות:**
1. אריח חדש ב-`.calm-tiles`: `<button class="calm-tile" id="tile-heavy" onclick="openCalmActivity('heavy')"><span class="t-ic">🦸</span>כוח-על</button>`
2. פאנל `<div id="calmHeavy">` (העתק מבנה מ-`calmMuscle`: אייקון גדול, טקסט, פס התקדמות, רמז). להוסיף `'calmHeavy'` למערך `CALM_PANES`.
3. קבוע חדש ב-`app.js`:
```js
const HEAVY_STEPS=[
 {ic:'🧱', txt:'לך לקיר ודחוף אותו הכי חזק שאתה יכול — כאילו אתה מזיז את הבית!', secs:10, hint:'דחוף! הקיר כמעט זז...'},
 {ic:'🪑', txt:'שב על כיסא, שים ידיים בצדדים ולחץ למטה להרים את עצמך', secs:8, hint:'אתה ממש חזק!'},
 {ic:'🤲', txt:'הצמד את כפות הידיים חזק אחת לשנייה מול החזה', secs:8, hint:'כמו סופרמן!'},
 {ic:'🤗', txt:'חבק את עצמך חזק חזק — לחיצה גדולה של אלוף', secs:10, hint:'החיבוק הכי חזק בעולם'},
];
```
   (הצעד האחרון הוא לחץ עמוק — self-hug — מהמחקר על deep pressure.)
4. פונקציה `startHeavy()` — העתק את התבנית של `startMuscle()`: טיימר שניות, פס מילוי, מעבר בין צעדים, סיום: `ic='😌'`, `txt='וואו! פרקת את כל הכוח. איך ההרגשה?'`. השתמש ב-`_muscleTimer` הקיים (אותו משתנה — `stopCalmActivity` כבר מנקה אותו).
5. ב-`openCalmActivity`: `else if(kind==='heavy'){ calmShowPane('calmHeavy'); startHeavy(); }`
6. עדכן המלצות: ב-`calmPickFeeling` שנה את המיפוי ל-`{1:'visual',2:'ground',3:'breathe',4:'heavy'}` ואת טקסט רמה 4 ל: `'כשכועסים ממש חזק — הגוף צריך לעבוד! נסה את כוח-העל 🦸'`.
7. הוסף `heavy:'🦸 כוח-על'` ל-`TOOLS` ב-`renderCalmLogStats` (שורה ~2371).

**קבלה:** האריח מופיע, מחזור מלא רץ עד "וואו!", מוצע אוטומטית ברמה 4, מופיע בסטטיסטיקות ההורה.
**בדיקה:** Playwright — פתיחת 🌿, בחירת רמה 4, לוודא `#tile-heavy` מקבל class `suggested`, קליק עליו מציג את `#calmHeavy`.

---

## C3 — פופ-בועות אינטראקטיבי (פידג'ט דיגיטלי) ⭐ עדיפות עליונה

**רציונל:** ה"מסך המרגיע" הנוכחי פסיבי לחלוטין. פידג'ט אינטראקטיבי (פיצוץ בועות בנגיעה + רטט קטן) = pop-it דיגיטלי — מוציא אנרגיה עצבנית דרך האצבעות, בדיוק הקטגוריה של Haptic Box.

**קבצים:** `app.js` (`renderCalmBubbles`), `styles.css`.

**מה לבנות:**
1. ב-`renderCalmBubbles`: הפוך כל בועה ללחיצה. בלחיצה: אנימציית pop (scale up + fade, ~250ms), רטט `navigator.vibrate(15)`, צליל "בלופ" רך (סינוס 500→200Hz יורד, 0.15s, gain 0.06 — העתק תבנית מ-`calmBreathTone`), ואחרי 400ms הבועה נולדת מחדש במקום אקראי חדש.
2. מונה עדין בפינה: `<div class="cm-sub">פוצצת <b id="bubbleCount">0</b> בועות 🫧</div>` — בלי יעד, בלי פרס, רק ספירה (זה פידג'ט, לא משחק).
3. CSS: `.calm-bubble{cursor:pointer;}` + `@keyframes bubblePop{to{transform:scale(1.6);opacity:0;}}` + class `.popping`.
4. הגדל כמות בועות מ-7 ל-10.

**קבלה:** נגיעה בבועה מפוצצת אותה עם צליל ורטט, בועה חדשה מופיעה, המונה עולה.
**בדיקה:** Playwright — קליק על `.calm-bubble`, לוודא שהמונה עלה ל-1 ושמספר הבועות חוזר ל-10 אחרי 500ms.

---

## C4 — נשימה בעקיבת אצבע (Finger-Trace Breathing)

**רציונל:** "Rainbow/Star breathing" — הילד מניע אצבע לאורך מסלול מצויר בקצב הנשימה. הערוץ המוטורי-מגע עוזר לילדים שקשה להם לעקוב אחרי הוראה ויזואלית בלבד; טכניקה סטנדרטית בגני תקשורת.

**קבצים:** `index.html` (פאנל `calmTrace` + אריח `tile-trace` 🌈), `app.js`, `styles.css`.

**מה לבנות:**
1. SVG של קשת בענן (5 קשתות חצי-עיגול קונצנטריות בצבעי פסטל, viewBox `0 0 300 170`).
2. נקודה (עיגול ⚪ r=12) שנעה לאורך הקשת החיצונית הלוך (שאיפה, 4s) ושוב (נשיפה, 6s) — אנימציה ב-JS עם `requestAnimationFrame` לאורך path (השתמש ב-`path.getPointAtLength(t*path.getTotalLength())`).
3. טקסט מתחלף: `'שאיפה — עקוב עם האצבע אחרי הכדור 👆'` / `'נשיפה ארוכה — חזרה לאט לאט'`.
4. רטט קצר `navigator.vibrate(30)` בכל היפוך כיוון.
5. חיבור מלא כמו C2: `CALM_PANES`, `openCalmActivity('trace')`, `TOOLS` ב-renderCalmLogStats (`trace:'🌈 נשימת קשת'`).

**קבלה:** הנקודה נעה חלק לאורך הקשת בקצב 4-6, מסתנכרנת עם הטקסט.
**בדיקה:** Playwright — פתיחת הכלי, לוודא שה-SVG קיים ושהטקסט מתחלף תוך 5 שניות.

---

## C5 — התאמה חכמה: "מה עזר לך בפעם שעברה"

**רציונל:** Zones of Regulation מדגיש התאמת כלי↔מצב אישית. הנתונים כבר נאספים (`cs_calmlog` עם before/after/tool) — אבל אף אחד לא לומד מהם. שיפור ההצעה מכללית לאישית = הליבה של שדרוג "רמה".

**קבצים:** `app.js` בלבד (`calmPickFeeling`).

**מה לבנות:**
1. פונקציה `bestToolFor(level)`:
```js
async function bestToolFor(level){
  const log=(await DB.get('cs_calmlog'))??[];
  // only this child's rated sessions that started at this feeling level
  const mine=log.filter(e=>e.childId===state.current&&e.before===level&&e.after&&e.tool);
  const score={}; // tool -> avg improvement (before-after; positive = calmer)
  mine.forEach(e=>{ (score[e.tool]=score[e.tool]||[]).push(e.before-e.after); });
  let best=null,bestAvg=0;
  for(const t in score){ const avg=score[t].reduce((a,b)=>a+b,0)/score[t].length;
    if(score[t].length>=2&&avg>bestAvg){ best=t; bestAvg=avg; } }
  return best; // null => fall back to the static map
}
```
2. ב-`calmPickFeeling`: הפוך ל-async; קרא `const personal=await bestToolFor(level);` והשתמש בו במקום המיפוי הסטטי אם אינו null. כשההצעה אישית, שנה את טקסט ההצעה ל: `'בפעם שעברה [שם הכלי] עזר לך הכי הרבה — רוצה שוב?'` (קח את השם ממילון `TOOLS` — העבר אותו לקבוע גלובלי `CALM_TOOL_NAMES` במקום להגדירו בתוך `renderCalmLogStats`).
3. ודא שהאריחים החדשים (heavy/trace) כלולים במילון.

**קבלה:** אחרי 2+ סשנים מדורגים עם אותו כלי ואותה רמת פתיחה שהראו שיפור, הכלי הזה מודגש במקום ברירת המחדל.
**בדיקה:** Playwright — לזרוע `cs_calmlog` מלאכותי ב-localStorage/DB עם 2 רשומות `{before:3,after:1,tool:'ocean'}`, לפתוח 🌿, לבחור רמה 3, לוודא ש-`#tile-ocean` מסומן `suggested`.

---

## C6 — הרחבת ספריית הצלילים + טיימר שינה

**רציונל:** מגוון (פעימות לב/גרגור חתול/רוח) מכסה פרופילים חושיים שונים; טיימר כיבוי הופך את הכלי לשימושי גם להרדמות — שעת השינה היא נקודת חיכוך מרכזית במשפחה (יש `sleep_time` באפליקציה).

**קבצים:** `app.js` (`startCalmNoise`), `index.html` (כפתורים בפאנל `calmSound`).

**מה לבנות:**
1. שני סוגים חדשים ב-`startCalmNoise` (אותה תבנית synthesis):
   - `heartbeat` 💓: אוסילטור סינוס 55Hz, envelope כפול ("לוב-דאב": gain 0.25 ל-0.1s, 0, 0.18 ל-0.1s אחרי 0.25s) בלולאה כל 0.9s — דופק רגוע של 66. השתמש ב-`setInterval` בתוך `_calmNoise` (הוסף שדה `interval` ונקה אותו ב-`stopCalmNoise`).
   - `purr` 🐱: רעש-חום דרך lowpass 150Hz עם LFO מהיר 25Hz על ה-gain (זמזום גרגור) + LFO איטי 0.4Hz לנשימת החתול.
2. שורת בחירה בתוך פאנל `calmSound` (לא אריחים חדשים בתפריט — הפאנל אחד): 4 כפתורים קטנים 🌊🌧️💓🐱 שמחליפים צליל בלי לצאת.
3. טיימר: 3 כפתורים `בלי הגבלה · 5 דק · 10 דק` — `setTimeout` שקורא `stopCalmNoise()` ומראה `'הצליל נגמר בשקט... לילה טוב 🌙'`. לנקות את ה-timeout ב-`stopCalmNoise`.
4. עדכן `TOOLS`/`CALM_TOOL_NAMES`: `heartbeat:'💓 פעימות לב'`, `purr:'🐱 גרגור חתול'`.

**קבלה:** 4 צלילים עובדים ומתחלפים בלי קליקים חדים; הטיימר מכבה בזמן.
**בדיקה:** ידנית (אודיו). Playwright — רק שהכפתורים קיימים ולא זורקים חריגה בלחיצה.

---

## C7 — הדרכה קולית (TTS) לכל תרגיל

**רציונל:** הקראה מלווה = הילד לא צריך לקרוא בזמן שהוא מוצף. תשתית ה-TTS העברית כבר בנויה ועובדת (native + web fallback) — רק לחבר אותה.

**קבצים:** `app.js` בלבד.

**מה לבנות:**
1. בכל תחנת תרגיל, קרא ל-`speakText` הקיימת (בדוק את החתימה המדויקת בקוד — יש `speakWithHighlight`/`speakText`; השתמש בגרסה הפשוטה ללא הדגשה) עם הטקסט המוצג:
   - `startBreathing.applyPhase` → הקרא את `p.label` (רק במחזור הראשון! אחרת זה מציק — שמור דגל `cycles===0`).
   - `renderGroundStep` → הקרא את `s.txt`.
   - `startMuscle.apply` / `startHeavy` → הקרא בתחילת כל תחנה (מעבר tense/release או step חדש, לא כל שנייה).
2. כפתור השתקה קבוע בפינת המודאל: `<button id="calmTtsBtn">🔊</button>` שמחליף ל-🔇 ושומר ב-`cs_calmtts` (device-local, ברירת מחדל: פועל). כבד את הדגל בכל הקריאות.
3. ודא `stopSpeaking()` נקרא ב-`stopCalmActivity` וב-`calmFinish`.

**קבלה:** כל תרגיל מדבר בעברית בקצב רגוע (state.calmMode כבר מאט ל-0.75); ההשתקה נשמרת בין סשנים.
**בדיקה:** Playwright — mock ל-speechSynthesis, לוודא קריאה אחת בכניסה לעיגון חושי ואפס קריאות כשההשתקה פעילה.

---

## C8 — Zones-of-Regulation מלא: check-in גוף→רגש בצבעים

**רציונל:** המסגרת המקצועית המקובלת: ירוק/צהוב/אדום/כחול + חיבור לתחושות גוף ("הלב דופק מהר? הידיים קפוצות?"). ה-check-in הנוכחי (4 פרצופים) קרוב אבל חסרים הצבעים, האזור ה"כחול" (עצוב/עייף/איטי), ותחושות הגוף.

**קבצים:** `index.html` (`feelRowBefore`/`calmAfter`), `app.js` (`calmPickFeeling`, `calmFinish`), `styles.css`.

**מה לבנות:**
1. החלף את 4 הכפתורים ב-5, עם צבע רקע מובהק לכל אחד (`data-zone`):
   - 🟢 `רגוע וטוב` (ירוק, level 1)
   - 🔵 `עצוב או עייף` (כחול-אפור רך, level 5 — **חדש**)
   - 🟡 `לא נעים / דאגה` (צהוב, level 2)
   - 🟠 `עצבני` (כתום, level 3)
   - 🔴 `כועס מאוד` (אדום, level 4)
2. מיפוי כלים לאזור הכחול: `5:'ocean'` (או ההצעה האישית מ-C5), טקסט: `'כשעצובים או עייפים — צליל נעים וחיבוק עוזרים 💙'`.
3. אחרי בחירת רגש, שורת תחושות-גוף אופציונלית (מדלגים בקליק על כלי): `'איפה אתה מרגיש את זה בגוף?'` עם 4 צ'יפים: `💓 הלב דופק מהר · ✊ הידיים קפוצות · 🌀 הבטן מתהפכת · 🗿 הגוף כבד` — הבחירה נשמרת בשדה `body` בלוג (`_calmSession.body`).
4. עדכן את מסך ה"אחרי" לאותם 5 כפתורים.
5. ב-`renderCalmLogStats` וב-report: אם יש `body`, הצג אותו בסטטיסטיקה להורה (טקסט פשוט, לא חובה גרף).

**קבלה:** 5 אזורים צבעוניים בכניסה וביציאה; תחושת גוף נרשמת בלוג; הדוח השבועי לא נשבר על רשומות ישנות בלי `body`.
**בדיקה:** Playwright — בחירת אזור כחול מדגישה את הכלי הנכון; רשומת לוג כוללת `body` כשנבחר.

---

## C9 — "הפינה שלי": התאמה אישית של סל הכלים לכל ילד

**רציונל:** לכל ילד פרופיל חושי שונה; ההורה (או הילד) בוחר אילו כלים מוצגים ובאיזה סדר — כמו calm-corner אמיתי שמרכיבים יחד. גם מוריד עומס בחירה ברגע הצפה (פחות אריחים = פחות הצפה).

**קבצים:** `app.js`, `index.html` (כרטיס באדמין Settings).

**מה לבנות:**
1. state חדש: `cs_calmprefs` — `{[childId]:{tools:['breathe','heavy',...]}}`  (סדר = סדר תצוגה; ריק/חסר = כל הכלים בסדר ברירת המחדל).
2. `openCalmBreak` בונה את `.calm-tiles` דינמית מהרשימה (העבר את האריחים מ-HTML סטטי לרינדור JS — פונקציה `renderCalmTiles()`; שמור על אותם ids `tile-*` כדי לא לשבור את `suggested`).
3. כרטיס באדמין (pane-settings, ליד כרטיס ה-Calm Mode): `'🌿 כלי רגיעה לכל ילד'` — לכל ילד שורת צ'קבוקסים של כל הכלים + חיצים ▲▼ לסידור. מינימום 2 כלים (חסום הסרה מתחת).
4. סנכרון family-wide רגיל (DB.set → scheduleSync, כמו `cs_rewards`).

**קבלה:** ביטול סימון כלי מעלים אותו מהתפריט של אותו ילד בלבד; הסדר נשמר; ילד בלי הגדרות רואה הכל.
**בדיקה:** Playwright — הגדרת prefs לילד אחד, לוודא שהאריח נעלם אצלו ומופיע אצל השני.

---

## C10 — סיפור חברתי קצר בכניסה (אופציונלי, פעם ראשונה בלבד)

**רציונל:** Social stories הן פרקטיקה מבוססת-ראיות באוטיזם: 3 מסכים חד-פעמיים שמסבירים "מה זה המקום הזה" מורידים חרדת-חדש.

**קבצים:** `app.js`, `index.html`.

**מה לבנות:** בפתיחה הראשונה אי-פעם של 🌿 לכל ילד (`cs_calmintro_<childId>` device-local), הצג 3 כרטיסים בזה-אחר-זה (כפתור `הבא ←`):
1. `🌿 זה המקום השקט שלך. אפשר לבוא לכאן מתי שרוצים — זה תמיד בסדר.`
2. `💪 כשמרגישים כעס או עצב בגוף, יש כאן כלים שעוזרים להרגיש טוב יותר.`
3. `🧑‍🤝‍🧑 לבוא לכאן זה סימן של כוח, לא של בעיה. גיבורים יודעים מתי לנוח.`
עם TTS (C7). כפתור `דלג` תמיד זמין.

**קבלה:** מוצג פעם אחת בלבד לכל ילד; לא חוסם את ה-check-in הרגיל.
**בדיקה:** Playwright — פתיחה ראשונה מציגה את הסיפור, פתיחה שנייה מדלגת ישר לתפריט.

---

## C11 — שיפור דוח ההורים: איזה כלי עובד לילד שלי

**רציונל:** הלוג כבר קיים; ההורה צריך תובנה, לא נתונים. סוגר את הלולאה הטיפולית (מה שעובד באפליקציה אפשר לתרגל גם מחוץ לה).

**קבצים:** `app.js` (`renderCalmLogStats` ~2367, והדוח השבועי ~2875).

**מה לבנות:**
1. ב-`renderCalmLogStats`: פירוק לפי ילד ולפי כלי — לכל כלי שהיו לו 2+ סשנים מדורגים: שם + מספר שימושים + `'עזר ב-X% מהפעמים'` (אחוז הרשומות עם after<before). מיין מהיעיל ביותר.
2. שורת מסקנה מודגשת: `'💡 הכלי שהכי עוזר לאריאל: 🦸 כוח-על'` (הכלי עם השיפור הממוצע הגבוה ביותר, מינימום 3 שימושים).
3. אם יש נתוני `body` (C8): `'התחושה הנפוצה לפני: ✊ ידיים קפוצות'`.
4. אל תשבור רשומות ישנות (שדות חסרים).

**קבלה:** הסטטיסטיקה קריאה בעברית פשוטה; אין NaN/undefined על לוג ריק או ישן.
**בדיקה:** Playwright — זריעת לוג מעורב (עם/בלי after, עם/בלי body) ולוודא שהרינדור לא זורק ומציג אחוזים נכונים.

---

## C12 — ליטוש חושי כללי של המודאל

**רציונל:** ההיררכיה הוויזואלית של המודאל צריכה להיות רגועה בעצמה: פחות טקסט במסך אחד, ניגודיות רכה, מעברים איטיים.

**קבצים:** `styles.css` בעיקר.

**מה לבנות:**
1. מעבר בין פאנלים: fade איטי (`opacity .4s ease`) במקום החלפה חדה — class `.calm-fade` על הפאנלים, toggle ב-`calmShowPane`.
2. רקע המודאל: גרדיאנט ירקרק-תכלת רך מאוד במקום לבן (בדוק את הקיים — אם כבר צבוע, דלג).
3. הגדל את שטחי הלחיצה של `feel-btn` ו-`calm-tile` למינימום 64px גובה (מוטוריקה עדינה).
4. `prefers-reduced-motion: reduce` — ודא שכל האנימציות החדשות (C3 pop, C4 נקודה, C12 fade) כבויות תחתיו. הבועות של C3 נשארות לחיצות גם בלי אנימציה.

**קבלה:** מעברים רכים; אין אנימציה תחת reduced-motion; אריחים גדולים.
**בדיקה:** ויזואלית + Playwright קיים ממשיך לעבור.

---

## סדר ביצוע מומלץ ותלויות

| שלב | משימות | הערות |
|-----|--------|-------|
| 1 | C1, C3 | קטנות, אפקט מיידי, ללא תלויות |
| 2 | C2 | הכלי החדש החשוב ביותר |
| 3 | C5 → C8 | C5 קודם (מנוע ההצעות), C8 בונה עליו |
| 4 | C6, C7 | אודיו/קול |
| 5 | C4, C9, C10 | כלים ופרסונליזציה |
| 6 | C11, C12 | דוחות וליטוש |

**כללי ברזל לכל המשימות:**
- לכל כלי חדש: לעדכן `CALM_PANES`, `openCalmActivity`, `stopCalmActivity` (אם יש טיימר/אודיו), `TOOLS`/`CALM_TOOL_NAMES`, ואת מיפוי ההצעות.
- שום כלי רגיעה לא נוגע במטבעות, ב-gtime או בהיסטוריה. הלוג היחיד: `cs_calmlog`.
- כל טקסט לילד: עברית פשוטה, חיובית, בלי שלילה ("שחרר" ולא "אל תכעס").
- אחרי כל משימה: `npx playwright test tests/core-flows.spec.js --reporter=line --workers=1` חייב לעבור (40+ בדיקות), ולהוסיף את הבדיקה החדשה של המשימה ל-`tests/core-flows.spec.js`.
- קומיט נפרד לכל משימה, בפורמט: `C<n>: <תיאור קצר באנגלית>`. push מפעיל deploy אוטומטי.

## מקורות המחקר

- [Autism Research Institute — Meltdowns & Calming Techniques](https://autism.org/meltdowns-calming-techniques-in-autism/)
- [National Autism Resources — 10 Calming Strategies](https://nationalautismresources.com/blog/10-calming-strategies-for-autism-reduce-anxiety-and-meltdowns/)
- [Zones of Regulation framework overview](https://christinedickson.com/the-zones-of-regulation-framework-for-children/)
- [Haptic Box — sensory calm fidget app (NAS directory)](https://www.autism.org.uk/autism-services-directory/haptic-box-%E2%80%94-sensory-calm-digital-fidget-app)
- [Haptic Calm — haptic breathing guide app](https://apps.apple.com/us/app/haptic-calm/id6758531681)
- [Rainbow Therapy — Proprioceptive Activities for Autism](https://rainbowtherapy.org/proprioceptive-activities-for-autism/)
- [Autism Parenting Magazine — Deep Pressure Therapy](https://www.autismparentingmagazine.com/autism-deep-pressure-therapy/)
- [Autism Parenting Magazine — 25 Emotional Regulation Techniques](https://www.autismparentingmagazine.com/help-child-with-emotional-regulation/)
