# 🚀 הוראות פרסום: GitHub + Netlify

## שלב 1: GitHub Repository

### 1.1 יצירת repo

1. עבור ל-[github.com/new](https://github.com/new)
2. **Repository name:** `coin-quest-app` (או שם בחירתך)
3. **Description:** "תגמול ממוגמר לילדים עם QR, משימות, חשבון, ואתגר 30 הימים"
4. **Visibility:** Public (כי זה רק HTML/JS, אין secrets)
5. **Initialize:** בחר **Add a README file** (אם לא יש לך עדיין)
6. לחץ **Create repository**

### 1.2 שיתוף הקבצים

```bash
# בתיקיית הפרויקט
git clone https://github.com/YOUR_USERNAME/coin-quest-app.git
cd coin-quest-app

# העתק את הקבצים
cp coin_quest_app.html .
cp README.md .
cp DEPLOYMENT.md .
cp PROJECT_STATUS.md .

# (optional: .gitignore למקרה שיש temp files)
echo "node_modules/" > .gitignore

# commit
git add .
git commit -m "Initial commit: Coin Quest App v1.0"
git push origin main
```

### 1.3 Verify

- עבור ל-`https://github.com/YOUR_USERNAME/coin-quest-app`
- וודא שכל הקבצים מופיעים

---

## שלב 2: Netlify Deployment

### 2.1 יצירת חשבון Netlify

1. עבור ל-[netlify.com](https://netlify.com)
2. לחץ **Sign up** (או **Log in** אם כבר יש לך)
3. בחר **GitHub** כדי להתחבר דרך GitHub (זה הדרך הקלה)
4. אנא **Authorize Netlify** ל-GitHub account שלך

### 2.2 חיבור ה-repo

1. בעמוד ראשי Netlify, לחץ **Add new site → Import an existing project**
2. בחר **GitHub** (אם לא בחרת)
3. חפש את `coin-quest-app` repo שלך
4. לחץ עליו

### 2.3 הגדרות בנייה

**בעמוד Build settings:**
- **Base directory:** (השאר ריק)
- **Build command:** (השאר ריק — אין build, זה HTML בלבד)
- **Publish directory:** (השאר ריק או הוסף `.` להצביע על root)

לחץ **Deploy site**

### 2.4 Naming your site

1. אחרי ה-deploy, תראה URL כמו: `https://happy-tree-xyz.netlify.app`
2. (optional) לחץ **Site settings → General → Change site name**
3. בחר שם קצר, למשל: `coin-quest-app`
4. הכתובת החדשה תהיה: `https://coin-quest-app.netlify.app`

---

## שלב 3: בדיקה חוצה-דפדפן

### Desktop
- Chrome, Firefox, Safari — תורם ב-http://localhost או https://coin-quest-app.netlify.app
- בדוק את כל המסכים (home, scan, math, rewards, history, streak)
- בדוק admin (PIN: 1234)

### Mobile (iOS / Android)
- **iOS Safari:** שים לב לרוחב ובטחון (HTTPS נדרש למצלמה)
- **Android Chrome:** בדוק את סריקת ה-QR
- בדוק orientation portrait ו-landscape

### Camera & QR
- iOS: תרשה גישה למצלמה
- Android: תרשה הרשאות
- סרוק את ה-QR שיצרת ב-admin

---

## שלב 4: עדכונים בעתיד

### כשמעדכנים את ה-HTML

```bash
cd coin-quest-app
git add coin_quest_app.html
git commit -m "Update: [describe change]"
git push origin main
```

Netlify יגיד automatically כשנדחף ל-main וידחה את ה-site.

### Rollback

אם יש בעיה, עבור ל-Netlify dashboard → **Deploys** → בחר deploy קודם → **Publish deploy**

---

## שלב 5: Optional — Custom Domain

אם יש לך כתובת שלך:

1. Netlify dashboard → **Site settings → Domain management**
2. לחץ **Add custom domain**
3. הזן את ה-domain שלך (למשל: `coinsafe.example.com`)
4. Netlify תתן לך **nameserver records** לשנות
5. עדכן אותם בספק ה-DNS שלך (GoDaddy, Namecheap, וכו')
6. (עשעועד עד 24 שעות עד שזה יעבוד)

---

## שלב 6: بأمان & Monitoring

### Analytics (optional, zero-tracking בחירה)
- Netlify מציע **Analytics** built-in (לא invasive)
- Dashboard → **Analytics** כדי לראות page views

### Logs (debugging)
- Dashboard → **Deploys** → לחץ על deploy → **Deploy summary**
- ראה build logs אם יש בעיות

### Performance
- Netlify ישדרג automatically (CDN global)
- Lighthouse דירוג יהיה גבוה (אין תלויות)

---

## טרבלשוטינג

### "Blank page" אחרי load
- בדוק את browser console (F12 → Console)
- ודא שום JavaScript errors
- בדוק אם localStorage מובנה

### Camera לא עובדת
- **iOS Safari:** כשמתחת לhttp://, מצלמה לא זמינה
- **Android:** בדוק הרשאות בהגדרות
- **Fallback:** צילום/העלאה של תמונה עובדת תמיד

### QR scan לא קורא
- ודא ש-QR מסך נקי (אור טוב)
- נסה את manual entry כ-fallback

### localStorage לא שמור
- בדוק אם browser מחסים cookies/storage מובנה
- בדוק אם אתה בIncognito/Private mode (זה לא עובד בדרך כלל)

---

## קבצי פרסום סופיים

✅ `coin_quest_app.html` — אפליקציה
✅ `README.md` — תיעוד
✅ `DEPLOYMENT.md` — קובץ זה
✅ `PROJECT_STATUS.md` — מצב & notes

---

## הערות חזקות

- **No build step needed** — זה HTML טהור + CDN ספריות
- **No environment variables** — הכל בקובץ אחד
- **No database** — localStorage בלבד
- **No server** — static site, עובד בכל הודח
- **Zero dependencies locally** — רק דפדפן צריך

---

## בדיקה תוך-שנייה

```
1. פתח את הקובץ ב-Chrome: ✅
2. בחר ילד: ✅
3. סימן מטלה: ✅
4. סרוק QR: ✅ (עם fallback עבור לא-Camera)
5. פתור תרגיל: ✅
6. אזור הורים (PIN 1234): ✅
7. הלוח של 30 הימים: ✅
```

כל זה צריך לעבוד בתוך דקה.

---

**Last Updated:** June 2026
**Status:** Production Ready ✅
