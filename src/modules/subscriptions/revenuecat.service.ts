import axios, { AxiosInstance } from 'axios';
import admin from 'firebase-admin';
import { env } from '../../config/env';
import { getFirestore, COLLECTIONS } from '../../config/firebase';
import {
  RevenueCatSubscriberResponse,
  RevenueCatWebhookPayload,
  RevenueCatEventType,
  SubscriptionStatus,
  SubscriptionTier,
  SubscriptionState,
  SubscriptionPeriod,
} from '../../types';
import { logger } from '../../config/logger';
import { invalidateSubscriptionCache } from '../../middleware/subscription.middleware';
import crypto from 'crypto';

const PRO_ENTITLEMENT_ID = 'pro';

const rcClient: AxiosInstance = axios.create({
  baseURL: 'https://api.revenuecat.com/v1',
  headers: {
    Authorization: `Bearer ${env.REVENUECAT_API_KEY}`,
    'Content-Type': 'application/json',
  },
  timeout: 10_000,
});

// ─── Webhook Verification ─────────────────────────────

export function verifyWebhookSignature(authorizationHeader: string | undefined): boolean {
  if (!authorizationHeader) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(authorizationHeader),
      Buffer.from(env.REVENUECAT_WEBHOOK_SECRET)
    );
  } catch {
    return false;
  }
}

// ─── Subscriber Fetch ─────────────────────────────────

export async function fetchRevenueCatSubscriber(
  appUserId: string
): Promise<RevenueCatSubscriberResponse> {
  const response = await rcClient.get<RevenueCatSubscriberResponse>(
    `/subscribers/${encodeURIComponent(appUserId)}`
  );
  return response.data;
}

// ─── Subscription State Derivation ────────────────────

function deriveSubscriptionStatus(
  subscriber: RevenueCatSubscriberResponse['subscriber']
): Record<string, unknown> {
  const proEntitlement = subscriber.entitlements[PRO_ENTITLEMENT_ID];

  if (!proEntitlement) {
    return { tier: 'free', state: 'none' };
  }

  const now = new Date();
  const productId = proEntitlement.product_identifier;
  const subscription = subscriber.subscriptions[productId];
  const period: SubscriptionPeriod =
    productId === env.PRO_YEARLY_PRODUCT_ID ? 'yearly' : 'monthly';

  const base: Record<string, unknown> = {
    tier: 'pro' as SubscriptionTier,
    period,
    productId,
    revenueCatAppUserId: subscriber.app_user_id,
    store: subscription?.store?.toLowerCase(),
    originalTransactionId: subscription?.store_transaction_id,
    currentPeriodStart: subscription?.purchase_date
      ? admin.firestore.Timestamp.fromDate(new Date(subscription.purchase_date))
      : undefined,
  };

  // Grace period check
  if (proEntitlement.grace_period_expires_date) {
    const graceEnd = new Date(proEntitlement.grace_period_expires_date);
    if (graceEnd > now) {
      return {
        ...base,
        state: 'grace_period' as SubscriptionState,
        currentPeriodEnd: proEntitlement.expires_date
          ? admin.firestore.Timestamp.fromDate(new Date(proEntitlement.expires_date))
          : undefined,
        gracePeriodEnd: admin.firestore.Timestamp.fromDate(graceEnd),
      };
    }
  }

  // Active check
  if (proEntitlement.expires_date) {
    const expiresDate = new Date(proEntitlement.expires_date);
    const state: SubscriptionState = expiresDate > now ? 'active' : 'expired';
    return {
      ...base,
      state,
      currentPeriodEnd: admin.firestore.Timestamp.fromDate(expiresDate),
    };
  }

  // Non-expiring (promotional / lifetime)
  return { ...base, state: 'active' as SubscriptionState };
}

// ─── Sync to Firestore ────────────────────────────────

