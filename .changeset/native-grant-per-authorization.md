---
'@seamless-auth/oidc-provider': patch
---

A first-party native client gets a grant of its own for each authorization again. Since 0.4.0 a step-up or second sign-in reused the grant of the first one, so an app that revoked the refresh token it replaced also ended the new sign-in, and a backend's account notices for that user answered `notice_unknown_user`. A sign-in after a sign-out that ended the grant also stopped on "We could not confirm your account". A remembered grant that has ended is now replaced for any first-party client.
