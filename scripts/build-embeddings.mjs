#!/usr/bin/env node
/**
 * Reads src/content/posts/*.md, chunks each post body, sends each chunk to
 * Cloudflare Workers AI bge-base-en-v1.5, and writes worker/src/embeddings.json
 * for the Worker to bundle.
 *
 * Required env:
 *   CLOUDFLARE_ACCOUNT_ID — your CF account id
 *   CLOUDFLARE_API_TOKEN  — token with "Workers AI: Read" permission
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const POSTS_DIR = join(REPO_ROOT, 'src/content/posts');
const OUT_PATH = join(REPO_ROOT, 'worker/src/embeddings.json');

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';

const CHUNK_TARGET_TOKENS = 280;
const CHUNK_OVERLAP_TOKENS = 60;
// Rough token estimate — bge tokeniser averages ~4 chars/token on English prose.
const CHARS_PER_TOKEN = 4;
const TARGET_CHARS = CHUNK_TARGET_TOKENS * CHARS_PER_TOKEN;
const OVERLAP_CHARS = CHUNK_OVERLAP_TOKENS * CHARS_PER_TOKEN;

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error('Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN before running.');
  process.exit(1);
}

/**
 * Splits markdown body into chunks at paragraph boundaries, packing paragraphs
 * up to ~TARGET_CHARS each and adding ~OVERLAP_CHARS of carry-over between
 * adjacent chunks for context continuity.
 */
function chunkMarkdown(body) {
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let buffer = '';

  for (const para of paragraphs) {
    if (buffer.length + para.length + 2 <= TARGET_CHARS) {
      buffer = buffer ? `${buffer}\n\n${para}` : para;
      continue;
    }
    if (buffer) chunks.push(buffer);
    if (para.length <= TARGET_CHARS) {
      // Start new chunk with overlap tail from the previous chunk.
      const tail = buffer.slice(-OVERLAP_CHARS);
      buffer = tail ? `${tail}\n\n${para}` : para;
    } else {
      // Single paragraph is bigger than the target; hard-split on sentence boundaries.
      const sentences = para.split(/(?<=[.!?])\s+/);
      let inner = '';
      for (const s of sentences) {
        if (inner.length + s.length + 1 > TARGET_CHARS) {
          if (inner) chunks.push(inner);
          inner = s;
        } else {
          inner = inner ? `${inner} ${s}` : s;
        }
      }
      buffer = inner;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

async function embed(text) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/${EMBED_MODEL}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ text: [text] }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`embed failed ${res.status}: ${body}`);
  }
  const json = await res.json();
  const vec = json?.result?.data?.[0];
  if (!Array.isArray(vec)) {
    throw new Error(`unexpected embed response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return vec;
}

async function main() {
  const files = (await readdir(POSTS_DIR)).filter((f) => f.endsWith('.md') || f.endsWith('.mdx'));
  const out = [];
  let chunkIdx = 0;

  for (const file of files) {
    const slug = basename(file).replace(/\.(md|mdx)$/, '');
    const raw = await readFile(join(POSTS_DIR, file), 'utf8');
    const { data, content } = matter(raw);
    if (data.draft) continue;

    const chunks = chunkMarkdown(content);
    console.log(`${slug}: ${chunks.length} chunks`);
    for (const [i, text] of chunks.entries()) {
      const embedding = await embed(text);
      out.push({
        id: chunkIdx++,
        slug,
        title: data.title,
        chunkIndex: i,
        text,
        embedding,
      });
    }
  }

  await writeFile(OUT_PATH, JSON.stringify(out));
  const stats = {
    chunks: out.length,
    dims: out[0]?.embedding?.length ?? 0,
    sizeKB: Math.round(Buffer.byteLength(JSON.stringify(out)) / 1024),
  };
  console.log(`wrote ${OUT_PATH}`, stats);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
