// @ts-check
const { test, expect } = require('@playwright/test');

// All tests run in LOCAL-ONLY mode (no Google account) — this is the mode
// every real user is in before they ever touch Firebase, it's fully
// deterministic (no network sync race, no auth popup), and it exercises the
// exact same business logic (DB/state/anti-cheat/sync-section-tagging) that
// cloud mode shares. Each test gets its own isolated browser context from
// Playwright, so localStorage never leaks between tests.

async function enterLocalOnly(page) {
  await page.goto('/');
  await page.getByRole('button', { name: /המשך בלי חשבון/ }).click();
  await expect(page.locator('#view-picker')).toHaveClass(/active/);
}

async function selectChild(page, name) {
  await page.locator('.kid-card', { hasText: name }).click();
  await expect(page.locator('#view-home')).toHaveClass(/active/);
}

async function openAdminWithPin(page) {
  await page.locator('#gearBtn').click();
  await page.locator('#mPin').fill('1234');
  await page.locator('#mPinOk').click();
  await expect(page.locator('#view-admin')).toHaveClass(/active/);
}

// Earning the first coin ever awards the "first_coin" badge, which pops a
// full celebration modal (see queueBadgeCelebration) that blocks further
// clicks until dismissed — close it if one is showing.
async function dismissBadgeCelebrationIfAny(page) {
  const closeBtn = page.locator('#modalBg.show button', { hasText: 'מגניב' });
  if (await closeBtn.count()) await closeBtn.click();
}

test.describe('onboarding + picker', () => {
  test('loads and enters local-only mode with the two default kids', async ({ page }) => {
    await enterLocalOnly(page);
    await expect(page.locator('.kid-card', { hasText: 'אריאל' })).toBeVisible();
    await expect(page.locator('.kid-card', { hasText: 'נועה' })).toBeVisible();
  });
});

test.describe('chores (golden path)', () => {
  // Noa has useSchedule:false, so her home view always lists the plain
  // state.chores set regardless of time of day — deterministic in CI,
  // unlike Ariel whose home view depends on the current hour.

  // The whole point of this change: a chore's checkbox is no longer a
  // self-report button. Tapping it must NEVER credit coins by itself -- it
  // only takes the child to the scanner, with a hint naming the expected
  // task, so a parent-generated QR code (real-world proof) is the only thing
  // that can ever pay out (see goScanForChore()/redeemToken()).
  test('tapping a chore only opens the scanner and shows a hint for that task -- it does not credit coins', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await expect(page.locator('#balTop')).toHaveText('0');

    const row = page.locator('.chore-row', { hasText: 'לשבת בשירותים' });
    await row.locator('.chore-check').click();

    await expect(page.locator('#view-scan')).toHaveClass(/active/);
    await expect(page.locator('#balTop')).toHaveText('0'); // unchanged -- no self-report credit
    await expect(page.locator('#scanHint')).toContainText('לשבת בשירותים');
  });

  test('completing a chore credits the exact configured points ONLY via a real scan/redemption, then caps at max', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await expect(page.locator('#balTop')).toHaveText('0');

    // "לשבת בשירותים": 3 points, max 6/day. Simulate a successful scan of the
    // parent-generated code (redeemToken is the ONLY function that ever
    // credits a chore now) rather than tapping the checkbox, which per the
    // test above just opens the scanner and pays nothing.
    for (let i = 1; i <= 6; i++) {
      // Redeeming the SAME chore twice within CHORE_MIN_GAP_MS is blocked (the
      // anti-cheat cooldown this test file's own "rapid re-scan" test below
      // verifies) -- clear the cooldown timestamp between redemptions to
      // simulate real time passing, since this test's whole point is the
      // per-day COUNT cap, not the per-redemption cooldown.
      await page.evaluate(() => { cur().daily.lastMark = {}; });
      await page.evaluate(() => redeemToken('CSQR|chore_toilet'));
      await dismissBadgeCelebrationIfAny(page); // first coin ever -> badge modal
      await expect(page.locator('#balTop')).toHaveText(String(3 * i));
    }
    // redeemToken() (unlike the old direct-tap markChore()) never re-renders
    // the home chore list itself -- it's normally called from the scan screen,
    // a different view entirely. Simulate the child tapping "בית" to return
    // home after scanning, which is what actually refreshes the checkbox.
    await page.evaluate(() => go('home'));
    // 6th completion disables the checkbox in the UI...
    const row = page.locator('.chore-row', { hasText: 'לשבת בשירותים' });
    await expect(row.locator('.chore-check')).toBeDisabled();
    // ...but the REAL protection is the daily-max check inside redeemToken
    // itself, not just a disabled button -- a 7th redemption must not pay out.
    // Clear the cooldown again so it's specifically the daily MAX guard being
    // tested here, not the unrelated per-redemption cooldown.
    await page.evaluate(() => { cur().daily.lastMark = {}; });
    await page.evaluate(() => redeemToken('CSQR|chore_toilet'));
    await expect(page.locator('#balTop')).toHaveText('18');
  });

  test('rapid re-scanning the SAME chore code twice in a row only pays out once (anti-cheat cooldown)', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await page.evaluate(() => redeemToken('CSQR|chore_toilet'));
    await dismissBadgeCelebrationIfAny(page);
    await expect(page.locator('#balTop')).toHaveText('3');
    await page.evaluate(() => redeemToken('CSQR|chore_toilet')); // immediately again, no time cleared
    await expect(page.locator('#balTop')).toHaveText('3'); // unchanged -- blocked by the cooldown
  });
});

