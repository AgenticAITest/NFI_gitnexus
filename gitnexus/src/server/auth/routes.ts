import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getAuthDb, isSetupComplete } from './db.js';
import {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  authMiddleware,
  auditLog,
  cleanExpiredTokens,
  JWT_SECRET,
  REFRESH_TOKEN_EXPIRY_DAYS,
} from './middleware.js';
import { toSafeUser } from './types.js';
import type { DbUser, JwtPayload } from './types.js';

const router = Router();

// ── First-time setup (create admin account) ─────────────────────
router.post('/setup', async (req: Request, res: Response) => {
  try {
    if (isSetupComplete()) {
      res.status(400).json({ error: 'Setup already complete — admin account exists' });
      return;
    }

    const { email, password, displayName } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const hash = await bcrypt.hash(password, 12);
    const db = getAuthDb();
    const result = db.prepare(
      'INSERT INTO users (email, display_name, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run(email, displayName || email.split('@')[0], hash, 'admin');

    const userId = result.lastInsertRowid as number;
    auditLog(userId, email, 'setup', 'Initial admin account created', req.ip);

    // Auto-grant all existing repos
    const { listRegisteredRepos } = await import('../auth/repo-access-helpers.js');
    const repos = listRegisteredRepos();
    for (const repo of repos) {
      db.prepare('INSERT OR IGNORE INTO repo_access (user_id, repo_name, granted_by) VALUES (?, ?, ?)').run(userId, repo, userId);
    }

    const accessToken = generateAccessToken({ userId, email, role: 'admin' });
    const refreshToken = generateRefreshToken(userId);

    res.json({
      user: toSafeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as DbUser),
      accessToken,
      refreshToken,
    });
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'Email already registered' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── Check if setup is needed ────────────────────────────────────
router.get('/status', (_req: Request, res: Response) => {
  res.json({ setupComplete: isSetupComplete() });
});

// ── Login ───────────────────────────────────────────────────────
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }

    const db = getAuthDb();
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email) as DbUser | undefined;
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    if (user.status === 'suspended') {
      res.status(403).json({ error: 'Account is suspended. Contact an administrator.' });
      return;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      auditLog(user.id, email, 'login_failed', 'Invalid password', req.ip);
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // Clean old tokens
    cleanExpiredTokens();

    const accessToken = generateAccessToken({ userId: user.id, email: user.email, role: user.role });
    const refreshToken = generateRefreshToken(user.id);

    auditLog(user.id, email, 'login', null, req.ip);

    res.json({
      user: toSafeUser(user),
      accessToken,
      refreshToken,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Refresh token ───────────────────────────────────────────────
router.post('/refresh', (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      res.status(400).json({ error: 'Refresh token required' });
      return;
    }

    const db = getAuthDb();
    const tokenRow = db.prepare(
      "SELECT * FROM refresh_tokens WHERE token = ? AND expires_at > datetime('now')"
    ).get(refreshToken) as { id: number; user_id: number; token: string } | undefined;

    if (!tokenRow) {
      res.status(401).json({ error: 'Invalid or expired refresh token' });
      return;
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ? AND status = ?').get(tokenRow.user_id, 'active') as DbUser | undefined;
    if (!user) {
      res.status(401).json({ error: 'Account not found or suspended' });
      return;
    }

    // Rotate refresh token
    db.prepare('DELETE FROM refresh_tokens WHERE id = ?').run(tokenRow.id);
    const newAccessToken = generateAccessToken({ userId: user.id, email: user.email, role: user.role });
    const newRefreshToken = generateRefreshToken(user.id);

    res.json({
      user: toSafeUser(user),
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Logout (invalidate refresh token) ───────────────────────────
router.post('/logout', authMiddleware, (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      const db = getAuthDb();
      db.prepare('DELETE FROM refresh_tokens WHERE token = ?').run(refreshToken);
    }
    const user = (req as any).user as JwtPayload;
    auditLog(user.userId, user.email, 'logout', null, req.ip);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get current user profile ────────────────────────────────────
router.get('/me', authMiddleware, (req: Request, res: Response) => {
  try {
    const user = (req as any).user as JwtPayload;
    const db = getAuthDb();
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.userId) as DbUser | undefined;
    if (!row) {
      res.status(404).json({ error: 'User not found' });
      return;
    }
    res.json(toSafeUser(row));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Update profile (display name, password) ─────────────────────
router.put('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = (req as any).user as JwtPayload;
    const { displayName, currentPassword, newPassword } = req.body;

    const db = getAuthDb();

    if (displayName) {
      db.prepare("UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?").run(displayName, user.userId);
    }

    if (newPassword) {
      if (!currentPassword) {
        res.status(400).json({ error: 'Current password required to change password' });
        return;
      }
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.userId) as { password_hash: string };
      const valid = await bcrypt.compare(currentPassword, row.password_hash);
      if (!valid) {
        res.status(401).json({ error: 'Current password is incorrect' });
        return;
      }
      if (newPassword.length < 8) {
        res.status(400).json({ error: 'Password must be at least 8 characters' });
        return;
      }
      const hash = await bcrypt.hash(newPassword, 12);
      db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, user.userId);
      auditLog(user.userId, user.email, 'password_changed', null, req.ip);
    }

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.userId) as DbUser;
    res.json(toSafeUser(updated));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get / update user LLM settings ─────────────────────────────
router.get('/me/settings', authMiddleware, (req: Request, res: Response) => {
  try {
    const user = (req as any).user as JwtPayload;
    const db = getAuthDb();
    const row = db.prepare('SELECT settings_json FROM user_settings WHERE user_id = ?').get(user.userId) as { settings_json: string } | undefined;
    res.json(row ? JSON.parse(row.settings_json) : {});
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/me/settings', authMiddleware, (req: Request, res: Response) => {
  try {
    const user = (req as any).user as JwtPayload;
    const db = getAuthDb();
    const json = JSON.stringify(req.body);
    db.prepare(
      "INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET settings_json = ?, updated_at = datetime('now')"
    ).run(user.userId, json, json);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export { router as authRoutes };
