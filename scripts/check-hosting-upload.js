#!/usr/bin/env node
/* Pre-deploy guard for Firebase Hosting projects whose `public` is the repo
 * root ("."). With that setup EVERY file in the folder is uploaded to the
 * public website unless an ignore pattern catches it -- which is reactive:
 * each new sibling folder, stray PDF, or Python venv has to be noticed and
 * excluded by hand, and the first sign of failure is either a leak or a
 * rejected deploy ("Executable files are forbidden on the Spark plan").
 *
 * This flips the model to an ALLOW-LIST. It simulates the upload using the
 * same ignore globs firebase.json declares, then fails -- BEFORE anything is
 * sent -- if the would-be upload contains:
 *   1. a top-level entry not listed in hosting-allowlist.json, or
 *   2. any file with an executable/installer extension.
 *
 * Generic on purpose: copy this file + a hosting-allowlist.json into any
 * project and call it from its deploy script. No dependencies.
 *
 * Usage:  node scripts/check-hosting-upload.js          (exit 1 on violation)
 *         node scripts/check-hosting-upload.js --list   (also print every file)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const listMode = process.argv.includes('--list');

function readJson(name) {
  const p = path.join(root, name);
  if (!fs.existsSync(p)) { console.error(`[hosting-guard] missing ${name}`); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
const firebaseJson = readJson('firebase.json');
const hosting = firebaseJson.hosting;
if (!hosting) { console.log('[hosting-guard] no hosting section -- nothing to check'); process.exit(0); }
const publicDir = path.resolve(root, hosting.public || '.');
const ignorePatterns = hosting.ignore || [];
const allow = new Set(readJson('hosting-allowlist.json'));

// Extensions Firebase's Spark plan rejects outright, plus a few that should
// never be on a public website regardless of plan.
const FORBIDDEN_EXT = /\.(exe|dll|so|dylib|bat|cmd|sh|msi|pyd|bin|com|ps1|jar|apk|aab|pkg|deb|rpm|app|jks|keystore|pem|key)$/i;

// Minimal glob -> RegExp, matching Firebase/minimatch semantics closely enough
// for the patterns people actually write: `**/`, `**`, `*`, `?`, and a `/`-less
// pattern anchoring at the top level (no implicit matchBase).
function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; }
        else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('.+^$(){}|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
const ignoreRes = ignorePatterns.map(globToRe);
const isIgnored = rel => ignoreRes.some(re => re.test(rel));

const uploads = [];
function walk(dirAbs, relPrefix) {
  for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const rel = relPrefix ? relPrefix + '/' + ent.name : ent.name;
    if (ent.name === '.git') continue;
    if (ent.isDirectory()) {
      // Prune whole subtrees the ignore list already excludes (node_modules,
      // android-app, .venv...) -- probe with a synthetic child path.
      if (isIgnored(rel + '/__probe__') || isIgnored(rel)) continue;
      walk(path.join(dirAbs, ent.name), rel);
    } else if (!isIgnored(rel)) {
      uploads.push(rel);
    }
  }
}
walk(publicDir, '');

const violations = [];
const unexpectedTop = new Map();
for (const rel of uploads) {
  const top = rel.split('/')[0];
  if (!allow.has(top)) unexpectedTop.set(top, (unexpectedTop.get(top) || 0) + 1);
  if (FORBIDDEN_EXT.test(rel)) violations.push(`executable/secret file would be uploaded: ${rel}`);
}
for (const [top, n] of unexpectedTop) {
  violations.push(`top-level entry "${top}" (${n} file${n === 1 ? '' : 's'}) is not in hosting-allowlist.json -- either add it to firebase.json "ignore" (if it is NOT part of the website) or to hosting-allowlist.json (if it IS)`);
}

if (listMode) { console.log(uploads.join('\n')); console.log(''); }
console.log(`[hosting-guard] ${uploads.length} files would be uploaded from ${path.relative(root, publicDir) || '.'}`);
if (violations.length) {
  console.error('\n[hosting-guard] DEPLOY BLOCKED:');
  for (const v of violations) console.error('  - ' + v);
  console.error('\nNothing was uploaded. Fix the items above and deploy again.');
  process.exit(1);
}
console.log('[hosting-guard] OK -- only allow-listed content, no executables.');
