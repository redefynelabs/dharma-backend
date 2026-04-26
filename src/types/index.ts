// ─────────────────────────────────────────────────────
// Core domain types for Dharma backend
// ─────────────────────────────────────────────────────

// ─── Auth ─────────────────────────────────────────────

export interface DecodedFirebaseToken {
  uid: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
  firebase: {
    sign_in_provider: 'google.com' | 'password' | 'anonymous';
  };
  iat: number;
  exp: number;
}

// ─── User / Profile ───────────────────────────────────

export type AuthProvider = 'email' | 'google';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  authProvider: AuthProvider;
  subscription: SubscriptionStatus;
  preferences: UserPreferences;
  stats: UserStats;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
  lastActiveAt: FirestoreTimestamp;
}

export interface UserPreferences {
  preferredScripture: 'gita' | 'ramayana' | 'mahabharata' | 'all';
  language: 'en' | 'hi' | 'sa'; // English, Hindi, Sanskrit
  notificationsEnabled: boolean;
}

export interface UserStats {
  totalChats: number;
  totalAiQueries: number;
  dailyAiQueries: number;
  dailyAiQueriesResetAt: FirestoreTimestamp;
  dailyCommentary: number;
  dailyCommentaryResetAt: FirestoreTimestamp;
  scriptureSessions: Record<string, number>; // scripture -> session count
}

// ─── Subscription ─────────────────────────────────────

export type SubscriptionTier = 'free' | 'pro';
export type SubscriptionPeriod = 'monthly' | 'yearly';
export type SubscriptionState =
  | 'active'
  | 'expired'
  | 'cancelled'
  | 'grace_period'
  | 'billing_retry'
  | 'paused'
  | 'none';

export interface SubscriptionStatus {
  tier: SubscriptionTier;
  state: SubscriptionState;
  period?: SubscriptionPeriod;
  productId?: string;
  originalTransactionId?: string;
  currentPeriodStart?: FirestoreTimestamp;
  currentPeriodEnd?: FirestoreTimestamp;
  gracePeriodEnd?: FirestoreTimestamp;
  revenueCatAppUserId?: string;
  store?: 'app_store' | 'play_store' | 'stripe' | 'promotional';
  updatedAt: FirestoreTimestamp;
}

// ─── RevenueCat ───────────────────────────────────────

export interface RevenueCatSubscriberResponse {
  subscriber: {
    app_user_id: string;
    entitlements: Record<string, RevenueCatEntitlement>;
    subscriptions: Record<string, RevenueCatSubscription>;
    non_subscriptions: Record<string, unknown[]>;
    first_seen: string;
    last_seen: string;
    management_url?: string;
  };
}

export interface RevenueCatEntitlement {
  expires_date: string | null;
  grace_period_expires_date: string | null;
  product_identifier: string;
  purchase_date: string;
}

export interface RevenueCatSubscription {
  auto_resume_date: string | null;
  billing_issues_detected_at: string | null;
  expires_date: string;
  grace_period_expires_date: string | null;
  is_sandbox: boolean;
  original_purchase_date: string;
  period_type: 'normal' | 'trial' | 'intro';
  product_plan_identifier?: string;
  purchase_date: string;
  refunded_at: string | null;
  store: 'app_store' | 'play_store' | 'stripe' | 'promotional';
  store_transaction_id: string;
  unsubscribe_detected_at: string | null;
}

export interface RevenueCatWebhookPayload {
  api_version: string;
  event: {
    aliases: string[];
    app_id: string;
    app_user_id: string;
    commission_percentage?: number;
    country_code?: string;
    currency?: string;
    entitlement_id?: string;
    entitlement_ids?: string[];
    environment: 'SANDBOX' | 'PRODUCTION';
    event_timestamp_ms: number;
    expiration_at_ms?: number;
    grace_period_expiration_at_ms?: number;
    id: string;
    is_family_share?: boolean;
    offer_code?: string;
    original_app_user_id: string;
    original_transaction_id?: string;
    period_type?: 'NORMAL' | 'TRIAL' | 'INTRO';
    presented_offering_id?: string;
    price?: number;
    price_in_purchased_currency?: number;
    product_id?: string;
    purchased_at_ms?: number;
    renewal_number?: number;
    store: 'APP_STORE' | 'PLAY_STORE' | 'STRIPE' | 'PROMOTIONAL';
    subscriber_attributes?: Record<string, { value: string; updated_at_ms: number }>;
    transaction_id?: string;
    type: RevenueCatEventType;
  };
}

export type RevenueCatEventType =
  | 'INITIAL_PURCHASE'
  | 'RENEWAL'
  | 'CANCELLATION'
  | 'UNCANCELLATION'
  | 'NON_RENEWING_PURCHASE'
  | 'SUBSCRIPTION_PAUSED'
  | 'EXPIRATION'
  | 'BILLING_ISSUE'
  | 'PRODUCT_CHANGE'
  | 'TRANSFER'
  | 'SUBSCRIBER_ALIAS';

// ─── Device Session ───────────────────────────────────

export interface DeviceSession {
  deviceId: string;
  platform: 'ios' | 'android';
  osVersion: string;
  appVersion: string;
  label: string; // e.g. "iPhone · iOS 18.2"
  createdAt: FirestoreTimestamp;
  lastActiveAt: FirestoreTimestamp;
}

// ─── Chat ─────────────────────────────────────────────

export type Scripture = 'gita' | 'ramayana' | 'mahabharata';
export type MessageRole = 'user' | 'assistant';

export interface ChatSession {
  id: string;
  uid: string;
  title: string;
  scripture?: Scripture;
  messageCount: number;
  lastMessage: string;
  createdAt: FirestoreTimestamp;
  updatedAt: FirestoreTimestamp;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  uid: string;
  role: MessageRole;
  content: string;
  sources?: ScriptureSource[];
  metadata?: {
    tokensUsed?: number;
    modelUsed?: string;
    retrievedChunks?: number;
    processingMs?: number;
  };
  createdAt: FirestoreTimestamp;
}

export interface ScriptureSource {
  scripture: Scripture;
  reference: string;      // e.g. "Chapter 2, Verse 47" or "Yuddha Kanda, Sarga 15"
  text: string;           // original verse/passage (from verified data)
  translation?: string;
  relevanceScore: number;
}

// ─── AI / RAG ─────────────────────────────────────────

export interface RAGQuery {
  question: string;
  scripture?: Scripture;
  sessionHistory?: { role: MessageRole; content: string }[];
  uid: string;
  sessionId: string;
}

export interface RAGResult {
  answer: string;
  sources: ScriptureSource[];
  tokensUsed: number;
  processingMs: number;
}

export interface ChromaDocument {
  id: string;
  content: string;
  metadata: {
    scripture: Scripture;
    reference: string;
    chapter?: number;
    verse?: number | string;
    kanda?: string;
    sarga?: number;
    parva?: string;
    section?: number;
    translation?: string;
  };
}

// ─── API ──────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
  meta?: {
    timestamp: string;
    requestId?: string;
  };
}

// ─── Express Extensions ───────────────────────────────

import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user: DecodedFirebaseToken;
  userProfile?: UserProfile;
  /** Call this after a successful AI response to atomically commit the quota increment. */
  commitQuota?: () => Promise<void>;
}

// ─── Firestore ────────────────────────────────────────

// Use this for Firestore Timestamps stored in documents.
// In practice, admin.firestore.Timestamp satisfies this interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FirestoreTimestamp = any;