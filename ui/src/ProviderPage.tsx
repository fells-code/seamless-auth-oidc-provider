/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { useEffect, useRef } from 'react';

export type ProviderPageData =
  | { view: 'logout'; action: string; xsrf: string; clientName: string | null }
  | { view: 'signed_out'; clientName: string | null }
  | {
      view: 'device_input';
      action: string;
      xsrf: string;
      userCode: string | null;
      error: string | null;
    }
  | {
      view: 'device_confirm';
      action: string;
      xsrf: string;
      userCode: string;
      clientName: string | null;
      scopes: string[];
    }
  | { view: 'device_done'; clientName: string | null };

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** A page the provider rendered itself, from the data the edge wrote into it. */
export function readProviderPage(): ProviderPageData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document.getElementById('seamless-page')?.textContent ?? 'null');
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || !('view' in parsed)) {
    return null;
  }
  const data = parsed as Record<string, unknown>;
  const clientName = text(data.clientName);
  const action = text(data.action);
  const xsrf = text(data.xsrf);
  if (data.view === 'logout' && action && xsrf) {
    return { view: 'logout', action, xsrf, clientName };
  }
  if (data.view === 'signed_out') {
    return { view: 'signed_out', clientName };
  }
  if (data.view === 'device_input' && action && xsrf) {
    return {
      view: 'device_input',
      action,
      xsrf,
      userCode: text(data.userCode),
      error: text(data.error),
    };
  }
  const userCode = text(data.userCode);
  if (data.view === 'device_confirm' && action && xsrf && userCode) {
    const scopes = Array.isArray(data.scopes)
      ? data.scopes.filter((scope): scope is string => typeof scope === 'string')
      : [];
    return { view: 'device_confirm', action, xsrf, userCode, clientName, scopes };
  }
  if (data.view === 'device_done') {
    return { view: 'device_done', clientName };
  }
  return null;
}

function useFocusedHeading() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return heading;
}

function Logout({
  appName,
  page,
}: {
  appName: string;
  page: Extract<ProviderPageData, { view: 'logout' }>;
}) {
  const heading = useFocusedHeading();
  return (
    <section aria-labelledby="logout-title" className="card">
      <h2 id="logout-title" ref={heading} tabIndex={-1}>
        Sign out?
      </h2>
      <p>
        This signs you out of {appName} and of every app you signed in to with it
        {page.clientName ? `, including ${page.clientName}` : ''}.
      </p>
      {/* A native form post: the library checks the xsrf value and answers with a redirect. */}
      <form method="post" action={page.action}>
        <input type="hidden" name="xsrf" value={page.xsrf} />
        <div className="actions">
          <button type="submit" className="primary" name="logout" value="yes">
            Sign out
          </button>
          <button type="submit" className="secondary">
            {page.clientName ? `Only sign out of ${page.clientName}` : 'Stay signed in'}
          </button>
        </div>
      </form>
    </section>
  );
}

function SignedOut({ appName }: { appName: string }) {
  const heading = useFocusedHeading();
  return (
    <section aria-labelledby="signed-out-title" className="card">
      <h2 id="signed-out-title" ref={heading} tabIndex={-1}>
        You are signed out
      </h2>
      <p>You can close this page. Sign in again from any app that uses {appName}.</p>
    </section>
  );
}

const DEVICE_ERRORS: Record<string, string> = {
  not_found: 'That code was not found. Check it and try again.',
  expired: 'That code has expired. Start again on your device.',
  already_used: 'That code was already used. Start again on your device.',
  aborted: 'You cancelled. Nothing was signed in.',
  no_code: 'Enter the code your device shows.',
};

function DeviceInput({ page }: { page: Extract<ProviderPageData, { view: 'device_input' }> }) {
  const heading = useFocusedHeading();
  const error = page.error
    ? (DEVICE_ERRORS[page.error] ?? 'Something went wrong. Try again.')
    : null;
  return (
    <section aria-labelledby="device-title" className="card">
      <h2 id="device-title" ref={heading} tabIndex={-1}>
        Sign in on a device
      </h2>
      <p>Enter the code shown on your TV, console or terminal.</p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <form method="post" action={page.action}>
        <input type="hidden" name="xsrf" value={page.xsrf} />
        <div className="device-code-field">
          <label htmlFor="user-code">Code</label>
          <input
            id="user-code"
            name="user_code"
            type="text"
            defaultValue={page.userCode ?? ''}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            required
            aria-invalid={error ? true : undefined}
          />
        </div>
        <div className="actions">
          <button type="submit" className="primary">
            Continue
          </button>
        </div>
      </form>
    </section>
  );
}

// ADR D10: this page comes before any sign-in, names the app, and says to stop unless the
// user started this themselves, because the tokens go to whichever device shows the code.
function DeviceConfirm({ page }: { page: Extract<ProviderPageData, { view: 'device_confirm' }> }) {
  const heading = useFocusedHeading();
  const name = page.clientName ?? 'An app';
  return (
    <section aria-labelledby="device-confirm-title" className="card consent">
      <h2 id="device-confirm-title" ref={heading} tabIndex={-1}>
        {name} wants to sign in on a device
      </h2>
      <p className="consent-warning">
        <strong>Only continue if you started this on your own device</strong> and it shows the code{' '}
        <strong className="user-code">{page.userCode}</strong>. If someone sent you this code or
        link, cancel: continuing would sign them in as you.
      </p>
      {page.scopes.length > 0 ? (
        <p>
          It asks for: <span>{page.scopes.join(', ')}</span>
        </p>
      ) : null}
      <form method="post" action={page.action}>
        <input type="hidden" name="xsrf" value={page.xsrf} />
        <input type="hidden" name="user_code" value={page.userCode} />
        <div className="actions">
          <button type="submit" className="primary" name="confirm" value="yes">
            Continue
          </button>
          <button type="submit" className="secondary" name="abort" value="yes">
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

function DeviceDone({ page }: { page: Extract<ProviderPageData, { view: 'device_done' }> }) {
  const heading = useFocusedHeading();
  return (
    <section aria-labelledby="device-done-title" className="card">
      <h2 id="device-done-title" ref={heading} tabIndex={-1}>
        Your device is signed in
      </h2>
      <p>
        {page.clientName ?? 'The app'} on your device can continue now. You can close this page.
      </p>
    </section>
  );
}

export function ProviderPage({ appName, page }: { appName: string; page: ProviderPageData }) {
  switch (page.view) {
    case 'logout':
      return <Logout appName={appName} page={page} />;
    case 'signed_out':
      return <SignedOut appName={appName} />;
    case 'device_input':
      return <DeviceInput page={page} />;
    case 'device_confirm':
      return <DeviceConfirm page={page} />;
    case 'device_done':
      return <DeviceDone page={page} />;
  }
}
