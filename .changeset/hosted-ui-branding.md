---
'@seamless-auth/oidc-provider': minor
---

The hosted pages take their branding from the API's `hosted_ui` system config, read from `GET /oidc/config` on each page load like `app_name`. `appName` overrides the name, `logoUrl` shows a logo (its origin is added to the page's `img-src`), `colors` and `fontFamily` become CSS variables in a `<style>` carrying the response's nonce. A branded palette replaces the dark palette, since it was chosen against a light page. The bundled sign-in screens now take their accent, text, surface and border colors from the same variables, so branding reaches every screen. Needs `@seamless-auth/types` with `hostedUi` on the config response.
