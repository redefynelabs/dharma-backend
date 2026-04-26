import admin from 'firebase-admin';
import { getFirestore, COLLECTIONS } from '../../config/firebase';
import { UserProfile, DecodedFirebaseToken, AuthProvider, DeviceSession } from '../../types';
import { logger } from '../../config/logger';

// Firestore batches are limited to 500 write operations.
const FIRESTORE_BATCH_SIZE = 450;

const DEFAULT_SUBSCRIPTION = {
  tier: 'free' as const,
  state: 'none' as const,
  updatedAt: null as unknown as admin.firestore.Timestamp, // set to serverTimestamp on write
};

/**
 * Gets or creates a user profile on first sign-in.
 * Handles both email/password and Google OAuth flows.
 */
export async function getOrCreateUserProfile(
  token: DecodedFirebaseToken
): Promise<UserProfile> {
  const db = getFirestore();
  const userRef = db.collection(COLLECTIONS.USERS).doc(token.uid);
  const snap = await userRef.get();

  if (snap.exists) {
    const existing = snap.data() as UserProfile;
    const updates: Record<string, unknown> = {
      lastActiveAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (token.name && token.name !== existing.displayName) updates.displayName = token.name;
    if (token.picture && token.picture !== existing.photoURL) updates.photoURL = token.picture;
    // Fire-and-forget — lastActiveAt doesn't need to block the response
    userRef.update(updates).catch(() => {});
    return { ...existing, ...updates } as unknown as UserProfile;
  }

  const provider: AuthProvider =
    token.firebase.sign_in_provider === 'google.com' ? 'google' : 'email';

  const now = admin.firestore.FieldValue.serverTimestamp();

  const newProfile: Record<string, unknown> = {
    uid: token.uid,
    email: token.email ?? '',
    displayName: token.name ?? token.email?.split('@')[0] ?? 'Devotee',
    photoURL: token.picture ?? undefined,
    authProvider: provider,
    subscription: {
      ...DEFAULT_SUBSCRIPTION,
      updatedAt: now,
    },
    preferences: {
      preferredScripture: 'all',
      language: 'en',
      notificationsEnabled: true,
    },
    stats: {
      totalChats: 0,
      totalAiQueries: 0,
      dailyAiQueries: 0,
      dailyAiQueriesResetAt: now,
      scriptureSessions: {},
    },
    createdAt: now,
    updatedAt: now,
    lastActiveAt: now,
  };

  await userRef.set(newProfile);
  logger.info('New user profile created', { uid: token.uid, provider });
  return newProfile as unknown as UserProfile;
}

export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snap = await getFirestore().collection(COLLECTIONS.USERS).doc(uid).get();
  return snap.exists ? (snap.data() as UserProfile) : null;
}

export async function updateUserPreferences(
  uid: string,
  preferences: Partial<UserProfile['preferences']>
): Promise<void> {
  const updates: Record<string, unknown> = {
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  for (const [key, value] of Object.entries(preferences)) {
    updates[`preferences.${key}`] = value;
  }
  await getFirestore().collection(COLLECTIONS.USERS).doc(uid).update(updates);
}

export async function updateDisplayName(uid: string, displayName: string): Promise<void> {
  await getFirestore().collection(COLLECTIONS.USERS).doc(uid).update({
    displayName,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ─── Device Sessions ──────────────────────────────────

export async function upsertDeviceSession(
  uid: string,
  info: Omit<DeviceSession, 'createdAt' | 'lastActiveAt'>
): Promise<void> {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.DEVICE_SESSIONS(uid)).doc(info.deviceId);
  const snap = await ref.get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  if (snap.exists) {
    await ref.update({ lastActiveAt: now, label: info.label, osVersion: info.osVersion, appVersion: info.appVersion });
  } else {
    await ref.set({ ...info, createdAt: now, lastActiveAt: now });
  }
}

export async function getDeviceSessions(uid: string): Promise<DeviceSession[]> {
  const snap = await getFirestore()
    .collection(COLLECTIONS.DEVICE_SESSIONS(uid))
    .orderBy('lastActiveAt', 'desc')
    .get();
  return snap.docs.map((d) => d.data() as DeviceSession);
}

export async function removeDeviceSession(uid: string, deviceId: string): Promise<void> {
  await getFirestore().collection(COLLECTIONS.DEVICE_SESSIONS(uid)).doc(deviceId).delete();
}

/**
 * Deletes all user data (GDPR).
 * Handles users with many chat sessions/messages by chunking Firestore
 * batch operations to stay under the 500-write limit per batch.
 */
export async function deleteUserData(uid: string): Promise<void> {
  const db = getFirestore();

  // Collect all refs to delete
  const sessions = await db
    .collection(COLLECTIONS.CHAT_SESSIONS)
    .where('uid', '==', uid)
    .get();

  const allRefs: admin.firestore.DocumentReference[] = [];

  // Collect all message refs across all sessions
  for (const session of sessions.docs) {
    const messages = await db.collection(COLLECTIONS.CHAT_MESSAGES(session.id)).get();
    for (const msg of messages.docs) allRefs.push(msg.ref);
    allRefs.push(session.ref);
  }

  // Collect device session refs
  const devices = await db.collection(COLLECTIONS.DEVICE_SESSIONS(uid)).get();
  for (const d of devices.docs) allRefs.push(d.ref);

  // Add user doc itself
  allRefs.push(db.collection(COLLECTIONS.USERS).doc(uid));

  // Delete in chunks to stay under Firestore's 500-op batch limit
  for (let i = 0; i < allRefs.length; i += FIRESTORE_BATCH_SIZE) {
    const chunk = allRefs.slice(i, i + FIRESTORE_BATCH_SIZE);
    const batch = db.batch();
    for (const ref of chunk) batch.delete(ref);
    await batch.commit();
  }

  logger.info('User data deleted', { uid, refsDeleted: allRefs.length });
}
