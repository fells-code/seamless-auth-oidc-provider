// What a user does on the hosted pages when the suite sends the browser to the provider.
const EDGE = /^https:\/\/op\.seamless\.test:5321\//;
const SUITE = /^https:\/\/localhost\.emobix\.co\.uk:8443\//;
const MAIL = process.env.FAKE_SES_URL ?? 'http://127.0.0.1:4590';

async function otpFor(address, after) {
  for (let i = 0; i < 60; i += 1) {
    const mail = await (await fetch(`${MAIL}/emails/${encodeURIComponent(address)}`)).json();
    const fresh = mail.filter((m) => m.at > after && m.code);
    if (fresh.length) return fresh.at(-1).code;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no code delivered to ${address}`);
}

async function register(page, account) {
  await page.getByLabel(/email address/i).fill(account.email);
  const sentAt = Date.now() - 1000;
  await page.getByRole('button', { name: /^register$/i }).click();
  await page.waitForURL(/verify-email-otp/);
  const code = await otpFor(account.email, sentAt);
  const inputs = page.locator('input');
  if ((await inputs.count()) >= 6) {
    for (let i = 0; i < 6; i += 1) await inputs.nth(i).fill(code[i]);
  } else {
    await inputs.first().fill(code);
  }
  const verify = page.getByRole('button', { name: /verify|continue|submit/i });
  if (await verify.count())
    await verify
      .first()
      .click()
      .catch(() => {});
  await page.waitForURL(/register-passkey|recovery-codes|localhost\.emobix/, { timeout: 20_000 });
  if (page.url().includes('register-passkey')) {
    await page
      .getByRole('button', { name: /register|add|create|continue/i })
      .first()
      .click();
    const modalContinue = page.getByRole('button', { name: /^continue$/i });
    await modalContinue
      .waitFor({ timeout: 5000 })
      .then(() => modalContinue.click())
      .catch(() => {});
  }
  await page.waitForURL(/recovery-codes|localhost\.emobix/, { timeout: 20_000 });
  if (page.url().includes('recovery-codes')) {
    await page.getByLabel(/i have saved/i).check();
    await page.getByRole('button', { name: /^continue$/i }).click();
  }
}

async function signInWithPasskey(page, account) {
  const toSignIn = page.getByRole('button', { name: /already have an account/i });
  if (await toSignIn.count()) await toSignIn.click();
  await page.getByLabel(/email address \/ phone number/i).fill(account.email);
  await page.getByRole('button', { name: /^login$/i }).click();
  const passkey = page.getByRole('button', { name: /passkey/i }).first();
  await passkey
    .waitFor({ timeout: 5000 })
    .then(() => passkey.click())
    .catch(() => {});
  await page.waitForURL((url) => url.pathname !== '/login', { timeout: 15_000 }).catch(() => {});
}

// For the modules that ask for a screenshot of the provider prompting the user.
const evidence = (page, path) => page.screenshot({ path }).catch(() => {});

/** Follows one front-channel URL until the browser is back at the suite or stops on a page. */
export async function signIn(session, url, account, screenshotPath) {
  const { page } = session;
  await page.goto(url).catch(() => {});
  const deadline = Date.now() + 60_000;
  let lastUrl = '';
  let stillSince = Date.now();
  while (Date.now() < deadline) {
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    const current = page.url();
    if (current !== lastUrl) {
      if (process.env.DEBUG_BROWSER) console.log('  browser', current.slice(0, 140));
      lastUrl = current;
      stillSince = Date.now();
    }
    if (SUITE.test(current)) {
      await page
        .locator('#submission_complete')
        .waitFor({ timeout: 3000 })
        .catch(() => {});
      return;
    }
    if (EDGE.test(current)) {
      const path = new URL(current).pathname;
      if (path === '/login') {
        await page
          .getByRole('heading', { level: 2 })
          .waitFor({ timeout: 5000 })
          .catch(() => {});
        await evidence(page, screenshotPath);
        if (account.credential) await signInWithPasskey(page, account);
        else await register(page, account);
        continue;
      }
      if (path.startsWith('/interaction/')) {
        // Both buttons disable themselves while the request is in flight.
        const stepUp = page.getByRole('button', { name: /use your passkey/i });
        if (await stepUp.isEnabled({ timeout: 500 }).catch(() => false)) {
          await evidence(page, screenshotPath);
          await stepUp.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(500);
          continue;
        }
        const allow = page.getByRole('button', { name: /^(allow|continue|accept)/i }).first();
        if (await allow.isEnabled({ timeout: 500 }).catch(() => false)) {
          await evidence(page, screenshotPath);
          await allow.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(500);
          continue;
        }
      }
    }
    // An error page the provider shows instead of redirecting: keep it as evidence.
    if (Date.now() - stillSince > 4000) {
      await page.screenshot({ path: screenshotPath }).catch(() => {});
      return;
    }
    await page.waitForTimeout(250);
  }
  await page.screenshot({ path: screenshotPath }).catch(() => {});
}
