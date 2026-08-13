# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report them privately through GitHub's [security advisory][advisory] form on
this repository. Include the version, how to reproduce the issue, and what an
attacker gains. You can expect an initial response within a few days.

[advisory]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

## Threat model

BotPanel runs commands you configure and clones code you point it at. Anyone
with an administrator account can execute arbitrary code on the host, by design
— that is what a process manager does. The security boundary is the login, not
the bot configuration.

This means:

- **Do not expose the panel directly to the internet.** Put it behind a reverse
  proxy with TLS, or reach it over a VPN or private network.
- **Treat administrator accounts as shell access.** Give collaborators the
  `operator` role unless they genuinely need to change configuration.
- **Treat webhook URLs as credentials.** Anyone holding one can trigger a
  deploy. Rotate them from the bot's Git tab if one leaks.

## What the panel does defend against

- Passwords are hashed with bcrypt (cost 12); they are never logged or returned.
- Sessions use httpOnly cookies, are stored server-side, and are revoked on
  password change.
- Sign-in attempts are rate limited per IP address.
- Cross-origin state-changing requests are refused, so a malicious page cannot
  drive the API with your cookie.
- Every file operation resolves paths against the bot's own directory and
  rejects anything that escapes it.
- Git access tokens are never written to `.git/config`, never returned to the
  browser, and are stripped from command output.
- Secret environment variables are masked in API responses unless an
  administrator explicitly reveals them.

## Supported versions

Fixes land on the latest release. There are no long-term support branches yet.
