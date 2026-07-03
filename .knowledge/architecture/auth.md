---
type: Architecture
title: Authentication & Authorization
description: BetterAuth for the single admin account; per-gallery JWT cookies for guests.
tags: [auth, betterauth, jwt, sessions]
timestamp: 2026-07-03T00:00:00Z
---

# Two Auth Layers

Pixshar has two completely separate authentication concerns:

| Who | Mechanism | Scope |
|---|---|---|
| Admin (photographer) | BetterAuth session cookie | Full API access |
| Guest | Per-gallery JWT cookie | Single event only |

# Admin Auth (BetterAuth)

**BetterAuth** manages the admin session. Configuration:
- `disableSignUp: true` — no public registration. The admin account is created by a seed script on first container start, seeded from `ADMIN_EMAIL` / `ADMIN_PASSWORD` env vars.
- Prisma adapter for session persistence (User, Session, Account, Verification tables in Postgres).
- All admin API routes are protected by a `requireAdmin` middleware that validates the BetterAuth session.

# Guest Auth (Gallery JWT)

When a guest submits the correct gallery password, the API:
1. Verifies the bcrypt-hashed password stored on the Event row.
2. Signs a JWT with the event's ID as the subject, using `BETTER_AUTH_SECRET` as the signing key.
3. Sets a `HttpOnly; SameSite=Lax` cookie named `gallery_{slug}`, scoped to `/gallery/{slug}`.

The `requireGallerySession` middleware verifies this JWT on every guest API request. The cookie is scoped to a single slug — a cookie from one event cannot be used to access another.

# No Guest User Accounts

Guests have no persistent identity. There are no guest user rows, no sign-up flow, and no password resets. The gallery cookie is the entire session. This is intentional: it removes friction, avoids PII collection, and keeps the data model simple.

See [Gallery Sessions decision](/decisions/gallery-sessions.md) for the rationale.

# Citations

[1] [BetterAuth documentation](https://www.better-auth.com)
[2] [Gallery sessions decision record](/decisions/gallery-sessions.md)
