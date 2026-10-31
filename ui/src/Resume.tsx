/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

import { pendingInteraction } from './interactionApi';

/** Where the bundled screens land after a sign-in: back to the interaction that sent them. */
export function Resume() {
  const navigate = useNavigate();
  const pending = pendingInteraction();

  useEffect(() => {
    if (pending) {
      navigate(`/interaction/${encodeURIComponent(pending.uid)}`, { replace: true });
    }
  }, [pending, navigate]);

  if (pending) {
    return (
      <p role="status" className="card status">
        Continuing…
      </p>
    );
  }
  return (
    <section aria-labelledby="done-title" className="card">
      <h2 id="done-title">You are signed in</h2>
      <p>You can close this tab and go back to the app.</p>
    </section>
  );
}