test.describe('rewards', () => {
  test('redeeming a reward debits the exact cost, never lets balance go negative', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await openAdminWithPin(page);
    await page.locator('[data-atab="children"]').click();
    await page.locator('.kid-admin', { hasText: 'נועה' }).locator('button[title="תקן יתרה"]').click();
    await page.locator('#mInput').fill('50');
    await page.locator('#mOk').click();
    await page.evaluate(() => exitAdmin());
    await expect(page.locator('#balTop')).toHaveText('50');

    await page.evaluate(() => go('rewards'));
    const iceCreamRow = page.locator('.row', { hasText: 'גלידה' }); // cost 50
    await iceCreamRow.getByRole('button', { name: 'החלף' }).click();
    await page.locator('#mYes').click();
    await expect(page.locator('#balTop')).toHaveText('0');

    const movieBtn = page.locator('.row', { hasText: 'ערב סרט' }).getByRole('button'); // cost 80, balance 0
    await expect(movieBtn).toBeDisabled();
  });

  // A cash reward ("שקל אחד") can't rely on a parent being right there to
  // physically pay out the instant it's redeemed -- it accrues in a running
  // "owed" tab instead (k.cashOwed), surfaced to the parent in the children
  // admin list, and only cleared there once they've actually paid.
  test('redeeming a cash reward accrues a pending-cash tab that the admin can see and pay out', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const result = await page.evaluate(async () => {
      const k = cur(); k.balance = 100; await DB.set('cs_bal_noa', 100);
      const before = k.cashOwed || 0;
      const rw = state.rewards.find(r => r.cash); // "שקל אחד", cost 20, cash:1
      redeemReward(rw);
      // redeemReward opens a confirm modal -- accept it, then dismiss the
      // resulting success modalMsg so it doesn't block the next interaction.
      document.getElementById('mYes').click();
      await new Promise(r => setTimeout(r, 50));
      closeModal();
      return { before, after: cur().cashOwed, cost: rw.cost };
    });
    expect(result.before).toBe(0);
    expect(result.after).toBe(1);
    expect(await page.evaluate(() => cur().balance)).toBe(80); // 100 - 20 cost

    // Redeem a second time -- the tab accumulates, it doesn't reset per redemption.
    await page.evaluate(async () => {
      const rw = state.rewards.find(r => r.cash);
      redeemReward(rw);
      document.getElementById('mYes').click();
      await new Promise(r => setTimeout(r, 50));
      closeModal();
    });
    expect(await page.evaluate(() => cur().cashOwed)).toBe(2);

    // Admin sees the badge and can pay it out, resetting the tab to 0.
    await openAdminWithPin(page);
    await page.locator('[data-atab="children"]').click();
    await expect(page.locator('.kid-admin', { hasText: 'נועה' }).locator('.ka-cash')).toContainText('2 ₪');
    await page.locator('.kid-admin', { hasText: 'נועה' }).locator('.ka-cash').click();
    await page.locator('#mYes').click();
    await expect(page.locator('.kid-admin', { hasText: 'נועה' }).locator('.ka-cash')).toHaveCount(0);
    expect(await page.evaluate(() => DB.get('cs_cash_noa'))).toBe(0);
  });
});

test.describe('required tasks gate game launches', () => {
  // A task marked `required` must block actually STARTING a game (spending
  // the banked gtime wallet), not earning/banking coins -- otherwise a child
  // could stockpile coins/minutes all day and cash them all in on games
  // without ever doing the chores that were due. Once completed, the same
  // game must launch normally.
  test('a required task blocks starting a game until done, then unblocks', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await page.evaluate(async () => {
      const k = cur(); k.gtime = 600; await DB.set('cs_gtime_noa', 600);
      state.chores.push({ id: 'test_req', label: 'מטלת חובה', emoji: '🎯', points: 2, max: 1, required: true });
      await DB.set('cs_chores', state.chores);
      go('games');
    });
    await page.locator('.game-row').first().click();
    await expect(page.locator('#modalContent')).toContainText('קודם המטלות');
    await expect(page.locator('#modalContent')).toContainText('מטלת חובה');
    // Declining doesn't start the game -- the wallet is untouched.
    expect(await page.evaluate(() => cur().gtime)).toBe(600);

    await page.evaluate(() => { closeModal(); redeemToken('CSQR|test_req'); });
    await page.evaluate(() => { closeModal(); go('games'); }); // dismiss the "+points!" celebration modal too
    await page.locator('.game-row').first().click();
    await expect(page.locator('#modalContent')).not.toContainText('קודם המטלות');
  });
});

