import { RequestHandler, Response, NextFunction, Request } from 'express';
import { AuthenticatedRequest } from '../types';

/**
 * Wraps a handler that expects AuthenticatedRequest.
 * Since requireAuth always runs first and sets req.user,
 * we safely cast through unknown.
 */
export function authHandler(
  fn: (req: AuthenticatedRequest, res: Response, next: NextFunction) => Promise<void> | void
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    return fn(req as AuthenticatedRequest, res, next);
  };
}