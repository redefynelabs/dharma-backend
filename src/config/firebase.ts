import admin from 'firebase-admin';
import { env } from './env';

// Singleton pattern — safe to import anywhere
let app: admin.app.App;

export function getFirebaseApp(): admin.app.App {
  if (app) return app;

  app = admin.initializeApp({
    credential: admin.credential.cert({
      projectId: env.FIREBASE_PROJECT_ID,
      clientEmail: env.FIREBASE_CLIENT_EMAIL,
      // Handles escaped newlines in env vars (common in CI/CD)
      privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
    databaseURL: `https://${env.FIREBASE_PROJECT_ID}-default-rtdb.firebaseio.com`,
  });

  return app;
}

let db: admin.firestore.Firestore;

export function getFirestore(): admin.firestore.Firestore {
  if (db) return db;
  db = admin.firestore(getFirebaseApp());
  db.settings({ ignoreUndefinedProperties: true });
  return db;
}

export function getFirebaseAuth(): admin.auth.Auth {
  return admin.auth(getFirebaseApp());
}

// Firestore collection references — strongly typed path constants
export const COLLECTIONS = {
  USERS: 'users',
  CHAT_SESSIONS: 'chat_sessions',
  CHAT_MESSAGES: (sessionId: string) => `chat_sessions/${sessionId}/messages`,
  DEVICE_SESSIONS: (uid: string) => `users/${uid}/devices`,
  SUBSCRIPTION_EVENTS: 'subscription_events', // webhook audit log
  VERSE_COMMENTARIES: 'verse_commentaries',   // cached AI commentary per verse
} as const;