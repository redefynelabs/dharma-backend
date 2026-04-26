import rateLimit from 'express-rate-limit';
import { env } from '../config/env';
import { sendError } from '../utils/response';

/**
 * General API rate limiter — applied globally
 */
export const globalRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    sendError(res, 429, 'RATE_LIMIT_EXCEEDED', 'Too many requests. Please slow down.');
  },
  // Key by IP — in production behind proxy, trust x-forwarded-for
  keyGenerator: (req) => {
    return (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ?? req.ip ?? 'unknown';
  },
});

/**
 * Strict limiter for AI endpoints — prevents token abuse
 */
export const aiRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS, // 15 minutes
  max: env.AI_RATE_LIMIT_MAX,          // 20 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    sendError(
      res,
      429,
      'AI_RATE_LIMIT_EXCEEDED',
      `Maximum ${env.AI_RATE_LIMIT_MAX} AI requests per 15 minutes.`
    );
  },
  keyGenerator: (req) => {
    // Key by user ID if authenticated, else by IP
    const authReq = req as { user?: { uid: string } };
    return authReq.user?.uid ??
      (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ??
      req.ip ??
      'unknown';
  },
});

/**
 * Auth endpoint limiter — prevents brute force
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  handler: (_req, res) => {
    sendError(res, 429, 'AUTH_RATE_LIMIT', 'Too many authentication attempts.');
  },
});