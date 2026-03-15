import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getAuthDb, isSetupComplete } from './db.js';
import type { JwtPayload, DbUser } from './types.js';

const JWT_SECRET = process.env.GITNEXUS_JWT_SECRET || 'gitnexus-dev-secret-change-in-production';
const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

export { JWT_SECRET, ACCESS_TOKEN_EXPIRY, REFRESH_TOKEN_EXPIRY_DAYS };

export function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ACCESS_TOKEN_EXPIRY });
}

export function generateRefreshToken(userId: number): string {
  const token = crypto.randomBytes(64).toString('hex');
  const db = getAuthDb();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES (?, ?, ?)').run(userId, token, expiresAt);
  return token;
}

export function verifyAccessToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, JWT_SECRET) as JwtPayload;
  } catch {
    return null;
  }
}

/** Express middleware — attaches req.user if valid token */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // If auth is not set up yet (no admin exists), skip auth
  if (!isSetupComplete()) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = header.slice(7);
  const payload = verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  // Check user still exists and is active
  const db = getAuthDb();
  const user = db.prepare('SELECT id, status FROM users WHERE id = ?').get(payload.userId) as Pick<DbUser, 'id' | 'status'> | undefined;
  if (!user || user.status !== 'active') {
    res.status(401).json({ error: 'Account suspended or deleted' });
    return;
  }

  (req as any).user = payload;
  next();
}

/** Require admin role */
export function adminOnly(req: Request, res: Response, next: NextFunction): void {
  const user = (req as any).user as JwtPayload | undefined;
  // If no auth setup, allow (single-user mode)
  if (!isSetupComplete()) {
    next();
    return;
  }
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/** Check if the requesting user has access to a specific repo */
export function checkRepoAccess(repoName: string, user?: JwtPayload): boolean {
  if (!isSetupComplete()) return true; // No auth = full access
  if (!user) return false;
  if (user.role === 'admin') return true; // Admins see everything

  const db = getAuthDb();
  const row = db.prepare('SELECT 1 FROM repo_access WHERE user_id = ? AND repo_name = ?').get(user.userId, repoName);
  return !!row;
}

/** Log an action to the audit log */
export function auditLog(userId: number | null, userEmail: string, action: string, details?: string, ip?: string): void {
  const db = getAuthDb();
  db.prepare('INSERT INTO audit_log (user_id, user_email, action, details, ip) VALUES (?, ?, ?, ?, ?)').run(
    userId,
    userEmail,
    action,
    details ?? null,
    ip ?? null
  );
}

/** Clean up expired refresh tokens */
export function cleanExpiredTokens(): void {
  const db = getAuthDb();
  db.prepare("DELETE FROM refresh_tokens WHERE expires_at < datetime('now')").run();
}
