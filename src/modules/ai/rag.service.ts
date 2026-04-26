import Anthropic from '@anthropic-ai/sdk';
import { ChromaClient, Collection, IncludeEnum, DefaultEmbeddingFunction } from 'chromadb';
import { env } from '../../config/env';
import {
  RAGQuery,
  RAGResult,
  Scripture,
  ScriptureSource,
  ChromaDocument,
  MessageRole,
} from '../../types';
import { logger } from '../../config/logger';

// ─── Client Singletons ────────────────────────────────

let chromaClient: ChromaClient;
let anthropicClient: Anthropic;
let embedFn: DefaultEmbeddingFunction;

function getChromaClient(): ChromaClient {
  if (!chromaClient) {
    chromaClient = new ChromaClient({
      path: `http://${env.CHROMA_HOST}:${env.CHROMA_PORT}`,
    });
  }
  return chromaClient;
}

function getEmbedFn(): DefaultEmbeddingFunction {
  if (!embedFn) embedFn = new DefaultEmbeddingFunction();
  return embedFn;
}

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return anthropicClient;
}

// ─── Collection Mapping ───────────────────────────────

const COLLECTION_MAP: Record<Scripture, string> = {
  gita: env.CHROMA_COLLECTION_GITA,
  ramayana: env.CHROMA_COLLECTION_RAMAYANA,
  mahabharata: env.CHROMA_COLLECTION_MAHABHARATA,
};

async function getCollections(scripture?: Scripture): Promise<Collection[]> {
  const client = getChromaClient();
  const targets = scripture
    ? [COLLECTION_MAP[scripture]]
    : Object.values(COLLECTION_MAP);

  return Promise.all(
    targets.map((name) =>
      client.getOrCreateCollection({
        name,
        embeddingFunction: getEmbedFn(),
        metadata: { 'hnsw:space': 'cosine' },
      })
    )
  );
}

// ─── Vector Search ────────────────────────────────────

export interface RetrievedChunk {
  content: string;
  metadata: ChromaDocument['metadata'];
  score: number;
}

export async function retrieveRelevantChunks(
  question: string,
  scripture?: Scripture,
  topK = 4
): Promise<RetrievedChunk[]> {
  const collections = await getCollections(scripture);
  const perCollection = scripture ? topK : Math.ceil(topK / collections.length);

  // Embed the question ONCE, then query all collections in parallel.
  const [questionEmbedding] = await getEmbedFn().generate([question]);

  const results = await Promise.all(
    collections.map((col) =>
      col.query({
        queryEmbeddings: [questionEmbedding],
        nResults: perCollection,
        include: [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Distances],
      })
    )
  );

  const chunks: RetrievedChunk[] = [];

  for (const result of results) {
    const docs = result.documents[0] ?? [];
    const metas = result.metadatas[0] ?? [];
    const distances = result.distances?.[0] ?? [];

    for (let i = 0; i < docs.length; i++) {
      if (!docs[i]) continue;
      chunks.push({
        content: docs[i] as string,
        metadata: metas[i] as ChromaDocument['metadata'],
        // Convert cosine distance to similarity score (lower distance = higher score)
        score: 1 - (distances[i] ?? 0),
      });
    }
  }

  // Sort by relevance, deduplicate, take top K
  return chunks
    .sort((a, b) => b.score - a.score)
    .filter((c, idx, arr) => arr.findIndex((x) => x.content === c.content) === idx)
    .slice(0, topK);
}

// ─── Prompt Construction ──────────────────────────────

function buildSystemPrompt(): string {
  return `You are Dharma, a wise and compassionate spiritual guide grounded in the sacred Hindu scriptures — the Bhagavad Gita, Valmiki Ramayana, and Mahabharata.

Your role:
- Provide guidance rooted exclusively in the scripture passages provided in the context
- Never fabricate, invent, or paraphrase verses that aren't in the provided context
- If the provided context doesn't contain a relevant answer, say so honestly and suggest the seeker explore further
- Speak with warmth, clarity, and reverence — like a knowledgeable yet humble teacher
- Reference specific chapters, verses, kandas, parvas, or sargas when citing scripture
- Connect ancient wisdom to the seeker's present question in a practical, compassionate way

Constraints:
- ONLY use information from the provided scripture context
- NEVER hallucinate verse numbers or content
- Keep responses focused and grounded — avoid generic spiritual platitudes
- Cite the scripture reference for every key point you make
- Keep your response under 120 words`;
}

