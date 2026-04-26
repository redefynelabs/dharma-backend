import { Router, Response } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middleware/auth.middleware';
import { authRateLimiter } from '../../middleware/ratelimiter';
import { AuthenticatedRequest } from '../../types';
import { authHandler } from '../../utils/routehelpers';
import {
  getOrCreateUserProfile,
  getUserProfile,
  updateUserPreferences,
  updateDisplayName,
  deleteUserData,
  upsertDeviceSession,
  getDeviceSessions,
  removeDeviceSession,
} from './user.service';
import { sendSuccess, NotFoundError } from '../../utils/response';
import { getFirebaseAuth } from '../../config/firebase';

const router = Router();

const deviceSchema = z.object({
  deviceId:   z.string().min(1).max(128).optional(),
  platform:   z.enum(['ios', 'android']).optional(),
  osVersion:  z.string().max(32).optional(),
  appVersion: z.string().max(32).optional(),
  label:      z.string().max(128).optional(),
});

// ─── POST /auth/sync ──────────────────────────────────
// Called after Firebase sign-in (email or Google). Creates or updates profile.
router.post(
  '/auth/sync',
  authRateLimiter,
  requireAuth,
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const profile = await getOrCreateUserProfile(req.user);

    // Fire-and-forget device session — doesn't need to block the response
    const device = deviceSchema.safeParse(req.body);
    if (device.success && device.data.deviceId && device.data.platform) {
      upsertDeviceSession(req.user.uid, {
        deviceId:   device.data.deviceId,
        platform:   device.data.platform,
        osVersion:  device.data.osVersion ?? '',
        appVersion: device.data.appVersion ?? '',
        label:      device.data.label ?? device.data.platform,
      }).catch(() => {});
    }

    sendSuccess(res, {
      uid: profile.uid,
      email: profile.email,
      displayName: profile.displayName,
      photoURL: profile.photoURL,
      authProvider: profile.authProvider,
      subscription: {
        tier: profile.subscription.tier,
        state: profile.subscription.state,
        currentPeriodEnd: profile.subscription.currentPeriodEnd,
      },
      preferences: profile.preferences,
      stats: {
        totalChats: profile.stats.totalChats,
        dailyAiQueries: (() => {
          const resetAt = profile.stats.dailyAiQueriesResetAt?.toMillis?.() ?? 0;
          const elapsed = Date.now() - resetAt;
          return elapsed >= 24 * 60 * 60 * 1000 ? 0 : (profile.stats.dailyAiQueries ?? 0);
        })(),
        dailyCommentary: (() => {
          const resetAt = profile.stats.dailyCommentaryResetAt?.toMillis?.() ?? 0;
          const elapsed = Date.now() - resetAt;
          return elapsed >= 24 * 60 * 60 * 1000 ? 0 : (profile.stats.dailyCommentary ?? 0);
        })(),
      },
      isNewUser: !profile.stats.totalChats && !profile.stats.totalAiQueries,
    });
  })
);

// ─── GET /users/me ────────────────────────────────────
router.get(
  '/users/me',
  requireAuth,
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const profile = await getUserProfile(req.user.uid);
    if (!profile) throw new NotFoundError('User profile');
    sendSuccess(res, {
      uid: profile.uid,
      email: profile.email,
      displayName: profile.displayName,
      photoURL: profile.photoURL,
      authProvider: profile.authProvider,
      subscription: {
        tier: profile.subscription.tier,
        state: profile.subscription.state,
        period: profile.subscription.period,
        currentPeriodEnd: profile.subscription.currentPeriodEnd,
      },
      preferences: profile.preferences,
      stats: {
        totalChats: profile.stats.totalChats,
        dailyAiQueries: (() => {
          const resetAt = profile.stats.dailyAiQueriesResetAt?.toMillis?.() ?? 0;
          const elapsed = Date.now() - resetAt;
          return elapsed >= 24 * 60 * 60 * 1000 ? 0 : (profile.stats.dailyAiQueries ?? 0);
        })(),
        dailyCommentary: (() => {
          const resetAt = profile.stats.dailyCommentaryResetAt?.toMillis?.() ?? 0;
          const elapsed = Date.now() - resetAt;
          return elapsed >= 24 * 60 * 60 * 1000 ? 0 : (profile.stats.dailyCommentary ?? 0);
        })(),
      },
      createdAt: profile.createdAt,
    });
  })
);

// ─── PATCH /users/me ──────────────────────────────────
const updateSchema = z.object({
  displayName: z.string().min(1).max(50).optional(),
  preferences: z
    .object({
      preferredScripture: z.enum(['gita', 'ramayana', 'mahabharata', 'all']).optional(),
      language: z.enum(['en', 'hi', 'sa']).optional(),
      notificationsEnabled: z.boolean().optional(),
    })
    .optional(),
});

router.patch(
  '/users/me',
  requireAuth,
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const body = updateSchema.parse(req.body);
    if (body.displayName) await updateDisplayName(req.user.uid, body.displayName);
    if (body.preferences) await updateUserPreferences(req.user.uid, body.preferences);
    sendSuccess(res, { updated: true });
  })
);

// ─── DELETE /users/me (GDPR) ──────────────────────────
router.delete(
  '/users/me',
  requireAuth,
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    await deleteUserData(req.user.uid);
    await getFirebaseAuth().deleteUser(req.user.uid);
    sendSuccess(res, { deleted: true });
  })
);

// ─── GET /users/me/devices ────────────────────────────
router.get(
  '/users/me/devices',
  requireAuth,
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const devices = await getDeviceSessions(req.user.uid);
    sendSuccess(res, { devices });
  })
);

// ─── DELETE /users/me/devices/:deviceId ───────────────
router.delete(
  '/users/me/devices/:deviceId',
  requireAuth,
  authHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { deviceId } = req.params;
    await removeDeviceSession(req.user.uid, deviceId);
    sendSuccess(res, { removed: true });
  })
);

export default router;