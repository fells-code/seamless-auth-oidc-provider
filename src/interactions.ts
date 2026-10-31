/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcAuthContext } from '@seamless-auth/types';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import type Provider from 'oidc-provider';
import { errors, type InteractionResults } from 'oidc-provider';

import type { OidcApiClient } from './apiClient.js';
import { authRequirements, stepUpMethods, unmetRequirements } from './authRequirements.js';
import { readFirstPartySession } from './firstPartySession.js';
import { createSameOriginGuard } from './originGuard.js';
import { bindSession } from './requestContext.js';

export const FIRST_PARTY_CLIENT_PROPERTY = 'urn:seamless:first_party';

export interface InteractionRouterOptions {
  provider: Provider;
  client: OidcApiClient;
  issuerOrigin: string;
  adapterCookieSecret: string;
  accessCookieName: string;
}

type Interaction = Awaited<ReturnType<Provider['interactionDetails']>>;

interface PromptDetails {
  missingOIDCScope?: string[];
  missingOIDCClaims?: string[];
  missingResourceScopes?: Record<string, string[]>;
}

class InteractionRefusal extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(error);
    this.name = 'InteractionRefusal';
  }
}

function stringParam(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  return typeof value === 'string' && value ? value : undefined;
}

function promptDetails(interaction: Interaction): PromptDetails {
  return interaction.prompt.details as PromptDetails;
}

function loginResult(accountId: string, context: OidcAuthContext): InteractionResults['login'] {
  return {
    accountId,
    ts: context.authTime,
    ...(context.amr.length > 0 ? { amr: [...context.amr] } : {}),
    ...(context.acr ? { acr: context.acr } : {}),
  };
}

/**
 * The JSON routes the hosted pages use to finish an OIDC interaction. They never sign anyone
 * in: the pages do that through this service's first-party adapter routes, and these routes
 * only read the resulting session.
 */