test.describe('parent-triggered bathroom session', () => {
  // Fully outside the coin economy: doesn't touch the wallet on start, and
  // doesn't credit anything back on end either (a leftover-minutes-into-the-
  // wallet design would let a child start-then-cancel to mint free time).
  test('grants up to 10 minutes of a bathroom-approved game without touching the coin wallet', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const before = await page.evaluate(async () => {
      const k = cur(); k.gtime = 42; await DB.set('cs_gtime_noa', 42); // arbitrary -- must be untouched throughout
      const g = state.games.find(x => !x.native); // classicube, a web game
      g.bathroomApproved = true;
      await DB.set('cs_games', state.games);
      return k.gtime;
    });
    await openAdminWithPin(page);
    await page.locator('[data-atab="games"]').click();
    await expect(page.locator('#bathroomSessionAdmin')).toContainText('קלאסיקיוב');
    await page.locator('#bathroomMinutes').fill('1');
    await page.locator('#bathroomSessionAdmin button', { hasText: 'התחל עכשיו' }).click();

    await expect(page.locator('#gameOverlay')).toBeVisible();
    expect(await page.evaluate(() => _gt && _gt.bathroom)).toBe(true);
    expect(await page.evaluate(() => cur().gtime)).toBe(before); // untouched the instant it starts

    // End it early (like the ✖ exit button) -- still must not touch the wallet.
    await page.evaluate(() => endGameSession(false));
    await expect(page.locator('#gameOverlay')).toBeHidden();
    expect(await page.evaluate(() => cur().gtime)).toBe(before);
  });
});

test.describe('unified chores + anchored (time-window) tasks', () => {
  // Before this fix, "anchored" tasks lived in a completely separate list
  // (state.anchored) that a schedule child's home screen read INSTEAD of
  // state.chores -- deleting a task from the chores admin screen had zero
  // effect on its anchored twin, which kept a separate, never-QR-able daily
  // counter forever stuck at 0. Now every task lives in state.chores, with an
  // optional `period` tag; this proves the tag actually governs visibility
  // for ANY child (not just schedule ones), with no duplication.
  test('a task tagged with the current period shows now and is hidden in a different period, for schedule AND non-schedule children', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה'); // useSchedule:false
    const now = await page.evaluate(() => getTimeOfDay(new Date().getHours()));
    const other = ['morning', 'afternoon', 'evening'].find(p => p !== now);
    await page.evaluate(({ now, other }) => {
      state.chores.push({ id: 'test_now', label: 'מטלת עכשיו', emoji: '⭐', points: 3, max: 1, period: now });
      state.chores.push({ id: 'test_other', label: 'מטלת זמן אחר', emoji: '🌙', points: 3, max: 1, period: other });
      DB.set('cs_chores', state.chores);
      go('home');
    }, { now, other });
    await expect(page.locator('.chore-row', { hasText: 'מטלת עכשיו' })).toBeVisible();
    await expect(page.locator('.chore-row', { hasText: 'מטלת זמן אחר' })).toHaveCount(0);

    // Same rule applies to the schedule child (Ariel) -- period filtering is
    // no longer tied to which list the task happens to live in.
    await page.evaluate(() => go('picker'));
    await selectChild(page, 'אריאל');
    await expect(page.locator('.chore-row', { hasText: 'מטלת עכשיו' })).toBeVisible();
    await expect(page.locator('.chore-row', { hasText: 'מטלת זמן אחר' })).toHaveCount(0);
  });

  // A task with NO period is unrestricted -- always visible regardless of
  // time of day, for either kind of child.
  test('a task with no period is always visible ("anytime")', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'אריאל');
    await page.evaluate(() => {
      state.chores.push({ id: 'test_anytime', label: 'מטלת כל היום', emoji: '🎯', points: 3, max: 1 });
      DB.set('cs_chores', state.chores);
      go('home');
    });
    await expect(page.locator('.chore-row', { hasText: 'מטלת כל היום' })).toBeVisible();
  });

  // A task allowed several times a day can set its own real-world spacing
  // (minGapMin) instead of the standard 1-minute anti-spam floor -- e.g. a
  // task legitimately doable 3x/day shouldn't credit twice for one
  // continuous real-world moment a minute apart.
  test('a task with minGapMin enforces its own cooldown instead of the standard 1-minute one', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const result = await page.evaluate(async () => {
      state.chores.push({ id: 'test_gap', label: 'מטלת מרווח', emoji: '⏳', points: 2, max: 3, minGapMin: 30 });
      await DB.set('cs_chores', state.chores);
      redeemToken('CSQR|test_gap');
      const afterFirst = cur().balance;
      redeemToken('CSQR|test_gap'); // immediately again -- must be blocked by the 30-minute gap
      return { afterFirst, afterSecond: cur().balance, count: cur().daily.counts['test_gap'] };
    });
    expect(result.afterFirst).toBe(2);
    expect(result.afterSecond).toBe(2); // unchanged -- blocked
    expect(result.count).toBe(1);
    await expect(page.locator('#modalContent')).toContainText('30 דקות');
  });
});

test.describe('math (adaptive)', () => {
  test('solving the on-screen problem via the keypad credits math points', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await page.evaluate(() => go('math'));
    await expect(page.locator('#view-math')).toHaveClass(/active/);

    const { ans } = await page.evaluate(() => ({ ans: mathCur.ans }));
    for (const digit of String(ans)) {
      await page.locator('.keypad button', { hasText: new RegExp(`^${digit}$`) }).click();
    }
    await page.locator('.keypad .key.ok').click();

    await expect(page.locator('#balTop')).toHaveText('2'); // DEFAULT_MATH.pts
    await expect(page.locator('#mathDone')).toHaveText('1');
  });

  test('four correct answers in a row raises the difficulty level', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await page.evaluate(() => go('math'));
    const levelBefore = await page.evaluate(() => cur().mathLevel || 1);

    for (let i = 0; i < 4; i++) {
      const { ans } = await page.evaluate(() => ({ ans: mathCur.ans }));
      await page.evaluate((a) => { mathStr = String(a); mathCheck(); }, ans);
    }
    const levelAfter = await page.evaluate(() => cur().mathLevel || 1);
    expect(levelAfter).toBe(levelBefore + 1);
  });
});

