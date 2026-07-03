---
type: Decision
title: Per-gallery JWT cookies for guests
description: Guests authenticate with a short-lived JWT cookie scoped to one event, rather than user accounts.
tags: [decision, auth, guests, jwt]
timestamp: 2026-07-03T00:00:00Z
---

# Decision

Guests unlock a gallery by entering a password. On success, they receive a single `HttpOnly` JWT cookie scoped to that one event's slug. No user account is created. No email is collected.

# Rationale

**Zero friction:** The core guest experience is "receive a link and a password → see photos." Any account creation step (email, verification, password choice) adds friction that causes guests to give up. For event photography, where guests arrive at the URL moments after the photographer shares it, conversion matters.

**No PII:** Pixshar stores no guest personal data. There is no user table for guests, no email, no password hash. This simplifies GDPR compliance for the self-hoster and eliminates an entire category of data breach risk.

**Simplicity:** Supporting user accounts would require password reset flows, email delivery, session management, and account merge logic (what happens when the same guest attends two events?). A per-event cookie avoids all of this.

**Per-event scoping:** The JWT subject is the event ID, and the cookie is scoped to `/gallery/{slug}`. A cookie from one event is cryptographically unusable for another. This prevents accidental cross-event access without any server-side session lookup on each request — the middleware validates the JWT signature alone.

# Trade-offs Accepted

- **No "my photos" view:** Guests cannot log in elsewhere and see all photos they've uploaded across multiple events. This was explicitly out of scope for Pixshar's target use case.
- **Password sharing:** The gallery password is a shared secret. If a guest shares the link + password, anyone can access the gallery. For private event photography this is the same model as sharing a Google Photos album link — accepted.
- **No revocation per-guest:** The admin can change the gallery password (invalidating all existing cookies), but cannot revoke a single guest's access. Accepted.

# Alternatives Considered

**Magic link per guest:** Admin enters guest emails; each receives a unique link. Rejected: requires email infrastructure (SMTP), complicates the self-hosting setup, and adds admin overhead per event.

**Standard user accounts:** Guests sign up. Rejected: see "No friction" above, and Pixshar would become a user-management product rather than a photo-sharing product.

# Citations

[1] [Auth architecture](/architecture/auth.md)
[2] [Gallery API](/api/gallery-api.md)
