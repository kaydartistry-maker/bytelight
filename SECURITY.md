# Security Policy

bytelight is designed as a **single-user, self-hosted** deployment: one operator behind authentication and a private tunnel. Its threat model is *your* machine and *your* accounts — it is not hardened as a public multi-tenant service and should not be exposed as one.

## Reporting a vulnerability

If you find a security issue (auth bypass, secret leakage, injection path, etc.):

- **Do not** open a public issue with exploit details.
- Use GitHub's private vulnerability reporting on this repository, or open a bare issue saying "security — requesting private contact" with no details.

You'll get a response as soon as the maintainer is able — this is a solo project; there is no security team or SLA.

## Supported versions

Only the current `main` branch is supported. There are no backported fixes.