function buildUserPrompt(
  question: string,
  chunks: RetrievedChunk[],
  history: { role: MessageRole; content: string }[]
): string {
  const contextBlock = chunks
    .map((chunk, i) => {
      const ref = chunk.metadata.reference;
      const scripture = chunk.metadata.scripture.toUpperCase();
      return `[${i + 1}] ${scripture} — ${ref}\n${chunk.content}`;
    })
    .join('\n\n---\n\n');

  const historyBlock =
    history.length > 0
      ? `\n\nConversation so far:\n${history
          .map((m) => `${m.role === 'user' ? 'Seeker' : 'Dharma'}: ${m.content}`)
          .join('\n')}`
      : '';

  return `SCRIPTURE CONTEXT:\n${contextBlock}${historyBlock}\n\nSeeker's question: ${question}`;
}

// ─── Startup Checks ───────────────────────────────────

/**
 * Pre-warms the ONNX embedding model so it's loaded in memory before
 * the first real query. Without this, the first query pays a 10-15s
 * cold-start penalty while @xenova/transformers loads and JIT-compiles
 * the all-MiniLM-L6-v2 model.
 */
export async function warmupEmbedding(): Promise<void> {
  const start = Date.now();
  await getEmbedFn().generate(['warmup']);
  logger.info('Embedding model warmed up', { ms: Date.now() - start });
}

/**
 * Verifies that ChromaDB is reachable and the expected collections exist.
 * Called at startup — throws if ChromaDB is unavailable so the server
 * fails fast rather than silently breaking on the first AI query.
 */
export async function verifyChromaConnection(): Promise<void> {
  const client = getChromaClient();
  // heartbeat throws if ChromaDB is unreachable
  await client.heartbeat();
  // ensure all three scripture collections exist (creates them if absent)
  await getCollections();
  logger.info('ChromaDB connection verified', {
    host: `${env.CHROMA_HOST}:${env.CHROMA_PORT}`,
  });
}

// ─── Shared helpers ───────────────────────────────────

function mapSources(chunks: RetrievedChunk[]): ScriptureSource[] {
  return chunks
    .filter((c) => c.score > 0.6)
    .map((c) => ({
      scripture: c.metadata.scripture,
      reference: c.metadata.reference,
      text: c.content,
      translation: c.metadata.translation,
      relevanceScore: Math.round(c.score * 100) / 100,
    }));
}

const ANTHROPIC_TIMEOUT_MS = 30_000; // 30 seconds

// ─── Main RAG Pipeline ────────────────────────────────

/**
 * answerWithRAG — non-streaming.
 * Accepts optional pre-fetched chunks so the caller can parallelise
 * vector search with other work (e.g. session history fetch).
 */
export async function answerWithRAG(
  query: RAGQuery,
  preloadedChunks?: RetrievedChunk[]
): Promise<RAGResult> {
  const startTime = Date.now();

  const chunks = preloadedChunks ?? await retrieveRelevantChunks(query.question, query.scripture, 6);

  if (chunks.length === 0) {
    return {
      answer:
        'I was unable to find relevant scripture passages for your question. Please try rephrasing, or explore the scriptures directly.',
      sources: [],
      tokensUsed: 0,
      processingMs: Date.now() - startTime,
    };
  }

  const userPrompt = buildUserPrompt(query.question, chunks, query.sessionHistory ?? []);
  const anthropic = getAnthropicClient();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

  try {
    const response = await anthropic.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: userPrompt }],
      },
      { signal: controller.signal }
    );

    clearTimeout(timeoutId);

    const answerBlock = response.content.find((b) => b.type === 'text');
    const answer = answerBlock?.type === 'text' ? answerBlock.text : '';
    const sources = mapSources(chunks);
    const processingMs = Date.now() - startTime;
    const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

    logger.debug('RAG query completed', {
      uid: query.uid,
      scripture: query.scripture ?? 'all',
      chunksRetrieved: chunks.length,
      tokensUsed,
      processingMs,
    });

    return { answer, sources, tokensUsed, processingMs };
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (controller.signal.aborted) {
      throw new Error('AI response timed out. Please try again.');
    }
    throw err;
  }
}

