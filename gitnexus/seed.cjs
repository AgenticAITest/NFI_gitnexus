#!/usr/bin/env node
/**
 * Seed script — creates an admin user for fresh deployments.
 *
 * Usage:
 *   node seed.js
 *   ADMIN_EMAIL=me@co.com ADMIN_PASSWORD=secret123 node seed.js
 *
 * Environment variables (all optional, defaults shown):
 *   ADMIN_EMAIL        — admin@gitnexus.local
 *   ADMIN_PASSWORD     — Admin123!
 *   ADMIN_DISPLAY_NAME — Admin
 */

const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');
const os = require('os');
const fs = require('fs');

const email = process.env.ADMIN_EMAIL || 'admin@gitnexus.local';
const password = process.env.ADMIN_PASSWORD || 'Admin123!';
const displayName = process.env.ADMIN_DISPLAY_NAME || 'Admin';

if (password.length < 8) {
  console.error('ERROR: Password must be at least 8 characters.');
  process.exit(1);
}

// ── Database setup (mirrors db.ts) ──────────────────────────────────────
const dir = path.join(os.homedir(), '.gitnexus');
fs.mkdirSync(dir, { recursive: true });
const dbPath = path.join(dir, 'auth.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS repo_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    repo_name TEXT NOT NULL,
    granted_at TEXT NOT NULL DEFAULT (datetime('now')),
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE(user_id, repo_name)
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_email TEXT NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    ip TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Check if admin already exists ───────────────────────────────────────
const existing = db.prepare('SELECT id, email FROM users WHERE role = ?').get('admin');
if (existing) {
  console.log(`Admin already exists: ${existing.email} (id=${existing.id}). Skipping.`);
  db.close();
  process.exit(0);
}

// ── Create admin ────────────────────────────────────────────────────────
const hash = bcrypt.hashSync(password, 12);
const result = db.prepare(
  'INSERT INTO users (email, display_name, password_hash, role) VALUES (?, ?, ?, ?)'
).run(email, displayName, hash, 'admin');

const userId = result.lastInsertRowid;

// Grant access to all registered repos (if any)
try {
  const registryPath = path.join(os.homedir(), '.gitnexus', 'registry.json');
  if (fs.existsSync(registryPath)) {
    const repos = JSON.parse(fs.readFileSync(registryPath, 'utf-8'));
    if (Array.isArray(repos)) {
      const grant = db.prepare(
        'INSERT OR IGNORE INTO repo_access (user_id, repo_name, granted_by) VALUES (?, ?, ?)'
      );
      let count = 0;
      for (const r of repos) {
        if (r.name) {
          grant.run(userId, r.name, userId);
          count++;
        }
      }
      if (count > 0) console.log(`Granted access to ${count} registered repo(s).`);
    }
  }
} catch {
  // Non-fatal — repos can be granted later
}

// Audit log
db.prepare(
  'INSERT INTO audit_log (user_id, user_email, action, details) VALUES (?, ?, ?, ?)'
).run(userId, email, 'seed', 'Admin account created via seed script');

db.close();

console.log(`Admin created successfully.`);
console.log(`  Email:    ${email}`);
console.log(`  Password: ${password}`);
console.log(`  DB:       ${dbPath}`);
