/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
    assetsDir: 'assets',
    sourcemap: false,
    // Inlined assets would arrive as data: URIs, which the CSP only allows for images.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 600,
  },
});
