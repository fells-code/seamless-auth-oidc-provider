/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { brandingContrastProblems, contrastRatio } from '../src/brandingContrast.js';
import { pageTitle } from '../src/hostedPages.js';
import { sendToEdge } from './browser.js';
import { EDGE_CONFIG } from './fakeApi.js';
import { startEdge } from './harness.js';

describe('brandingContrastProblems', () => {
  it('computes WCAG contrast ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#fff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#1f4fd1', '#ffffffcc')).toBeCloseTo(contrastRatio('#1f4fd1', '#fff'));
  });

  it('has nothing to say about the default palette or a sound one', () => {
    expect(brandingContrastProblems(undefined)).toEqual([]);
    expect(brandingContrastProblems({ appName: 'Acme' })).toEqual([]);
    expect(brandingContrastProblems({ colors: {} })).toEqual([]);
    expect(
      brandingContrastProblems({ colors: { primary: '#0b6e4f', background: '#fbf7ef' } }),
    ).toEqual([]);
  });

  it('names each pair below AA, filling unset colors from the defaults', () => {
    expect(brandingContrastProblems({ colors: { primary: '#60a5fa', muted: '#9ca3af' } })).toEqual([
      'muted #9ca3af on background #f5f6f8 is 2.35:1, needs 4.5:1',
      'muted #9ca3af on surface #ffffff is 2.54:1, needs 4.5:1',
      'onPrimary #ffffff on primary #60a5fa is 2.54:1, needs 4.5:1',
      'primary #60a5fa on surface #ffffff is 2.54:1, needs 4.5:1',
      'primary #60a5fa on background #f5f6f8 is 2.35:1, needs 3:1',
    ]);
  });
});

describe('hosted page titles', () => {
  it('name what each page is for', () => {
    expect(pageTitle('Acme')).toBe('Sign in to Acme');
    expect(pageTitle('Acme', { view: 'logout' })).toBe('Sign out of Acme');
    expect(pageTitle('Acme', { view: 'signed_out' })).toBe('Signed out of Acme');
    expect(pageTitle('Acme', { view: 'device_input' })).toBe('Sign in on a device with Acme');
    expect(pageTitle('Acme', { view: 'device_confirm' })).toBe('Sign in on a device with Acme');
    expect(pageTitle('Acme', { view: 'device_done' })).toBe('Device signed in with Acme');
    expect(pageTitle('Acme', { view: 'error' })).toBe('Acme: we could not continue');
    expect(pageTitle('Acme', { view: 'something_new' })).toBe('Sign in to Acme');
  });
});

describe('a branded palette below AA', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is logged once, when the hosted pages first render with it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = { ...EDGE_CONFIG, hostedUi: { colors: { primary: '#60a5fa' } } };
    const { base } = await startEdge(config);

    await sendToEdge(base, '/login');
    await sendToEdge(base, '/login');

    const logged = warn.mock.calls.filter(([message]) => String(message).includes('hosted_ui'));
    expect(logged).toHaveLength(1);
    expect(String(logged[0]![0])).toContain('onPrimary #ffffff on primary #60a5fa is 2.54:1');
  });
});
