# Dharma Backend

Production-grade Node.js backend for the Dharma scripture app.

## Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 20 + TypeScript |
| Framework | Express |
| Auth | Firebase Admin SDK |
| Database | Firestore |
| Vectors | ChromaDB |
| AI | Anthropic Claude |
| Subscriptions | RevenueCat |
| Containerization | Docker |

---

## Architecture

```
Mobile App (React Native)
    │
    ▼
Express API  ──► Firebase Auth (token verify)
    │
    ├──► Firestore       (user profiles, chat, audit)
    │
    ├──► ChromaDB        (scripture vector search)
    │
    ├──► Claude API      (LLM with RAG context)
    │
    └──► RevenueCat API  (subscription sync)

RevenueCat Webhooks ──► POST /subscriptions/webhook
```

---

## Quick Start

### 1. Clone and install

```bash
git clone <repo>
cd dharma-backend
npm install
cp .env.example .env
# Fill in .env with your keys
```

### 2. Start ChromaDB

```bash
docker-compose up chromadb -d
```

### 3. Ingest scriptures

Place your scripture JSON files in `./data/`:
- `data/bhagavad-gita.json`
- `data/valmiki-ramayana.json`
- `data/mahabharata.json`

Then run:
```bash
npx tsx src/scripts/ingest-scriptures.ts
# Or for a single scripture:
npx tsx src/scripts/ingest-scriptures.ts --scripture=gita
```

### 4. Start the server

```bash
npm run dev
```

---

## Environment Variables

See `.env.example` for all required variables.

**Critical ones:**

| Variable | Description |
|----------|-------------|
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Service account email |
| `FIREBASE_PRIVATE_KEY` | Service account private key (with `\n` escaped) |
| `REVENUECAT_API_KEY` | RevenueCat secret key |
| `REVENUECAT_WEBHOOK_SECRET` | Shared secret set in RevenueCat dashboard |
| `ANTHROPIC_API_KEY` | Anthropic API key |

---

## API Reference

All routes are prefixed with `/api/v1`.

### Auth & Users

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/auth/sync` | ✅ | Sync Firebase user → create/update profile |
| GET | `/users/me` | ✅ | Get current user profile |
| PATCH | `/users/me` | ✅ | Update display name or preferences |
| DELETE | `/users/me` | ✅ | Delete account (GDPR) |

### Chat

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| POST | `/chat/sessions` | ✅ | Create chat session |
| GET | `/chat/sessions` | ✅ | List sessions (paginated) |
| GET | `/chat/sessions/:id` | ✅ | Get session |
| DELETE | `/chat/sessions/:id` | ✅ | Delete session + messages |
| GET | `/chat/sessions/:id/messages` | ✅ | Get messages (paginated) |
| POST | `/chat/sessions/:id/ask` | ✅ 🔒 | Ask AI (quota enforced) |
| POST | `/chat/ask` | ✅ 🔒 | Stateless one-shot query |

### Subscriptions

| Method | Route | Auth | Description |
|--------|-------|------|-------------|
| GET | `/subscriptions/status` | ✅ | Current subscription status |
| POST | `/subscriptions/sync` | ✅ | Force sync from RevenueCat |
| POST | `/subscriptions/webhook` | Secret | RevenueCat webhook |
| GET | `/subscriptions/plans` | ❌ | Available plans (static) |

---

## Subscription Flow

### Purchase (Mobile)

```
1. User taps "Subscribe" in app
2. RevenueCat SDK handles purchase (App Store / Play Store)
3. App calls POST /api/v1/subscriptions/sync
4. Backend fetches subscriber from RevenueCat API
5. Writes subscription status to Firestore user doc
6. Response includes tier + state
```

### Webhook (RevenueCat → Backend)

```
RevenueCat Dashboard → Webhooks → POST /api/v1/subscriptions/webhook
Authorization header = REVENUECAT_WEBHOOK_SECRET

Events handled:
  INITIAL_PURCHASE  → sync → pro active
  RENEWAL           → sync → pro active
  CANCELLATION      → sync → pro active (until period end)
  EXPIRATION        → downgrade → free
  BILLING_ISSUE     → state = billing_retry
  UNCANCELLATION    → sync → pro active
  TRANSFER          → transfer entitlement between users
```

### Client-side RevenueCat Setup

The mobile app **must** set RevenueCat's app user ID to the Firebase UID:

```typescript
// React Native — after Firebase sign-in
import Purchases from 'react-native-purchases';

const user = await signInWithFirebase(...);
await Purchases.logIn(user.uid); // ← Critical: RC app_user_id = Firebase UID
```

---

## RAG Pipeline

```
User question
    │
    ▼
ChromaDB query (cosine similarity)
  → top 6 relevant scripture chunks
    │
    ▼
Build prompt:
  - System: Dharma persona + grounding rules
  - Context: Scripture passages with references
  - History: Last 10 messages
  - Question
    │
    ▼
Claude (claude-opus-4-5)
    │
    ▼
Response + sources (filtered by relevance score > 0.6)
```

---

## Subscription Tiers

| Feature | Free (Seeker) | Pro (Devotee) |
|---------|--------------|---------------|
| Scripture reading | ✅ Unlimited | ✅ Unlimited |
| AI queries | 5/day | ✅ Unlimited |
| Chat history | ✅ | ✅ |
| Offline access | ❌ | ✅ |

---

## Firestore Schema

### `users/{uid}`
```
{
  uid, email, displayName, photoURL, authProvider,
  subscription: { tier, state, period, productId, currentPeriodEnd, ... },
  preferences: { preferredScripture, language, notificationsEnabled },
  stats: { totalChats, totalAiQueries, dailyAiQueries, dailyAiQueriesResetAt },
  createdAt, updatedAt, lastActiveAt
}
```

### `chat_sessions/{sessionId}`
```
{ id, uid, title, scripture, messageCount, lastMessage, createdAt, updatedAt }
```

### `chat_sessions/{sessionId}/messages/{messageId}`
```
{ id, sessionId, uid, role, content, sources[], metadata, createdAt }
```

### `subscription_events/{eventId}`
```
{ uid, eventType, eventId, environment, payload, receivedAt }
```

---

## Deploying to Production

### Firebase setup
```bash
firebase deploy --only firestore:rules,firestore:indexes
```

### Environment
- Set `NODE_ENV=production`
- Set `trust proxy` (already configured for nginx/ALB)
- Use a secrets manager (AWS SSM, GCP Secret Manager) instead of `.env`

### RevenueCat Webhook
1. Go to RevenueCat Dashboard → Project → Webhooks
2. Add endpoint: `https://your-api.com/api/v1/subscriptions/webhook`
3. Set Authorization header = your `REVENUECAT_WEBHOOK_SECRET`

---

## Scripture JSON Format

### Bhagavad Gita (`data/bhagavad-gita.json`)
```json
[
  {
    "chapter": 2,
    "verse": 47,
    "sanskrit": "कर्मण्येवाधिकारस्ते...",
    "transliteration": "karmaṇy evādhikāras te...",
    "translation": "You have a right to perform your prescribed duties...",
    "commentary": "This verse encapsulates the philosophy of Nishkama Karma..."
  }
]
```

### Valmiki Ramayana (`data/valmiki-ramayana.json`)
```json
[
  {
    "kanda": "Yuddha",
    "sarga": 18,
    "verse": 3,
    "sanskrit": "...",
    "translation": "..."
  }
]
```

### Mahabharata (`data/mahabharata.json`)
```json
[
  {
    "parva": "Shanti",
    "section": 12,
    "verse": 1,
    "translation": "..."
  }
]
```