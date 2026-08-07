# MONETIZATION-PLAN — הכנת "כספת המטבעות" למכירה ב-Google Play

מסמך משימות מדורג ובטוח, בנוי לביצוע משימה-משימה ע"י מודל Sonnet.
כל משימה: מטרה → קבצים מדויקים → מה בדיוק לבנות (כולל שלדי קוד ומחרוזות עברית) → קריטריוני קבלה → בדיקה.

## עקרון-העל: אסור לשבור את המשפחה הקיימת

האפליקציה משרתת היום משפחה אמיתית בייצור. לכן:

1. **דגל-אב:** כל לוגיקת התשלום חיה מאחורי `MONETIZATION_ENABLED` (קבוע ב-app.js, ברירת מחדל `false`). כל עוד הוא כבוי — האפליקציה מתנהגת בדיוק כמו היום, כולל בדיקות. מדליקים אותו רק בסוף, אחרי שהכול עובד.
2. **סבא-וסבתא (grandfathering):** משפחה שקיימת לפני הפעלת המונטיזציה מקבלת `entitlement.plan='legacy'` שנחשב premium לתמיד. המשפחה שלך לעולם לא תראה paywall.
3. **כל משימה מסתיימת ב:** `npx playwright test tests/core-flows.spec.js --reporter=line --workers=1` ירוק (80+ בדיקות) + בדיקות חדשות למשימה + קומיט נפרד בפורמט `M<שלב>.<מס'>: <תיאור>`. push מפעיל deploy אוטומטי — וזה בטוח כי הדגל כבוי.
4. **שום סוד לא נכנס לריפו:** מפתחות שירות של Google, מפתח Groq — רק ב-Secret Manager / קובצי env מקומיים שכבר ב-.gitignore.

## החלטות מוצר (מומשות בתוכנית; ההורה יכול לשנות מספרים בקלות)

| דבר | החלטה |
|-----|--------|
| מה חינם (דמו) | ילד אחד · עד 4 מטלות · סורק QR · תרגילי חשבון · **כלי הרגיעה במלואם** (עניין אתי — כלי ויסות לילד לא נועל מאחורי תשלום) |
| מה בתשלום | ילדים מרובים · מטלות ללא הגבלה · משחקים וזמן-מסך · מכרה הידע · רצפים ותגים · אירועים · דוחות · עוזר AI |
| ניסיון | 7 ימים premium מלא מרגע יצירת משפחה, בלי כרטיס אשראי (trial צד-אפליקציה, לא של Play) |
| מוצרים | `premium_monthly` (מנוי מתחדש) · `premium_lifetime` (רכישה חד-פעמית) |
| קופונים | דרך מנגנון ה-promo codes של Play (חד-פעמיים או קוד מותאם למנוי) — לא מנגנון קופונים עצמאי |
| אכיפה נטיבית בגרסת Play | **לא נכללת** (AccessibilityService לאכיפה = דחייה כמעט ודאית). גרסת Play מוכרת: משחקי-web עם טיימר אכוף, כלכלת מטבעות, AI, רגיעה. גרסת family נשארת לשימוש הפרטי עם האכיפה המלאה. אין לנסות לעקוף את המדיניות. |

---

## שלב M0 — פעולות של ההורה (לא של המודל) — תנאים מקדימים

אלה דברים שרק מייק יכול לעשות; המודל רק מזכיר לו ועוצר עד שבוצעו:

- **M0.1** חשבון Google Play Console (אגרה חד-פעמית 25$) אם עוד אין.
- **M0.2** שדרוג פרויקט Firebase ל-**Blaze** (חיוב לפי שימוש; נשאר ~0$ בהיקפים קטנים). חובה בשביל Cloud Functions.
- **M0.3** ב-Play Console: יצירת שני מוצרים — מנוי `premium_monthly` (עם base plan חודשי) ומוצר חד-פעמי `premium_lifetime`, ותמחור. לרשום את המזהים המדויקים.
- **M0.4** חיבור Play Console ↔ Google Cloud project (Setup → API access) + יצירת Service Account עם הרשאת `androidpublisher` לאימות רכישות.
- **M0.5** רישום כ-license tester (החשבון של מייק) לבדיקות רכישה בלי כסף אמיתי.

