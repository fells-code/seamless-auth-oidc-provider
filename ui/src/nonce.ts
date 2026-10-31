/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

// The bundled sign-in screens inject their CSS as <style> elements at runtime, and the page's
// CSP only runs styles carrying this response's nonce. This module is imported first so the
// patch is in place before those screens load.
const nonce = document
  .querySelector<HTMLMetaElement>('meta[name="seamless-csp-nonce"]')
  ?.getAttribute('content');

if (nonce) {
  const createElement = document.createElement.bind(document);
  document.createElement = ((tagName: string, options?: ElementCreationOptions) => {
    const element = createElement(tagName, options);
    if (element instanceof HTMLStyleElement) {
      element.nonce = nonce;
    }
    return element;
  }) as typeof document.createElement;
}

export {};
