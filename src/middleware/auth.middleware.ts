import { Request, Response, NextFunction } from 'express';
import { getFirebaseAuth } from '../config/firebase';
import { AuthenticatedRequest, DecodedFirebaseToken } from '../types';
import { AuthError } from '../utils/response';
import { logger } from '../config/logger';

/**
 * Verifies Firebase ID token from Authorization header.
 * Attaches decoded token to req.user.
 * Works for both email/password and Google sign-in providers.
 *
 * Typed as standard RequestHandler so it composes cleanly with router.use()
 * and route-level middleware chains.
 */
export async function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new AuthError('Missing or malformed Authorization header');
    }

    const token = authHeader.slice(7);
    const decoded = await getFirebaseAuth().verifyIdToken(token, true);

    // Safe cast — we know req is actually an AuthenticatedRequest after this
    (req as AuthenticatedRequest).user = decoded as unknown as DecodedFirebaseToken;
    next();
  } catch (err) {
    if (err instanceof AuthError) {
      next(err);
      return;
    }

    const firebaseErr = err as { code?: string; message?: string };

    if (firebaseErr.code === 'auth/id-token-revoked') {
      next(new AuthError('Token has been revoked. Please sign in again.'));
    } else if (firebaseErr.code === 'auth/id-token-expired') {
      next(new AuthError('Token expired. Please refresh and try again.'));
    } else if (firebaseErr.code === 'auth/argument-error') {
      logger.warn('Token verification failed: malformed token argument', { code: firebaseErr.code, message: firebaseErr.message });
      next(new AuthError('Malformed authentication token. Please sign in again.'));
    } else {
      logger.warn('Token verification failed', { code: firebaseErr.code, message: firebaseErr.message });
      next(new AuthError('Invalid authentication token'));
    }
  }
}

/**
 * Optional auth — attaches user if valid token present, continues either way.
 */
export async function optionalAuth(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const decoded = await getFirebaseAuth().verifyIdToken(token);
      (req as AuthenticatedRequest).user = decoded as unknown as DecodedFirebaseToken;
    } catch {
      // Silently continue — optional auth never blocks
    }
  }

  next();
}