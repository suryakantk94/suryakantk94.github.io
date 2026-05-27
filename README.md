# suryakantk94.github.io

Personal site of Surya Kant Kashyap — long-form notes on observability, metrics internals, and the production systems behind them.

Built with [Astro](https://astro.build) + MDX, deployed to GitHub Pages.

## Local dev

```sh
npm install
npm run dev     # http://localhost:4321
npm run build   # outputs to ./dist
npm run preview # serve the built site
```

## Layout

- `src/pages/` — top-level routes (`/`, `/about/`, `/posts/`, `/work/`, `/hire/`, `/now/`, `/rss.xml`, `/404`).
- `src/content/posts/` — Markdown/MDX posts. Frontmatter schema lives in `src/content.config.ts`.
- `src/layouts/` — `Base.astro` (chrome) and `Post.astro` (article wrapper).
- `src/components/` — `SiteHeader.astro`, `SiteFooter.astro`.
- `src/styles/global.css` — Tailwind v4 + theme tokens.

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds the site and publishes the `./dist` output to GitHub Pages. First-time setup: in repo settings → Pages → set Source to "GitHub Actions".

## Posts

Posts originally lived in [observability-deep-dives](https://github.com/suryakantk94/observability-deep-dives). That repo continues to exist as an archival mirror; this site is the canonical home going forward.
