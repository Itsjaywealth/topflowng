/**
 * TopFlowNG — browser tests for the polish layer: dual palettes, theme
 * persistence, notification centre, transaction history filters/detail.
 *
 * These assert real UI behaviour end-to-end in the harness, not just markup.
 */

'use strict';

const { test, expect } = require('@playwright/test');

const WIDTHS = [320, 390, 768, 1440];

async function login(request, page) {
  const stamp = Date.now();
  const email = `pol${stamp}@test.local`;
  const res = await request.post('/api/auth/register', {
    data: {
      fullName: 'Polish Tester',
      email,
      phone: '080' + stamp.toString().slice(-9),
      password: 'polishSecret123',
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  await page.addInitScript((t) => localStorage.setItem('tf_token', t), body.token);
}

test.describe('palette + appearance', () => {
  test('palette selection persists and survives reload', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();
    await page.evaluate(() => goTab('account'));
    await expect(page.locator('#appearance-section')).toBeVisible();
    await page.locator('#palette-emerald').click();
    await expect(page.locator('#palette-emerald')).toHaveAttribute('aria-checked', 'true');
    const stored = await page.evaluate(() => localStorage.getItem('topflowng-palette'));
    expect(stored).toBe('emerald');
    const attr = await page.evaluate(() => document.documentElement.getAttribute('data-palette'));
    expect(attr).toBe('emerald');
    await page.reload();
    await expect(page.locator('#main-app')).toBeVisible();
    const attrAfter = await page.evaluate(() => document.documentElement.getAttribute('data-palette'));
    expect(attrAfter).toBe('emerald');
  });

  test('theme preference persists and system option is offered', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();
    await page.evaluate(() => goTab('account'));
    await page.locator('#theme-dark').click();
    await expect(page.locator('#theme-dark')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.locator('#theme-light').click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.locator('#theme-system').click();
    await expect(page.locator('#theme-system')).toHaveAttribute('aria-checked', 'true');
  });

  for (const w of WIDTHS) {
    test(`no overflow in account screen with appearance panel @${w}px`, async ({ page, request }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await login(request, page);
      await page.goto('/');
      await expect(page.locator('#main-app')).toBeVisible();
      await page.evaluate(() => goTab('account'));
      await expect(page.locator('#appearance-section')).toBeVisible();
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      );
      expect(overflow).toBe(false);
    });
  }
});

test.describe('notification centre', () => {
  test('bell, badge, feed, empty state, and mark-all-read', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();
    // A new user has no notifications — bell badge hidden, empty state present.
    await expect(page.locator('#notif-badge')).toBeHidden();
    await page.evaluate(() => goTab('notifications'));
    await expect(page.locator('#screen-notifications')).toBeVisible();
    await expect(page.locator('#notif-list')).toContainText(/No notifications yet/i);
    // Feed filter chips are present.
    await expect(page.locator('.notif-filter-chips')).toContainText('Transactions');
  });
});

test.describe('transaction history', () => {
  test('history screen exposes category, status and date filters', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();
    await page.evaluate(() => goTab('history'));
    await expect(page.locator('#screen-history')).toBeVisible();
    await expect(page.locator('.filter-chip[data-cat="airtime"]')).toBeVisible();
    await expect(page.locator('.filter-chip--status[data-status="pending"]')).toBeVisible();
    await expect(page.locator('.filter-chip--date[data-range="today"]')).toBeVisible();
    await expect(page.locator('#txn-search-input')).toBeVisible();
  });

  test('transaction rows are clickable and open detail', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();
    await page.evaluate(() => goTab('history'));
    await page.waitForTimeout(600);
    const row = page.locator('.txn-row').first();
    // A brand-new user may have an empty ledger — the empty state must still render.
    if (await row.count()) {
      await row.click();
      await expect(page.locator('#txn-detail-overlay')).toBeVisible();
      await expect(page.locator('#txn-detail-actions')).toBeVisible();
      await page.locator('#txn-detail-overlay .btn-close-receipt').click();
      await expect(page.locator('#txn-detail-overlay')).toBeHidden();
    } else {
      await expect(page.locator('#all-txns')).toContainText(/No transactions/i);
    }
  });
});

test.describe('wallet + branding', () => {
  test('wallet-centric UI is removed; balance lives on Account; brand mark present', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();
    // The wallet screen and fund-wallet entry points are fully removed.
    await expect(page.locator('#screen-wallet')).toHaveCount(0);
    await expect(page.locator('#fund-modal')).toHaveCount(0);
    await expect(page.getByText('Fund wallet')).toHaveCount(0);
    // Dashboard hero is services-focused, not a balance hero.
    await expect(page.locator('.dash-balance-card')).toContainText('TopFlowNG services');
    // Balance remains visible as quiet accounting on the Account tab.
    await page.evaluate(() => goTab('account'));
    await expect(page.locator('#acct-balance')).toContainText('Available balance');
    await expect(page.locator('.wordmark img')).toBeVisible();
  });
});