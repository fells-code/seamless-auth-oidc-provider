/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { useEffect, useRef } from 'react';

interface ConfirmProps {
  clientName: string;
  account: string;
  busy: boolean;
  onContinue: () => void;
  onCancel: () => void;
}

/**
 * RFC 8252 section 8.6: any program on the device can receive a native app's redirect, so a
 * first-party native app still waits for the user to say they started this sign-in.
 */
export function Confirm({ clientName, account, busy, onContinue, onCancel }: ConfirmProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  return (
    <section aria-labelledby="confirm-title" className="card">
      <h2 id="confirm-title" ref={heading} tabIndex={-1}>
        Continue to {clientName}?
      </h2>
      <p>
        You are signed in as <strong className="confirm-account">{account}</strong>.
      </p>
      <p>
        Only continue if you started signing in to {clientName} with this account, on this device,
        just now.
      </p>
      <div className="actions">
        <button type="button" className="primary" onClick={onContinue} disabled={busy}>
          Continue to {clientName}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}

interface AccountUnknownProps {
  clientName: string;
  busy: boolean;
  onCancel: () => void;
}

/** ADR 0003 X8: a person approves a client and an account, never a client alone. */
export function AccountUnknown({ clientName, busy, onCancel }: AccountUnknownProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);

  return (
    <section role="alert" aria-labelledby="account-unknown-title" className="card notice">
      <h2 id="account-unknown-title" ref={heading} tabIndex={-1}>
        We could not confirm your account
      </h2>
      <p>
        This sign-in to {clientName} cannot continue, because we cannot show which account it would
        use. Cancel, then start again from {clientName}.
      </p>
      <div className="actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}