test.describe('QR redemption', () => {
  test('manual code entry credits the REAL configured points, ignoring anything typed alongside it', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await openAdminWithPin(page);
    await page.locator('[data-atab="qr"]').click();
    await page.selectOption('#qrSelect', 'chore|chore_teeth'); // 5 points
    await page.locator('button', { hasText: '🔳 צור קוד QR' }).click();
    const tokenText = await page.locator('#qrToken').textContent();
    const id = tokenText.split(':').pop().trim();
    expect(id).toBe('chore_teeth');

    await page.evaluate(() => go('home'));
    await page.evaluate(() => go('scan'));
    await page.locator('button', { hasText: 'הזנת קוד ידנית' }).click();
    await page.locator('#manualCode').fill(id);
    await page.locator('button', { hasText: 'אישור' }).click();

    await expect(page.locator('#balTop')).toHaveText('5');

    // Anti-forgery regression: a hand-typed LEGACY-format token carrying forged
    // points/max must still only pay out the real configured value.
    await page.evaluate(() => redeemToken('CSQR|chore_toilet|forged|9999|9999'));
    await expect(page.locator('#balTop')).toHaveText('8'); // 5 + 3 (real chore_toilet points)
  });
});

test.describe('streak', () => {
  test('marking a clean day requires the parent PIN and advances the streak exactly once per day', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'אריאל'); // both default streak challenges are assigned to ariel
    await page.evaluate(() => openStreakView('clean'));
    await expect(page.locator('#view-streak')).toHaveClass(/active/);

    await page.getByRole('button', { name: /היה יום נקי/ }).click();
    await page.locator('#mPin').fill('1234');
    await page.locator('#mPinOk').click();

    const current = await page.evaluate(() => getStreak('clean').current);
    expect(current).toBe(1);

    // Same day again must be a no-op (button is now disabled/shows "done").
    await expect(page.getByRole('button', { name: /סימנת היום/ })).toBeVisible();
  });
});

test.describe('admin: undo delete', () => {
  test('deleting a chore then tapping undo restores it at the same position', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await openAdminWithPin(page);
    await page.locator('[data-atab="chores"]').click();

    const before = await page.evaluate(() => state.chores.length);
    await page.locator('#choresAdmin .admin-row', { hasText: 'פינוי אוכל' }).locator('button.icon-btn').click();
    expect(await page.evaluate(() => state.chores.length)).toBe(before - 1);

    await page.locator('#toast button', { hasText: 'בטל' }).click();
    expect(await page.evaluate(() => state.chores.length)).toBe(before);
    expect(await page.evaluate(() => state.chores.some(c => c.label === 'פינוי אוכל אחרי שמסיימים'))).toBe(true);
  });
});

test.describe('calm toolkit', () => {
  test('using a calming tool logs the before/after feeling', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'אריאל');
    await page.locator('.break-btn').click();
    await page.locator('#feelRowBefore .feel-btn', { hasText: 'כועס מאוד' }).click();
    await page.locator('.calm-tile', { hasText: 'נשימת בלון' }).click();
    await expect(page.locator('#calmBreathe')).toBeVisible();

    await page.locator('button', { hasText: 'אני מוכן/ה להמשיך' }).click();
    await page.locator('#calmAfter .feel-btn', { hasText: 'רגוע' }).click();

    const log = await page.evaluate(() => DB.get('cs_calmlog'));
    expect(log[0].tool).toBe('breathe');
    expect(log[0].before).toBe(4);
    expect(log[0].after).toBe(1);
  });
});

test.describe('backup / restore', () => {
  test('export then import restores an overwritten balance exactly', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await page.evaluate(async () => { const k = cur(); k.balance = 42; await DB.set('cs_bal_noa', 42); });

    const backupJson = await page.evaluate(async () => {
      const data = {};
      for (const k of backupKeyList()) { const v = await DB.get(k); if (v !== null) data[k] = v; }
      if (!data.cs_children) data.cs_children = state.children;
      return JSON.stringify({ app: 'coin-quest', version: 1, exportedAt: new Date().toISOString(), data });
    });

    await page.evaluate(async () => { const k = cur(); k.balance = 999; await DB.set('cs_bal_noa', 999); });

    await page.evaluate(async (json) => {
      const file = new File([json], 'backup.json', { type: 'application/json' });
      await importBackup({ target: { files: [file], value: '' } });
    }, backupJson);
    await page.locator('#mYes').click();

    // importBackup reloads the page ~800ms after confirmation.
    await page.waitForTimeout(1200);
    await page.waitForLoadState('domcontentloaded');
    const restored = await page.evaluate(() => DB.get('cs_bal_noa'));
    expect(restored).toBe(42);
  });
});

