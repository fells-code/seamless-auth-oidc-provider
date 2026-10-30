/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { OidcSignRefusalCode } from '@seamless-auth/types';

export class OidcApiError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    message = `Seamless Auth API answered ${status} for ${path}`,
  ) {
    super(message);
    this.name = 'OidcApiError';
  }
}

export class OidcSignRefusedError extends Error {
  constructor(
    readonly code: OidcSignRefusalCode,
    message = `Seamless Auth API refused to sign: ${code}`,
  ) {
    super(message);
    this.name = 'OidcSignRefusedError';
  }
}

export class OidcProviderDisabledError extends Error {
  constructor() {
    super('The Seamless Auth API has the OpenID Provider disabled (oidc_provider_enabled is off)');
    this.name = 'OidcProviderDisabledError';
  }
}

export class OidcContractMismatchError extends Error {
  constructor(
    readonly apiVersion: number,
    readonly edgeVersion: number,
  ) {
    super(
      `The Seamless Auth API speaks /oidc contract version ${apiVersion}, this service speaks ${edgeVersion}`,
    );
    this.name = 'OidcContractMismatchError';
  }
}
