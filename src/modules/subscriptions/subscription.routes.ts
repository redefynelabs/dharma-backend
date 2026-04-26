import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { authRateLimiter } from '../../middleware/ratelimiter';
import { AuthenticatedRequest, RevenueCatWebhookPayload } from '../../types';
import { authHandler } from '../../utils/routehelpers';
import {
  verifyWebhookSignature,
  syncSubscriptionToFirestore,
  processWebhookEvent,
} from './revenuecat.service';
import { getUserProfile } from '../users/user.service';
import { sendSuccess, NotFoundError } from '../../utils/response';
import { logger } from '../../config/logger';
import { env } from '../../config/env';

const router = Router();

// ─── POST /subscriptions/webhook ─────────────────────
// No auth middleware — verified via shared secret header.
// RevenueCat sends the raw secret as the value of the Authorization header.
router.post('/webhook', async (req: Request, res: Response) => {
  const isValid = verifyWebhookSignature(req.headers.authorization);
  if (!isValid) {
    logger.warn('Webhook received with invalid signature', { ip: req.ip });
    res.status(200).json({ received: true }); // always 200 to prevent retry floods
    return;
  }

  const payload = req.body as RevenueCatWebhookPayload;
  if (!payload?.event?.type) {
    res.status(200).json({ received: true });
    return;
  }

  // ACK immediately — RevenueCat considers a webhook delivered once it
  // receives a 200 within a few seconds.  Processing is fire-and-forget;
  // errors are logged and can be replayed from the subscription_events collection.
  res.status(200).json({ received: true });

  processWebhookEvent(payload).catch((err) => {
    logger.error('Webhook processing failed', {
      eventType: payload.event.type,
      eventId: payload.event.id,
      error: err.message,
    });
  });
});

// ─── GET /subscriptions/status ────────────────────────
router.get(
  '/status',
  requireAuth,
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const profile = await getUserProfile(req.user.uid);
    if (!profile) throw new NotFoundError('User profile');
    const { subscription, stats } = profile;
    sendSuccess(res, {
      tier: subscription.tier,
      state: subscription.state,
      period: subscription.period,
      currentPeriodEnd: subscription.currentPeriodEnd,
      gracePeriodEnd: subscription.gracePeriodEnd,
      store: subscription.store,
      usage: {
        dailyAiQueries: stats.dailyAiQueries,
        dailyAiQueriesResetAt: stats.dailyAiQueriesResetAt,
        dailyLimit: env.FREE_DAILY_AI_QUERIES,
      },
    });
  })
);

// ─── POST /subscriptions/sync ─────────────────────────
// Rate-limited: this endpoint calls the RevenueCat external API on every
// request, so we cap it to prevent runaway calls.
const syncSchema = z.object({
  revenueCatAppUserId: z.string().optional(),
});

router.post(
  '/sync',
  requireAuth,
  authRateLimiter, // 30 requests / 15 min per user
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const body = syncSchema.parse(req.body);
    const appUserId = body.revenueCatAppUserId ?? req.user.uid;
    const subscription = await syncSubscriptionToFirestore(req.user.uid, appUserId);
    sendSuccess(res, {
      tier: subscription.tier,
      state: subscription.state,
      period: subscription.period,
      currentPeriodEnd: subscription.currentPeriodEnd,
    });
  })
);

// ─── GET /subscriptions/plans ─────────────────────────
router.get('/plans', (_req: Request, res: Response) => {
  sendSuccess(res, {
    plans: [
      {
        id: 'free',
        name: 'Seeker',
        price: 0,
        features: [
          `${env.FREE_DAILY_AI_QUERIES} AI guidance queries per day`,
          'Full scripture reading',
          'Basic search',
        ],
      },
      {
        id: 'pro_monthly',
        productId: env.PRO_MONTHLY_PRODUCT_ID,
        name: 'Devotee',
        period: 'monthly',
        features: [
          'Unlimited AI guidance',
          'Full scripture reading',
          'Deep search across all texts',
          'Chat history sync',
          'Offline access',
        ],
      },
      {
        id: 'pro_yearly',
        productId: env.PRO_YEARLY_PRODUCT_ID,
        name: 'Devotee (Annual)',
        period: 'yearly',
        savings: '~40%',
        features: ['Everything in monthly', 'Best value'],
      },
    ],
  });
});

export default router;
