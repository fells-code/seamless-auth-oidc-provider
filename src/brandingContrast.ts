/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { HostedUi } from '@seamless-auth/types';

type ColorName = keyof NonNullable<HostedUi['colors']>;

/** The stylesheet's light palette (ui/src/styles.css), which unset colors fall back to. */
const DEFAULT_COLORS: Record<ColorName, string> = {
  primary: '#1f4fd1',
  onPrimary: '#ffffff',
  background: '#f5f6f8',
  surface: '#ffffff',
  text: '#1a1d21',
  muted: '#4a515b',
};

/**
 * The pairs the hosted pages draw. Text needs 4.5:1 (WCAG 1.4.3). The primary color is also
 * the focus ring on the page background, which needs 3:1 (1.4.11).
 */
const PAIRS: { foreground: ColorName; background: ColorName; minimum: number }[] = [
  { foreground: 'text', background: 'background', minimum: 4.5 },
  { foreground: 'text', background: 'surface', minimum: 4.5 },
  { foreground: 'muted', background: 'background', minimum: 4.5 },
  { foreground: 'muted', background: 'surface', minimum: 4.5 },
  { foreground: 'onPrimary', background: 'primary', minimum: 4.5 },
  { foreground: 'primary', background: 'surface', minimum: 4.5 },
  { foreground: 'primary', background: 'background', minimum: 3 },
];

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const digits = hex.slice(1);
  // An 8-digit color's alpha is ignored: the check reads it as opaque.
  const full =
    digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((index) => channel(parseInt(full.slice(index, index + 2), 16)));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** The color pairs a branded palette leaves below WCAG 2.2 AA, as readable lines. */
export function brandingContrastProblems(hostedUi: HostedUi | undefined): string[] {
  const colors = hostedUi?.colors;
  if (!colors || Object.keys(colors).length === 0) {
    return [];
  }
  const palette = { ...DEFAULT_COLORS, ...colors };
  return PAIRS.flatMap(({ foreground, background, minimum }) => {
    const ratio = contrastRatio(palette[foreground], palette[background]);
    return ratio < minimum
      ? [
          `${foreground} ${palette[foreground]} on ${background} ${palette[background]} is ${ratio.toFixed(2)}:1, needs ${minimum}:1`,
        ]
      : [];
  });
}
