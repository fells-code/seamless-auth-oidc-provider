// Runs the plans in plans.json through the conformance suite's REST API and drives the
// front channel with Playwright, because the hosted pages sign in with a passkey (a CDP
// virtual authenticator) that the suite's own HtmlUnit browser cannot provide.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import { chromium } from 'playwright';

import { signIn } from './browser.mjs';

const here = new URL('.', import.meta.url).pathname;
const runDir = process.env.RUN_DIR ?? new URL('../.run/', import.meta.url).pathname;
const suite = process.env.SUITE_URL ?? 'https://localhost:8443';
const moduleTimeoutMs = Number(process.env.MODULE_TIMEOUT_MS ?? 180_000);
const only = process.env.PLANS ? new Set(process.env.PLANS.split(',')) : null;
const onlyModules = process.env.MODULES ? new Set(process.env.MODULES.split(',')) : null;

const plans = JSON.parse(readFileSync(`${here}../plans.json`, 'utf8')).filter(
  (plan) => plan.enabled !== false && (!only || only.has(plan.id)),
);
const expected = JSON.parse(readFileSync(`${here}../expected.json`, 'utf8'));
const resultsDir = `${runDir}/results`;
mkdirSync(`${resultsDir}/screens`, { recursive: true });

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, path, body) {
  const response = await fetch(`${suite}/api/${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new Error(
      `${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`,
    );
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

const query = (params) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
  ).toString();

const spki = readFileSync(`${runDir}/spki.txt`, 'utf8').trim();
const browser = await chromium.launch({
  args: [
    `--ignore-certificate-errors-spki-list=${spki}`,
    '--host-resolver-rules=MAP op.seamless.test 127.0.0.1, MAP localhost.emobix.co.uk 127.0.0.1',
  ],
});
// One account for the whole run: registered by the first sign-in, then its passkey is
// copied into each module's fresh authenticator, as a returning user's device would hold it.
const account = { email: `conformance+${Date.now()}@seamless.test`, credential: null };

async function newBrowserSession() {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  if (account.credential) {
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: account.credential });
  }
  // Carries the sign count forward: the API treats a count that does not grow as a cloned key.
  const remember = async () => {
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    if (credentials[0]) account.credential = credentials[0];
  };
  return { context, page, remember };
}

// A module that asks for a screenshot (the provider's own error page) waits for it.
async function fillPlaceholders(id, screenshot) {
  const entries = await api('GET', `log/${id}`);
  const open = entries.filter((e) => e.upload && !e.img);
  if (!open.length) return false;
  const image = existsSync(screenshot) ? readFileSync(screenshot).toString('base64') : '';
  if (!image) return false;
  for (const entry of open) {
    await fetch(`${suite}/api/log/${id}/images/${entry.upload}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: `data:image/png;base64,${image}`,
    });
  }
  return true;
}

