import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { aiRateLimiter } from '../../middleware/ratelimiter';
import { requireCommentaryQuota } from '../../middleware/subscription.middleware';
import { AuthenticatedRequest } from '../../types';
import { authHandler } from '../../utils/routehelpers';
import { generateVerseCommentary } from '../ai/rag.service';
import { sendSuccess } from '../../utils/response';
import { getFirestore, COLLECTIONS } from '../../config/firebase';
import { logger } from '../../config/logger';

const router = Router();

router.use(requireAuth);

// Firestore doc ID — safe key from scripture + reference (e.g. "gita_BG_1.1")
function cacheKey(scripture: string, reference: string): string {
  return `${scripture}_${reference.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

// ─── GET /verses/commentary?scripture=&reference= ────
// Returns cached commentary if it exists, null otherwise. No quota consumed.

router.get(
  '/commentary',
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const scripture = String(req.query.scripture ?? '');
    const reference = String(req.query.reference ?? '');

    if (!scripture || !reference) {
      return sendSuccess(res, { commentary: null });
    }

    const doc = await getFirestore()
      .collection(COLLECTIONS.VERSE_COMMENTARIES)
      .doc(cacheKey(scripture, reference))
      .get();

    const commentary = doc.exists ? (doc.data()?.commentary as string) : null;
    sendSuccess(res, { commentary });
  })
);

// ─── POST /verses/commentary ──────────────────────────
// Checks cache first — quota only consumed on actual generation.

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
    const db   = getFirestore();
    const key  = cacheKey(body.scripture, body.reference);
    const ref  = db.collection(COLLECTIONS.VERSE_COMMENTARIES).doc(key);

    // ── Cache hit: return cached but still charge quota ──
    const existing = await ref.get();
    if (existing.exists) {
      const commentary = existing.data()?.commentary as string;
      await req.commitQuota?.().catch((e) =>
        logger.warn('commitQuota (commentary) failed', { uid: req.user.uid, error: e })
      );
      logger.debug('Commentary cache hit', { reference: body.reference });
      return sendSuccess(res, { commentary, cached: true });
    }

    // ── Cache miss: generate, store, charge quota ─────
    const { commentary, tokensUsed } = await generateVerseCommentary(
      body.reference,
      body.sanskrit,
      body.english,
      body.scripture
    );

    // Save to Firestore so every future request gets it for free
    await ref.set({
      scripture: body.scripture,
      reference: body.reference,
      commentary,
      generatedAt: new Date().toISOString(),
    });

    await req.commitQuota?.().catch((e) =>
      logger.warn('commitQuota (commentary) failed', { uid: req.user.uid, error: e })
    );

    logger.debug('Commentary generated and cached', {
      reference: body.reference, tokensUsed,
    });

    sendSuccess(res, { commentary, cached: false });
  })
);

export default router;
