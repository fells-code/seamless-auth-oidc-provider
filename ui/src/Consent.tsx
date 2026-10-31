/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { useEffect, useRef } from 'react';

import type { InteractionDetails } from './interactionApi';
import { describeScope } from './scopes';

interface ConsentProps {
  details: InteractionDetails;
  appName: string;
  busy: boolean;
  onAllow: () => void;
  onDeny: () => void;
}

/** ADR D10: the client's name, where it sends you back to, and what it asks for. */
export function Consent({ details, appName, busy, onAllow, onDeny }: ConsentProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  const scopes = details.prompt.missingScopes.length
    ? details.prompt.missingScopes
    : details.scopes;

  return (
    <section aria-labelledby="consent-title" className="card consent">
      <h2 id="consent-title" ref={heading} tabIndex={-1}>
        {details.client.name} wants to use your {appName} account
      </h2>
      {details.client.redirectHost ? (
        <p>
          After this you will be sent to <strong>{details.client.redirectHost}</strong>.
        </p>
      ) : null}
      <h3 className="consent-subtitle">It is asking to</h3>
      <ul className="consent-scopes">
        {scopes.map((scope) => (
          <li key={scope}>{describeScope(scope)}</li>
        ))}
      </ul>
      <p className="consent-warning">
        {details.client.name} is not run by {appName}. Only allow this if you trust it and you
        started this sign-in yourself.
      </p>
      <div className="actions">
        <button type="button" className="primary" onClick={onAllow} disabled={busy}>
          Allow
        </button>
        <button type="button" className="secondary" onClick={onDeny} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}