---

## שלב M1 — מודל זכאות בצד הלקוח (עובד עוד לפני שקיים Billing)

### M1.1 — מבנה הזכאות + קריאה

**קבצים:** `app.js`.

```js
const MONETIZATION_ENABLED=false; // דגל-האב — נשאר false עד M6.4
const TRIAL_DAYS=7;
// entitlement חי ב-RTDB תחת families/$id/entitlement ונכתב ע"י השרת בלבד (ראה M2.4).
// shape: {plan:'legacy'|'trial'|'premium'|'lifetime'|'free', expiresAt:<ms|null>, source:'grandfather'|'play'|'promo'|'trial'}
```

1. ב-`loadState()`: לקרוא `state.entitlement=(await DB.get('cs_entitlement'))??null;` (מפתח מסונכרן — להוסיף `cs_entitlement:'entitlement'` ל-`SYNC_SECTIONS` ולכלול ב-`buildSyncPayload` **בקריאה בלבד**: הלקוח לעולם לא דוחף entitlement, ראה M2.4 — לכן דווקא *לא* להוסיף ל-payload, רק לאמץ ב-`applyRemoteSnapshot`).
2. פונקציות:
```js
function entitlementPlan(){
  if(!MONETIZATION_ENABLED) return 'legacy';
  const e=state.entitlement;
  if(!e) return trialActive()?'trial':'free';
  if(e.expiresAt&&Date.now()>e.expiresAt) return trialActive()?'trial':'free';
  return e.plan;
}
function isPremium(){ return ['legacy','trial','premium','lifetime'].includes(entitlementPlan()); }
function trialActive(){
  const t=state.trialStartedAt; // נקבע ביצירת משפחה (M1.2)
  return !!t && (Date.now()-t) < TRIAL_DAYS*86400000;
}
function trialDaysLeft(){ const t=state.trialStartedAt; if(!t) return 0; return Math.max(0,Math.ceil((t+TRIAL_DAYS*86400000-Date.now())/86400000)); }
```
3. **Grandfathering:** ב-`loadState`, אם `MONETIZATION_ENABLED` והמשפחה קיימת (יש `cs_children`) ואין `cs_entitlement` ואין `cs_trial_started` — לכתוב מקומית `{plan:'legacy',source:'grandfather'}` ל-`cs_entitlement`. (השרת יאשרר בהמשך; מקומית זה מספיק כדי לא לחסום אף אחד ביום ההדלקה.)

**קבלה:** עם הדגל כבוי — `isPremium()===true` תמיד וכל 80+ הבדיקות עוברות ללא שינוי.
**בדיקה:** Playwright — override של הדגל ב-page.evaluate (`window.__forceMonetization=true` — להוסיף hook קטן: `const MON_ON=()=>MONETIZATION_ENABLED||window.__forceMonetization;` ולהשתמש בו במקום הקבוע ישירות) ואימות שלוש מצבים: free / trial פעיל / legacy.

### M1.2 — תחילת trial ביצירת משפחה

**קבצים:** `app.js` (`createNewFamily`, `finishWizard`).
`state.trialStartedAt=Date.now(); await DB.set('cs_trial_started',state.trialStartedAt);` + סנכרון (סקשן חדש `trialStartedAt`). **חשוב:** להשתמש ב-hwm-style הגנה — אם קיים ערך מרוחק, לא לדרוס אותו (מכשיר שני שמצטרף לא מאפס את הניסיון).

### M1.3 — מפת שערי פיצ'רים (feature gates)

**קבצים:** `app.js`, `index.html`.

