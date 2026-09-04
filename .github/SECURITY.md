# Security Policy

## Supported Versions

Only the latest released version of ORGII receives security patches.

| Version | Supported |
| ------- | --------- |
| Latest  | ✅        |
| Older   | ❌        |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Email **security@org2.ai** with:

- A description of the vulnerability and its potential impact
- Steps to reproduce (proof-of-concept, if available)
- Affected version(s) and platform(s)
- Any suggested mitigations you are aware of

We use PGP-encrypted email if you need it — request our public key in your initial message.

### Response SLA

| Event                          | Target                                   |
| ------------------------------ | ---------------------------------------- |
| Acknowledgement                | Within **48 hours** of receipt           |
| Triage and severity assessment | Within **5 business days**               |
| Patch for critical/high issues | Within **14 days** of triage             |
| Patch for medium/low issues    | Within **90 days** of triage             |
| Coordinated public disclosure  | After patch ships or by mutual agreement |

We follow [coordinated disclosure](https://cheatsheetseries.owasp.org/cheatsheets/Vulnerability_Disclosure_Cheat_Sheet.html): we ask reporters to keep the issue confidential until a fix is available, and we credit reporters in release notes (unless you prefer to remain anonymous).

## Out of Scope

The following are **not** considered security vulnerabilities for this project:

- Vulnerabilities in versions older than the latest release
- Issues that require physical access to the device running ORGII
- Issues in third-party services or infrastructure not under ORGII's control
- Self-XSS or social-engineering attacks requiring victim interaction
- Denial-of-service attacks requiring unrestricted network access to a local port
- Missing "security best practice" flags in Lighthouse / security scanners that have no practical exploitability
- Rate-limiting issues on local API endpoints that are not network-exposed by default

## Disclosure Policy

When a security issue is confirmed:

1. We work with the reporter to understand and reproduce the vulnerability.
2. We prepare and test a fix in a private branch.
3. We release a patched version and publish a security advisory on GitHub.
4. We publicly thank the reporter (with permission) in the advisory and changelog.

Thank you for helping keep ORGII and its users safe.
