import admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { getFirestore, COLLECTIONS } from '../../config/firebase';
import { ChatSession, ChatMessage, ScriptureSource, Scripture, MessageRole } from '../../types';
import { NotFoundError, ForbiddenError } from '../../utils/response';

const MAX_HISTORY_FOR_CONTEXT = 6; // last N messages sent to LLM

// Firestore batches are limited to 500 write operations.
// Use 450 as a safe ceiling to leave headroom.
const FIRESTORE_BATCH_SIZE = 450;

/**
 * Commits an array of document references as deletes, chunked into
 * sequential batches of FIRESTORE_BATCH_SIZE to stay under Firestore's
 * 500-operation limit.
 */
async function batchDeleteRefs(
  db: admin.firestore.Firestore,
  refs: admin.firestore.DocumentReference[]
): Promise<void> {
  for (let i = 0; i < refs.length; i += FIRESTORE_BATCH_SIZE) {
    const chunk = refs.slice(i, i + FIRESTORE_BATCH_SIZE);
    const batch = db.batch();
    for (const ref of chunk) batch.delete(ref);
    await batch.commit();
  }
}

// ─── Sessions ─────────────────────────────────────────

export async function createChatSession(
  uid: string,
  scripture?: Scripture,
  initialTitle = 'New Conversation',
  clientId?: string
): Promise<ChatSession> {
  const db = getFirestore();
  const sessionId = clientId ?? uuidv4();
  const now = admin.firestore.FieldValue.serverTimestamp();

  const session: Omit<ChatSession, 'createdAt' | 'updatedAt'> & Record<string, unknown> = {
    id: sessionId,
    uid,
    title: initialTitle,
    scripture: scripture ?? undefined,
    messageCount: 0,
    lastMessage: '',
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTIONS.CHAT_SESSIONS).doc(sessionId).set(session);

  // Increment user's total chat count
  await db.collection(COLLECTIONS.USERS).doc(uid).update({
    'stats.totalChats': admin.firestore.FieldValue.increment(1),
  });

  return session as unknown as ChatSession;
}

export async function getChatSessions(
  uid: string,
  limit = 20,
  afterId?: string
): Promise<{ sessions: ChatSession[]; hasMore: boolean }> {
  const db = getFirestore();
  // NOTE: orderBy('updatedAt') + where('uid') requires a composite index.
  // Fetch all user sessions and sort client-side to avoid index dependency.
  const snap = await db
    .collection(COLLECTIONS.CHAT_SESSIONS)
    .where('uid', '==', uid)
    .get();

  // Sort by updatedAt descending client-side
  const allSessions = snap.docs
    .map((doc) => doc.data() as ChatSession)
    .sort((a, b) => {
      const aTime = (a.updatedAt as any)?._seconds ?? (a.updatedAt as any)?.seconds ?? 0;
      const bTime = (b.updatedAt as any)?._seconds ?? (b.updatedAt as any)?.seconds ?? 0;
      return bTime - aTime;
    });

  // Handle cursor-based pagination
  let startIndex = 0;
  if (afterId) {
    const idx = allSessions.findIndex((s) => s.id === afterId);
    if (idx !== -1) startIndex = idx + 1;
  }

  const page = allSessions.slice(startIndex, startIndex + limit + 1);
  const sessions = page.slice(0, limit);

  return {
    sessions,
    hasMore: page.length > limit,
  };
}

export async function getChatSession(
  sessionId: string,
  uid: string
): Promise<ChatSession> {
  const snap = await getFirestore()
    .collection(COLLECTIONS.CHAT_SESSIONS)
    .doc(sessionId)
    .get();

  if (!snap.exists) throw new NotFoundError('Chat session');

  const session = snap.data() as ChatSession;
  if (session.uid !== uid) throw new ForbiddenError();

  return session;
}

export async function deleteChatSession(sessionId: string, uid: string): Promise<void> {
  const db = getFirestore();

  // Parallel: verify ownership + fetch messages simultaneously
  const [session, messagesSnap] = await Promise.all([
    getChatSession(sessionId, uid),
    db.collection(COLLECTIONS.CHAT_MESSAGES(sessionId)).get(),
  ]);
  void session; // ownership validated above

  const messageRefs = messagesSnap.docs.map((d) => d.ref);

  // Batch-delete messages + session doc + counter update in parallel
  await Promise.all([
    batchDeleteRefs(db, messageRefs),
    db.collection(COLLECTIONS.CHAT_SESSIONS).doc(sessionId).delete(),
    db.collection(COLLECTIONS.USERS).doc(uid).update({
      'stats.totalChats': admin.firestore.FieldValue.increment(-1),
    }),
  ]);
}

