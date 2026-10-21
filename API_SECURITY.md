# API request handling

The Express app is assembled by `createApp` in `apps/api/src/app.ts`. The entry point starts the server and initializes the database separately so tests can exercise the complete HTTP middleware without starting the production listener.

## Validation

Request bodies must be JSON and are limited to 16 KiB after decompression. Registration, login, session renewal/logout, monitor creation/updates/checks, notification channels, and API key creation use strict Zod schemas. Unknown body fields, arrays, nulls, invalid resource IDs, and values requiring type coercion are rejected. Monitor history accepts only the supported `hours` query values: 24, 168, and 720.

Names are trimmed, non-empty, and limited to 120 characters. Emails are validated and bounded. Passwords must be at least eight characters on registration and at most 72 UTF-8 bytes, matching bcrypt's input limit. Monitor intervals are JSON integers between 30 and 2147483647 seconds. HTTP targets must use HTTP or HTTPS, fit within 2048 characters, and omit embedded credentials. Email notification targets accept one address. Channel responses omit stored targets so webhook credentials remain private.

## Outbound requests and SSRF protection

Manual checks, scheduled checks, and HTTP notification delivery use the same outbound client in `apps/api/src/outbound.ts`. They support public HTTP/HTTPS destinations. Private, loopback, link-local, multicast, reserved, carrier-grade NAT, and special-use addresses are blocked. IPv6 is restricted to global unicast and excludes mapped and transition addresses. The Azure platform address `168.63.129.16` is also blocked. Local and reserved hostnames and embedded URL credentials are rejected.

URLs pass through the same WHATWG parser during configuration and execution, which also normalizes numeric IPv4 encodings before address classification. Hostname checks at configuration time do not perform DNS queries. At execution time the client resolves all available IPv4 and IPv6 answers and rejects the entire result if any answer is disallowed. It connects to one checked address through a pinned lookup callback, without a second DNS lookup. IPv4 is preferred when available. The HTTP Host header and HTTPS server name retain the target hostname, and TLS certificate validation remains enabled. Each connection is new; no socket pool or cached security decision is reused.

GET monitor checks follow at most five redirects. Every destination, including relative redirects back to the same hostname, goes through URL and DNS checks again before connection. POST webhooks and Slack delivery never follow redirects, so incident payloads are not forwarded to another destination. Redirect responses are recorded as failed deliveries without retrying the redirect. Policy blocks also stop delivery retries; transient DNS and connection failures keep the existing retry behavior.

A single ten-second deadline covers DNS resolution and the complete redirect chain. Response headers are limited to 16 KiB, response bodies are closed after headers, request bodies are capped at 64 KiB, and protocol upgrades are rejected. HTTP request errors stored in check or delivery history omit target URLs, DNS addresses, TLS details, and webhook secrets. Blocked monitor checks are recorded as down; blocked deliveries are recorded as failed. Existing stored targets are checked again during execution, so this policy also applies to records created before the feature.

Internal-only monitoring is not supported by this public-target policy. Operator-configured SMTP connections are separate from user-supplied HTTP targets. Application checks should be paired with deployment egress controls; they do not determine an organization's routing rules for globally assigned addresses.

Design references: [OWASP SSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), [Node HTTP connection options](https://nodejs.org/api/http.html#httprequesturl-options-callback), and [ipaddr.js](https://github.com/whitequark/ipaddr.js).

## Rate limits

Limits are counted by client IP within each running API process:

| Environment setting  | Default | Window     | Applies to                      |
| -------------------- | ------- | ---------- | ------------------------------- |
| `API_RATE_LIMIT`     | 300     | 1 minute   | API requests                    |
| `AUTH_RATE_LIMIT`    | 20      | 15 minutes | Login and registration combined |
| `REFRESH_RATE_LIMIT` | 60      | 1 minute   | Session renewal                 |
| `CHECK_RATE_LIMIT`   | 10      | 1 minute   | Manual monitor checks           |

Responses exceeding a limit return HTTP 429, a `Retry-After` header in seconds, standard `RateLimit` headers, and the usual JSON error body. Health checks, logout, and CORS preflight remain available when the general limit is exhausted. Route casing and trailing slashes do not bypass the specific limits.

The current store is in memory. Counters reset on API restart and are not shared between replicas. A shared store is required before scaling to multiple API instances.

Forwarded IP headers are untrusted by default. Behind a reverse proxy, configure `TRUSTED_PROXIES` with only the proxy IPs or CIDRs, separated by commas. Do not trust arbitrary forwarding headers or all internet addresses. Without that configuration, proxied traffic shares the proxy's rate-limit bucket. Compose exposes all four limit settings and `TRUSTED_PROXIES`.

## Headers and CORS

Helmet supplies browser security headers and Express's identifying header is disabled. Authenticated data and errors use `Cache-Control: no-store`. Credentialed CORS allows only `WEB_ORIGINS`; authentication endpoints also reject untrusted Origin headers before changing session cookies. See `AUTHENTICATION.md` for cookie and HTTPS configuration.

## Error format

Application errors use JSON with a top-level `message` for the existing frontend:

```json
{
  "message": "Request validation failed",
  "code": "VALIDATION_ERROR",
  "requestId": "server-generated UUID",
  "details": [{ "path": "intervalSeconds", "message": "Expected an integer" }]
}
```

`details` is present for schema errors. Status codes distinguish invalid input (400), authentication (401), permissions/Origin checks (403), missing resources (404), conflicts (409), oversized payloads (413), unsupported media (415), throttling (429), internal errors (500), and unavailable services (503). Malformed JSON and unknown routes use the same envelope.

Every response has `X-Request-Id`. The error body repeats it, and unexpected failures produce a structured server log with that ID. Unexpected database messages, SQL, credentials, request bodies, and stack traces are excluded from error responses and those logs. Request IDs and retry headers are exposed to allowed browser origins.
