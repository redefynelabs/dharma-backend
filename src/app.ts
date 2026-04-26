import 'express-async-errors';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import morgan from 'morgan';

import { env } from './config/env';
import { logger } from './config/logger';
import { globalRateLimiter } from './middleware/ratelimiter';
import { globalErrorHandler } from './utils/response';

import userRoutes from './modules/users/user.routes';
import chatRoutes from './modules/chat/chat.routes';
import subscriptionRoutes from './modules/subscriptions/subscription.routes';

const app = express();

// ─── Security Headers ─────────────────────────────────
app.set('trust proxy', 1); // Required behind reverse proxy (nginx, AWS ALB)
app.use(helmet());
// React Native / Expo apps don't use CORS — requests come from a native
// HTTP client, not a browser origin.  The CORS headers matter only for
// web builds.  In production we still restrict to known origins; the
// wildcard is safe for native apps because they ignore the header.
app.use(
  cors({
    origin:
      env.NODE_ENV === 'production'
        ? ['https://dharma.app', 'https://www.dharma.app']
        : '*',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  })
);

// ─── Body Parsing ─────────────────────────────────────
// Webhook route needs raw body for signature verification
app.use('/api/v1/subscriptions/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(compression());

// ─── Request Logging ──────────────────────────────────
app.use(
  morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev', {
    stream: { write: (msg) => logger.http(msg.trim()) },
    skip: (_req, res) => res.statusCode < 400 && env.NODE_ENV === 'production',
  })
);

// ─── Global Rate Limiter ──────────────────────────────
app.use(globalRateLimiter);

// ─── Health Check ─────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: env.API_VERSION,
    timestamp: new Date().toISOString(),
  });
});

// ─── API Routes ───────────────────────────────────────
const apiRouter = express.Router();

apiRouter.use('/', userRoutes);              // POST /auth/sync, GET/PATCH/DELETE /users/me
apiRouter.use('/chat', chatRoutes);          // /chat/sessions/*, /chat/ask
apiRouter.use('/subscriptions', subscriptionRoutes); // /subscriptions/webhook, /status, /sync, /plans

app.use(`/api/${env.API_VERSION}`, apiRouter);

// ─── 404 Handler ──────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  });
});

// ─── Global Error Handler ─────────────────────────────
app.use(globalErrorHandler);

export default app;