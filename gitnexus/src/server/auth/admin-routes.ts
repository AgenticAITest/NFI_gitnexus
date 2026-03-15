import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getAuthDb } from './db.js';
import { authMiddleware, adminOnly, auditLog } from './middleware.js';
import { toSafeUser } from './types.js';
import type { DbUser, JwtPayload, AuditEntry, RepoAccess } from './types.js';

const router = Router();

// All admin routes require auth + admin role
router.use(authMiddleware, adminOnly);

// ── List all users ──────────────────────────────────────────────
router.get('/users', (_req: Request, res: Response) => {
  try {
    const db = getAuthDb();
    const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all() as DbUser[];
    res.json(users.map(toSafeUser));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Create user ─────────────────────────────────────────────────
router.post('/users', async (req: Request, res: Response) => {
  try {
    const admin = (req as any).user as JwtPayload;
    const { email, password, displayName, role } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }
    const userRole = role === 'admin' ? 'admin' : 'user';

    const hash = await bcrypt.hash(password, 12);
    const db = getAuthDb();
    const result = db.prepare(
      'INSERT INTO users (email, display_name, password_hash, role) VALUES (?, ?, ?, ?)'
    ).run(email, displayName || email.split('@')[0], hash, userRole);

    const userId = result.lastInsertRowid as number;
    auditLog(admin.userId, admin.email, 'user_created', `Created user ${email} (${userRole})`, req.ip);

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as DbUser;
    res.status(201).json(toSafeUser(row));
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint')) {
      res.status(409).json({ error: 'Email already registered' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── Update user (role, status, display name) ────────────────────
router.put('/users/:id', (req: Request, res: Response) => {
  try {
    const admin = (req as any).user as JwtPayload;
    const targetId = parseInt(req.params.id, 10);
    const { displayName, role, status } = req.body;

    const db = getAuthDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as DbUser | undefined;
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    // Prevent demoting yourself
    if (targetId === admin.userId && role && role !== 'admin') {
      res.status(400).json({ error: 'Cannot remove your own admin role' });
      return;
    }
    // Prevent suspending yourself
    if (targetId === admin.userId && status === 'suspended') {
      res.status(400).json({ error: 'Cannot suspend your own account' });
      return;
    }

    const updates: string[] = [];
    const params: any[] = [];

    if (displayName) {
      updates.push('display_name = ?');
      params.push(displayName);
    }
    if (role && (role === 'admin' || role === 'user')) {
      updates.push('role = ?');
      params.push(role);
    }
    if (status && (status === 'active' || status === 'suspended')) {
      updates.push('status = ?');
      params.push(status);

      // If suspending, revoke all refresh tokens
      if (status === 'suspended') {
        db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(targetId);
      }
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No valid fields to update' });
      return;
    }

    updates.push("updated_at = datetime('now')");
    params.push(targetId);

    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const changes = [];
    if (role) changes.push(`role→${role}`);
    if (status) changes.push(`status→${status}`);
    if (displayName) changes.push(`name→${displayName}`);
    auditLog(admin.userId, admin.email, 'user_updated', `Updated ${target.email}: ${changes.join(', ')}`, req.ip);

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as DbUser;
    res.json(toSafeUser(updated));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Reset user password ─────────────────────────────────────────
router.post('/users/:id/reset-password', async (req: Request, res: Response) => {
  try {
    const admin = (req as any).user as JwtPayload;
    const targetId = parseInt(req.params.id, 10);
    const { newPassword } = req.body;

    if (!newPassword || newPassword.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const db = getAuthDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as DbUser | undefined;
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const hash = await bcrypt.hash(newPassword, 12);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(hash, targetId);

    // Invalidate all refresh tokens for this user
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(targetId);

    auditLog(admin.userId, admin.email, 'password_reset', `Reset password for ${target.email}`, req.ip);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Delete user ─────────────────────────────────────────────────
router.delete('/users/:id', (req: Request, res: Response) => {
  try {
    const admin = (req as any).user as JwtPayload;
    const targetId = parseInt(req.params.id, 10);

    if (targetId === admin.userId) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    const db = getAuthDb();
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId) as DbUser | undefined;
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
    auditLog(admin.userId, admin.email, 'user_deleted', `Deleted user ${target.email}`, req.ip);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Repo access: list repos for a user ──────────────────────────
router.get('/users/:id/repos', (req: Request, res: Response) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const db = getAuthDb();
    const rows = db.prepare('SELECT * FROM repo_access WHERE user_id = ? ORDER BY granted_at DESC').all(targetId) as RepoAccess[];
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Repo access: grant ──────────────────────────────────────────
router.post('/users/:id/repos', (req: Request, res: Response) => {
  try {
    const admin = (req as any).user as JwtPayload;
    const targetId = parseInt(req.params.id, 10);
    const { repoName } = req.body;

    if (!repoName) {
      res.status(400).json({ error: 'repoName is required' });
      return;
    }

    const db = getAuthDb();
    const target = db.prepare('SELECT email FROM users WHERE id = ?').get(targetId) as { email: string } | undefined;
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    db.prepare('INSERT OR IGNORE INTO repo_access (user_id, repo_name, granted_by) VALUES (?, ?, ?)').run(targetId, repoName, admin.userId);
    auditLog(admin.userId, admin.email, 'repo_access_granted', `Granted ${target.email} access to ${repoName}`, req.ip);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Repo access: revoke ─────────────────────────────────────────
router.delete('/users/:id/repos/:repoName', (req: Request, res: Response) => {
  try {
    const admin = (req as any).user as JwtPayload;
    const targetId = parseInt(req.params.id, 10);
    const repoName = decodeURIComponent(req.params.repoName);

    const db = getAuthDb();
    const target = db.prepare('SELECT email FROM users WHERE id = ?').get(targetId) as { email: string } | undefined;
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    db.prepare('DELETE FROM repo_access WHERE user_id = ? AND repo_name = ?').run(targetId, repoName);
    auditLog(admin.userId, admin.email, 'repo_access_revoked', `Revoked ${target.email} access to ${repoName}`, req.ip);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk grant repos to a user ──────────────────────────────────
router.post('/users/:id/repos/bulk', (req: Request, res: Response) => {
  try {
    const admin = (req as any).user as JwtPayload;
    const targetId = parseInt(req.params.id, 10);
    const { repoNames } = req.body;

    if (!Array.isArray(repoNames) || repoNames.length === 0) {
      res.status(400).json({ error: 'repoNames array is required' });
      return;
    }

    const db = getAuthDb();
    const target = db.prepare('SELECT email FROM users WHERE id = ?').get(targetId) as { email: string } | undefined;
    if (!target) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const insert = db.prepare('INSERT OR IGNORE INTO repo_access (user_id, repo_name, granted_by) VALUES (?, ?, ?)');
    const tx = db.transaction(() => {
      for (const name of repoNames) {
        insert.run(targetId, name, admin.userId);
      }
    });
    tx();

    auditLog(admin.userId, admin.email, 'repo_access_bulk_granted', `Granted ${target.email} access to ${repoNames.length} repos`, req.ip);
    res.json({ ok: true, count: repoNames.length });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── List who has access to a repo ───────────────────────────────
router.get('/repo-access/:repoName', (req: Request, res: Response) => {
  try {
    const repoName = decodeURIComponent(req.params.repoName);
    const db = getAuthDb();
    const rows = db.prepare(
      `SELECT u.id, u.email, u.display_name, u.role, u.status, ra.granted_at
       FROM repo_access ra JOIN users u ON u.id = ra.user_id
       WHERE ra.repo_name = ? ORDER BY ra.granted_at DESC`
    ).all(repoName);
    res.json(rows);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Audit log ───────────────────────────────────────────────────
router.get('/audit-log', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const offset = parseInt(req.query.offset as string) || 0;
    const userFilter = req.query.user as string | undefined;
    const actionFilter = req.query.action as string | undefined;

    const db = getAuthDb();
    const conditions: string[] = [];
    const params: any[] = [];

    if (userFilter) {
      conditions.push('user_email LIKE ?');
      params.push(`%${userFilter}%`);
    }
    if (actionFilter) {
      conditions.push('action = ?');
      params.push(actionFilter);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRow = db.prepare(`SELECT COUNT(*) as total FROM audit_log ${where}`).get(...params) as { total: number };
    const rows = db.prepare(
      `SELECT id, user_id as userId, user_email as userEmail, action, details, ip, created_at as createdAt
       FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset) as AuditEntry[];

    res.json({ entries: rows, total: countRow.total, limit, offset });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export { router as adminRoutes };
