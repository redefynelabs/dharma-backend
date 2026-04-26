import { Response } from 'express';
import { ApiResponse } from '../types';
import { logger } from '../config/logger';

// ─── Firestore Timestamp Serializer ───────────────────

function serializeFirestore(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  // Firestore Timestamp — has seconds + nanoseconds
  if (
    typeof value === 'object' &&
    '_seconds' in (value as object) &&
    '_nanoseconds' in (value as object)
  ) {
    const ts = value as { _seconds: number; _nanoseconds: number };
    return new Date(ts._seconds * 1000).toISOString();
  }
  // Also handle Admin SDK Timestamp with toDate()
  if (typeof (value as any)?.toDate === 'function') {
    return (value as any).toDate().toISOString();
  }
  if (Array.isArray(value)) return value.map(serializeFirestore);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, serializeFirestore(v)])
    );
  }
  return value;
}

// ─── Response Helpers ─────────────────────────────────

export function sendSuccess<T>(res: Response, data: T, statusCode = 200): void {
  const response: ApiResponse<T> = {
    success: true,
    data: serializeFirestore(data) as T,
    meta: { timestamp: new Date().toISOString() },
  };
  res.status(statusCode).json(response);
}

export function sendError(
  res: Response,
  statusCode: number,
  code: string,
  message: string
): void {
  const response: ApiResponse = {
    success: false,
    error: { code, message },
    meta: { timestamp: new Date().toISOString() },
  };
  res.status(statusCode).json(response);
}

// ─── Custom Error Classes ─────────────────────────────

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class AuthError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, 'AUTH_REQUIRED', message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(403, 'FORBIDDEN', message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, 'NOT_FOUND', `${resource} not found`);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(400, 'VALIDATION_ERROR', message);
  }
}

export class SubscriptionError extends AppError {
  constructor(message = 'Pro subscription required') {
    super(402, 'SUBSCRIPTION_REQUIRED', message);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests') {
    super(429, 'RATE_LIMIT_EXCEEDED', message);
  }
}

// ─── Global Error Handler (Express middleware) ─────────

import { Request, NextFunction } from 'express';
import { ZodError } from 'zod';

export function globalErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  if (err instanceof AppError) {
    sendError(res, err.statusCode, err.code, err.message);
    return;
  }

  if (err instanceof ZodError) {
    const message = err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ');
    sendError(res, 400, 'VALIDATION_ERROR', message);
    return;
  }

  // Unexpected errors — log fully, expose minimally
  logger.error('Unhandled error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    path: req.path,
    method: req.method,
  });

  sendError(res, 500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}