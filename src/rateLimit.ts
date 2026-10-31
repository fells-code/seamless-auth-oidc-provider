/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import type { NextFunction, Request, Response } from 'express';

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

/**
 * A fixed window per client IP, per instance. Each call reaches the API's store, which has no
 * limit of its own on reads, so this keeps one caller from turning these endpoints into a
 * load generator against it.
 */
export function createRateLimiter({ limit, windowMs }: RateLimitOptions) {
  const windows = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    if (windows.size > 10_000) {
      for (const [key, window] of windows) {
        if (window.resetAt <= now) windows.delete(key);
      }
    }
    const key = req.ip ?? 'unknown';
    let window = windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs };
      windows.set(key, window);
    }
    window.count += 1;
    if (window.count > limit) {
      res.set('retry-after', String(Math.ceil((window.resetAt - now) / 1000)));
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}