export async function deleteAllChatSessions(uid: string): Promise<number> {
  const db = getFirestore();

  // Fetch all sessions for user
  const sessionsSnap = await db
    .collection(COLLECTIONS.CHAT_SESSIONS)
    .where('uid', '==', uid)
    .get();

  if (sessionsSnap.empty) return 0;

  const sessionIds = sessionsSnap.docs.map((d) => d.id);

  // Fetch all message sub-collections in parallel
  const messageFetches = await Promise.all(
    sessionIds.map((id) => db.collection(COLLECTIONS.CHAT_MESSAGES(id)).get())
  );

  // Collect every ref that needs deleting (messages + sessions)
  const allRefs: admin.firestore.DocumentReference[] = [];
  for (const snap of messageFetches) {
    for (const doc of snap.docs) allRefs.push(doc.ref);
  }
  for (const doc of sessionsSnap.docs) allRefs.push(doc.ref);

  // Batch delete everything + reset counter in parallel
  await Promise.all([
    batchDeleteRefs(db, allRefs),
    db.collection(COLLECTIONS.USERS).doc(uid).update({
      'stats.totalChats': 0,
    }),
  ]);

  return sessionIds.length;
}

// ─── Messages ─────────────────────────────────────────

export async function saveMessage(
  sessionId: string,
  uid: string,
  role: MessageRole,
  content: string,
  sources?: ScriptureSource[],
  metadata?: ChatMessage['metadata']
): Promise<ChatMessage> {
  const db = getFirestore();
  const messageId = uuidv4();
  const now = admin.firestore.FieldValue.serverTimestamp();

  const message: Omit<ChatMessage, 'createdAt'> & Record<string, unknown> = {
    id: messageId,
    sessionId,
    uid,
    role,
    content,
    sources: sources ?? [],
    metadata: metadata ?? undefined,
    createdAt: now,
  };

  const batch = db.batch();

  // Save message to sub-collection
  batch.set(
    db.collection(COLLECTIONS.CHAT_MESSAGES(sessionId)).doc(messageId),
    message
  );

  // Update session metadata
  batch.update(db.collection(COLLECTIONS.CHAT_SESSIONS).doc(sessionId), {
    messageCount: admin.firestore.FieldValue.increment(1),
    lastMessage: content.substring(0, 100),
    updatedAt: now,
  });

  await batch.commit();

  // Return a proper ISO timestamp instead of the Firestore sentinel so SSE
  // serialisation produces a valid date string on the client.
  return { ...message, createdAt: new Date().toISOString() } as unknown as ChatMessage;
}

export async function getChatMessages(
  sessionId: string,
  uid: string,
  limit = 50,
  beforeId?: string
): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
  // Verify session ownership first
  await getChatSession(sessionId, uid);

  const db = getFirestore();
  let query = db
    .collection(COLLECTIONS.CHAT_MESSAGES(sessionId))
    .orderBy('createdAt', 'desc')
    .limit(limit + 1);

  if (beforeId) {
    const cursorSnap = await db
      .collection(COLLECTIONS.CHAT_MESSAGES(sessionId))
      .doc(beforeId)
      .get();
    if (cursorSnap.exists) {
      query = query.startAfter(cursorSnap);
    }
  }

  const snap = await query.get();
  const messages = snap.docs
    .slice(0, limit)
    .map((doc) => doc.data() as ChatMessage)
    .reverse(); // return chronological order

  return {
    messages,
    hasMore: snap.docs.length > limit,
  };
}

/**
 * Fetches recent messages for LLM context.
 * Returns chronological order, limited to avoid token overflow.
 */
export async function getSessionContextHistory(
  sessionId: string
): Promise<{ role: MessageRole; content: string }[]> {
  const db = getFirestore();
  const snap = await db
    .collection(COLLECTIONS.CHAT_MESSAGES(sessionId))
    .orderBy('createdAt', 'desc')
    .limit(MAX_HISTORY_FOR_CONTEXT)
    .get();

  return snap.docs
    .map((doc) => {
      const msg = doc.data() as ChatMessage;
      return { role: msg.role, content: msg.content };
    })
    .reverse();
}

/**
 * Auto-generates a session title from the first user message.
 */
export async function updateSessionTitle(
  sessionId: string,
  title: string
): Promise<void> {
  await getFirestore().collection(COLLECTIONS.CHAT_SESSIONS).doc(sessionId).update({
    title: title.substring(0, 80),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}
