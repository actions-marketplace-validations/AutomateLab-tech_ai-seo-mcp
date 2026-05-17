# Security policy

## Supported versions

Only the latest minor release receives security fixes during the 0.x phase.

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.**

Email the maintainers privately by opening a [GitHub Security Advisory](https://github.com/AutomateLab-tech/ai-seo-mcp/security/advisories/new) on the repository. This routes the report directly to maintainers without disclosing it publicly.

Please include:

- A clear description of the issue and its impact.
- Steps to reproduce, or a minimal proof-of-concept.
- Any affected versions you have confirmed.
- Your suggested fix, if you have one.

You will receive an acknowledgement within 5 business days. We aim to release a fix or mitigation within 30 days of confirmation, depending on severity and complexity.

## Scope

Vulnerabilities in scope:

- Code execution via crafted MCP input.
- HTTP request smuggling, SSRF, or DNS rebinding via tool inputs.
- Path traversal via user-supplied URLs or file paths.
- Dependency vulnerabilities that affect runtime behavior.
- Bypasses of the polite-fetch contract (e.g. forcing the server to ignore `robots.txt` without setting `RESPECT_ROBOTS=false`).

Out of scope:

- Denial of service via excessive tool calls (rate limiting is the MCP client's job).
- Findings produced by audit tools that you disagree with. Open a regular issue with reproduction steps.
- Issues in third-party MCP clients consuming this server.

## Disclosure

Once a fix ships, the advisory is published publicly with credit to the reporter, unless the reporter requests anonymity.
