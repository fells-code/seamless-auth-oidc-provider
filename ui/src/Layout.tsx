/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { ReactNode } from 'react';

import { pendingInteraction } from './interactionApi';

export function Layout({
  appName,
  logoUrl,
  children,
}: {
  appName: string;
  logoUrl?: string;
  children: ReactNode;
}) {
  const pending = pendingInteraction();
  return (
    <div className="page">
      <header className="brand">
        {logoUrl ? <img className="brand-logo" src={logoUrl} alt="" /> : null}
        <h1 className="brand-name">{appName}</h1>
        {pending ? (
          <p className="brand-context">
            Signing in to continue to <strong>{pending.clientName}</strong>
          </p>
        ) : null}
      </header>
      <main className="content" id="main">
        {children}
      </main>
    </div>
  );
}
