---
'@seamless-auth/oidc-provider': minor
---

`TRUST_PROXY` now takes a hop count (`2` for a CDN in front of a load balancer) or a comma-separated list of proxy addresses and subnets (`10.0.0.0/8, 172.16.0.5`, or Express's `loopback`, `linklocal` and `uniquelocal`), and is passed to Express's `trust proxy` as is. Behind more than one proxy the edge used to forward the last proxy's address as the client IP, so users shared the API's per-IP rate limits and lockouts. `true` still means one hop and `false` none, so existing deployments are unchanged; a value that is neither a hop count nor valid addresses now stops the service at startup. Keep the container port reachable only through the proxy.
