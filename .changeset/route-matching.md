---
'@seamless-auth/oidc-provider': patch
---

The device poll throttle and the resume cookie check now match paths the way the provider's router does. A device client polling `/token/` was never told `slow_down`, because the throttle only recognised the exact path `/token`; it now follows the provider's own routing, so every spelling the provider accepts is throttled. The check that a resumed authorization is the one the resume cookie names now also covers `/authorize/<uid>/` and a differently cased `/AUTHORIZE/<uid>`.
