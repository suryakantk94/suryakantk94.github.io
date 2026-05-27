// @ts-check
import { defineConfig } from 'astro/config';

import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://suryakantk94.github.io',

  integrations: [mdx(), sitemap()],

  markdown: {
    shikiConfig: {
      theme: 'github-dark-dimmed',
      wrap: false,
    },
  },

  vite: {
    plugins: [tailwindcss()],
  },
});
