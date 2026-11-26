# Stage 13 — UI Security Hardening

Applied to `fix/accounting-fifo-persistence` without replacing branch-specific accounting, FIFO, or Supabase changes.

- Added safe runtime error formatting: production UI receives a generic message; development output is length-limited and common bearer/JWT/API-secret patterns are redacted.
- Updated the React ErrorBoundary to avoid rendering raw backend JSON and to keep technical diagnostics in the developer console only.
- Added Permissions-Policy and conditional HSTS headers; retained existing content-type and referrer protections.
- Disabled caching for API responses and added `Retry-After` to rate-limit responses.
- Scoped in-memory rate-limit buckets by HTTP method, route and client IP, with bounded stale-bucket cleanup.
- Added focused runtime-safety tests to the package test script.

## Validation notes

Full dependency-backed tests, TypeScript checking, production build, browser testing and penetration testing still need to run in an environment with dependencies installed. HSTS depends on Express correctly detecting HTTPS; the app currently assumes one trusted reverse proxy (`trust proxy = 1`). The rate limiter remains in-memory and is not shared across multiple server instances; production multi-instance deployments should use a shared store such as Redis.
