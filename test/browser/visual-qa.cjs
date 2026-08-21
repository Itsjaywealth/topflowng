const { chromium } = require('@playwright/test');

const BASE = 'http://127.0.0.1:3210';
const WIDTHS = [320, 360, 375, 390, 412, 430, 768, 1024, 1280, 1366, 1440, 1600, 1920];
const MOBILE = [320, 360, 375, 390, 412, 430];
const OUT = 'test-results/visual-qa';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  // Register a fresh user
  const stamp = Date.now();
  const reg = await fetch(BASE + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: 'Visual QA',
      email: `vqa${stamp}@test.local`,
      phone: '081' + stamp.toString().slice(-8),
      password: 'vqaSecret123',
    }),
  });
  if (reg.status !== 201) throw new Error('register failed: ' + reg.status);
  const { token } = await reg.json();
  await page.addInitScript((t) => localStorage.setItem('tf_token', t), token);

  for (const theme of ['light', 'dark']) {
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: w < 768 ? 844 : 1000 });
      await page.goto(BASE + '/');
      await page.waitForTimeout(400);
      await page.evaluate((t) => localStorage.setItem('tf_theme', t), theme);
      await page.reload();
      await page.waitForSelector('#main-app', { timeout: 15000 });
      await page.waitForTimeout(700);
      await page.screenshot({ path: `${OUT}/${theme}-${w}-home.png`, fullPage: false });

      // Services hub
      await page.evaluate(() => goTab('services'));
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${OUT}/${theme}-${w}-services.png` });

      // Service bottom sheet / panel
      await page.evaluate(() => openService('airtime'));
      await page.waitForTimeout(450);
      await page.screenshot({ path: `${OUT}/${theme}-${w}-svc-airtime.png` });
      await page.evaluate(() => closeService('airtime'));

      // Activity
      await page.evaluate(() => goTab('history'));
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${OUT}/${theme}-${w}-activity.png` });

      // Account
      await page.evaluate(() => goTab('account'));
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${OUT}/${theme}-${w}-account.png`, fullPage: w >= 768 });
    }
  }

  // Overflow check across widths
  const problems = [];
  for (const w of WIDTHS) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(BASE + '/');
    await page.waitForSelector('#main-app', { timeout: 15000 });
    for (const tab of ['home', 'services', 'history', 'account']) {
      await page.evaluate((t) => goTab(t), tab);
      await page.waitForTimeout(250);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (over > 1) problems.push(`${w}px ${tab}: horizontal overflow ${over}px`);
    }
  }
  console.log(problems.length ? 'OVERFLOW ISSUES:\n' + problems.join('\n') : 'No horizontal overflow at any width.');

  await browser.close();
  console.log('Visual QA screenshots written to ' + OUT);
})();
