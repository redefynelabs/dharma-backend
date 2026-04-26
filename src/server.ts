import app from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { getFirebaseApp } from './config/firebase';
import { warmupEmbedding, verifyChromaConnection } from './modules/ai/rag.service';

// ─── Firebase ──────────────────────────────────────���──

try {
  getFirebaseApp();
  logger.info('Firebase Admin initialized');
} catch (err) {
  logger.error('Firebase initialization failed', { error: err });
  process.exit(1);
}

// ─── HTTP Server ──────────────────────────────────────

const server = app.listen(env.PORT, () => {
  logger.info('Dharma backend running', {
    port: env.PORT,
    env: env.NODE_ENV,
    version: env.API_VERSION,
  });
});

// ─── ChromaDB + Embedding Warmup ──────────────────────
//
// Retry with back-off so `npm run dev` works even when Docker is still
// starting up.  AI routes degrade gracefully until ChromaDB is ready.

const CHROMA_RETRY_INTERVALS_MS = [2_000, 5_000, 10_000, 15_000, 30_000];

async function initAiServices(attempt = 0): Promise<void> {
  try {
    await verifyChromaConnection();
    await warmupEmbedding();
    logger.info('AI services ready');
  } catch (err) {
    const delay = CHROMA_RETRY_INTERVALS_MS[attempt] ?? 30_000;
    const isLastAttempt = attempt >= CHROMA_RETRY_INTERVALS_MS.length;

    if (isLastAttempt) {
      logger.error(
        'ChromaDB unavailable after all retries — AI queries will fail until it is reachable. ' +
        'Run: docker compose up chromadb -d',
        { error: err instanceof Error ? err.message : String(err) }
      );
      return;
    }

    logger.warn(
      `ChromaDB not ready (attempt ${attempt + 1}/${CHROMA_RETRY_INTERVALS_MS.length + 1}). ` +
      `Retrying in ${delay / 1000}s… Run: docker compose up chromadb -d`,
      { error: err instanceof Error ? err.message : String(err) }
    );

    setTimeout(() => initAiServices(attempt + 1), delay);
  }
}

initAiServices();

// ─── Graceful Shutdown ────────────────────────────────

function shutdown(signal: string) {
  logger.info(`${signal} received — shutting down gracefully`);

  server.close(() => {
    logger.info('HTTP server closed');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

export default server;
