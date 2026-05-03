import axios from 'axios';
import admin from 'firebase-admin';
import { getFirestore, COLLECTIONS } from '../../config/firebase';
import { logger } from '../../config/logger';

// ─── Types ────────────────────────────────────────────

export type NotificationSlot = 'morning' | 'afternoon' | 'evening' | 'night';

interface DailyVerse {
  scripture: 'gita' | 'ramayana' | 'mahabharata';
  reference: string;
  text: string;
}

// ─── Curated Verses ───────────────────────────────────
// 7 verses per slot (one per day of the week, cycling by dayOfWeek)

const DAILY_VERSES: Record<NotificationSlot, DailyVerse[]> = {
  morning: [
    { scripture: 'gita',        reference: 'BG 2.47',             text: 'You have a right to perform your duty, but never to the fruits of your actions.' },
    { scripture: 'gita',        reference: 'BG 6.5',              text: 'Elevate yourself through your own efforts; do not degrade yourself.' },
    { scripture: 'gita',        reference: 'BG 3.8',              text: 'Perform your prescribed duties, for action is better than inaction.' },
    { scripture: 'ramayana',    reference: 'Bala Kanda, Sarga 1', text: 'Righteousness, prosperity, and liberation are the fruits of righteous living.' },
    { scripture: 'gita',        reference: 'BG 18.46',            text: 'By performing one\'s natural work, a person worships the Creator and attains perfection.' },
    { scripture: 'gita',        reference: 'BG 4.7',              text: 'Whenever righteousness declines and unrighteousness rises, I manifest Myself.' },
    { scripture: 'mahabharata', reference: 'Udyoga Parva',        text: 'One who rises with purpose and acts with devotion achieves success in all endeavors.' },
  ],
  afternoon: [
    { scripture: 'gita',        reference: 'BG 2.20',    text: 'The soul is never born nor dies. It has not come into being and will not cease to be.' },
    { scripture: 'gita',        reference: 'BG 4.34',    text: 'Learn the truth by approaching a spiritual master, inquiring with humility and serving him.' },
    { scripture: 'gita',        reference: 'BG 13.28',   text: 'One who sees the Lord equally present everywhere does not harm himself by his mind.' },
    { scripture: 'gita',        reference: 'BG 7.19',    text: 'After many births, the wise person surrenders unto Me, knowing that Vasudeva is everything.' },
    { scripture: 'ramayana',    reference: 'Aranya Kanda', text: 'True wisdom is knowing one\'s duty and fulfilling it without wavering.' },
    { scripture: 'gita',        reference: 'BG 9.22',    text: 'To those who worship Me with devotion, I carry what they lack and preserve what they have.' },
    { scripture: 'mahabharata', reference: 'Shanti Parva', text: 'Truth alone triumphs; by truth alone is the divine path illuminated.' },
  ],
  evening: [
    { scripture: 'gita',        reference: 'BG 2.14',    text: 'Feelings of heat and cold, pleasure and pain come and go — they are impermanent.' },
    { scripture: 'gita',        reference: 'BG 5.22',    text: 'Pleasures born of senses are sources of suffering; they have a beginning and an end.' },
    { scripture: 'gita',        reference: 'BG 6.35',    text: 'The restless mind is subdued through practice and detachment — do not be discouraged.' },
    { scripture: 'ramayana',    reference: 'Sundara Kanda', text: 'With devotion, patience, and courage, no obstacle remains insurmountable.' },
    { scripture: 'gita',        reference: 'BG 12.13',   text: 'One who bears no ill will toward any being, who is kind and compassionate, is dear to Me.' },
    { scripture: 'gita',        reference: 'BG 2.50',    text: 'One who acts in devotion is freed from both good and evil actions even in this life.' },
    { scripture: 'mahabharata', reference: 'Vana Parva', text: 'Patience is the highest virtue — it alone sustains the wise through all difficulties.' },
  ],
  night: [
    { scripture: 'gita',        reference: 'BG 18.66',   text: 'Surrender unto Me alone. I shall deliver you from all sinful reactions; do not fear.' },
    { scripture: 'gita',        reference: 'BG 2.70',    text: 'As the ocean remains undisturbed as rivers flow into it, so the wise remain undisturbed.' },
    { scripture: 'gita',        reference: 'BG 6.17',    text: 'One who is regulated in eating, sleeping, and work can mitigate all material miseries.' },
    { scripture: 'ramayana',    reference: 'Yuddha Kanda', text: 'After every battle comes peace; after every night comes the light of a new dawn.' },
    { scripture: 'gita',        reference: 'BG 8.5',     text: 'Whoever remembers Me alone at the time of death attains My nature — of this there is no doubt.' },
    { scripture: 'gita',        reference: 'BG 4.9',     text: 'One who knows the nature of My birth and activities is not reborn after leaving this body.' },
    { scripture: 'mahabharata', reference: 'Anushasana Parva', text: 'May your rest be as pure as your intentions, and your dreams as high as your devotion.' },
  ],
};

const SLOT_TITLES: Record<NotificationSlot, string> = {
  morning:   'Morning Verse',
  afternoon: 'Afternoon Wisdom',
  evening:   'Evening Reflection',
  night:     'Night Peace',
};

