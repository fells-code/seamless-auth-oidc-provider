---
'@seamless-auth/oidc-provider': patch
---

The hosted pages meet WCAG 2.2 AA with the default palette and a sound custom one (see `docs/accessibility-audit.md`).

- The sign-in screens' mode toggle, error text and hovered button now take this service's palette, and follow `hosted_ui` branding, instead of fallback colors that fell below 4.5:1.
- Text field edges are darker (`#7a828e` light, `#8a93a0` dark) so they meet 3:1, which also darkens card borders.
- Sign-out, device and error pages are titled for what they do rather than "Sign in to <app>".
- The device code error is tied to the code field.
- When the hosted pages render with a `hosted_ui` palette whose pairs fall below AA contrast, the service logs one warning naming each pair. Nothing is refused.
