import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { aiRateLimiter } from '../../middleware/ratelimiter';
import { requireSubscriptionOrFreeQuota } from '../../middleware/subscription.middleware';
import { AuthenticatedRequest } from '../../types';
import { authHandler } from '../../utils/routehelpers';
import {
  createChatSession,
  getChatSessions,
  getChatSession,
  getChatMessages,
  saveMessage,
  getSessionContextHistory,
  updateSessionTitle,
  deleteChatSession,
  deleteAllChatSessions,
} from './chat.service';
import {
  answerWithRAG,
  answerWithRAGStream,
  generateSessionTitle,
  retrieveRelevantChunks,
} from '../ai/rag.service';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../config/logger';

const router = Router();

// All chat routes require authentication
router.use(requireAuth);

// ─── POST /chat/sessions ──────────────────────────────
const createSessionSchema = z.object({
  scripture: z.enum(['gita', 'ramayana', 'mahabharata']).optional(),
  title: z.string().max(80).optional(),
  id: z.string().uuid().optional(), // client-generated UUID for optimistic creation
});

router.post(
  '/sessions',
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const body = createSessionSchema.parse(req.body);
    const session = await createChatSession(req.user.uid, body.scripture, body.title, body.id);
    sendSuccess(res, session, 201);
  })
);

// ─── GET /chat/sessions ───────────────────────────────
router.get(
  '/sessions',
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 20, 50);
    const afterId = req.query.afterId as string | undefined;
    const result = await getChatSessions(req.user.uid, limit, afterId);
    sendSuccess(res, result);
  })
);

// ─── GET /chat/sessions/:sessionId ───────────────────
router.get(
  '/sessions/:sessionId',
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const session = await getChatSession(req.params.sessionId, req.user.uid);
    sendSuccess(res, session);
  })
);

// ─── DELETE /chat/sessions (clear all) ───────────────
router.delete(
  '/sessions',
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const count = await deleteAllChatSessions(req.user.uid);
    sendSuccess(res, { deleted: count });
  })
);

// ─── DELETE /chat/sessions/:sessionId ────────────────
router.delete(
  '/sessions/:sessionId',
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    await deleteChatSession(req.params.sessionId, req.user.uid);
    sendSuccess(res, { deleted: true });
  })
);

// ─── GET /chat/sessions/:sessionId/messages ───────────
router.get(
  '/sessions/:sessionId/messages',
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const beforeId = req.query.beforeId as string | undefined;
    const result = await getChatMessages(req.params.sessionId, req.user.uid, limit, beforeId);
    sendSuccess(res, result);
  })
);

// ─── POST /chat/sessions/:sessionId/ask ───────────────
const askSchema = z.object({
  question: z.string().min(3).max(1000),
  scripture: z.enum(['gita', 'ramayana', 'mahabharata']).optional(),
});

router.post(
  '/sessions/:sessionId/ask',
  aiRateLimiter,
  requireSubscriptionOrFreeQuota,
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const body = askSchema.parse(req.body);
    const { sessionId } = req.params;
    const scripture = body.scripture;

    const session = await getChatSession(sessionId, req.user.uid);
    await saveMessage(sessionId, req.user.uid, 'user', body.question);

    // Parallelise: history fetch + chunk retrieval run simultaneously
    const [history, preloadedChunks] = await Promise.all([
      getSessionContextHistory(sessionId),
      retrieveRelevantChunks(body.question, scripture ?? session.scripture, 6),
    ]);

    const result = await answerWithRAG(
      {
        question: body.question,
        scripture: scripture ?? session.scripture,
        sessionHistory: history.slice(0, -1),
        uid: req.user.uid,
        sessionId,
      },
      preloadedChunks
    );

    const assistantMessage = await saveMessage(
      sessionId,
      req.user.uid,
      'assistant',
      result.answer,
      result.sources,
      {
        tokensUsed: result.tokensUsed,
        modelUsed: 'claude-sonnet-4-6',
        retrievedChunks: result.sources.length,
        processingMs: result.processingMs,
      }
    );

    // Commit quota only after successful AI response
    await req.commitQuota?.().catch((e) =>
      logger.warn('commitQuota failed', { uid: req.user.uid, error: e })
    );

    // Auto-title on first exchange
    if (session.messageCount === 0) {
      generateSessionTitle(body.question)
        .then((title) => updateSessionTitle(sessionId, title))
        .catch(() => {});
    }

    sendSuccess(res, {
      message: assistantMessage,
      sources: result.sources,
      usage: { tokensUsed: result.tokensUsed, processingMs: result.processingMs },
    });
  })
);

