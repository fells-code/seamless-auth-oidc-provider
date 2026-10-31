/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { useAuth } from '@seamless-auth/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Consent } from './Consent';
import {
  finish,
  forgetInteraction,
  getDetails,
  type InteractionDetails,
  type InteractionStep,
  pendingInteraction,
  rememberInteraction,
  sameOriginUrl,
} from './interactionApi';
import { Notice } from './Notice';

const EXPIRED = 'This sign-in request has expired. Go back to the app and start again.';

/**
 * Finishes the OIDC interaction once the bundled screens have signed the user in, or shows
 * consent. It never signs anyone in itself.
 */
export function InteractionPage({ appName }: { appName: string }) {
  const { uid = '' } = useParams();
  const navigate = useNavigate();
  const { isAuthenticated, loading } = useAuth();
  const [details, setDetails] = useState<InteractionDetails | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void getDetails(uid).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        forgetInteraction();
        setMessage(EXPIRED);
        return;
      }
      rememberInteraction({
        ...pendingInteraction(),
        uid,
        clientName: result.data.client.name,
      });
      setDetails(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  const complete = useCallback(
    async (step: InteractionStep) => {
      setBusy(true);
      const result = await finish(uid, step);
      if (result.ok) {
        const target = sameOriginUrl(result.data.redirectTo);
        if (target) {
          forgetInteraction();
          window.location.assign(target);
          return;
        }
        setBusy(false);
        setMessage('Something went wrong. Go back to the app and try again.');
        return;
      }
      setBusy(false);
      started.current = false;
      switch (result.error) {
        case 'login_required':
          navigate('/login', { replace: true });
          return;
        case 'reauthentication_required':
          // Signing out first would end the session this interaction belongs to, so the user
          // signs in again on top of it.
          rememberInteraction({
            uid,
            clientName: details?.client.name ?? '',
            reauthenticate: true,
          });
          navigate('/login', { replace: true });
          return;
        case 'enrollment_required':
          navigate('/register-passkey', { replace: true });
          return;
        case 'account_mismatch':
          setMessage(
            'You are signed in here with a different account from the one this app knows. Sign out of the app, then try again.',
          );
          return;
        case 'interaction_expired':
        case 'interaction_mismatch':
          forgetInteraction();
          setMessage(EXPIRED);
          return;
        default:
          setMessage('Something went wrong. Go back to the app and try again.');
      }
    },
    [uid, navigate, details],
  );

  useEffect(() => {
    if (!details || loading || started.current) return;
    if (details.prompt.name === 'login') {
      if (!isAuthenticated) {
        navigate('/login', { replace: true });
        return;
      }
      started.current = true;
      void complete('login');
    } else if (details.prompt.name === 'consent' && details.client.firstParty) {
      started.current = true;
      void complete('consent');
    }
  }, [details, loading, isAuthenticated, navigate, complete]);

  if (message) {
    return <Notice title="We could not finish signing you in">{message}</Notice>;
  }
  if (details?.prompt.name === 'consent' && !details.client.firstParty) {
    return (
      <Consent
        details={details}
        appName={appName}
        busy={busy}
        onAllow={() => void complete('consent')}
        onDeny={() => void complete('abort')}
      />
    );
  }
  return (
    <p role="status" className="card status">
      {details ? `Signing you in to ${details.client.name}…` : 'Loading…'}
    </p>
  );
}
