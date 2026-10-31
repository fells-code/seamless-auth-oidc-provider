/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { useEffect, useRef } from 'react';

export type ProviderPageData =
  | { view: 'logout'; action: string; xsrf: string; clientName: string | null }
  | { view: 'signed_out'; clientName: string | null };

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

export function ProviderPage({ appName, page }: { appName: string; page: ProviderPageData }) {
  return page.view === 'logout' ? (
    <Logout appName={appName} page={page} />
  ) : (
    <SignedOut appName={appName} />
  );
}
