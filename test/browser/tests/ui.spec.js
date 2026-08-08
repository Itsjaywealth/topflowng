/**
 * TopFlowNG — browser UI quality checks (Playwright).
 *
 * Coverage:
 *   - responsive (320 / 375 / 768 / 1024 / 1440) — no horizontal overflow
 *   - unlabeled inputs and empty accessible names
 *   - essential navigation present
 *   - the six service purchase forms open
 *   - admin login screen renders
 *   - PWA / static asset availability
 */

'use strict';

const { test, expect } = require('@playwright/test');

const WIDTHS = [320, 375, 768, 1024, 1440];

const SERVICES = [
  ['airtime', 'Buy airtime'],
  ['data', 'Buy data'],
  ['electricity', 'Pay electricity'],
  ['cable', 'Pay cable TV'],
  ['exam', 'Buy Exam PINs'],
  ['recharge', 'Recharge Cards'],
];

test.describe('landing page', () => {
  for (const w of WIDTHS) {
    test(`no horizontal overflow @${w}px`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto('/');
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      );
      expect(overflow).toBe(false);
    });
  }

  test('essential branding + CTAs are present', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.marketing-brand').first()).toBeVisible();
    await expect(page.locator('.marketing-primary').first()).toBeVisible();
    await expect(page.locator('.marketing-secondary').first()).toBeVisible();
  });

  test('CTAs and links have accessible names', async ({ page }) => {
    await page.goto('/');
    const empties = await page.evaluate(() => {
      return [...document.querySelectorAll('button, a, [role="button"]')]
        .filter((el) => {
          const t = (el.textContent || '').trim();
          const al = el.getAttribute('aria-label') || '';
          return !t && !al && !el.title && el.getAttribute('aria-hidden') === null;
        })
        .map((el) => el.outerHTML.slice(0, 120));
    });
    expect(empties).toEqual([]);
  });
});

test.describe('auth screen', () => {
  for (const w of WIDTHS) {
    test(`inputs labeled @${w}px`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await page.goto('/');
      await page.evaluate(() => openAuthFromMarketing('login'));
      await expect(page.locator('#auth-screen')).toBeVisible();
      const unlabeled = await page.evaluate(() => {
        return [...document.querySelectorAll('#auth-screen input')]
          .filter((inp) => !inp.labels || inp.labels.length === 0)
          .map((inp) => inp.id)
          .filter(Boolean);
      });
      expect(unlabeled).toEqual([]);
    });
  }
});

test.describe('static/PWA assets', () => {
  const PATHS = [
    '/manifest.json',
    '/sw.js',
    '/robots.txt',
    '/sitemap.xml',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
  ];
  for (const p of PATHS) {
    test(`${p} returns 200`, async ({ request }) => {
      const res = await request.get(p);
      expect(res.status()).toBe(200);
    });
  }
});

test.describe('logged-in app shell', () => {
  async function login(request, page) {
    const stamp = Date.now();
    const email = `dash${stamp}@test.local`;
    const res = await request.post('/api/auth/register', {
      data: {
        fullName: 'Dashboard Tester',
        email,
        phone: '081' + stamp.toString().slice(-8),
        password: 'dashSecret123',
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    await page.addInitScript((t) => localStorage.setItem('tf_token', t), body.token);
  }

  test('essential navigation present', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();
    await expect(page.locator('#app-header')).toBeVisible();
    const navLabels = await page.locator('.bottom-nav .nav-item').allTextContents();
    const joined = navLabels.map((s) => s.trim()).join(' ');
    expect(joined).toContain('Home');
    expect(joined).toContain('Services');
    expect(joined).toContain('History');
    expect(joined).toContain('Account');
  });

  for (const w of WIDTHS) {
    test(`no horizontal overflow in dashboard @${w}px`, async ({ page, request }) => {
      await page.setViewportSize({ width: w, height: 900 });
      await login(request, page);
      await page.goto('/');
      await expect(page.locator('#main-app')).toBeVisible();
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
      );
      expect(overflow).toBe(false);
    });
  }

  for (const [key, title] of SERVICES) {
    test(`service form "${title}" opens`, async ({ page, request }) => {
      await login(request, page);
      await page.goto('/');
      await expect(page.locator('#main-app')).toBeVisible();
      await page.locator('.service-tile').first().waitFor({ state: 'visible' });
      await page.evaluate((k) => openService(k), key);
      await expect(page.locator(`#svc-${key}`)).toHaveClass(/open/);
      await expect(page.locator(`#svc-${key} .svc-title`)).toHaveText(title);
      // back returns to dashboard
      await page.locator(`#svc-${key} .svc-back`).click();
      await expect(page.locator(`#svc-${key}`)).not.toHaveClass(/open/);
    });
  }
});

test.describe('admin login screen', () => {
  test('renders the sign-in form', async ({ page }) => {
    await page.goto('/admin.html');
    await expect(page.locator('#login-screen')).toBeVisible();
    await expect(page.locator('#admin-email')).toBeVisible();
    await expect(page.locator('#admin-password')).toBeVisible();
    await expect(page.locator('#login-btn')).toBeVisible();
  });
});