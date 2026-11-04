---
'@seamless-auth/oidc-provider': patch
---

A request object that asks for `response_mode=form_post` now gets its `request_not_supported` refusal by form post rather than in the query string. Request objects are still not supported. Only `response_mode` is read from the refused object, without verifying it, and only the value `form_post` changes anything: the error still goes only to the request's own `redirect_uri` once it is checked against the client's registered URIs, and no other value from the object is used or shown. This lets the Form Post OP conformance profile pass `oidcc-unsigned-request-object-supported-correctly-or-rejected-as-unsupported`.
