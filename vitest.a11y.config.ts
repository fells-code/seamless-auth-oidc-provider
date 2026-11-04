/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { defineConfig } from 'vitest/config';

/** The axe checks of the built hosted pages in a real browser (`npm run test:a11y`). */
export default defineConfig({
  test: {
    include: ['tests/a11y/**/*.a11y.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
