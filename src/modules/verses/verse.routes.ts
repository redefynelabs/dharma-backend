import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { aiRateLimiter } from '../../middleware/ratelimiter';
import { requireCommentaryQuota } from '../../middleware/subscription.middleware';
import { AuthenticatedRequest } from '../../types';
import { authHandler } from '../../utils/routehelpers';
import { generateVerseCommentary } from '../ai/rag.service';
import { sendSuccess } from '../../utils/response';
import { logger } from '../../config/logger';

const router = Router();

router.use(requireAuth);

// ─── POST /verses/commentary ──────────────────────────

const commentarySchema = z.object({
  scripture: z.enum(['gita', 'ramayana', 'mahabharata']),
  reference: z.string().min(1).max(100),
  sanskrit:  z.string().max(2000).optional().default(''),
  english:   z.string().min(1).max(2000),
});

router.post(
  '/commentary',
  aiRateLimiter,
  requireCommentaryQuota,
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const body = commentarySchema.parse(req.body);

    const { commentary, tokensUsed } = await generateVerseCommentary(
      body.reference,
      body.sanskrit,
      body.english,
      body.scripture
    );

    await req.commitQuota?.().catch((e) =>
      logger.warn('commitQuota (commentary) failed', { uid: req.user.uid, error: e })
    );

    sendSuccess(res, { commentary, tokensUsed });
  })
);

export default router;
