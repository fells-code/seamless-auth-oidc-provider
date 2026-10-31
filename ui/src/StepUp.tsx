/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { useAuth } from '@seamless-auth/react';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import type { StepUpMethod } from './interactionApi';

interface StepUpProps {
  clientName: string;
  methods: StepUpMethod[];
  onVerified: () => void;
  onCancel: () => void;
}

/**
 * The app asked for a stronger or more recent sign-in than the session has. The user proves
 * it again on the same session, so the API records the step-up where the tokens read it.
 */
export function StepUp({ clientName, methods, onVerified, onCancel }: StepUpProps) {
  const { verifyStepUpWithPasskey, verifyStepUpWithTotp } = useAuth();
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  useEffect(() => heading.current?.focus(), []);

  async function withPasskey() {
    setBusy(true);
    setError(null);
    const result = await verifyStepUpWithPasskey();
    setBusy(false);
    if (!result.error) {
      onVerified();
      return;
    }
    setError('We could not confirm it was you. Try again with your passkey.');
  }

  async function withTotp(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await verifyStepUpWithTotp(code.trim());
    setBusy(false);
    setCode('');
    if (!result.error) {
      onVerified();
      return;
    }
    setError('That code did not work. Enter the code your authenticator app shows now.');
  }

  return (
    <section aria-labelledby="step-up-title" className="card">
      <h2 id="step-up-title" ref={heading} tabIndex={-1}>
        Confirm it is you
      </h2>
      <p>{clientName} needs you to confirm your sign-in before it continues.</p>
      {error ? (
        <p role="alert" className="error">
          {error}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={() => void withPasskey()}
          disabled={busy}
        >
          Use your passkey
        </button>
      </div>
      {methods.includes('totp') ? (
        <form className="step-up-totp" onSubmit={(event) => void withTotp(event)}>
          <label htmlFor="step-up-code">Or enter a code from your authenticator app</label>
          <input
            id="step-up-code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            disabled={busy}
          />
          <button type="submit" className="secondary" disabled={busy || code.trim().length !== 6}>
            Confirm with code
          </button>
        </form>
      ) : null}
      <div className="actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}