פונקציה אחת מרכזית — לא תנאים מפוזרים:
```js
const PREMIUM_FEATURES={
  multiChild:   ()=>state.children.length>=1,        // הוספת ילד שני
  chores5plus:  ()=>state.chores.length>=4,          // מטלה חמישית ומעלה
  games:        ()=>true, learning:()=>true, streaks:()=>true,
  badges:()=>true, events:()=>true, reports:()=>true, aiChat:()=>true,
};
function featureAllowed(key){ return isPremium() || !(key in PREMIUM_FEATURES); }
function gate(key){ if(featureAllowed(key)) return true; showPaywall(key); return false; }
```
נקודות חיבור (לפי הדפוס הקיים באפליקציה — **לעולם לא `disabled`, תמיד לחיץ-ומסביר**):
- `addChild()` — בתחילתה: `if(state.children.length>=1&&!gate('multiChild')) return;`
- `addChore()` — `if(state.chores.length>=4&&!gate('chores5plus')) return;`
- `go('games')`, `go('learn')`, `beginGameLaunch`, `openStreakView`, לשונית אירועים/דוח/תגים באדמין, `sendChatMessage` — שער בכניסה.
- כרטיסי בית (משחקים/מכרה) לא מוסתרים אלא מקבלים תג 🔒 קטן — עקביות עם עקרון ה"מוסבר, לא נעלם".

**קבלה:** במצב free — כל נגיעה בפיצ'ר נעול פותחת paywall אחד עקבי; במצב premium/legacy — אפס שינוי.
**בדיקה:** Playwright לכל שער (עם `__forceMonetization`).

### M1.4 — מסך paywall + באנר trial

**קבצים:** `index.html` (מודאל/מסך), `app.js` (`showPaywall`), `styles.css`.

- `showPaywall(featureKey)` — מודאל בעברית רכה: מה הפיצ'ר, מה כלול ב-premium, שני כפתורים: `⭐ מנוי חודשי` / `♾️ רכישה לתמיד` (מחירים נטענים מה-Billing ב-M3; עד אז placeholder "—"), קישור "יש לי קוד" (מוביל למימוש קוד של Play, M3.4), וכפתור סגירה. בלי לחץ, בלי דפוסי-אופל: אין טיימר מלחיץ, אין "רק היום".
- באנר trial במסך ההורה בלבד (לא אצל הילד!): "נשארו X ימי ניסיון" — הילד לא צריך לראות שיווק. גם ה-paywall מוצג רק בפעולות של מסכי הורה/מעברים, ואם ילד נתקל בו — נוסח ניטרלי "אמא או אבא צריכים לפתוח את זה" + כפתור שמפעיל את `modalPin`.

**קבלה:** paywall נגיש, סוגר, לא מופיע כשהדגל כבוי; אצל ילד מופיע הנוסח הניטרלי.

---

## שלב M2 — צד שרת (Cloud Functions, אחרי M0.2)

תיקייה חדשה `functions/` (Node 20, firebase-functions v2). **המודל יוצר את הקוד; ההורה מריץ `firebase deploy --only functions` ידנית** (ה-pre-push hook פורס hosting בלבד — לא לשנות אותו).

### M2.1 — שלד + סודות
`firebase init functions` ידני ע"י ההורה, ואז המודל כותב: `functions/index.js`, `functions/package.json`. סודות ב-`firebase functions:secrets:set` — `GROQ_API_KEY`, ו-service-account לאימות רכישות (או ADC).

### M2.2 — `verifyPurchase` (callable)
קלט: `{purchaseToken, productId, type:'subs'|'inapp'}` + auth של Firebase (חובה). התהליך:
1. אימות מול Google Play Developer API (`purchases.subscriptionsv2.get` / `purchases.products.get`).
2. אם תקף — כתיבה ל-`families/$familyId/entitlement` (ה-familyId נלקח מ-`users/{uid}/familyId`, לא מהקלט!): מנוי → `{plan:'premium',expiresAt:<expiryTimeMillis>,source:'play'}`; חד-פעמי → `{plan:'lifetime',expiresAt:null,source:'play'}`.
3. Acknowledge לרכישה אם טרם בוצע (חובת Play תוך 3 ימים, אחרת החזר אוטומטי).
4. רישום ב-`purchaseLog` (טוקן→familyId) למניעת שימוש באותו טוקן בשתי משפחות.

