# החנות שלי — אתר קניות בעברית

אתר קניות סטטי בעברית (RTL) הכולל ניהול מוצרים, עגלת קניות, ותשלום דרך Tranzila ו-PayPal.

---

## מבנה הקבצים

```
├── index.html          ← דף הבית + רשת מוצרים
├── cart.html           ← עגלת קניות + תשלום
├── admin.html          ← פאנל ניהול מוצרים (מוגן בהתחברות)
├── success.html        ← דף הצלחה לאחר תשלום
├── fail.html           ← דף שגיאה לאחר תשלום
├── css/style.css       ← כל עיצוב האתר
├── js/
│   ├── firebase-config.js  ← פרטי חיבור Firebase (ממלאים בשלב 1)
│   ├── app.js              ← טעינת מוצרים, עגלה, חיפוש
│   ├── cart.js             ← לוגיקת עגלה + תשלום
│   └── admin.js            ← הוספה / עריכה / מחיקת מוצרים
├── firestore.rules     ← חוקי אבטחה ל-Firestore (מעלים ב-Firebase)
└── _headers            ← כותרות אבטחה עבור Netlify
```

---

## שלב 1 — הגדרת Firebase

1. כנס ל-[Firebase Console](https://console.firebase.google.com/) וצור פרויקט חדש.
2. בפרויקט: **Build → Firestore Database** → צור מסד נתונים (Production mode).
3. בפרויקט: **Build → Authentication → Sign-in method** → הפעל **Email/Password**.
4. ב-Authentication → **Users** → הוסף משתמש עם כתובת מייל וסיסמה (זה חשבון הניהול שלך).
5. **Project Settings → Your apps → Add app (Web)** → העתק את ה-`firebaseConfig`.
6. פתח את `js/firebase-config.js` והחלף את ערכי ה-placeholder בערכים האמיתיים.

### הגדרת חוקי Firestore

1. ב-Firebase Console → **Firestore → Rules**
2. העתק את תוכן הקובץ `firestore.rules` ולחץ **Publish**.

---

## שלב 2 — הגדרת Tranzila

1. פתח חשבון ב-[Tranzila](https://www.tranzila.com/).
2. קבל את **מזהה הטרמינל** שלך.
3. פתח `js/cart.js` ועדכן:
   ```js
   const TRANZILA_TERMINAL = 'YOUR_TRANZILA_TERMINAL_ID';
   ```

---

## שלב 3 — הגדרת PayPal (אופציונלי)

1. היכנס ל-[PayPal Developer](https://developer.paypal.com/).
2. צור אפליקציה וקבל **Client ID** (Live).
3. פתח `js/cart.js` ועדכן:
   ```js
   const PAYPAL_CLIENT_ID = 'YOUR_PAYPAL_CLIENT_ID';
   ```

---

## שלב 4 — פרסום האתר

### Netlify (מומלץ)
1. העלה את כל הקבצים ל-GitHub Repository חדש.
2. כנס ל-[netlify.com](https://www.netlify.com/) → **Add new site → Import from Git**.
3. בחר את ה-Repository וכנס **Deploy site**.
4. הקובץ `_headers` יחיל אוטומטית את כותרות האבטחה.

### GitHub Pages
1. העלה ל-Repository ב-GitHub.
2. Settings → Pages → Branch: main → Save.
3. **שים לב:** GitHub Pages לא תומך בקובץ `_headers`. הוסף כותרות ידנית ב-Firebase Hosting אם תרצה.

### Vercel
1. העלה ל-GitHub ואז חבר ב-[vercel.com](https://vercel.com/).
2. הוסף קובץ `vercel.json` להגדרת הכותרות (ראה תיעוד Vercel).

---

## הוספת תמונות למוצרים

האתר משתמש בקישורי URL לתמונות. כדי לארח תמונות בחינם:
- [imgBB](https://imgbb.com/) — העלה תמונה, קבל קישור ישיר, הדבק בשדה התמונה בפאנל הניהול.
- [Cloudinary](https://cloudinary.com/) — 25GB בחינם, אפשרויות עריכה מתקדמות.

---

## אבטחה

| נושא | פתרון |
|------|--------|
| גישה לניהול | Firebase Auth (אימייל + סיסמה) |
| כתיבה ל-Firestore | רק משתמשים מחוברים (חוקי Firestore) |
| אימות נתונים | Server-side validation ב-Firestore Rules |
| XSS | כל הנתונים מוצגים דרך `textContent` (לא innerHTML) |
| Clickjacking | X-Frame-Options: DENY |
| HTTPS | אוטומטי ב-Netlify / Vercel / GitHub Pages |
| פרטי כרטיס אשראי | לא עוברים דרך האתר — Tranzila/PayPal מטפלים ישירות |
| CSP | Content-Security-Policy מוגדר ב-`_headers` |