// ─── Streaming RAG Pipeline ───────────────────────────

/**
 * answerWithRAGStream — streams Claude's response token-by-token via SSE.
 *
 * Accepts optional pre-fetched chunks so the route can parallelise
 * vector retrieval with session history fetch (saves ~500ms-2s).
 *
 * Uses AbortController with a 30-second timeout: if Claude doesn't
 * finish within 30 s the stream is aborted and an error is thrown so
 * the caller can send a clean SSE error event.
 */
export async function answerWithRAGStream(
  query: RAGQuery,
  onChunk: (text: string) => void,
  onDone: (result: RAGResult) => Promise<void>,
  preloadedChunks?: RetrievedChunk[]
): Promise<void> {
  const startTime = Date.now();

  const chunks = preloadedChunks ?? await retrieveRelevantChunks(query.question, query.scripture, 6);

  if (chunks.length === 0) {
    const fallback =
      'I was unable to find relevant scripture passages for your question. Please try rephrasing, or explore the scriptures directly.';
    onChunk(fallback);
    await onDone({ answer: fallback, sources: [], tokensUsed: 0, processingMs: Date.now() - startTime });
    return;
  }

  const userPrompt = buildUserPrompt(query.question, chunks, query.sessionHistory ?? []);
  const anthropic = getAnthropicClient();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);

  let fullAnswer = '';

  try {
    const stream = anthropic.messages.stream(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: userPrompt }],
      },
      { signal: controller.signal }
    );

    stream.on('text', (text) => {
      onChunk(text);
      fullAnswer += text;
    });

    const finalMessage = await stream.finalMessage();
    clearTimeout(timeoutId);

    const tokensUsed = finalMessage.usage.input_tokens + finalMessage.usage.output_tokens;
    const sources = mapSources(chunks);
    const processingMs = Date.now() - startTime;

    logger.debug('RAG stream completed', {
      uid: query.uid,
      scripture: query.scripture ?? 'all',
      chunksRetrieved: chunks.length,
      tokensUsed,
      processingMs,
    });

    await onDone({ answer: fullAnswer, sources, tokensUsed, processingMs });
  } catch (err: any) {
    clearTimeout(timeoutId);
    if (controller.signal.aborted) {
      throw new Error('AI response timed out. Please try again.');
    }
    throw err;
  }
}

// ─── Verse Commentary ─────────────────────────────────

export async function generateVerseCommentary(
  reference: string,
  sanskrit: string,
  english: string,
  scripture: string
): Promise<{ commentary: string; tokensUsed: number }> {
  const anthropic = getAnthropicClient();
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 180,
    messages: [
      {
        role: 'user',
        content: `You are a scholar of Hindu scriptures. Write a spiritual commentary on this ${scripture} verse in under 120 words. Be direct, insightful, and practical — connect the verse to inner life.

Verse: ${reference}
Sanskrit: ${sanskrit}
Translation: ${english}

Commentary:`,
      },
    ],
  });

  const block = response.content[0];
  const commentary = block.type === 'text' ? block.text.trim() : '';
  const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;
  return { commentary, tokensUsed };
}

// ─── Title Generation ─────────────────────────────────

/**
 * Generates a short, meaningful title for a chat session from the first message.
 * Uses Claude Haiku for cost efficiency.
 */
export async function generateSessionTitle(firstMessage: string): Promise<string> {
  try {
    const anthropic = getAnthropicClient();
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 30,
      messages: [
        {
          role: 'user',
          content: `Generate a short (4-6 word) title for a spiritual conversation that starts with: "${firstMessage.substring(0, 200)}". Return only the title, no punctuation.`,
        },
      ],
    });

    const block = response.content[0];
    return block.type === 'text' ? block.text.trim() : 'Spiritual Guidance';
  } catch {
    return 'Spiritual Guidance';
  }
}
