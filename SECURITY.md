# Security Policy for Seamless Auth

Thank you for taking the time to help make Seamless Auth more secure.

Seamless Auth is a security-sensitive project used to protect authentication flows. As an open-source project, we take vulnerability reporting seriously.

---

## Supported Versions

`@seamless-auth/oidc-provider` is pre-1.0. Only the latest published minor on
[npm](https://www.npmjs.com/package/@seamless-auth/oidc-provider) receives fixes, and there are no
backports to earlier minors. Report against the latest release, and upgrade to it first if you
can.

This service is the public tier of a Seamless Auth deployment: the OpenID Connect endpoints,
the hosted sign-in pages and their cookies. Findings in the protocol handling, cookie and CSRF
protections, the storage adapter, or the signing path to the API are in scope. Findings in the
auth API itself, the SDKs, or `oidc-provider` upstream belong in their own repositories, though
we want to hear how an upstream issue affects this service.

---

## Reporting a Vulnerability

If you believe you’ve found a security issue, **please do NOT open a public GitHub issue**. Instead, report privately via email:

**security@fellscode.com**  
Subject: `Security Issue: seamless-auth-oidc-provider`

When possible, include the following information in your report:

- A clear description of the issue
- Steps to reproduce (proof of concept if available)
- Affected versions or commits
- Suggested mitigation (optional)

We will acknowledge receipt within **3 business days** and work with you on a coordinated disclosure plan.

---

## What to Expect

Once a report is received:

1. We will acknowledge it within **3 business days**
2. We may ask follow-up questions for clarification or reproduction
3. We aim to fix critical vulnerabilities within **30 days**
4. Coordinated disclosure will be managed on a case-by-case basis

We will not publicly discuss security issues until a fix or mitigation is available.

---

## What to _not_ do

Please do not:

- Open a public issue describing a vulnerability
- Share sensitive details publicly
- Attempt to exploit the vulnerability in production or in ways that compromise user data

Responsible disclosure helps protect all users of this project.

---

## Best Practices

Seamless Auth uses modern identity and crypto best practices, but you should always:

- Review configuration and deployment settings carefully
- Rotate signing and session keys periodically
- Use HTTPS and secure cookie settings in production
- Isolate your instance from untrusted networks

---

Thank you for helping keep Seamless Auth secure!
