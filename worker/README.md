# ask-my-notes Worker

A Cloudflare Worker that powers the "ask my notes" chat widget on
suryakantk94.github.io. Uses Cloudflare Workers AI for both the question
embedding and the answer generation, plus a simple KV-backed per-IP daily
rate limiter.

## Architecture

```
browser  ── POST /ask {question}  ──►  Worker
                                        │
                                        │  embed question  (Workers AI · bge-base-en-v1.5)
                                        │  cosine top-k    (over bundled embeddings.json)
                                        │  prompt + retrieved chunks
                                        │  LLM stream       (Workers AI · llama-3.3-70b)
                                        ▼
browser  ◄── SSE stream + X-Sources ─── Worker
```

The Worker bundles `src/embeddings.json` — a static list of `{slug, title,
chunkIndex, text, embedding}` records — produced at build time by the site
repo's `scripts/build-embeddings.mjs`. No runtime DB.

## Routes

- `GET /health` — health probe, returns `{ok: true, chunks: N}`.
- `POST /ask` — body `{question: string}`. Streams the LLM response as
  Server-Sent Events. The response header `X-Sources` contains a
  URL-encoded JSON array of `{slug, title, score, url}` for the retrieved
  chunks.

## Setup

One-time:

```sh
# 1. Sign in (browser auth)
npx wrangler login

# 2. Create the KV namespace for the rate limiter
npx wrangler kv namespace create RATE_LIMIT
# Copy the returned id into wrangler.toml under [[kv_namespaces]].

# 3. Generate the embeddings (run from repo root)
cd ..
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run build:embeddings
# This writes worker/src/embeddings.json.

# 4. Deploy
cd worker
npx wrangler deploy
```

After the first deploy, the Worker is reachable at
`https://ask-my-notes.<your-cf-subdomain>.workers.dev`. Set
`PUBLIC_ASK_ENDPOINT` in the site's `.env` (or in GitHub Actions secrets)
to that URL so the chat widget points at it.

## Updating after a new post

```sh
# Re-embed
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm run build:embeddings

# Redeploy the Worker so the new embeddings ship
cd worker && npx wrangler deploy
```

## Tuning

`wrangler.toml` exposes a few knobs via `[vars]`:

- `ALLOWED_ORIGIN` — CORS origin allowed to call /ask.
- `DAILY_LIMIT_PER_IP` — questions per IP per day. Default 20.
- `EMBED_MODEL` / `LLM_MODEL` — Workers AI model ids. Swap to a smaller
  Llama if you want faster responses at lower quality.
- `TOP_K` — how many chunks to retrieve. 4 is a good default.

## Local dev

```sh
npx wrangler dev
# POST http://127.0.0.1:8787/ask
```

KV bindings work locally via wrangler's in-memory KV emulator. Workers AI
calls go to the real service — they cost real (free-tier) Neurons.
