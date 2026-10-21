# Authentication and session lifecycle

Registration and login return the public user, workspace, role, and a 15-minute JWT access token. They set an opaque refresh token in the `pulseops_refresh` cookie. The cookie is HttpOnly, host-only, scoped to `/auth`, and uses SameSite=Lax. Refresh tokens are never included in JSON responses or browser storage; PostgreSQL stores SHA-256 hashes only. Access tokens remain in localStorage for dashboard reloads.

Sessions have a fixed seven-day lifetime. `POST /auth/refresh` consumes the current refresh token and replaces its cookie with a new token. Rotation is transactional and locks the session and token records. Reusing a consumed refresh token revokes that session, including its newly issued tokens. Other logins remain valid. Refreshing does not extend the original session expiry.

Every protected request checks the JWT signature and expiry, the active database session, and the user's current workspace membership. Role changes take effect immediately. `POST /auth/logout` revokes the session and expires its cookie, invalidating access tokens immediately. Logout accepts the refresh cookie, a signed access token, or both; it also works with an expired access token. Deleting a membership cascades to its sessions and refresh tokens.

The web client retries an authenticated request once after a successful refresh. Concurrent requests share a renewal, and browsers with Web Locks serialize refresh, login, and logout across tabs. A delayed refresh cannot restore client state after logout. Temporary service errors preserve the saved session for retry. An invalid or expired refresh returns the user to sign-in. Account switches between tabs clear the previous workspace's data before loading the new session.

## Local and deployed configuration

The local dashboard at `http://localhost:3002` uses the API at `http://localhost:3001`. Use the same hostname for both; mixing `localhost` and `127.0.0.1` changes the cookie's site. Web requests include credentials.

`WEB_ORIGINS` is a comma-separated list of allowed frontend origins, without trailing slashes. Defaults allow the local dashboard, the Next.js development port, and the Playwright test origin. Credentialed CORS and explicit Origin checks protect login, registration, refresh, and logout. Non-browser clients without an Origin header may call these endpoints and must maintain their own cookie jar.

For HTTPS deployment, set `REFRESH_COOKIE_SECURE=true`, configure `WEB_ORIGINS` for the actual frontend, and configure the web app's public API URL at build time. Serve the frontend and API on the same site, such as HTTPS subdomains of the same domain, so SameSite cookies can be used. Local Compose explicitly defaults `REFRESH_COOKIE_SECURE` to false for HTTP. Set a private `JWT_SECRET` for deployment.

The session tables are added by the existing database initialization. Access tokens issued before session support lack a session identifier and are rejected; existing development users must sign in once after this update. Expired session records can be deleted with their refresh tokens cascading; scheduling that cleanup belongs to the project's retention work.

See [TESTING.md](TESTING.md) for real PostgreSQL and browser verification.