### M2.3 — RTDN (התראות בזמן-אמת מ-Play)
Pub/Sub topic ב-Play Console → function שמאזין ומעדכן entitlement על חידוש/ביטול/החזר. בלי זה מנוי מבוטל ממשיך לקבל premium עד שיפתח את האפליקציה אחרי ה-expiry.

### M2.4 — הקשחת rules
ב-`database.rules.json`, תחת `families/$familyId` להוסיף חריג:
```json
"entitlement": { ".write": false }
```
(כתיבת Admin SDK עוקפת rules — רק השרת יכול). וכן `purchaseLog` ברמת השורש: קריאה/כתיבה false.
**קבלה:** ניסיון כתיבת entitlement מהלקוח נכשל ב-permission denied; הפריסה של rules ידנית ע"י ההורה.

### M2.5 — פרוקסי Groq
Function `chat` שמקבל `{messages}` (עם אימות Firebase + בדיקת entitlement בצד השרת!), קורא ל-Groq עם המפתח הסודי, ומחזיר את התשובה. ב-`app.js` — `sendChatMessage` עובר לקרוא ל-function כשהדגל דולק (fallback למפתח מקומי כשהדגל כבוי, לתאימות המשפחה הקיימת). שכבת הבטיחות (crisis/blocked/PII) **נשארת בלקוח** — היא חייבת לעבוד גם offline — אבל נוספת גם בשרת כהגנת עומק.

---

## שלב M3 — אינטגרציית Play Billing (Kotlin)

**דרישה: Billing Library 8+** (כל הגשה חדשה מחויבת בה מ-31.8.2026).

### M3.1 — BillingManager
`android-app/app/build.gradle`: `implementation 'com.android.billingclient:billing-ktx:8.0.0'` (בגרסת play בלבד אם אפשר — `playImplementation`).
קובץ חדש `BillingManager.kt`: התחברות, `queryProductDetailsAsync` לשני המוצרים, `launchBillingFlow`, מאזין רכישות, `queryPurchasesAsync` בכל עלייה (שחזור רכישות).

### M3.2 — גשר ל-JS
ב-`NativeGameBridge.kt`: `billingAvailable()`, `getProducts()` (JSON עם מחירים מקומיים), `startPurchase(productId)`, callbacks `_onPurchaseComplete(token,productId,type)` / `_onPurchaseFailed(msg)`.
ב-`app.js`: על `_onPurchaseComplete` → קריאה ל-`verifyPurchase` (M2.2) → עם החזרה תקינה ה-entitlement כבר נכתב ב-RTDB ויגיע בסנכרון החי → `toast('⭐ premium פעיל!')`.

### M3.3 — שחזור רכישות
בעלייה של האפליקציה בגרסת play: אם `queryPurchasesAsync` מחזיר רכישה שלא נרשמה — לשלוח ל-verifyPurchase. מכסה החלפת מכשיר.

### M3.4 — קופונים (promo codes)
אין מנגנון עצמאי — כפתור "יש לי קוד" ב-paywall פותח את דף המימוש של Play (`https://play.google.com/redeem?code=`) או את ה-In-App Promotions flow. הרכישה שנוצרת מהקוד מגיעה דרך אותו מסלול אימות בדיוק. את הקודים עצמם ההורה מנפיק ב-Play Console → Promotions (חד-פעמיים, או קוד מותאם למנוי עד תקרה).

**קבלה (M3 כולו):** רכישת בדיקה כ-license tester → entitlement נכתב → פיצ'רים נפתחים בכל מכשירי המשפחה; ביטול מנוי בבדיקות → RTDN מוריד ל-free בתום התקופה.

---

## שלב M4 — התאמת גרסת Play למכירה

