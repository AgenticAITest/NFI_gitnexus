export type UserRole = 'admin' | 'user';
export type UserStatus = 'active' | 'suspended';

export interface DbUser {
  id: number;
  email: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

export interface SafeUser {
  id: number;
  email: string;
  displayName: string;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
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

export interface RepoAccess {
  id: number;
  userId: number;
  repoName: string;
  grantedAt: string;
  grantedBy: number;
}

export interface JwtPayload {
  userId: number;
  email: string;
  role: UserRole;
}

export function toSafeUser(row: DbUser): SafeUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
  };
}
