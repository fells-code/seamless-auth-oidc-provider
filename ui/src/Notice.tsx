/*
 * Copyright © 2026 Fells Code, LLC
 * Licensed under the Apache License, Version 2.0
 * See LICENSE file in the project root for full license information
 */

import { type ReactNode, useEffect, useRef } from 'react';

export function Notice({ title, children }: { title: string; children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section role="alert" aria-labelledby="notice-title" className="card notice">
      <h2 id="notice-title" ref={heading} tabIndex={-1}>
        {title}
      </h2>
      <p>{children}</p>
    </section>
  );
}