// ─── POST /chat/sessions/:sessionId/ask/stream ────────
// SSE endpoint: streams Claude tokens as they arrive so the client
// can render the response progressively.
//
// Optimisation: SSE headers are flushed immediately after saving the
// user message, then history-fetch and chunk-retrieval run in parallel
// while the client is already connected (cuts ~500 ms–2 s of latency).
//
// Quota: commitQuota() is called only after a successful done event,
// so failed or timed-out requests never consume a user's free quota.

router.post(
  '/sessions/:sessionId/ask/stream',
  aiRateLimiter,
  requireSubscriptionOrFreeQuota,
  authHandler(async (req: AuthenticatedRequest, res: Response, next) => {
    const body = askSchema.parse(req.body);
    const { sessionId } = req.params;
    const scripture = body.scripture;

    let sseOpen = false;

    const writeEvent = (data: object) => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // ── Phase 1: validate + save user message ──────────────────────
      const session = await getChatSession(sessionId, req.user.uid);
      await saveMessage(sessionId, req.user.uid, 'user', body.question);

      // ── Phase 2: open SSE immediately (client shows typing indicator)
      sseOpen = true;
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no'); // disable nginx/proxy buffering
      res.flushHeaders();

      // ── Phase 3: parallel retrieval + history (overlap with network RTT)
      const [history, preloadedChunks] = await Promise.all([
        getSessionContextHistory(sessionId),
        retrieveRelevantChunks(body.question, scripture ?? session.scripture, 6),
      ]);

      // ── Phase 4: stream Claude response ────────────────────────────
      await answerWithRAGStream(
        {
          question: body.question,
          scripture: scripture ?? session.scripture,
          sessionHistory: history.slice(0, -1),
          uid: req.user.uid,
          sessionId,
        },
        (text) => {
          writeEvent({ type: 'chunk', text });
        },
        async (result) => {
          const assistantMessage = await saveMessage(
            sessionId,
            req.user.uid,
            'assistant',
            result.answer,
            result.sources,
            {
              tokensUsed: result.tokensUsed,
              modelUsed: 'claude-sonnet-4-6',
              retrievedChunks: result.sources.length,
              processingMs: result.processingMs,
            }
          );

          // Commit quota only on successful completion
          await req.commitQuota?.().catch((e) =>
            logger.warn('commitQuota failed', { uid: req.user.uid, error: e })
          );

          // For the first exchange, await title generation so the client
          // receives the real title in the done event (no extra round-trip).
          let generatedTitle: string | undefined;
          if (session.messageCount === 0) {
            generatedTitle = await generateSessionTitle(body.question).catch(() => undefined);
            if (generatedTitle) {
              updateSessionTitle(sessionId, generatedTitle).catch(() => {});
            }
          }

          writeEvent({ type: 'done', message: assistantMessage, sources: result.sources, title: generatedTitle });
          res.end();
        },
        preloadedChunks
      );
    } catch (err: any) {
      if (!sseOpen) {
        // Headers not yet sent — let Express handle as a normal HTTP error
        next(err);
      } else {
        writeEvent({ type: 'error', message: err.message ?? 'An error occurred' });
        res.end();
      }
    }
  })
);

// ─── POST /chat/ask (stateless one-shot) ──────────────
router.post(
  '/ask',
  aiRateLimiter,
  requireSubscriptionOrFreeQuota,
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const body = askSchema.parse(req.body);

    const [preloadedChunks] = await Promise.all([
      retrieveRelevantChunks(body.question, body.scripture, 6),
    ]);

    const result = await answerWithRAG(
      {
        question: body.question,
        scripture: body.scripture,
        sessionHistory: [],
        uid: req.user.uid,
        sessionId: 'stateless',
      },
      preloadedChunks
    );

    // Commit quota only after successful response
    await req.commitQuota?.().catch((e) =>
      logger.warn('commitQuota failed', { uid: req.user.uid, error: e })
    );

    sendSuccess(res, {
      answer: result.answer,
      sources: result.sources,
      usage: { tokensUsed: result.tokensUsed, processingMs: result.processingMs },
    });
  })
);

export default router;