export async function syncSubscriptionToFirestore(
  uid: string,
  appUserId: string
): Promise<SubscriptionStatus> {
  const subscriber = await fetchRevenueCatSubscriber(appUserId);
  const statusData = deriveSubscriptionStatus(subscriber.subscriber);

  const subscriptionStatus = {
    ...statusData,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await getFirestore().collection(COLLECTIONS.USERS).doc(uid).update({
    subscription: subscriptionStatus,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Invalidate the in-memory subscription cache so the next request
  // picks up the updated tier/state from Firestore immediately.
  invalidateSubscriptionCache(uid);

  logger.info('Subscription synced', { uid, tier: statusData.tier, state: statusData.state });
  return subscriptionStatus as unknown as SubscriptionStatus;
}

// ─── Webhook Event Processor ──────────────────────────

export async function processWebhookEvent(payload: RevenueCatWebhookPayload): Promise<void> {
  const { event } = payload;
  const { type, app_user_id, original_app_user_id } = event;

  const rcUserId = type === 'TRANSFER' ? original_app_user_id : app_user_id;
  const uid = await resolveFirebaseUid(rcUserId);

  if (!uid) {
    logger.warn('Webhook: could not resolve Firebase UID', { rcUserId, type });
    return;
  }

  await logWebhookEvent(uid, payload);

  const db = getFirestore();
  const userRef = db.collection(COLLECTIONS.USERS).doc(uid);

  type EventHandler = () => Promise<void>;

  const handlers: Partial<Record<RevenueCatEventType, EventHandler>> = {
    INITIAL_PURCHASE: async () => { await syncSubscriptionToFirestore(uid, rcUserId); },
    RENEWAL:          async () => { await syncSubscriptionToFirestore(uid, rcUserId); },
    UNCANCELLATION:   async () => { await syncSubscriptionToFirestore(uid, rcUserId); },
    PRODUCT_CHANGE:   async () => { await syncSubscriptionToFirestore(uid, rcUserId); },
    CANCELLATION:     async () => { await syncSubscriptionToFirestore(uid, rcUserId); },

    EXPIRATION: async () => {
      await userRef.update({
        'subscription.tier': 'free',
        'subscription.state': 'expired',
        'subscription.updatedAt': admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      invalidateSubscriptionCache(uid);
    },

    BILLING_ISSUE: async () => {
      await userRef.update({
        'subscription.state': 'billing_retry',
        'subscription.updatedAt': admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      invalidateSubscriptionCache(uid);
    },

    SUBSCRIPTION_PAUSED: async () => {
      await userRef.update({
        'subscription.state': 'paused',
        'subscription.updatedAt': admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      invalidateSubscriptionCache(uid);
    },

    TRANSFER: async () => {
      const newUid = await resolveFirebaseUid(app_user_id);
      if (newUid) await syncSubscriptionToFirestore(newUid, app_user_id);
      await userRef.update({
        'subscription.tier': 'free',
        'subscription.state': 'none',
        'subscription.updatedAt': admin.firestore.FieldValue.serverTimestamp(),
      });
      invalidateSubscriptionCache(uid);
    },
  };

  const handler = handlers[type];
  if (handler) {
    await handler();
    logger.info('Webhook processed', { uid, type });
  } else {
    logger.debug('Webhook event ignored', { type });
  }
}

// ─── Helpers ──────────────────────────────────────────

async function resolveFirebaseUid(appUserId: string): Promise<string | null> {
  try {
    // First try: appUserId IS the Firebase UID (recommended client setup)
    const direct = await getFirestore().collection(COLLECTIONS.USERS).doc(appUserId).get();
    if (direct.exists) return appUserId;

    // Fallback: query by stored revenueCatAppUserId field
    const snap = await getFirestore()
      .collection(COLLECTIONS.USERS)
      .where('subscription.revenueCatAppUserId', '==', appUserId)
      .limit(1)
      .get();

    return snap.empty ? null : snap.docs[0].id;
  } catch {
    return null;
  }
}

async function logWebhookEvent(uid: string, payload: RevenueCatWebhookPayload): Promise<void> {
  await getFirestore().collection(COLLECTIONS.SUBSCRIPTION_EVENTS).add({
    uid,
    eventType: payload.event.type,
    eventId: payload.event.id,
    environment: payload.event.environment,
    payload: payload.event,
    receivedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}