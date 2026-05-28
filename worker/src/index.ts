import { Hono } from 'hono';
import { cors } from 'hono/cors';
import embeddingsData from './embeddings.json';

interface ChunkRecord {
  id: number;
  slug: string;
  title: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

interface Env {
  AI: Ai;
  RATE_LIMIT: KVNamespace;
  ALLOWED_ORIGIN: string;
  DAILY_LIMIT_PER_IP: string;
  EMBED_MODEL: string;
  LLM_MODEL: string;
  TOP_K: string;
}

const chunks = embeddingsData as ChunkRecord[];

function cosineSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function topK(queryEmbedding: number[], k: number) {
  const scored = chunks.map((c) => ({ chunk: c, score: cosineSim(queryEmbedding, c.embedding) }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

function buildPrompt(question: string, retrieved: { chunk: ChunkRecord; score: number }[]): string {
  const context = retrieved
    .map(
      ({ chunk }, i) =>
        `[Source ${i + 1}: "${chunk.title}"]\n${chunk.text}`,
    )
    .join('\n\n---\n\n');

  return `You are answering questions about Suryakant Kashyap's technical blog posts. Suryakant is an AI engineer with a systems background; his posts cover LLMs, retrieval-augmented generation, evals, and the production metrics and observability systems beneath them. Answer using ONLY the sources below. If the sources don't cover the question, say so directly — don't guess. Quote source titles when you reference them.

${context}

---

Question: ${question}

Answer:`;
}

async function rateLimit(env: Env, ip: string): Promise<{ ok: true } | { ok: false; remaining: number }> {
  const limit = parseInt(env.DAILY_LIMIT_PER_IP, 10) || 20;
  const today = new Date().toISOString().slice(0, 10);
  const key = `rl:${today}:${ip}`;
  const current = parseInt((await env.RATE_LIMIT.get(key)) || '0', 10);
  if (current >= limit) return { ok: false, remaining: 0 };
  await env.RATE_LIMIT.put(key, String(current + 1), { expirationTtl: 60 * 60 * 26 });
  return { ok: true };
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  return cors({
    origin: (c.env as Env).ALLOWED_ORIGIN,
    allowMethods: ['POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 600,
  })(c, next);
});

app.get('/health', (c) => c.json({ ok: true, chunks: chunks.length }));

app.post('/ask', async (c) => {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'anon';
  const rl = await rateLimit(c.env, ip);
  if (!rl.ok) {
    return c.json({ error: 'rate_limited', message: 'Daily question limit reached. Please come back tomorrow.' }, 429);
  }

  let payload: { question?: string };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: 'bad_request', message: 'Body must be JSON: {"question": "..."}.' }, 400);
  }
  const question = (payload.question || '').trim();
  if (!question) return c.json({ error: 'empty_question' }, 400);
  if (question.length > 500) return c.json({ error: 'question_too_long', message: 'Keep questions under 500 chars.' }, 400);

  // Embed the question.
  const embedRes = await c.env.AI.run(c.env.EMBED_MODEL as any, { text: [question] });
  const qVec = (embedRes as any)?.data?.[0];
  if (!Array.isArray(qVec)) {
    return c.json({ error: 'embed_failed' }, 500);
  }

  const retrieved = topK(qVec, parseInt(c.env.TOP_K, 10) || 4);
  const prompt = buildPrompt(question, retrieved);

  // Stream the LLM response back to the client.
  const stream = (await c.env.AI.run(c.env.LLM_MODEL as any, {
    prompt,
    max_tokens: 600,
    temperature: 0.2,
    stream: true,
  })) as ReadableStream;

  const sources = retrieved.map(({ chunk, score }) => ({
    slug: chunk.slug,
    title: chunk.title,
    score: Number(score.toFixed(3)),
    url: `/posts/${chunk.slug}/`,
  }));

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Sources': encodeURIComponent(JSON.stringify(sources)),
      'Access-Control-Expose-Headers': 'X-Sources',
    },
  });
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;
