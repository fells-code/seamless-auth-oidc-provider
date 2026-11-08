/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

const DESCRIPTIONS: Record<string, string> = {
  openid: 'Confirm who you are',
  email: 'See your email address',
  phone: 'See your phone number',
  seamless: 'See your roles and organization',
  permissions: 'See your roles, permissions and organization roles',
  custom_claims: 'See the extra account details your administrator set for it',
  offline_access: 'Stay signed in when you are not using it',
};

export function describeScope(scope: string): string {
  return DESCRIPTIONS[scope] ?? scope;
}
