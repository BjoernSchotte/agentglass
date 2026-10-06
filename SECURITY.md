# Security policy

## Supported versions

Only the latest release gets security fixes. Releases are CalVer (`YYYY.MM.N`); see
[Releases](https://github.com/BjoernSchotte/agentglass/releases/latest). Update before you report.

## Report a vulnerability

Do not open a public issue. Report privately through GitHub:
[Report a vulnerability](https://github.com/BjoernSchotte/agentglass/security/advisories/new).

Include:

- the agentglass version (`agentglass --version`) and OS;
- what you did, what happened, and what an attacker gains;
- a minimal reproduction, if you have one.

You get a reply within 7 days. A confirmed issue is fixed in a new release, then the advisory is published with credit,
unless you ask to stay anonymous.

## Scope

In scope: the `agentglass` binary, `install.sh`, the release artifacts and their provenance attestations, and
`agentglass receive` (the OTLP/HTTP hub endpoint). Examples: secrets that leak past redaction into output or exports,
path traversal when reading transcripts, auth bypass or resource exhaustion on `receive`.

Out of scope: vulnerabilities in the agent harnesses whose transcripts agentglass reads (report those upstream), and
findings that need an attacker who already has your user account.
