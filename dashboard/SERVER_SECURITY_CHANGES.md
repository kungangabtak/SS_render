## Context

This repository contains only the **static subscriber dashboard** (SS viewer). The **hub** (`dom-hub`) and **token issuer** (`dom-auth`) live elsewhere, so their hardening must be applied in those services’ codebases.

This dashboard has been updated to **always**:

- Require a **Dashboard Password**
- `POST https://dom-auth.onrender.com/token` with header `X-Dashboard-Password: <password>` and body `{ room, role: "sub" }`
- Connect to the hub using the returned **JWT**
- On hub close code **4003** (“token expired”), **re-fetch JWT and reconnect**

## Hub enforcement (required)

For `role=sub` (subscribers/viewers):

- Require a **valid JWT on every connection**
- Do **not** allow `HUB_TOKEN` (or any “public”/shared token mechanism) for subscribers
- Validate JWT claims:
  - `role === "sub"`
  - `room` (or `roomId`) matches the requested `room` query param
  - `exp` not expired

For `role=pub` (publishers):

- Recommended: also use JWTs for publishers (same claim validation rules, with `role === "pub"`)
- If you allow a different mechanism for publishers, ensure subscriber auth is **not weaker** than publisher auth.

## dom-auth hardening (required)

Token endpoint should:

- Issue JWTs containing:
  - `room` (or `roomId`)
  - `role` (must be `sub` for viewers)
  - short `exp` (10–30 minutes)
- Add basic protection:
  - **Rate limit** `/token` by IP (and optionally by room)
  - **Constant-time password compare** (to avoid timing attacks)
  - **Log failed attempts** (include IP, room, timestamp; never log the password)

## Suggested acceptance checks

- Connecting as `role=sub` without a token returns hub close code **4002** (or similar) and does not stream data.
- Providing a valid JWT for a different room results in hub close code **4004** (claim mismatch).
- Expired JWT results in hub close code **4003** and the dashboard transparently re-auths and reconnects.

