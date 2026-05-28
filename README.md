# suryakantk94.github.io

Personal site of Suryakant Kashyap — AI engineer with a systems background. Long-form notes on LLMs, retrieval, evals, and the production systems they run on.

Built with [Astro](https://astro.build) + MDX, deployed to GitHub Pages.

## Local dev

```sh
npm install
npm run dev     # http://localhost:4321
npm run build   # outputs to ./dist
npm run preview # serve the built site
```

## Layout

- `src/pages/` — top-level routes (`/`, `/about/`, `/posts/`, `/work/`, `/now/`, `/rss.xml`, `/404`).
- `src/content/posts/` — Markdown/MDX posts. Frontmatter schema lives in `src/content.config.ts`.
- `src/layouts/` — `Base.astro` (chrome) and `Post.astro` (article wrapper).
- `src/components/` — `SiteHeader.astro`, `SiteFooter.astro`, `AskWidget.astro`.
- `src/styles/global.css` — Tailwind v4 + theme tokens.
- `scripts/build-embeddings.mjs` — chunks posts + calls Cloudflare Workers AI to produce `worker/src/embeddings.json`.
- `worker/` — Cloudflare Worker that powers the "ask my notes" chat widget. See `worker/README.md`.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the site and publishes the `./dist` output to GitHub Pages. First-time setup: in repo settings → Pages → set Source to "GitHub Actions".

## "Ask my notes" chat

The chat widget on the site is backed by a small Cloudflare Worker that
runs RAG over the post corpus. End-to-end setup lives in
[`worker/README.md`](worker/README.md). Short version:

```sh
# One-time: sign in to Cloudflare
npx wrangler login

# Generate embeddings (requires CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN)
npm run build:embeddings

# Deploy the worker
cd worker && npx wrangler deploy
```

Then set `PUBLIC_ASK_ENDPOINT` in `.env` (or in the GitHub Actions deploy
workflow) to your Worker's URL so the widget knows where to send queries.
Without that variable the widget renders but tells visitors the endpoint
isn't configured.

## Posts

Posts originally lived in [observability-deep-dives](https://github.com/suryakantk94/observability-deep-dives). That repo continues to exist as an archival mirror; this site is the canonical home going forward.
