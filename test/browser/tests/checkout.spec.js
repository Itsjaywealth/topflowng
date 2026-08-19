/**
 * TopFlowNG — browser tests for the checkout review step.
 *
 * The review overlay is the required confirm step between filling a service
 * form and entering the transaction PIN. These tests exercise it directly
 * (openReview) plus through the airtime form, asserting lines render, totals
 * match, and confirm/cancel resolve correctly without ever placing an order.
 */

'use strict';

const { test, expect } = require('@playwright/test');

async function login(request, page) {
  const stamp = Date.now();
  const email = `co${stamp}@test.local`;
  const res = await request.post('/api/auth/register', {
    data: {
      fullName: 'Checkout Tester',
      email,
      phone: '070' + stamp.toString().slice(-9),
      password: 'checkoutSecret123',
    },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  await page.addInitScript((t) => localStorage.setItem('tf_token', t), body.token);
}

test.describe('checkout review step', () => {
  test('openReview renders summary rows and resolves true on confirm', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();

    const result = await page.evaluate(async () => {
      let resolved = 'not-yet';
      const promise = openReview({
        providerKey: 'MTN',
        lines: [
          ['Service', 'Airtime'],
          ['Provider', 'MTN'],
          ['Recipient', '08012345678'],
          ['Amount', fmt(5500)],
          ['Fee', '₦0.00'],
        ],
        total: 5500,
        balanceNote: 'New balance: ₦4,500.00',
        confirmLabel: 'Buy ₦5,500 airtime',
      });
      promise.then((v) => { resolved = v; });
      const overlay = document.getElementById('review-overlay');
      const visible = overlay.classList.contains('open');
      const totalText = document.getElementById('review-total').textContent;
      const btnText = document.getElementById('review-confirm-btn').textContent;
      document.getElementById('review-confirm-btn').click();
      await new Promise((r) => setTimeout(r, 30));
      const closed = !overlay.classList.contains('open');
      return { visible, totalText, btnText, resolved, closed };
    });

    expect(result.visible).toBe(true);
    expect(result.totalText).toBe('₦5,500.00');
    expect(result.btnText).toBe('Buy ₦5,500 airtime');
    expect(result.resolved).toBe(true);
    expect(result.closed).toBe(true);
  });

  test('openReview resolves false when the user goes back to edit', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();

    const result = await page.evaluate(async () => {
      let resolved = 'not-yet';
      const promise = openReview({ lines: [['Service', 'Data']], total: 1000 });
      promise.then((v) => { resolved = v; });
      const overlay = document.getElementById('review-overlay');
      document.querySelector('.review-back').click();
      await new Promise((r) => setTimeout(r, 30));
      return { resolved, closed: !overlay.classList.contains('open') };
    });

    expect(result.resolved).toBe(false);
    expect(result.closed).toBe(true);
  });

  test('airtime purchase reaches the review step before the PIN prompt', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();

    // Fund the wallet directly so the balance guard passes, then drive the
    // airtime form: validation -> review overlay visible -> PIN prompt absent.
    await page.evaluate(() => { user.wallet = 100000; });

    await page.evaluate(() => openService('airtime'));
    await expect(page.locator('#svc-airtime')).toBeVisible();
    await page.locator('#airtime-phone').fill('08012345678');
    await page.locator('#svc-airtime .network-chip').first().click();
    await page.locator('#airtime-amount').fill('1000');
    await page.locator('#btn-buy-airtime').click();

    await expect(page.locator('#review-overlay')).toHaveClass(/open/);
    await expect(page.locator('#review-lines')).toContainText('Airtime');
    await expect(page.locator('#review-lines')).toContainText('08012345678');
    await expect(page.locator('#review-total')).toHaveText('₦1,000.00');

    // Cancel keeps the service form open and never shows the PIN prompt.
    await page.locator('.review-back').click();
    await expect(page.locator('#review-overlay')).not.toHaveClass(/open/);
    await expect(page.locator('#svc-airtime')).toBeVisible();
    await expect(page.locator('#pin-prompt-overlay')).not.toHaveClass(/open/);
  });
});
