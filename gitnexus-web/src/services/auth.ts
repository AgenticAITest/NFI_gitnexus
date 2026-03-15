/** Auth service — manages tokens, auth API calls, and authenticated fetch */

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  role: 'admin' | 'user';
  status: 'active' | 'suspended';
  createdAt: string;
}

interface AuthResponse {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

const TOKEN_KEY = 'gitnexus_access_token';
const REFRESH_KEY = 'gitnexus_refresh_token';
const USER_KEY = 'gitnexus_user';

// ── Token storage ────────────────────────────────────────────────

export function getStoredTokens() {
  return {
    accessToken: localStorage.getItem(TOKEN_KEY),
    refreshToken: localStorage.getItem(REFRESH_KEY),
  };
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? JSON.parse(raw) : null;
}

function storeAuth(data: AuthResponse) {
  localStorage.setItem(TOKEN_KEY, data.accessToken);
  localStorage.setItem(REFRESH_KEY, data.refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(data.user));
}

export function clearAuth() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(USER_KEY);
}

// ── API calls ────────────────────────────────────────────────────

function authUrl(serverUrl: string, path: string): string {
  // serverUrl ends with /api
  return `${serverUrl}/auth${path}`;
}

function adminUrl(serverUrl: string, path: string): string {
  return `${serverUrl}/admin${path}`;
}

export async function checkAuthStatus(serverUrl: string): Promise<{ setupComplete: boolean }> {
  const res = await fetch(authUrl(serverUrl, '/status'));
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export async function setupAdmin(serverUrl: string, email: string, password: string, displayName?: string): Promise<AuthUser> {
  const res = await fetch(authUrl(serverUrl, '/setup'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Server returned ${res.status}`);
  }
  const data: AuthResponse = await res.json();
  storeAuth(data);
  return data.user;
}

export async function login(serverUrl: string, email: string, password: string): Promise<AuthUser> {
  const res = await fetch(authUrl(serverUrl, '/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Server returned ${res.status}`);
  }
  const data: AuthResponse = await res.json();
  storeAuth(data);
  return data.user;
}

export async function refreshToken(serverUrl: string): Promise<AuthUser | null> {
  const { refreshToken: rt } = getStoredTokens();
  if (!rt) return null;

  const res = await fetch(authUrl(serverUrl, '/refresh'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: rt }),
  });
  if (!res.ok) {
    clearAuth();
    return null;
  }
  const data: AuthResponse = await res.json();
  storeAuth(data);
  return data.user;
}

export async function logout(serverUrl: string): Promise<void> {
  const { accessToken, refreshToken: rt } = getStoredTokens();
  try {
    await fetch(authUrl(serverUrl, '/logout'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ refreshToken: rt }),
    });
  } catch { /* ignore logout errors */ }
  clearAuth();
}

export async function updateProfile(serverUrl: string, data: { displayName?: string; currentPassword?: string; newPassword?: string }): Promise<AuthUser> {
  const { accessToken } = getStoredTokens();
  const res = await fetch(authUrl(serverUrl, '/me'), {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server returned ${res.status}`);
  }
  const user: AuthUser = await res.json();
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

// ── Authenticated fetch wrapper ──────────────────────────────────

let _refreshPromise: Promise<AuthUser | null> | null = null;

/** Fetch with auth — auto-refreshes token on 401 */
export async function authFetch(serverUrl: string, input: string, init?: RequestInit): Promise<Response> {
  const { accessToken } = getStoredTokens();
  const headers = new Headers(init?.headers);
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }

  let res = await fetch(input, { ...init, headers });

  if (res.status === 401 && accessToken) {
    // Try refresh — deduplicate concurrent refresh attempts
    if (!_refreshPromise) {
      _refreshPromise = refreshToken(serverUrl).finally(() => { _refreshPromise = null; });
    }
    const newUser = await _refreshPromise;
    if (newUser) {
      const { accessToken: newToken } = getStoredTokens();
      headers.set('Authorization', `Bearer ${newToken}`);
      res = await fetch(input, { ...init, headers });
    }
  }

  return res;
}

// ── Admin API calls ──────────────────────────────────────────────

export async function listUsers(serverUrl: string): Promise<AuthUser[]> {
  const res = await authFetch(serverUrl, adminUrl(serverUrl, '/users'));
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}

export async function createUser(serverUrl: string, data: { email: string; password: string; displayName?: string; role?: string }): Promise<AuthUser> {
  const res = await authFetch(serverUrl, adminUrl(serverUrl, '/users'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server returned ${res.status}`);
  }
  return res.json();
}

export async function updateUser(serverUrl: string, userId: number, data: { displayName?: string; role?: string; status?: string }): Promise<AuthUser> {
  const res = await authFetch(serverUrl, adminUrl(serverUrl, `/users/${userId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server returned ${res.status}`);
  }
  return res.json();
}

export async function deleteUser(serverUrl: string, userId: number): Promise<void> {
  const res = await authFetch(serverUrl, adminUrl(serverUrl, `/users/${userId}`), { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server returned ${res.status}`);
  }
}

export async function resetUserPassword(serverUrl: string, userId: number, newPassword: string): Promise<void> {
  const res = await authFetch(serverUrl, adminUrl(serverUrl, `/users/${userId}/reset-password`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newPassword }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server returned ${res.status}`);
  }
}

export async function getUserRepos(serverUrl: string, userId: number): Promise<{ repoName: string; grantedAt: string }[]> {
  const res = await authFetch(serverUrl, adminUrl(serverUrl, `/users/${userId}/repos`));
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const rows = await res.json();
  return rows.map((r: any) => ({ repoName: r.repo_name, grantedAt: r.granted_at }));
}

export async function grantRepoAccess(serverUrl: string, userId: number, repoName: string): Promise<void> {
  const res = await authFetch(serverUrl, adminUrl(serverUrl, `/users/${userId}/repos`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoName }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server returned ${res.status}`);
  }
}

export async function revokeRepoAccess(serverUrl: string, userId: number, repoName: string): Promise<void> {
  const res = await authFetch(serverUrl, adminUrl(serverUrl, `/users/${userId}/repos/${encodeURIComponent(repoName)}`), {
    method: 'DELETE',
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server returned ${res.status}`);
  }
}

export async function bulkGrantRepos(serverUrl: string, userId: number, repoNames: string[]): Promise<void> {
  const res = await authFetch(serverUrl, adminUrl(serverUrl, `/users/${userId}/repos/bulk`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoNames }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server returned ${res.status}`);
  }
}

export interface AuditEntry {
  id: number;
  userId: number;
  userEmail: string;
  action: string;
  details: string | null;
  ip: string | null;
  createdAt: string;
}

export async function getAuditLog(serverUrl: string, params?: { limit?: number; offset?: number; user?: string; action?: string }): Promise<{ entries: AuditEntry[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  if (params?.user) qs.set('user', params.user);
  if (params?.action) qs.set('action', params.action);
  const res = await authFetch(serverUrl, adminUrl(serverUrl, `/audit-log?${qs}`));
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return res.json();
}
