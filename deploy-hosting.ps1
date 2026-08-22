# Deploy the web app to Firebase Hosting (coin-quest-app.web.app).
# Run after every change to index.html/privacy.html/terms.html:
#   powershell -File deploy-hosting.ps1
# GitHub Pages (hershkom.github.io) still auto-deploys via GitHub Actions,
# but the canonical URL — the one the Android app and mobile sign-in use —
# is the Firebase Hosting one, and it only updates when this script runs.
$env:Path += ';C:\Program Files\nodejs;C:\Users\mikeh\AppData\Roaming\npm'
Set-Location $PSScriptRoot

# Allow-list guard FIRST. hosting.public is "." so every stray folder in this
# directory is website content unless excluded -- this refuses to upload
# anything not in hosting-allowlist.json (or any executable), before a single
# byte leaves the machine. See scripts/check-hosting-upload.js.
node scripts/check-hosting-upload.js
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

firebase.cmd deploy --only hosting
exit $LASTEXITCODE