export function createInteractionRouter(options: InteractionRouterOptions): Router {
  const { provider, client } = options;
  const router = express.Router();

  router.use('/interaction', cookieParser(), createSameOriginGuard(options.issuerOrigin));

  async function load(req: Request, res: Response): Promise<Interaction> {
    const interaction = await provider.interactionDetails(req, res);
    // The cookie names the browser's current interaction. A page left open from an earlier
    // one must not act on this one.
    if (interaction.uid !== req.params.uid) {
      throw new InteractionRefusal(409, 'interaction_mismatch');
    }
    return interaction;
  }

  async function clientFor(interaction: Interaction) {
    const clientId = stringParam(interaction.params, 'client_id');
    const found = clientId ? await provider.Client.find(clientId) : undefined;
    if (!found) {
      throw new InteractionRefusal(400, 'invalid_client');
    }
    return found;
  }

  function firstPartySession(req: Request) {
    const cookies = req.cookies as Record<string, string | undefined>;
    const result = readFirstPartySession(
      cookies[options.accessCookieName],
      options.adapterCookieSecret,
    );
    if (result.rejection) {
      throw new InteractionRefusal(result.rejection.status, result.rejection.error);
    }
    return result.session;
  }

  router.get(
    '/interaction/:uid/details',
    handle(async (req, res) => {
      const interaction = await load(req, res);
      const found = await clientFor(interaction);
      const details = promptDetails(interaction);
      const redirectUri = stringParam(interaction.params, 'redirect_uri');
      res.set('cache-control', 'no-store');
      res.json({
        uid: interaction.uid,
        prompt: {
          name: interaction.prompt.name,
          reasons: interaction.prompt.reasons,
          missingScopes: details.missingOIDCScope ?? [],
          missingClaims: details.missingOIDCClaims ?? [],
        },
        client: {
          id: found.clientId,
          name: found.clientName ?? found.clientId,
          firstParty: found[FIRST_PARTY_CLIENT_PROPERTY] === true,
          redirectHost: redirectUri ? new URL(redirectUri).host : null,
        },
        scopes: (stringParam(interaction.params, 'scope') ?? '').split(' ').filter(Boolean),
        loginHint: stringParam(interaction.params, 'login_hint') ?? null,
      });
    }),
  );

  router.post(
    '/interaction/:uid/login',
    express.json({ limit: '1kb' }),
    handle(async (req, res) => {
      const afterStepUp =
        typeof req.body === 'object' && req.body !== null && req.body.afterStepUp === true;
      const session = firstPartySession(req);
      const interaction = await load(req, res);
      if (interaction.prompt.name !== 'login') {
        throw new InteractionRefusal(409, 'login_not_requested');
      }
      // Switching accounts would need the provider session ended first, which is
      // RP-initiated logout's job, so the hosted pages sign out of the old one instead.
      if (interaction.session?.accountId && interaction.session.accountId !== session.userId) {
        throw new InteractionRefusal(409, 'account_mismatch');
      }
      const found = await clientFor(interaction);

      bindSession(session.sessionId);

      // The API answers the auth context only for a session holding a grant for the client,
      // so the grant is saved first. It starts empty: the consent step fills it.
      const grant = new provider.Grant({ accountId: session.userId, clientId: found.clientId });
      const grantId = await grant.save();

      const context = await client.authContext(session.sessionId, found.clientId);
      const refusal =
        !context || !context.active || context.userId !== session.userId
          ? new InteractionRefusal(401, 'login_required')
          : context.recovery
            ? new InteractionRefusal(403, 'enrollment_required')
            : undefined;
      if (refusal || !context) {
        // A grant left behind would bind the session to the client without a sign-in.
        await grant.destroy();
        throw refusal ?? new InteractionRefusal(401, 'login_required');
      }

      const unmet = unmetRequirements(
        authRequirements(interaction.params),
        context,
        interaction.iat,
      );
      if (unmet) {
        await grant.destroy();
        if (!afterStepUp) {
          throw new InteractionRefusal(409, 'step_up_required', {
            methods: stepUpMethods(unmet, context),
          });
        }
        // A weaker step-up than the request needs (a synced passkey for phrh, say) ends the
        // request instead of issuing a lower acr.
        const redirectTo = await provider.interactionResult(
          req,
          res,
          {
            error: 'unmet_authentication_requirements',
            error_description: 'the requested authentication could not be obtained',
          },
          { mergeWithLastSubmission: false },
        );
        res.json({ redirectTo });
        return;
      }

      const redirectTo = await provider.interactionResult(req, res, {
        login: loginResult(session.userId, context),
        consent: { grantId },
      });
      res.json({ redirectTo });
    }),
  );

  router.post(
    '/interaction/:uid/consent',
    handle(async (req, res) => {
      const session = firstPartySession(req);
      const interaction = await load(req, res);
      if (interaction.prompt.name !== 'consent') {
        throw new InteractionRefusal(409, 'consent_not_requested');
      }
      const accountId = interaction.session?.accountId;
      if (!accountId || accountId !== session.userId) {
        throw new InteractionRefusal(409, 'account_mismatch');
      }
      const found = await clientFor(interaction);

      const existing = interaction.grantId
        ? await provider.Grant.find(interaction.grantId)
        : undefined;
      const grant =
        existing && existing.accountId === accountId && existing.clientId === found.clientId
          ? existing
          : new provider.Grant({ accountId, clientId: found.clientId });

      const details = promptDetails(interaction);
      if (details.missingOIDCScope?.length) {
        grant.addOIDCScope(details.missingOIDCScope.join(' '));
      }
      if (details.missingOIDCClaims?.length) {
        grant.addOIDCClaims(details.missingOIDCClaims);
      }
      for (const [indicator, scopes] of Object.entries(details.missingResourceScopes ?? {})) {
        grant.addResourceScope(indicator, scopes.join(' '));
      }
      const grantId = await grant.save();

      const redirectTo = await provider.interactionResult(
        req,
        res,
        { consent: { grantId } },
        { mergeWithLastSubmission: true },
      );
      res.json({ redirectTo });
    }),
  );

  router.post(
    '/interaction/:uid/abort',
    handle(async (req, res) => {
      await load(req, res);
      const redirectTo = await provider.interactionResult(
        req,
        res,
        { error: 'access_denied', error_description: 'End-User aborted interaction' },
        { mergeWithLastSubmission: false },
      );
      res.json({ redirectTo });
    }),
  );

  return router;
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((error: unknown) => {
      if (error instanceof InteractionRefusal) {
        res.status(error.status).json({ ...error.extra, error: error.error });
        return;
      }
      if (error instanceof errors.SessionNotFound) {
        res.status(404).json({ error: 'interaction_expired' });
        return;
      }
      next(error);
    });
  };
}
