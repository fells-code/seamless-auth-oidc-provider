# Accessibility audit: hosted pages, WCAG 2.2 AA

Issue: [#37](https://github.com/fells-code/seamless-auth-oidc-provider/issues/37). Audited
2026-11-03 against `@seamless-auth/react` 0.19.2. ADR 0001 D7 makes WCAG 2.2 AA the bar for
every page this service serves.

## What was checked

Every page a person can land on, rendered from the built UI (`dist/ui`) with the real
serve-time branding, CSP and nonce:

| Page                         | Owner                            | State(s) checked                          |
| ---------------------------- | -------------------------------- | ----------------------------------------- |
| Sign-in                      | bundled (`@seamless-auth/react`) | new account, returning user, failed start |
| Consent (third-party app)    | this repo (`Consent.tsx`)        | scopes, redirect host, resource scopes    |
| "Continue to <app>" (native) | this repo (`Confirm.tsx`)        | confirmation card                         |
| Step-up                      | this repo (`StepUp.tsx`)         | passkey and authenticator code            |
| Expired sign-in request      | this repo (`Notice.tsx`)         | notice                                    |
| Device code entry            | this repo (`ProviderPage.tsx`)   | empty, and with an error                  |
| Device confirmation          | this repo                        | code, app name, scopes                    |
| Device signed in             | this repo                        | done                                      |
| Sign-out confirmation        | this repo                        | with an app name                          |
| Signed out                   | this repo                        | done                                      |
| Error page (#32)             | this repo                        | `invalid_redirect_uri` with a description |
| Passkey enrollment           | bundled                          | with a platform authenticator             |
| Recovery codes               | bundled                          | codes shown                               |

Each page was checked in four themes: the default palette in light and dark, and a custom
`hosted_ui` branding (name, logo, all six colors, a serif font stack) with a light and a
dark color-scheme preference. A branded palette turns the dark palette off, so the last two
should match, and do.

## How

**Automated, in CI.** `npm run test:a11y` (`tests/a11y/hostedPages.a11y.ts`, the `a11y` job
in `.github/workflows/ci.yml`) builds the UI, serves it through `createHostedPagesRouter`
and the hosted page renderer, answers the API calls the pages make with fixtures, and opens
each page in Chromium with a virtual platform authenticator. For each page and theme it runs:

- **axe** (`@axe-core/playwright` 4.14) with the tags `wcag2a`, `wcag2aa`, `wcag21a`,
  `wcag21aa` and `wcag22aa`. Any violation fails the test.
- **Keyboard** (2.1.1, 2.4.7): Tab through the page; every link, enabled button and input in
  `main` must be reached, and each must show a focus indicator (outline or box shadow).
- **Reflow** (1.4.10): at 320 by 640 CSS pixels with the custom branding, the page must not
  scroll sideways.

**Manual review** of the code and the rendered pages for what axe cannot judge: focus
management between views, error identification and association, page titles, non-text
contrast of field edges, input purpose, status messages, and accessible authentication.
No screen reader pass (VoiceOver, NVDA) was done; that is listed under what remains.

## Results before the fixes

The first run of the axe check (commit `test(a11y): check the hosted pages with axe and the
keyboard`) failed 10 of 80 checks, all `color-contrast` (serious) on the bundled sign-in
screen. Every page owned by this repo passed axe and the keyboard pass.

| Theme          | Element                                         | Colors                 | Ratio |
| -------------- | ----------------------------------------------- | ---------------------- | ----- |
| default, light | sign-in mode toggle ("Already have an account") | `#60a5fa` on `#ffffff` | 2.54  |
| default, light | sign-in error text                              | `#f87171` on `#ffffff` | 2.76  |
| default, dark  | hovered Login button                            | `#0b1530` on `#1d4ed8` | 2.69  |
| custom (both)  | sign-in mode toggle                             | `#60a5fa` on `#fffdf8` | 2.50  |
| custom (both)  | sign-in error text                              | `#f87171` on `#fffdf8` | 2.72  |

Cause: the bundled screens read `--seamless-accent-soft`, `--seamless-danger` and
`--seamless-accent-hover`, which this service's stylesheet never set, so the screens' own
fallback colors applied. The colors come from the bundled CSS, but setting the variables is
the host's job, so the fix is here and the bundled CSS is unchanged.

Manual review found, in this repo:

- **1.4.11 Non-text contrast.** Text field edges (device code, authenticator code, and the
  bundled fields, which read `--seamless-border`) were `#c4c9d1`: 1.66:1 on white, 1.54:1 on
  the page background. Dark: `#454c56` on `#1c1f24`, 1.91:1.
- **2.4.2 Page titled.** Every page was titled "Sign in to <app>", including sign-out, the
  device pages and the error page.
- **3.3.1 Error identification.** The device code error was announced (`role="alert"`) and
  the field marked `aria-invalid`, but the message was not tied to the field.
- **1.4.3 under custom branding.** `hosted_ui.colors` accepts any hex color, so an adopter can
  pick a palette below AA and nothing says so.

## What was fixed

In `ui/src/styles.css`:

- Set every variable the bundled screens read: `--seamless-accent-soft` and
  `--seamless-accent-hover` follow the primary color (so they follow branding too),
  `--seamless-danger`, `--seamless-success` and `--seamless-warning` take AA colors for each
  scheme (`#b42318`, `#1a7f37`, `#8a4b00` light; `#ffb4ab`, `#7ee2a8`, `#facc15` dark), and
  `--seamless-accent-muted` and `--seamless-surface-hover` are derived from the palette.
- Border color `#7a828e` (3.59:1 or better on both light surfaces, 3.63:1 on the custom
  background) and `#8a93a0` dark (5.32:1), so every field edge meets 3:1.
- Action rows wrap, so long button labels ("Only sign out of <app>") reflow at 320px.
- The inline error marker uses the danger color rather than the primary color.

In `ui/src/ProviderPage.tsx`: the device code error has an id and the field names it with
`aria-describedby`.

In `src/hostedPages.ts`: provider-rendered pages are titled for what they do ("Sign out of
<app>", "Signed out of <app>", "Sign in on a device with <app>", "Device signed in with
<app>", "<app>: we could not continue"). The SPA's own pages keep "Sign in to <app>".

In `src/brandingContrast.ts` and the renderer: when the hosted pages first render with a
`hosted_ui` palette, and again whenever it changes, the service checks the pairs the pages
draw (text and muted on background and surface, on-primary on primary at 4.5:1; primary on
surface at 4.5:1 since it is link text; primary on background at 3:1 as the focus ring) and
logs one warning naming each pair below AA. It warns rather than refuses, since the palette
is the adopter's choice and refusing would take sign-in down.

## Results after the fixes

`npm run test:a11y`: 96 of 96 checks pass. That is 16 page states: axe in each of the 4
themes (64), the keyboard pass in the default theme (16) and reflow with the custom branding
(16). The reflow check was added with the fixes, so the first run had 80 checks.

| Page                         | axe, 4 themes | Keyboard | Reflow 320px | Manual           |
| ---------------------------- | ------------- | -------- | ------------ | ---------------- |
| Sign-in (3 states)           | pass          | pass     | pass         | see remaining    |
| Consent                      | pass          | pass     | pass         | pass             |
| "Continue to <app>" (native) | pass          | pass     | pass         | pass             |
| Step-up                      | pass          | pass     | pass         | pass             |
| Expired sign-in request      | pass          | pass     | pass         | pass             |
| Device code entry (2 states) | pass          | pass     | pass         | pass after fixes |
| Device confirmation          | pass          | pass     | pass         | pass             |
| Device signed in             | pass          | pass     | pass         | pass             |
| Sign-out confirmation        | pass          | pass     | pass         | pass after fixes |
| Signed out                   | pass          | pass     | pass         | pass after fixes |
| Error page                   | pass          | pass     | pass         | pass after fixes |
| Passkey enrollment           | pass          | pass     | pass         | see remaining    |
| Recovery codes               | pass          | pass     | pass         | see remaining    |

Points the manual review confirmed on this repo's pages: each view moves focus to its
heading on render (2.4.3); the page has a banner and a `main` landmark under one `h1`
(1.3.1); every field has a visible label (3.3.2); errors use `role="alert"` (4.1.3); buttons
are at least 44px tall (2.5.8); nothing is sticky, so focus is never covered (2.4.11);
`prefers-reduced-motion` turns off animation. Device sign-in asks the user to copy a code from
another screen; RFC 8628's `verification_uri_complete` fills it in (the page pre-fills
`user_code`), which is the assisting mechanism 3.3.8 asks for, so devices should show that
URI (as a QR code, for example).

## What remains, and where

| Finding                                                                                                                                                                                                                                                                                                    | Criterion | Where it is fixed                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Bundled fallback palette: passkey enrollment `.button`, `.secondary`, `.skip` and recovery codes `.secondary` fail 4.5:1 when the host sets no variables. Under this service's variables the states scanned here pass, but other hosts, and states not scanned (the enrollment skip link), still hit them. | 1.4.3     | [fells-code/seamless-auth-js#230](https://github.com/fells-code/seamless-auth-js/issues/230), in progress. Not forked here.            |
| The sign-in error ("Failed to start sign-in") is plain text with no `role="alert"` or live region, so a screen reader does not hear it.                                                                                                                                                                    | 4.1.3     | `@seamless-auth/react` login screen (seamless-auth-js). Needs an issue.                                                                |
| The sign-in identifier field has `autocomplete="off"`, so the browser cannot offer the user's email or phone.                                                                                                                                                                                              | 1.3.5     | `@seamless-auth/react` login screen (seamless-auth-js). Needs an issue.                                                                |
| The danger, success and warning colors cannot be branded. A custom palette is always light, so this holds today, but a dark custom palette would put the light-mode danger color on a dark surface.                                                                                                        | 1.4.3     | `HostedUiSchema` in seamless-auth-types, then the API and this service.                                                                |
| A `hosted_ui` palette below AA is warned about, not refused.                                                                                                                                                                                                                                               | 1.4.3     | Refusing it belongs to the API's admin validation of `hosted_ui` (seamless-auth-api), where the adopter sets it.                       |
| No screen reader pass (VoiceOver with Safari, NVDA with Firefox) over the flows.                                                                                                                                                                                                                           | 4.1.2 etc | A manual pass before 1.0.                                                                                                              |
| The axe and keyboard checks cover the states listed above. OTP, magic link, account recovery and authenticator screens of the bundled set are not driven by the test.                                                                                                                                      | all       | Extend `tests/a11y/hostedPages.a11y.ts` as those screens are reached in provider flows; their own audit belongs with seamless-auth-js. |