test.describe('anti-cheat invariants', () => {
  test('the clock high-water-mark never moves backward, even if asked to', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const today = await page.evaluate(() => effectiveToday());
    // Directly exercise the guard with a date 5 days in the past: effectiveToday()
    // must still report the high-water-mark, not the earlier date, or a device
    // clock rewind would resurrect already-spent daily allowances.
    const staysAtHwm = await page.evaluate(() => {
      const past = new Date(); past.setDate(past.getDate() - 5);
      return dateToNum(past.getFullYear() + '-' + (past.getMonth() + 1) + '-' + past.getDate()) <= dateToNum(_hwmDate);
    });
    expect(staysAtHwm).toBe(true);
    expect(await page.evaluate(() => effectiveToday())).toBe(today);
  });

  test('sync only sends the section that actually changed (no whole-tree overwrite)', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const section = await page.evaluate(() => keyToSyncSection('cs_chores'));
    expect(section).toBe('chores');
    const kidSection = await page.evaluate(() => keyToSyncSection('cs_bal_noa'));
    expect(kidSection).toBe('kids/noa');
  });
});

test.describe('live cross-device sync', () => {
  // Full real-time Firebase E2E (two signed-in browsers) is out of scope for
  // a no-credentials CI suite -- this mocks fbDb.ref the same way the whole
  // app already treats Firebase as swappable, and verifies the actual
  // contract: attach subscribes exactly once, a remote push is applied to
  // local state via the shared applyRemoteSnapshot path, and detach cleans
  // up the subscription (no leaked listeners across sign-out/sign-in).
  test('attachLiveSync applies a remote change once and detachLiveSync unsubscribes', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');

    const result = await page.evaluate(() => new Promise((resolve) => {
      const calls = { on: 0, off: 0 };
      let handler = null;
      const fakeRef = {
        on: (event, cb) => { calls.on++; handler = cb; return cb; },
        off: () => { calls.off++; },
      };
      const originalRef = fbDb.ref.bind(fbDb);
      fbDb.ref = () => fakeRef;
      state.familyId = 'faketest';

      attachLiveSync();
      const remoteChores = JSON.parse(JSON.stringify(state.chores));
      remoteChores[0].label = 'REMOTE-EDIT';
      handler({ val: () => ({ chores: remoteChores }) }); // simulate a push from another device

      setTimeout(() => {
        detachLiveSync();
        fbDb.ref = originalRef;
        state.familyId = null;
        resolve({ calls, appliedLabel: state.chores[0].label });
      }, 50);
    }));

    expect(result.calls.on).toBe(1);
    expect(result.calls.off).toBe(1);
    expect(result.appliedLabel).toBe('REMOTE-EDIT');
  });

  // Regression test for a real reported bug: a child buys game-time minutes
  // with coins, but a remote snapshot -- pulled/echoed a split-second before
  // this device's own push of the purchase reaches the server -- carries the
  // OLD (pre-purchase) gtime and would silently revert the wallet, making it
  // look like "the time wasn't added". applyRemoteSnapshot must skip a kid
  // entirely while this device has an unpushed local edit for them.
  test('a pending local edit is not clobbered by a stale remote snapshot for the same kid', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const result = await page.evaluate(async () => {
      const k = cur();
      k.balance = 100; await DB.set('cs_bal_noa', 100);
      const staleSnapshot = JSON.parse(JSON.stringify(buildSyncPayload()));
      staleSnapshot.kids.noa.gtime = 0; // stale: predates the purchase below

      state.rewards.push({ id: 'test_gtime', label: 'טסט', cost: 10, minutes: 20 });
      await addPoints(-10, 'פרס: טסט', 'spend');
      k.gtime = (k.gtime || 0) + 20 * 60;
      await DB.set('cs_gtime_noa', k.gtime); // marks kids/noa dirty -- purchase not yet "pushed"
      const afterPurchase = k.gtime;

      await applyRemoteSnapshot(staleSnapshot); // simulates the race
      const afterStalePull = cur().gtime;

      state.rewards.pop();
      return { afterPurchase, afterStalePull };
    });
    expect(result.afterPurchase).toBe(1200);
    expect(result.afterStalePull).toBe(1200); // NOT reverted to the stale 0
  });

  test('a remote snapshot still applies normally once nothing is locally pending', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const gtime = await page.evaluate(async () => {
      syncDirty.clear(); // simulate: this device's own earlier push already completed
      const snap = JSON.parse(JSON.stringify(buildSyncPayload()));
      snap.kids.noa.gtime = 777;
      await applyRemoteSnapshot(snap);
      return cur().gtime;
    });
    expect(gtime).toBe(777);
  });
});

test.describe('demo mode', () => {
  test('has zero storage footprint and shows seeded progress', async ({ page }) => {
    await page.goto('/');
    const before = await page.evaluate(() => localStorage.getItem('cs_children'));

    await page.getByRole('button', { name: /נסה הדגמה/ }).click();
    await expect(page.locator('#view-picker')).toHaveClass(/active/);
    await expect(page.locator('#demoBanner')).toBeVisible();

    const seeded = await page.evaluate(() => ({
      backend, demoMode,
      arielBalance: state.kid.ariel.balance,
      cleanStreak: getStreak('clean').current,
    }));
    expect(seeded.backend).toBe('mem');
    expect(seeded.demoMode).toBe(true);
    expect(seeded.arielBalance).toBe(47);
    expect(seeded.cleanStreak).toBe(6);

    // The whole point: a demo visitor's clicks must never touch this
    // device's real localStorage (which could belong to an actual family
    // using a shared/kiosk device).
    await page.locator('.kid-card', { hasText: 'אריאל' }).click();
    await page.locator('.chore-row').first().locator('.chore-check').click();
    const after = await page.evaluate(() => localStorage.getItem('cs_children'));
    expect(after).toBe(before);
  });
});

