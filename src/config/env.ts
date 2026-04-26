import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  API_VERSION: z.string().default('v1'),

  // Firebase
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().email(),
  FIREBASE_PRIVATE_KEY: z.string().min(1),
  FIRESTORE_DATABASE_ID: z.string().default('(default)'),

  // RevenueCat
  REVENUECAT_API_KEY: z.string().min(1),
  REVENUECAT_WEBHOOK_SECRET: z.string().min(1),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1),

  // ChromaDB
  CHROMA_HOST: z.string().default('localhost'),
  CHROMA_PORT: z.coerce.number().default(8000),
  CHROMA_COLLECTION_GITA: z.string().default('bhagavad_gita'),
  CHROMA_COLLECTION_RAMAYANA: z.string().default('ramayana'),
  CHROMA_COLLECTION_MAHABHARATA: z.string().default('mahabharata'),

  // Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900_000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().default(100),
  AI_RATE_LIMIT_MAX: z.coerce.number().default(20),

  // Subscription
  FREE_DAILY_AI_QUERIES: z.coerce.number().default(3),
  FREE_DAILY_COMMENTARY: z.coerce.number().default(5),
  PRO_MONTHLY_PRODUCT_ID: z.string().default('dharma_pro_monthly'),
  PRO_YEARLY_PRODUCT_ID: z.string().default('dharma_pro_yearly'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;