// ─── Helpers ──────────────────────────────────────────

function getVerseOfTheDay(slot: NotificationSlot): DailyVerse {
  const dayOfWeek = new Date().getDay(); // 0 (Sun) – 6 (Sat)
  const verses = DAILY_VERSES[slot];
  return verses[dayOfWeek % verses.length];
}

async function getAllPushTokens(): Promise<{ uid: string; tokens: string[] }[]> {
  const db = getFirestore();
  const snap = await db
    .collection(COLLECTIONS.USERS)
    .where('preferences.notificationsEnabled', '==', true)
    .get();

  const result: { uid: string; tokens: string[] }[] = [];
  for (const doc of snap.docs) {
    const tokens: string[] = doc.data().expoPushTokens ?? [];
    if (tokens.length > 0) result.push({ uid: doc.id, tokens });
  }
  return result;
}

async function removeStaleToken(uid: string, token: string): Promise<void> {
  await getFirestore()
    .collection(COLLECTIONS.USERS)
    .doc(uid)
    .update({ expoPushTokens: admin.firestore.FieldValue.arrayRemove(token) });
}

// ─── Expo Push API ────────────────────────────────────

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100; // Expo limit per request

interface ExpoPushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  sound?: 'default';
  badge?: number;
  channelId?: string;
}

interface ExpoPushTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

async function sendExpoBatch(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]> {
  const response = await axios.post<{ data: ExpoPushTicket[] }>(
    EXPO_PUSH_URL,
    messages,
    {
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    }
  );
  return response.data.data;
}

// ─── Welcome Notification ─────────────────────────────

/**
 * Sends a one-time welcome notification to a user's device.
 * Uses a Firestore flag (`welcomeNotificationSent`) to ensure it fires
 * only once, even if the user registers tokens from multiple devices.
 */
export async function sendWelcomeNotificationIfNeeded(
  uid: string,
  token: string
): Promise<void> {
  const db = getFirestore();
  const ref = db.collection(COLLECTIONS.USERS).doc(uid);
  const snap = await ref.get();

  if (!snap.exists || snap.data()?.welcomeNotificationSent) return;

  // Mark as sent before sending to prevent duplicates on concurrent registrations
  await ref.update({ welcomeNotificationSent: true });

  try {
    await sendExpoBatch([
      {
        to: token,
        title: 'Welcome to Dharma',
        body: 'Your spiritual journey begins. Daily wisdom from the Gita, Ramayana, and Mahabharata awaits you.',
        sound: 'default',
        channelId: 'daily_verse',
        data: { type: 'welcome' },
      },
    ]);
    logger.info('Welcome notification sent', { uid });
  } catch (err) {
    // Revert flag so next token registration can retry
    ref.update({ welcomeNotificationSent: false }).catch(() => {});
    logger.error('Welcome notification failed', {
      uid,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ─── Main send function ───────────────────────────────

export async function sendDailyVerseNotification(slot: NotificationSlot): Promise<void> {
  const verse = getVerseOfTheDay(slot);
  const title = SLOT_TITLES[slot];
  const body = verse.text.length > 120
    ? verse.text.substring(0, 117) + '...'
    : verse.text;

  logger.info(`Sending ${slot} verse notification`, { reference: verse.reference });

  const userTokens = await getAllPushTokens();
  if (userTokens.length === 0) {
    logger.info(`No push tokens registered — skipping ${slot} notification`);
    return;
  }

  // Build a token→uid map for stale-token cleanup
  const tokenToUid = new Map<string, string>();
  for (const { uid, tokens } of userTokens) {
    for (const t of tokens) tokenToUid.set(t, uid);
  }

  const allTokens = Array.from(tokenToUid.keys());
  const messages: ExpoPushMessage[] = allTokens.map((token) => ({
    to: token,
    title,
    body,
    sound: 'default',
    channelId: 'daily_verse',
    data: {
      type: 'daily_verse',
      slot,
      scripture: verse.scripture,
      reference: verse.reference,
    },
  }));

  let successCount = 0;
  let failureCount = 0;

  for (let i = 0; i < messages.length; i += EXPO_BATCH_SIZE) {
    const batch = messages.slice(i, i + EXPO_BATCH_SIZE);
    const batchTokens = allTokens.slice(i, i + EXPO_BATCH_SIZE);

    try {
      const tickets = await sendExpoBatch(batch);

      for (let j = 0; j < tickets.length; j++) {
        const ticket = tickets[j];
        if (ticket.status === 'ok') {
          successCount++;
        } else {
          failureCount++;
          // DeviceNotRegistered means the token is stale — clean it up
          if (ticket.details?.error === 'DeviceNotRegistered') {
            const uid = tokenToUid.get(batchTokens[j]);
            if (uid) removeStaleToken(uid, batchTokens[j]).catch(() => {});
          }
        }
      }
    } catch (err) {
      logger.error(`Failed to send Expo push batch for ${slot}`, {
        error: err instanceof Error ? err.message : String(err),
      });
      failureCount += batch.length;
    }
  }

  logger.info(`${slot} verse notification complete`, {
    totalTokens: allTokens.length,
    successCount,
    failureCount,
    reference: verse.reference,
  });
}
