const { test } = require('@playwright/test');
const crypto = require('crypto');
test('2FA can be enabled and disabled from Account → Security', async ({ page, request }) => {
  const email = `tfaui-${Date.now()}@example.com`;
  const reg = await request.post('/api/auth/register', { data: { fullName: 'TFA UI', email, phone: '08091800001', password: 'VqTest123!' } });
  const { token } = await reg.json();
  await page.goto('/topflowng.html');
  await page.evaluate((t) => localStorage.setItem('tf_token', t), token);
  await page.goto('/topflowng.html');
  await page.waitForTimeout(1500);
  await page.evaluate(() => goTab('account'));
  await page.waitForTimeout(500);

  // Enable
  await page.getByRole('button', { name: 'Enable two-factor' }).click();
  await page.waitForSelector('#acct-tfa-secret:not([hidden])');
  const secret = await page.locator('#acct-tfa-secret').textContent();
  if (!secret || secret.length < 16) throw new Error('no setup key shown');
  const counter = Math.floor(Date.now() / 30000);

  // decode base32 manually
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0; const bytes = [];
  for (const ch of secret.toUpperCase()) { value = (value << 5) | ALPHA.indexOf(ch); bits += 5; if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = String((((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3]) % 1000000).padStart(6, '0');
  await page.fill('#acct-tfa-code', code);
  await page.getByRole('button', { name: /Confirm & enable/i }).click();
  await page.waitForTimeout(800);
  const badgeAfterOn = await page.locator('#tfa-status-badge').textContent();

  // Disable
  await page.fill('#acct-tfa-password', 'VqTest123!');
  const counter2 = Math.floor(Date.now() / 30000);
  const buf2 = Buffer.alloc(8); buf2.writeBigUInt64BE(BigInt(counter2));
  const h2 = crypto.createHmac('sha1', Buffer.from(bytes)).update(buf2).digest();
  const off2 = h2[h2.length - 1] & 0xf;
  const code2 = String((((h2[off2] & 0x7f) << 24) | (h2[off2 + 1] << 16) | (h2[off2 + 2] << 8) | h2[off2 + 3]) % 1000000).padStart(6, '0');
  await page.fill('#acct-tfa-code2', code2);
  await page.getByRole('button', { name: 'Turn off' }).click();
  await page.waitForTimeout(1500);
  const badgeAfterOff = await page.locator('#tfa-status-badge').textContent();
  const msg = await page.locator('#acct-tfa-msg').textContent();
  console.log(`BADGE: on="${badgeAfterOn.trim()}" off="${badgeAfterOff.trim()}" msg="${msg}"`);
});