async function runModule(planId, entry, label) {
  const created = await api(
    'POST',
    `runner?${query({ test: entry.testModule, plan: planId, variant: entry.variant })}`,
  );
  const id = created.id;
  const started = Date.now();
  const visited = new Set();
  let session = null;
  let screenshot = null;
  let info;
  try {
    for (;;) {
      info = await api('GET', `info/${id}`);
      if (info.status === 'FINISHED' || info.status === 'INTERRUPTED') break;
      if (Date.now() - started > moduleTimeoutMs) {
        await api('DELETE', `runner/${id}`).catch(() => {});
        info = { ...info, result: 'TIMEOUT' };
        break;
      }
      if (info.status === 'CONFIGURED') {
        await api('POST', `runner/${id}`).catch(() => {});
      }
      if (info.status === 'WAITING') {
        const front = await api('GET', `runner/browser/${id}`).catch(() => null);
        const next = (front?.urls ?? []).find((url) => !visited.has(url));
        if (next) {
          visited.add(next);
          session ??= await newBrowserSession();
          await api('POST', `runner/browser/${id}/visit?${query({ url: next })}`);
          screenshot = `${resultsDir}/screens/${label}-${visited.size}.png`;
          await signIn(session, next, account, screenshot).catch(async (error) => {
            log(`browser step in ${label} failed: ${error.message.split('\n')[0]}`);
            const page = await session.page
              .locator('body')
              .ariaSnapshot()
              .catch(() => '');
            log(`  at ${session.page.url()}\n${page}`);
            await session.page.screenshot({ path: screenshot }).catch(() => {});
          });
          await session.remember();
          continue;
        }
        if (screenshot && (await fillPlaceholders(id, screenshot))) {
          screenshot = null;
          continue;
        }
      }
      await sleep(750);
    }
  } finally {
    await session?.context.close();
  }
  return {
    id,
    status: info.status,
    result: info.result ?? 'UNKNOWN',
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

function expectationFor(planId, testModule) {
  return expected.find((e) => e.plan === planId && e.module === testModule);
}

const rows = [];
let unexpected = 0;
for (const plan of plans) {
  const config = JSON.parse(readFileSync(`${runDir}/configs/${plan.config}.json`, 'utf8'));
  const created = await api(
    'POST',
    `plan?${query({ planName: plan.planName, variant: plan.variant })}`,
    config,
  );
  log(
    `plan ${plan.id}: ${created.modules.length} modules (${suite}/plan-detail.html?plan=${created.id})`,
  );
  for (const entry of created.modules) {
    if (onlyModules && !onlyModules.has(entry.testModule)) continue;
    const label = `${plan.id}-${entry.testModule}`;
    const outcome = await runModule(created.id, entry, label);
    const expectation = expectationFor(plan.id, entry.testModule);
    const bad =
      ['FAILED', 'TIMEOUT', 'UNKNOWN'].includes(outcome.result) || outcome.status === 'INTERRUPTED';
    let verdict = 'ok';
    if (expectation && expectation.result === outcome.result) verdict = 'expected';
    else if (expectation) verdict = 'stale-expectation';
    else if (bad) verdict = 'unexpected';
    if (verdict === 'unexpected' || verdict === 'stale-expectation') unexpected += 1;
    rows.push({
      plan: plan.id,
      module: entry.testModule,
      ...outcome,
      verdict,
      reason: expectation?.reason,
    });
    log(
      `${outcome.result.padEnd(8)} ${verdict.padEnd(17)} ${entry.testModule} (${outcome.seconds}s) ${suite}/log-detail.html?log=${outcome.id}`,
    );
  }
  try {
    const response = await fetch(`${suite}/api/plan/exporthtml/${created.id}`);
    if (response.ok)
      writeFileSync(
        `${resultsDir}/${plan.id}-${created.id}.zip`,
        Buffer.from(await response.arrayBuffer()),
      );
  } catch (error) {
    log(`export of ${plan.id} failed: ${error.message}`);
  }
}
await browser.close();

for (const e of expected) {
  if (
    !onlyModules &&
    (!only || only.has(e.plan)) &&
    plans.some((p) => p.id === e.plan) &&
    !rows.some((r) => r.plan === e.plan && r.module === e.module)
  ) {
    rows.push({
      plan: e.plan,
      module: e.module,
      result: 'NOT RUN',
      verdict: 'stale-expectation',
      reason: e.reason,
    });
    unexpected += 1;
  }
}

const counts = rows.reduce(
  (acc, row) => ({ ...acc, [row.result]: (acc[row.result] ?? 0) + 1 }),
  {},
);
const summary = [
  '## OpenID conformance',
  '',
  `Suite ${process.env.SUITE_VERSION ?? 'release-v5.3.4'}. ${Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ')}. ${unexpected ? `**${unexpected} unexpected**` : 'No unexpected results.'}`,
  '',
  '| Plan | Module | Result | Verdict | Note |',
  '| --- | --- | --- | --- | --- |',
  ...rows.map(
    (r) => `| ${r.plan} | ${r.module} | ${r.result} | ${r.verdict} | ${r.reason ?? ''} |`,
  ),
  '',
].join('\n');
writeFileSync(`${resultsDir}/summary.md`, summary);
writeFileSync(`${resultsDir}/results.json`, JSON.stringify(rows, null, 2));
if (process.env.GITHUB_STEP_SUMMARY)
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
console.log(summary);
process.exit(unexpected ? 1 : 0);