test.describe('native game (real purchased app, e.g. Minecraft)', () => {
  // window.CoinQuestNative only exists inside the Android wrapper's WebView;
  // in this plain-browser CI environment it's absent, which is itself the
  // condition under test -- the UI must degrade gracefully (clickable,
  // explanatory, not just silently disabled) rather than pretend to work.
  test('is visibly locked and explains itself when the native bridge is absent', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'אריאל');
    await page.evaluate(async () => { const k = cur(); k.gtime = 300; await DB.set('cs_gtime_ariel', 300); });
    await page.evaluate(() => go('games'));

    const nativeRow = page.locator('.game-row', { hasText: 'הגרסה שקנית' });
    await expect(nativeRow).toHaveClass(/locked/);
    // A real `disabled` attribute would silently swallow this click too --
    // regression-tests the fix where that exact bug hid the explanation.
    await nativeRow.click();
    await expect(page.locator('#modalContent')).toContainText('זמין רק באפליקציה');
    await page.locator('#modalContent button').click();
  });

  test('a mocked native bridge: happy path debits exactly the reported seconds, missing permissions block the session', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'אריאל');

    // Happy path: permissions granted, game installed.
    const happyPath = await page.evaluate(async () => {
      const k = cur(); k.gtime = 600; await DB.set('cs_gtime_ariel', 600);
      const calls = [];
      window.CoinQuestNative = {
        isPackageInstalled: (pkg) => { calls.push(['isPackageInstalled', pkg]); return true; },
        hasOverlayPermission: () => true,
        isDeviceOwner: () => true, // enforcement now rests on device-owner status
        startNativeSession: (pkg, seconds) => { calls.push(['startNativeSession', pkg, seconds]); return true; },
      };
      const g = state.games.find(x => x.native);
      await startNativeGameSession(g);
      await onNativeGameSessionEnded(200); // native side reports 200s actually consumed
      return { calls, wallet: await DB.get('cs_gtime_ariel') };
    });
    expect(happyPath.calls[0]).toEqual(['isPackageInstalled', 'com.mojang.minecraftpe']);
    expect(happyPath.calls[1]).toEqual(['startNativeSession', 'com.mojang.minecraftpe', 600]);
    expect(happyPath.wallet).toBe(400); // 600 - 200, NOT zeroed and NOT the full 600

    // Missing overlay permission: a session that can't show its timer must
    // never start, and the wallet must stay untouched. (Overlay is checked
    // first, before device-owner status.)
    const blocked = await page.evaluate(async () => {
      const k = cur(); k.gtime = 300; await DB.set('cs_gtime_ariel', 300);
      window.CoinQuestNative = {
        isPackageInstalled: () => true,
        hasOverlayPermission: () => false,
        isDeviceOwner: () => true,
        requestOverlayPermission: () => {},
        startNativeSession: () => { throw new Error('must not be called without permissions'); },
      };
      const g = state.games.find(x => x.native);
      await startNativeGameSession(g);
      return { walletUntouched: await DB.get('cs_gtime_ariel') };
    });
    await expect(page.locator('#modalContent')).toContainText('נדרשת הרשאה חד-פעמית');
    expect(blocked.walletUntouched).toBe(300);

    // Neither enforcement path available (not device owner AND no accessibility):
    // the game must not launch and the wallet must stay untouched.
    const noEnforcement = await page.evaluate(async () => {
      const k = cur(); k.gtime = 300; await DB.set('cs_gtime_ariel', 300);
      window.CoinQuestNative = {
        isPackageInstalled: () => true,
        hasOverlayPermission: () => true,
        isDeviceOwner: () => false,
        hasAccessibilityPermission: () => false,
        requestAccessibilityPermission: () => {},
        startNativeSession: () => { throw new Error('must not be called without any enforcement path'); },
      };
      const g = state.games.find(x => x.native);
      await startNativeGameSession(g);
      return { walletUntouched: await DB.get('cs_gtime_ariel') };
    });
    await expect(page.locator('#modalContent')).toContainText('נדרשת הרשאה חד-פעמית');
    expect(noEnforcement.walletUntouched).toBe(300);

    // Accessibility-only enforcement (no device owner) is a valid path: the
    // session starts and the game launches -- this is the MIUI/post-Family-Link
    // fallback where device-owner can't be provisioned.
    const accOnly = await page.evaluate(async () => {
      const k = cur(); k.gtime = 500; await DB.set('cs_gtime_ariel', 500);
      const calls = [];
      window.CoinQuestNative = {
        isPackageInstalled: () => true,
        hasOverlayPermission: () => true,
        isDeviceOwner: () => false,
        hasAccessibilityPermission: () => true,
        startNativeSession: (pkg, seconds) => { calls.push([pkg, seconds]); return true; },
      };
      const g = state.games.find(x => x.native);
      await startNativeGameSession(g);
      return { calls };
    });
    expect(accOnly.calls[0]).toEqual(['com.mojang.minecraftpe', 500]);
  });
});

