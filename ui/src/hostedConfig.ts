/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

export interface HostedConfig {
  appName: string;
}

/** Branding the edge writes into the page at serve time. */
export function readHostedConfig(): HostedConfig {
  try {
    const parsed: unknown = JSON.parse(
      document.getElementById('seamless-hosted')?.textContent ?? '{}',
    );
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'appName' in parsed &&
      typeof parsed.appName === 'string'
    ) {
      return { appName: parsed.appName };
    }
  } catch {
    // Fall through to the default.
  }
  return { appName: 'Seamless Auth' };
}
