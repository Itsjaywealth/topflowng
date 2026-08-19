/**
 * TopFlowNG — browser UI quality checks (Playwright).
 *
 * Coverage:
 *   - responsive provider-logo layout from 320 through 1920px
 *   - unlabeled inputs and empty accessible names
 *   - essential navigation present
 *   - enabled service purchase forms open; unavailable products stay disabled
 *   - admin login screen renders
 *   - PWA / static asset availability
 */

'use strict';

const { test, expect } = require('@playwright/test');

const WIDTHS = [320, 360, 375, 390, 430, 768, 1024, 1280, 1440, 1920];

const SERVICES = [
  ['airtime', 'Buy airtime'],
  ['data', 'Buy data'],
  ['electricity', 'Pay electricity'],
  ['cable', 'Pay cable TV'],
  ['exam', 'Buy Exam PINs'],
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

  test('marketing rates render from the live server catalogue', async ({ page, request }) => {
    const cat = await (await request.get('/api/vtu/plans')).json();
    const mtn = (cat.data && cat.data.MTN || []).filter((p) => p.price > 0);
    expect(mtn.length).toBeGreaterThan(0);

    await page.goto('/');
    const table = page.locator('#marketing-rate-table');
    await expect(table).toBeVisible();

    const firstPrice = await table.locator('.rate-row strong').first().textContent();
    const expected = `₦${Number(mtn[0].price).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    expect(firstPrice.replace(/,/g, '')).toBe(expected.replace(/,/g, ''));

    const renderedNetworks = await table.locator('.rate-network').allTextContents();
    expect(renderedNetworks).toContain('MTN');
    expect(renderedNetworks.length).toBeGreaterThanOrEqual(4);
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
    '/icons/icon-192.png?v=2',
    '/icons/icon-512.png?v=2',
    '/assets/brand/topflowng-mark.svg',
    '/assets/provider-logos.js',
    '/assets/providers/mtn.svg',
    '/assets/providers/airtel.png',
    '/assets/providers/glo.png',
    '/assets/providers/9mobile.webp',
    '/assets/providers/ikedc.png',
    '/assets/providers/ekedc.png',
    '/assets/providers/aedc.png',
    '/assets/providers/phedc.jpg',
    '/assets/providers/kedc.png',
    '/assets/providers/ibedc.png',
    '/assets/providers/dstv.png',
    '/assets/providers/gotv.png',
    '/assets/providers/startimes.png',
    '/assets/providers/waec.png',
    '/assets/providers/paystack.svg',
    '/assets/providers/vtpass.png',
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

  test('enabled provider logos load, are labeled, and map uniquely', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();
    for (const service of ['airtime', 'data', 'electricity', 'cable', 'exam']) {
      await page.evaluate((name) => openService(name), service);
      const logos = page.locator(`#svc-${service} .provider-choice img.provider-logo`);
      await expect(logos.first()).toBeVisible();
      const audit = await logos.evaluateAll((images) => images.map((img) => ({
        src: new URL(img.src).pathname,
        alt: img.alt,
        loaded: img.complete && img.naturalWidth > 0 && img.naturalHeight > 0,
      })));
      expect(audit.every((item) => item.loaded && item.alt.trim())).toBe(true);
      expect(new Set(audit.map((item) => item.src)).size).toBe(audit.length);
      const tileText = await page.locator(`#svc-${service} .provider-choice`).allTextContents();
      expect(tileText.join('')).not.toMatch(/\p{Extended_Pictographic}/u);
      await page.evaluate((name) => closeService(name), service);
    }
  });

  test('provider brand colors apply on selection', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();
    await page.evaluate(() => openService('airtime'));
    const screen = page.locator('#svc-airtime');
    // Default selected chip is MTN → --brand must resolve to MTN yellow.
    const resolved = await screen.evaluate((el) => getComputedStyle(el).getPropertyValue('--brand').trim());
    expect(resolved.toLowerCase()).toBe('#ffcc00');
    // Switch to Airtel → brand vars must flip to Airtel red.
    const airtelChip = page.locator('#svc-airtime .provider-choice', { hasText: 'Airtel' });
    await airtelChip.click();
    const resolvedAfter = await screen.evaluate((el) => getComputedStyle(el).getPropertyValue('--brand').trim());
    expect(resolvedAfter.toLowerCase()).toBe('#ed1b24');
    // Selected chip border/ink use the brand color (Airtel red #ED1B24).
    await expect.poll(async () => {
      return airtelChip.evaluate((el) => getComputedStyle(el).borderColor);
    }).toBe('rgb(237, 27, 36)');
    await page.evaluate(() => closeService('airtime'));
  });

  test('primary service grid shows only active services', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    // Inactive products are not presented in the primary grid.
    await expect(page.locator('.service-tile', { hasText: 'Recharge Cards' })).toHaveCount(0);
    for (const active of ['Airtime', 'Data', 'Electricity', 'Cable TV', 'Exam PINs']) {
      await expect(page.locator('.service-tile', { hasText: active })).toHaveCount(1);
    }
    await page.evaluate(() => openService('electricity'));
    // All 12 DISCOs verified live on the active provider are selectable.
    for (const disco of ['IKEDC', 'EKEDC', 'AEDC', 'PHEDC', 'KEDC', 'IBEDC', 'JED', 'KAEDCO', 'EEDC', 'BEDC', 'APLE', 'YEDC']) {
      await expect(page.locator('#svc-electricity .provider-choice-name').filter({ hasText: new RegExp(`^${disco}$`) })).toHaveCount(1);
    }
    await page.evaluate(() => closeService('electricity'));
    await page.evaluate(() => openService('exam'));
    for (const body of ['JAMB', 'NECO', 'NABTEB']) {
      await expect(page.locator('#svc-exam .network-chip', { hasText: body })).toHaveAttribute('aria-disabled', 'true');
    }
  });

  test('dashboard has one service grid and search opens the launcher', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await expect(page.locator('#main-app')).toBeVisible();
    await expect(page.locator('h2', { hasText: 'Buy a service' })).toHaveCount(1);
    await expect(page.locator('.service-grid')).toHaveCount(1);
    await expect(page.locator('#quickpay-grid')).toHaveCount(0);
    for (const active of ['Airtime', 'Data', 'Electricity', 'Cable TV', 'Exam PINs']) {
      await expect(page.locator('.service-tile', { hasText: active })).toHaveCount(1);
    }
    await expect(page.locator('.service-tile', { hasText: 'Recharge Cards' })).toHaveCount(0);
    await page.locator('.quickpay-bar .quickpay-search').click();
    const launcher = page.locator('#quickpay-launcher');
    await expect(launcher).toBeVisible();
    await expect(launcher.locator('.quickpay-item', { hasText: 'Airtime' })).toHaveCount(1);
    await expect(launcher.locator('.quickpay-item', { hasText: 'Recharge Cards' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(launcher).toBeHidden();
  });

  test('provider logos remain visible in light and dark themes', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    for (const dark of [false, true]) {
      await page.evaluate((enabled) => document.documentElement.classList.toggle('dark', enabled), dark);
      await page.evaluate(() => openService('electricity'));
      const audit = await page.locator('#svc-electricity .provider-choice img.provider-logo').evaluateAll((images) => images.map((img) => {
        const rect = img.getBoundingClientRect();
        const frame = img.closest('.provider-logo-frame');
        return {
          loaded: img.complete && img.naturalWidth > 0,
          visible: rect.width > 0 && rect.height > 0,
          frame: getComputedStyle(frame).backgroundColor,
        };
      }));
      expect(audit.every((item) => item.loaded && item.visible && item.frame !== 'rgba(0, 0, 0, 0)')).toBe(true);
      await page.evaluate(() => closeService('electricity'));
    }
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
      await expect(page.locator(`#svc-${key}`)).toHaveAttribute('role', 'dialog');
      await expect(page.locator(`#svc-${key}`)).toHaveAttribute('aria-hidden', 'false');
      await expect(page.locator(`#svc-${key} .svc-title`)).toHaveText(title);
      await expect(page.locator(`#svc-${key} .svc-back`)).toBeFocused();
      // back returns to dashboard
      await page.locator(`#svc-${key} .svc-back`).click();
      await expect(page.locator(`#svc-${key}`)).not.toHaveClass(/open/);
      await expect(page.locator(`#svc-${key}`)).toHaveAttribute('aria-hidden', 'true');
    });
  }

  test('button-like controls support keyboard activation and Escape closes service panels', async ({ page, request }) => {
    await login(request, page);
    await page.goto('/');
    await page.locator('.service-tile').first().click();
    await expect(page.locator('#svc-airtime .svc-back')).toBeFocused();
    const glo = page.locator('#svc-airtime .network-chip', { hasText: 'Glo' });
    await glo.focus();
    await glo.press('Enter');
    await expect(glo).toHaveClass(/selected/);
    await expect(glo).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('#svc-airtime')).toHaveAttribute('aria-hidden', 'true');
  });
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