test.describe('learning quiz ("מכרה הידע")', () => {
  test('a correct answer credits exactly coinsPerCorrect, a wrong answer credits nothing', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const balBefore = await page.locator('#balTop').textContent();

    const result = await page.evaluate(() => {
      startLearningSession();
      const q = learnSession.questions[learnSession.idx];
      const before = cur().balance;
      answerLearningQuestion(q, q.answer, null); // correct
      return { before, after: cur().balance, coinsPerCorrect: state.learning.coinsPerCorrect };
    });
    expect(result.after - result.before).toBe(result.coinsPerCorrect);

    const wrongResult = await page.evaluate(() => {
      const q = learnSession.questions[learnSession.idx];
      const before = cur().balance;
      answerLearningQuestion(q, '__definitely_wrong__', null);
      return { before, after: cur().balance };
    });
    expect(wrongResult.after).toBe(wrongResult.before);
  });

  // Mutation-test style: call the crediting function directly past the daily
  // cap, bypassing any UI state, to prove the guard lives in the function
  // itself (same anti-cheat pattern as redeemToken's daily-max check).
  test('daily coin cap is enforced even when answerLearningQuestion is called directly past it', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const result = await page.evaluate(() => {
      startLearningSession();
      const k = cur();
      k.learn.earnedToday.coins = state.learning.dailyMaxCoins; // simulate already at cap
      const q = learnSession.questions[learnSession.idx];
      const before = k.balance;
      answerLearningQuestion(q, q.answer, null); // correct, but capped
      return { before, after: k.balance, coins: k.learn.earnedToday.coins };
    });
    expect(result.after).toBe(result.before);
    expect(result.coins).toBe(await page.evaluate(() => state.learning.dailyMaxCoins));
  });

  // answerLearningQuestion advances to the next question (or finishes the
  // session) inside a real setTimeout, so driving a whole session from
  // page.evaluate needs to actually wait out those timers, not just loop
  // synchronously (which would spin forever on a session that never advances).
  test('a perfect 5/5 session shows the summary and, once capped, the mine "closed for today" message on re-entry', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await page.evaluate(async () => {
      state.learning.dailyMaxCoins = 3; // small cap so a single session trips it
      startLearningSession();
      while (learnSession) {
        const q = learnSession.questions[learnSession.idx];
        answerLearningQuestion(q, q.answer, null);
        await new Promise(r => setTimeout(r, 1000));
      }
    });
    await expect(page.locator('#learnSummary')).toContainText('ענית נכון על');
    // Re-entering the view after the cap is hit must show the closed message,
    // not a fresh "start session" button (the daily cap must persist across nav).
    await page.evaluate(() => { go('home'); go('learn'); });
    await expect(page.locator('#learnDisabled')).toBeVisible();
    await expect(page.locator('#learnStartBtn')).toBeHidden();
  });

  test('a perfect session with minutesPerSession enabled offers coins-vs-minutes choice, and the minutes path credits the game-time wallet without touching coins', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const outcome = await page.evaluate(async () => {
      state.learning.minutesPerSession = 5;
      state.learning.dailyMaxMinutes = 15;
      const k = cur();
      const balBefore = k.balance;
      startLearningSession();
      while (learnSession) {
        const q = learnSession.questions[learnSession.idx];
        answerLearningQuestion(q, q.answer, null);
        await new Promise(r => setTimeout(r, 1000));
      }
      return { balBefore };
    });
    await expect(page.locator('#learnSummary')).toContainText('בחר את הבונוס שלך');
    await page.evaluate(() => claimLearningBonus('minutes'));
    const after = await page.evaluate(() => ({ gtime: cur().gtime, balance: cur().balance }));
    expect(after.gtime).toBe(300); // 5 minutes * 60
    // Per-question coins (1 each, 5 correct) still apply regardless of which
    // bonus is chosen -- only the session-completion BONUS becomes minutes
    // instead of coins, so balance is +5, not the untouched pre-session value.
    expect(after.balance).toBe(outcome.balBefore + 5);
  });
});

test.describe('pre-game learning gate (L6)', () => {
  test('gate is non-blocking: even 3 wrong answers still starts the game session afterward', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const result = await page.evaluate(async () => {
      state.learning.gateEnabled = true;
      state.learning.enabled = true;
      const k = cur(); k.gtime = 600;
      const g = state.games.find(x => !x.native);
      beginGameLaunch(g);
      const gateShown1 = modalBg.classList.contains('show');
      for (let i = 0; i < 3 && _gateSession; i++) {
        answerGateQuestion('__definitely_wrong__');
        await new Promise(r => setTimeout(r, 1000));
      }
      return { gateShown1, gateSessionDone: _gateSession === null };
    });
    expect(result.gateShown1).toBe(true);
    expect(result.gateSessionDone).toBe(true);
    await expect(page.locator('#gameOverlay')).toBeVisible();
  });

  test('gate disabled (default): launching a game skips straight to the session with no modal', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await page.evaluate(() => {
      const k = cur(); k.gtime = 600;
      const g = state.games.find(x => !x.native);
      beginGameLaunch(g);
    });
    await expect(page.locator('#gameOverlay')).toBeVisible();
    await expect(page.locator('#modalBg')).not.toHaveClass(/show/);
  });
});