- **M4.1** ב-flavor play: לוודא שכל נתיבי הקוד הנטיבי-אכיפתי נעלמים נקי (כבר קיים), ושמשחקי-web עם הטיימר האכוף עובדים מצוין — הם הצעת הערך של גרסת החנות. לעדכן את טקסטי המסכים שמזכירים "אפליקציה אמיתית באנדרואיד" כך שלא יופיעו בגרסת play.
- **M4.2** PIN: בגרסה מסחרית אין ברירת מחדל 1234 — האשף כבר כופה בחירת קוד; לוודא שאין מסלול שמשאיר 1234 (למשל local-only). לחסום כניסת אדמין עם '1234' כשהדגל דולק עד שהוגדר קוד.
- **M4.3** פרטיות ו-Data Safety: לעדכן `privacy.html` (מה נאסף: חשבון Google, נתוני משפחה ב-RTDB, רכישות; מה לא: אין פרסומות, אין מכירת מידע), ולהכין טיוטת תשובות לטופס Data Safety ב-Play Console כקובץ `PLAY-DATA-SAFETY.md`.
- **M4.4** Families Policy: היעד "הורים" (ההורה מתקין ומגדיר) אבל ילדים משתמשים — נדרש להצהיר בהתאם ולוודא: אין פרסומות, אין קישורים החוצה נגישים לילד (יוטיוב נפתח כאפליקציה נפרדת — תקין), ה-AI chat מאחורי הפעלת הורה (קיים).

---

## שלב M5 — בדיקות ו-QA

- **M5.1** בדיקות Playwright לכל שערי M1 (free/trial/premium/legacy) — לפחות 8 בדיקות.
- **M5.2** אמולציית גשר Billing ב-Playwright (mock `window.CoinQuestNative.startPurchase` → `_onPurchaseComplete`) לבדיקת ה-flow המלא בלי חנות.
- **M5.3** בדיקה ידנית ב-Internal Testing track עם license tester: רכישה, ביטול, שחזור מכשיר, מימוש קוד. רשימת צעדים כ-`PLAY-QA-CHECKLIST.md`.

## שלב M6 — השקה

- **M6.1** בניית AAB של flavor play (`bundlePlayRelease`), העלאה ל-Internal → Closed → Production בהדרגה.
- **M6.2** גרסת family נשארת ללא מונטיזציה לתמיד (הדגל כבוי בה תמיד — אפשר לקבוע `MONETIZATION_ENABLED=BuildConfig`-style לפי flavor דרך משתנה ב-index.html שה-wrapper מזריק, או פשוט תנאי על `isNativeGameAvailable()`... **לא** — הפשוט והבטוח: לקבוע לפי `applicationId` שמדווח דרך הגשר; בגרסת family תמיד legacy).
- **M6.3** ניטור: לוג רכישות ב-Functions, התראת מייל על כשלי verifyPurchase.
- **M6.4** הדלקת `MONETIZATION_ENABLED=true` — הקומיט האחרון, אחרי שהכול ירוק.

---

## תשובות לארבע השאלות המקוריות — איפה בתוכנית

1. **ריבוי משתמשים בחינם** — עד ~מאות משפחות על Spark; שדרוג Blaze (M0.2) נדרש ממילא ל-Functions, והעלות בהיקפים קטנים ~0$. אין פעולה בתוכנית שמייקרת קריאות/כתיבות מעבר לקיים.
2. **מנוי + רכישה חד-פעמית** — M0.3 (הגדרה בקונסול) + M3 (אינטגרציה).
3. **קופון חינם** — M3.4, דרך promo codes של Play.
4. **שבוע ניסיון + דמו מנוון** — M1.2 (trial) + M1.3 (שערים) + M1.4 (paywall).

## כללי ברזל למודל המבצע

- אף פעם לא לשנות התנהגות כשהדגל כבוי. כל בדיקת gating נעשית עם `__forceMonetization`.
- אף פעם לא לדחוף entitlement מהלקוח ל-RTDB.
- ה-paywall לעולם לא מוצג לילד עם שפת מכירה — רק להורה.
- כלי הרגיעה נשארים חינם בכל תרחיש.
- כל קומיט: הבדיקות המלאות ירוקות. סודות — לעולם לא בריפו.
- דברים שרק ההורה יכול (קונסול, Blaze, deploy functions/rules, מוצרים, קודים) — לעצור ולבקש, לא לנסות לעקוף.
