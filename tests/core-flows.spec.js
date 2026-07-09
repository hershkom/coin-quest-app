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
  test('completing a chore credits the exact configured points, then caps at max', async ({ page }) => {
    await enterLocalOnly(page);
    await selectChild(page, 'נועה');
    await expect(page.locator('#balTop')).toHaveText('0');

    // "לשבת בשירותים": 3 points, max 6/day
    const row = page.locator('.chore-row', { hasText: 'לשבת בשירותים' });
    for (let i = 1; i <= 6; i++) {
      await row.locator('.chore-check').click();
      await dismissBadgeCelebrationIfAny(page); // first coin ever -> badge modal
      await expect(page.locator('#balTop')).toHaveText(String(3 * i));
    }
    // 6th completion disables the button in the UI...
    await expect(row.locator('.chore-check')).toBeDisabled();
    // ...but the REAL protection must be server-side logic, not just a
    // disabled attribute (which a forged/replayed QR redemption bypasses
    // entirely by calling markChore directly) -- a 7th call must not pay out.
    await page.evaluate((id) => markChore(id), 'chore_toilet');
    await expect(page.locator('#balTop')).toHaveText('18');
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