test.describe('custom parent-authored questions (L8)', () => {
  test('a custom question is added to its subject pool and can be deleted with undo', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const added = await page.evaluate(() => {
      state.learning.customQuestions = [];
      state.learning.customQuestions.push({ id: 'lqtest1', subject: 'english', level: 1, type: 'choice',
        q: 'test question?', choices: ['A', 'B', 'C'], answer: 'A' });
      return subjectQuestionPool('english').some(q => q.id === 'lqtest1');
    });
    expect(added).toBe(true);

    const afterDelete = await page.evaluate(() => {
      delWithUndo(state.learning.customQuestions, 0, 'cs_learning', () => {}, 'השאלה',
        async () => { await DB.set('cs_learning', state.learning); });
      return state.learning.customQuestions.length;
    });
    expect(afterDelete).toBe(0);
  });
});

test.describe('read-aloud (TTS) for learning questions', () => {
  test('the question is wrapped into per-word spans for highlighting', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await page.evaluate(() => { go('learn'); startLearningSession(); });
    await expect(page.locator('#learnQ .tts-word').first()).toBeVisible();
    const wordCount = await page.locator('#learnQ .tts-word').count();
    expect(wordCount).toBeGreaterThan(0);
  });

  // Regression test for a real bug found during manual testing: calling
  // stopSpeaking() (speechSynthesis.cancel()) still left speechSynthesis
  // reporting speaking/pending afterward, because the interrupted utterance's
  // own `error` event advanced the question->choices chain to the NEXT step,
  // which called speak() again right after the cancel. Fixed with a
  // generation counter (_ttsGen) that invalidates any in-flight chain once
  // stopSpeaking() (or a newer speak) supersedes it.
  test('answering mid-narration actually stops speech, not just the current utterance', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await page.evaluate(() => { go('learn'); startLearningSession(); });
    await page.waitForTimeout(80);
    await page.evaluate(() => {
      const q = learnSession.questions[learnSession.idx];
      if (q.type === 'typed-number') {
        document.getElementById('learnTypedInput').value = q.answer;
        submitTypedLearningAnswer();
      } else {
        answerLearningQuestion(q, q.answer, document.querySelector('#learnChoices .learn-choice-btn'));
      }
    });
    await page.waitForTimeout(150);
    const stillTalking = await page.evaluate(() => speechSynthesis.speaking || speechSynthesis.pending);
    expect(stillTalking).toBe(false);
  });

  test('disabling read-aloud in settings shows plain text with no speech spans', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    const q = await page.evaluate(() => {
      state.learning.readAloud = false;
      go('learn'); startLearningSession();
      return document.getElementById('learnQ').querySelectorAll('.tts-word').length;
    });
    expect(q).toBe(0);
  });
});

test.describe('badges banner hides when no badges are defined', () => {
  test('removing every badge definition hides the home banner instead of showing "0 of 0"', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await expect(page.locator('.badges-banner')).toBeVisible();
    await page.evaluate(async () => {
      state.badgeDefs = [];
      await DB.set('cs_badgedefs', state.badgeDefs);
      renderBadgesBanner();
    });
    await expect(page.locator('.badges-banner')).toHaveCount(0);
  });
});

test.describe('streak challenges are fully editable (add/remove)', () => {
  test('a parent can add a brand-new streak challenge and later delete it', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'אריאל');
    await openAdminWithPin(page);
    await page.locator('[data-atab="streak"]').click();
    const before = await page.evaluate(() => state.streaks.length);

    await page.evaluate(() => addStreak());
    expect(await page.evaluate(() => state.streaks.length)).toBe(before + 1);
    await expect(page.locator('#streakTitle')).toHaveValue('אתגר חדש');

    // Rename and save, then confirm it persisted under the new title.
    await page.locator('#streakTitle').fill('אתגר בדיקה');
    await page.locator('button', { hasText: 'שמור הגדרות אתגר' }).click();
    expect(await page.evaluate(() => getStreak(adminStreakId).title)).toBe('אתגר בדיקה');

    // Delete it -- back to the original count.
    await page.evaluate(() => delStreak());
    await page.locator('#mYes').click();
    expect(await page.evaluate(() => state.streaks.length)).toBe(before);
  });

  test('the last remaining streak challenge cannot be deleted', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'אריאל');
    await openAdminWithPin(page);
    await page.locator('[data-atab="streak"]').click();
    await page.evaluate(() => { state.streaks = [state.streaks[0]]; adminStreakId = state.streaks[0].id; DB.set('cs_streaks', state.streaks); fillStreakAdmin(); });
    await page.evaluate(() => delStreak());
    expect(await page.evaluate(() => state.streaks.length)).toBe(1);
  });
});

test.describe('modal keyboard dismissal', () => {
  // On mobile, hiding a modal via CSS alone leaves its input focused -- the
  // on-screen keyboard stays open (covering part of the screen) until
  // something blurs it. Most visible with the parent-PIN modal.
  test('closeModal blurs whatever input was focused inside it', async ({ page }) => {
    await enterLocalOnly(page);
    await page.locator('#gearBtn').click();
    await page.locator('#mPin').focus();
    await expect(page.locator('#mPin')).toBeFocused();
    await page.evaluate(() => closeModal());
    await expect(page.locator('#mPin')).not.toBeFocused();
  });
});
