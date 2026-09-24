---
title: AES-256-GCM encryption for gallery passwords
status: accepted
---

## Context

The admin can reveal the gallery password they originally set (needed because gallery passwords are short shared secrets, not user-chosen credentials — the admin routinely needs to re-share them). This requires storing the plaintext (or a reversibly-encrypted form) alongside the scrypt hash used for verification.

## Decision

Gallery passwords are encrypted at rest using **AES-256-GCM** before being stored in the `event.password` column. The `event.passwordHash` column continues to hold the scrypt hash used for guest verification and is never sent to the client.

**Key**: `GALLERY_ENCRYPTION_KEY` — a 64-character lowercase hex string (32 bytes) injected via environment variable.

**Storage format**: `enc1:<ivHex>:<ciphertextHex>:<authTagHex>`

- `enc1:` prefix lets `decryptPassword()` distinguish encrypted values from legacy plaintext values stored before this feature was introduced (migration path: return as-is).
- IV is 12 bytes, randomly generated per encryption.
- Auth tag is 16 bytes (GCM default), providing ciphertext integrity.

**Implementation**: `apps/api/src/lib/crypto.ts` — `encryptPassword` / `decryptPassword`.

The API decrypts before returning in `events.get` and encrypts in `events.create` and `events.setPassword`.

## Why not plaintext?

Plaintext protects against nothing. A database dump (backup exfiltration, read replica leak) exposes all gallery passwords immediately.

## Why not a stronger scheme (e.g. per-row keys, HSM)?

Overkill for the threat model. Gallery passwords are not user authentication credentials — they are short shared secrets equivalent to a shared Google Photos album link. AES-256-GCM with an env-var key defends against the most realistic risk (DB dump) without infrastructure complexity.

## Trade-offs

- **Key rotation requires re-encryption.** If `GALLERY_ENCRYPTION_KEY` changes, existing `enc1:…` values cannot be decrypted until re-saved. Mitigation: rotate the key with a one-off migration script that decrypts with the old key and re-encrypts with the new key.
- **Full server compromise still exposes passwords.** If both the DB and the env vars are leaked (e.g. complete host access), all passwords are recoverable. Accepted — this is a self-hosted single-admin app.

## Key management

| Environment | Key source |
|---|---|
| Local dev / Docker Compose | Fixed placeholder `deadbeef…` (default, no secret needed) |
| Kubernetes (Helm) | `secrets.galleryEncryptionKey` → K8s Secret → env var. Generate: `openssl rand -hex 32` |
| BYO secret | Set `secrets.existingSecret` and include `GALLERY_ENCRYPTION_KEY` in that secret |
