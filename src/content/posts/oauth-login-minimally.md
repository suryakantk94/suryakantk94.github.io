---
title: 'OAuth login, minimally: what your app actually does'
description: 'I set out to do the simplest possible "log in with Google" for a standalone app — a session cookie the backend can validate. The plumbing is small; the confusing part is the vocabulary and the one real decision (stateful vs stateless). Notes to my future self.'
date: 2026-06-02
tags: ['auth', 'oauth', 'oidc', 'typescript']
---

I wanted the simplest possible thing: log in with my Google account, have the
backend drop an `HttpOnly` cookie, and validate that cookie on later requests.
The classic web login. It turns out the *plumbing* is small — the genuinely
confusing parts are the vocabulary and one real architectural decision. These
are the notes I wish I'd had at the start.

## The one decision that matters: stateful or stateless

Everything else is a library choice. This isn't.

|  | Stateful (server session) | Stateless (signed token) |
|---|---|---|
| The cookie holds | an opaque session ID | a signed token (JWT) with claims inside |
| To validate it | **look it up** in a store | **verify the signature** — no lookup |
| State lives | server-side (DB/Redis) | nowhere; it's in the token |
| Logout / revoke | easy — delete the row | hard — valid until it expires |
| Cost per request | a lookup | pure CPU |

Stateful gives you instant revocation at the price of a store and a lookup.
Stateless gives you a no-infrastructure backend at the price of "you can't
easily kill a token early." For a small standalone app I leaned stateless —
the cookie is a signed JWT, and "validate the cookie" just means *check the
signature and the `exp`/`iss`/`aud` claims*. No database.

## The login flow

Provider-agnostic OIDC (Google, or an Auth0/Ory tenant in front of Google —
same shape). Two phases: get the cookie, then use it.

```
   User      Browser          Your App            Auth Server
    |        (client)        (backend)           (Google / Auth0 / …)
    |           |                |                     |
 ===|===========|================|=====================|=========
  PHASE A — Login  (OAuth 2.0 Authorization Code + PKCE)
 ===|===========|================|=====================|=========
    |           |                |                     |
    |--click--->|                |                     |
    | "Sign in" |--GET /login -->|                     |
    |           |   <--302 redirect to /authorize ---->|
    |           |     client_id, redirect_uri, scope,  |
    |           |     state, PKCE challenge            |
    |           |--GET /authorize ------------------->|
    |--authenticate + consent --------------------->|
    |           |<--302 redirect to /callback ?code---|
    |           |--GET /callback ?code -->|            |
    |           |          |--POST /token (code+PKCE)->|   back-channel
    |           |          |<--id_token (a signed JWT)-|   (secret never
    |           |          |-verify id_token via JWKS  |    hits browser)
    |           |          |-mint MY session cookie    |
    |           |<--302 to /  Set-Cookie: session=...  |
    |           |   HttpOnly; SameSite=Lax; (Secure)   |
    |           |                |                     |
 ===|===========|================|=====================|=========
  PHASE B — Authenticated request
 ===|===========|================|=====================|=========
    |           |                |                     |
    |--use app->|                |                     |
    |           |--GET /api/me -->|                    |
    |           |  Cookie: session=...                 |
    |           |        |- verify signature + exp     |
    |           |        |  (stateless: no DB, no call) |
    |           |<--200 protected data (your email)    |
    |           |                |                     |
 ===|===========|================|=====================|=========
```

Two things this picture makes obvious:

- **The browser does the whole dance; your backend only shows up at
  `/callback` and afterward.** The auth server and the browser talk directly.
- **The token exchange is back-channel** (server-to-server). That's why it's
  the *Authorization Code* flow — the secret and the tokens never ride in the
  browser URL.

## So what is *my* app even doing?

This was my real confusion. The auth server hosts the login page, talks to
Google, issues tokens — so what's left for me? The answer:

> The auth server proves **who the user is**. Your app does **everything
> else** — including deciding what they're allowed to do, and being the actual
> product.

The bouncer checks ID and stamps your hand. The venue still has to decide which
rooms a stamped guest can enter, and provide the thing people came for. Your
app's jobs:

1. **Start login** — "not logged in → send them to the auth server."
2. **Handle the callback** — exchange the code, set the session cookie.
3. **Validate the cookie** on every request.
4. **Be the product** — serve protected data and decide *permissions*.

Job 4 is the point. Authentication (who you are) is the auth server's.
**Authorization** (what you may do) and the whole application are yours — no
library does that part for you.

## Terminology, decoded

The words tripped me up more than the code did.

| Term | Plain meaning |
|---|---|
| **Client ID** | Your app's public username, issued when you register it |
| **Client Secret** | Your app's password — **server-side only** |
| **Redirect URI** | The exact return address the auth server is allowed to send the user back to (must match, anti-phishing) |
| **Scope** | What you're asking for: `openid`, `profile`, `email` |
| **Authorization Code** | A one-time ticket, exchanged server-side for tokens |
| **ID Token** | A signed JWT describing *who* logged in (the OIDC bit) |
| **Access Token** | A key to call APIs |
| **state** | Random value echoed back — anti-CSRF |
| **PKCE** | Proof the app finishing the flow is the one that started it |
| **JWKS** | The auth server's public-keys endpoint, used to verify a JWT |
| **Claims** | Fields inside a JWT — `iss` (issuer), `aud` (audience), `exp` (expiry), `sub` (user id) |

The 10-second model:

```
Client ID + Redirect URI  →  start login (public, in the URL)
Authorization Code        →  one-time ticket back through the browser
   (exchanged server-side with the Client Secret + PKCE)
ID Token (a JWT)          →  "here's who they are" — verified via JWKS
Your session cookie       →  what you validate on every later request
```

Everything else — `state`, `scope`, refresh tokens — is a safety rail or a
convenience bolted onto that spine.

## Where I landed

For a standalone app, stateless: a single backend that does the Authorization
Code flow, verifies the provider's ID token, and mints its own short-lived JWT
session cookie. No session store, no extra infrastructure. If I later need hard
logout or central session control, that's the day to add a server-side session
— and now I know exactly what that trade buys.
