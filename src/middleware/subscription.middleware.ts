import { Request, Response, NextFunction } from 'express';
import admin from 'firebase-admin';
import { getFirestore, COLLECTIONS } from '../config/firebase';
import { AuthenticatedRequest, UserProfile } from '../types';
import { SubscriptionError, RateLimitError, NotFoundError } from '../utils/response';
import { env } from '../config/env';

// ─── Subscription Cache (5-min TTL, pro users only) ───
//
// We cache the subscription tier/state per UID to avoid a Firestore
// read on every AI request for pro users.  Free users always need a
// fresh read so we can inspect their daily counter.
//
// Cache is invalidated by invalidateSubscriptionCache() which is
// called from revenuecat.service.ts whenever a webhook updates the
// user's subscription status.

interface CacheEntry {
  tier: 'free' | 'pro';
  state: string;
  expiresAt: number;
}

const subscriptionCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function invalidateSubscriptionCache(uid: string): void {
  subscriptionCache.delete(uid);
}

function getCachedStatus(uid: string): Pick<CacheEntry, 'tier' | 'state'> | null {
  const entry = subscriptionCache.get(uid);
  if (!entry || Date.now() > entry.expiresAt) {
    subscriptionCache.delete(uid);
    return null;
  }
  return { tier: entry.tier, state: entry.state };
}

function setCachedStatus(uid: string, tier: 'free' | 'pro', state: string): void {
  subscriptionCache.set(uid, { tier, state, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Enforces subscription tier access for AI query endpoints.
 *
 * IMPORTANT: This middleware only CHECKS the quota — it does NOT
 * increment any counter.  Instead it attaches `req.commitQuota()`,
 * a function the route must call after a successful AI response.
 * This ensures failed AI calls never consume a user's free quota.
 */
export async function requireSubscriptionOrFreeQuota(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const uid = authReq.user.uid;
    const db = getFirestore();
    const userRef = db.collection(COLLECTIONS.USERS).doc(uid);

    // ── Step 1: resolve subscription tier (cached for pro users) ──
    const cached = getCachedStatus(uid);
    let profile: UserProfile | null = null;
    let tier: 'free' | 'pro';
    let state: string;

    if (cached) {
      tier = cached.tier;
      state = cached.state;
    } else {
      const snap = await userRef.get();
      if (!snap.exists) throw new NotFoundError('User profile');
      profile = snap.data() as UserProfile;
      authReq.userProfile = profile;
      tier = profile.subscription.tier;
      state = profile.subscription.state;
      setCachedStatus(uid, tier, state);
    }

    // ── Step 2: pro users — unlimited, attach cheap commit ─────────
    if (tier === 'pro' && ['active', 'grace_period'].includes(state)) {
      authReq.commitQuota = async () => {
        await userRef.update({
          'stats.totalAiQueries': admin.firestore.FieldValue.increment(1),
          lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      };
      next();
      return;
    }

    // ── Step 3: free tier — must read daily counter from Firestore ──
    if (!profile) {
      const snap = await userRef.get();
      if (!snap.exists) throw new NotFoundError('User profile');
      profile = snap.data() as UserProfile;
      authReq.userProfile = profile;
    }

    const { stats } = profile;
    const now = Date.now();
    const resetAt = stats.dailyAiQueriesResetAt?.toMillis?.() ?? 0;
    const isNewDay = now - resetAt >= 24 * 60 * 60 * 1000;
    const currentCount = isNewDay ? 0 : (stats.dailyAiQueries ?? 0);

    if (currentCount >= env.FREE_DAILY_AI_QUERIES) {
      throw new RateLimitError(
        `Daily limit of ${env.FREE_DAILY_AI_QUERIES} AI queries reached. Upgrade to Pro for unlimited access.`
      );
    }

    // ── Step 4: attach commit — called only after successful AI response ──
    authReq.commitQuota = async () => {
      if (isNewDay) {
        // New calendar day: reset counter to 1 (this query)
        await userRef.update({
          'stats.dailyAiQueries': 1,
          'stats.dailyAiQueriesResetAt': admin.firestore.FieldValue.serverTimestamp(),
          'stats.totalAiQueries': admin.firestore.FieldValue.increment(1),
          lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        await userRef.update({
          'stats.dailyAiQueries': admin.firestore.FieldValue.increment(1),
          'stats.totalAiQueries': admin.firestore.FieldValue.increment(1),
          lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    };

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Hard gate — Pro subscription required (no free fallback).
 */
export async function requireProSubscription(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authReq = req as AuthenticatedRequest;
    const db = getFirestore();
    const userSnap = await db.collection(COLLECTIONS.USERS).doc(authReq.user.uid).get();

    if (!userSnap.exists) throw new NotFoundError('User profile');

    const profile = userSnap.data() as UserProfile;
    const { tier, state } = profile.subscription;

    if (tier !== 'pro' || !['active', 'grace_period'].includes(state)) {
      throw new SubscriptionError();
    }

    authReq.userProfile = profile;
    next();
  } catch (err) {
    next(err);
  }
}
