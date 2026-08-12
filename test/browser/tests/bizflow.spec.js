'use strict';
const { test, expect } = require('@playwright/test');

// ── BizFlow backend integration ───────────────────────────────────────────────
// Verifies: unauthenticated visitors are routed to topflowng auth, and a signed
// in user's invoices/clients persist server-side across "devices".

test('unauthenticated bizflow redirects to auth with next= return path', async ({ page }) => {
  await page.goto('/bizflow.html');
  await page.waitForURL(/topflowng\.html\?next=bizflow\.html/, { timeout: 10000 });
  expect(new URL(page.url()).searchParams.get('next')).toBe('bizflow.html');
});

test('bizflow data persists server-side across devices', async ({ page, browser }) => {
  const email = `bizflow${Date.now()}@test.local`;
  const reg = await page.request.post('/api/auth/register', {
    data: { fullName: 'BizFlow Owner', email, phone: '070' + String(Date.now()).slice(-8), password: 'bizflowSecret123' },
  });
  expect(reg.status()).toBe(201);
  const { token } = await reg.json();

  // "Device 1": signed in, create a client + invoice.
  const ctx1 = await browser.newContext();
  const p2 = await ctx1.newPage();
  await p2.addInitScript((t) => localStorage.setItem('tf_token', t), token);
  await p2.goto('/bizflow.html');
  await p2.waitForTimeout(1200);
  expect((await p2.locator('#biz-user-name').textContent()).trim()).toBe('BizFlow Owner');

  await p2.click('#nav-crm');
  await p2.locator('#page-crm').getByRole('button', { name: '+ Add Client' }).first().click();
  await p2.waitForTimeout(300);
  await p2.fill('#cl-name', 'Acme Ltd');
  await p2.locator('#client-modal').getByRole('button', { name: 'Save client' }).click();
  await p2.waitForTimeout(300);

  await p2.click('#nav-invoices');
  await p2.locator('#page-invoices').getByRole('button', { name: '+ New Invoice' }).first().click();
  await p2.waitForTimeout(300);
  await p2.selectOption('#inv-client', { label: 'Acme Ltd' });
  await p2.fill('#invoice-items-body input[type="text"]', 'Consulting');
  const nums = p2.locator('#invoice-items-body input[type="number"]');
  await nums.nth(0).fill('1');
  await nums.nth(1).fill('5000');
  await p2.locator('#invoice-modal').getByRole('button', { name: 'Send invoice' }).click();
  await p2.waitForTimeout(2000); // allow debounced cloud PUT
  await expect(p2.locator('#page-invoices')).toContainText('Acme Ltd');

  // "Device 2": fresh context, same token, no local data.
  const ctx2 = await browser.newContext();
  const p3 = await ctx2.newPage();
  await p3.addInitScript((t) => localStorage.setItem('tf_token', t), token);
  await p3.goto('/bizflow.html');
  await p3.waitForTimeout(1200);
  await p3.click('#nav-invoices');
  await p3.waitForTimeout(400);
  await expect(p3.locator('#page-invoices')).toContainText('Acme Ltd');

  await ctx1.close();
  await ctx2.close();
});

test('invoice can be sent to the client by email', async ({ page, browser }) => {
  const email = `bizsend${Date.now()}@test.local`;
  const reg = await page.request.post('/api/auth/register', {
    data: { fullName: 'BizFlow Sender', email, phone: '080' + String(Date.now()).slice(-8), password: 'bizflowSecret123' },
  });
  expect(reg.status()).toBe(201);
  const { token } = await reg.json();

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript((t) => localStorage.setItem('tf_token', t), token);
  await p.goto('/bizflow.html');
  await p.waitForTimeout(1200);

  // Client WITH email.
  await p.click('#nav-crm');
  await p.locator('#page-crm').getByRole('button', { name: '+ Add Client' }).first().click();
  await p.waitForTimeout(300);
  await p.fill('#cl-name', 'Email Co');
  await p.fill('#cl-email', 'client@emailco.test');
  await p.locator('#client-modal').getByRole('button', { name: 'Save client' }).click();
  await p.waitForTimeout(300);

  // Invoice (draft).
  await p.click('#nav-invoices');
  await p.locator('#page-invoices').getByRole('button', { name: '+ New Invoice' }).first().click();
  await p.waitForTimeout(300);
  await p.selectOption('#inv-client', { label: 'Email Co' });
  await p.fill('#invoice-items-body input[type="text"]', 'Design');
  const nums = p.locator('#invoice-items-body input[type="number"]');
  await nums.nth(0).fill('1');
  await nums.nth(1).fill('25000');
  await p.locator('#invoice-modal').getByRole('button', { name: 'Save draft' }).click();
  await p.waitForTimeout(2500); // allow debounced cloud PUT to land

  // Click per-row "Send" and await the API response.
  const respPromise = p.waitForResponse(r => r.url().includes('/api/bizflow/invoices/') && r.url().endsWith('/send') && r.request().method() === 'POST');
  await p.getByRole('button', { name: /Send/ }).first().click();
  const resp = await respPromise;
  expect(resp.status()).toBe(200);

  await p.waitForTimeout(800);
  // Status badge now shows "Sent".
  await expect(p.locator('#page-invoices')).toContainText('Sent');
  await ctx.close();
});

test('payroll month selector is a rolling 6-month list derived from today', async ({ page, browser }) => {
  const email = `bizpay${Date.now()}@test.local`;
  const reg = await page.request.post('/api/auth/register', {
    data: { fullName: 'BizFlow Payroll', email, phone: '090' + String(Date.now()).slice(-8), password: 'bizflowSecret123' },
  });
  expect(reg.status()).toBe(201);
  const { token } = await reg.json();

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.addInitScript((t) => localStorage.setItem('tf_token', t), token);
  await p.goto('/bizflow.html');
  await p.waitForTimeout(1200);
  await p.click('#nav-payroll');
  await p.waitForTimeout(300);

  const sel = p.locator('#payroll-month');
  const opts = sel.locator('option');
  const count = await opts.count();
  expect(count).toBe(6);

  const expected = [];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    expected.push({
      value: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-NG', { month: 'long', year: 'numeric' }),
    });
  }

  const first = await opts.nth(0).textContent();
  const last = await opts.nth(5).textContent();
  expect(first.trim()).toBe(expected[0].label);
  expect(last.trim()).toBe(expected[5].label);
  await expect(sel).toHaveValue(expected[0].value);
  await expect(sel.locator(`option[value="${expected[5].value}"]`)).toHaveCount(1);

  // Selecting a different month re-renders payroll for that month.
  await sel.selectOption(expected[5].value);
  await expect(sel).toHaveValue(expected[5].value);

  // Option values are exactly the rolling 6-month set — no hardcoded months.
  const values = await sel.locator('option').evaluateAll(os => os.map(o => o.value));
  expect(values).toEqual(expected.map(e => e.value));
  await ctx.close();
});