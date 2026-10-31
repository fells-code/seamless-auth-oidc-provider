/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { RequestHandler } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Refuses a state-changing request unless the browser says it came from this origin.
 *
 * RPs often sit on sibling subdomains, which are same-site, so `SameSite=Lax` cookies still
 * ride their requests and `same-site` is not good enough here. `Sec-Fetch-Site` must be
 * `same-origin` when present, `Origin` must be this origin when present, and a request
 * carrying neither is refused, since only the hosted pages call these routes.
 */
export function createSameOriginGuard(origin: string): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const fetchSite = req.get('sec-fetch-site');
    const requestOrigin = req.get('origin');
    const siteOk = fetchSite === undefined || fetchSite === 'same-origin';
    const originOk =
      requestOrigin === undefined ? fetchSite === 'same-origin' : requestOrigin === origin;
    if (siteOk && originOk) {
      next();
      return;
    }
    res.status(403).json({ error: 'cross_origin_request_blocked' });
  };
}
