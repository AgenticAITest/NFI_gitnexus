import { useState, useEffect, useCallback } from 'react';
import {
  X, Users, Shield, ShieldCheck, UserPlus, Trash2, Ban, CheckCircle,
  Key, ChevronDown, ChevronRight, Database, Clock, Search, RefreshCw,
  AlertCircle,
} from 'lucide-react';
import {
  type AuthUser, type AuditEntry,
  listUsers, createUser, updateUser, deleteUser, resetUserPassword,
  getUserRepos, grantRepoAccess, revokeRepoAccess,
  getAuditLog,
} from '../services/auth';
import { type RepoSummary, fetchRepos } from '../services/server-connection';

interface AdminPanelProps {
  isOpen: boolean;
  onClose: () => void;
  serverUrl: string;
  availableRepos?: RepoSummary[];
  currentUser: AuthUser | null;
}

type Tab = 'users' | 'audit';

export function AdminPanel({ isOpen, onClose, serverUrl, availableRepos: externalRepos, currentUser }: AdminPanelProps) {
  const [tab, setTab] = useState<Tab>('users');
  const [users, setUsers] = useState<AuthUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [repos, setRepos] = useState<RepoSummary[]>(externalRepos || []);

  // Add user form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<'user' | 'admin'>('user');

  // Expanded user (repo assignment)
  const [expandedUser, setExpandedUser] = useState<number | null>(null);
  const [userRepos, setUserRepos] = useState<Record<number, string[]>>({});

  // Audit log
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditFilter, setAuditFilter] = useState('');

  // Reset password
  const [resetPasswordUserId, setResetPasswordUserId] = useState<number | null>(null);
  const [resetPasswordValue, setResetPasswordValue] = useState('');

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [data, repoList] = await Promise.all([
        listUsers(serverUrl),
        fetchRepos(serverUrl).catch(() => null),
      ]);
      setUsers(data);
      if (repoList) {
        setRepos(repoList);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [serverUrl]);

  const loadAudit = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getAuditLog(serverUrl, { limit: 100, user: auditFilter || undefined });
      setAuditEntries(data.entries);
      setAuditTotal(data.total);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [serverUrl, auditFilter]);

  useEffect(() => {
    if (!isOpen) return;
    if (tab === 'users') loadUsers();
    if (tab === 'audit') loadAudit();
  }, [isOpen, tab, loadUsers, loadAudit]);

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await createUser(serverUrl, { email: newEmail, password: newPassword, displayName: newDisplayName, role: newRole });
      setShowAddForm(false);
      setNewEmail('');
      setNewPassword('');
      setNewDisplayName('');
      setNewRole('user');
      await loadUsers();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleStatus = async (user: AuthUser) => {
    const newStatus = user.status === 'active' ? 'suspended' : 'active';
    try {
      await updateUser(serverUrl, user.id, { status: newStatus });
      await loadUsers();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleRole = async (user: AuthUser) => {
    const newRole = user.role === 'admin' ? 'user' : 'admin';
    try {
      await updateUser(serverUrl, user.id, { role: newRole });
      await loadUsers();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDeleteUser = async (user: AuthUser) => {
    if (!confirm(`Delete user ${user.email}? This cannot be undone.`)) return;
    try {
      await deleteUser(serverUrl, user.id);
      await loadUsers();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleResetPassword = async (userId: number) => {
    if (!resetPasswordValue || resetPasswordValue.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    try {
      await resetUserPassword(serverUrl, userId, resetPasswordValue);
      setResetPasswordUserId(null);
      setResetPasswordValue('');
    } catch (err: any) {
      setError(err.message);
    }
  };

  const toggleExpandUser = async (userId: number) => {
    if (expandedUser === userId) {
      setExpandedUser(null);
      return;
    }
    setExpandedUser(userId);
    if (!userRepos[userId]) {
      try {
        const repos = await getUserRepos(serverUrl, userId);
        setUserRepos(prev => ({ ...prev, [userId]: repos.map(r => r.repoName) }));
      } catch (err: any) {
        setError(err.message);
      }
    }
  };

  const handleGrantRepo = async (userId: number, repoName: string) => {
    try {
      await grantRepoAccess(serverUrl, userId, repoName);
      setUserRepos(prev => ({
        ...prev,
        [userId]: [...(prev[userId] || []), repoName],
      }));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRevokeRepo = async (userId: number, repoName: string) => {
    try {
      await revokeRepoAccess(serverUrl, userId, repoName);
      setUserRepos(prev => ({
        ...prev,
        [userId]: (prev[userId] || []).filter(r => r !== repoName),
      }));
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-3xl max-h-[85vh] bg-surface border border-border-subtle rounded-xl shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <Shield className="w-5 h-5 text-accent" />
            <h2 className="text-lg font-semibold text-text-primary">Admin Panel</h2>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-md text-text-muted hover:bg-hover hover:text-text-primary transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border-subtle">
          <button
            onClick={() => setTab('users')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition-colors border-b-2 ${
              tab === 'users' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            <Users className="w-4 h-4" />
            Users
          </button>
          <button
            onClick={() => setTab('audit')}
            className={`flex items-center gap-2 px-5 py-3 text-sm font-medium transition-colors border-b-2 ${
              tab === 'audit' ? 'border-accent text-accent' : 'border-transparent text-text-muted hover:text-text-secondary'
            }`}
          >
            <Clock className="w-4 h-4" />
            Audit Log
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="mx-6 mt-4 flex items-center gap-2 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {error}
            <button onClick={() => setError('')} className="ml-auto text-red-400 hover:text-red-300"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === 'users' && (
            <div className="space-y-4">
              {/* Add user button */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-text-muted">{users.length} users</span>
                <button
                  onClick={() => setShowAddForm(v => !v)}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-accent hover:bg-accent/90 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  <UserPlus className="w-4 h-4" />
                  Add User
                </button>
              </div>

              {/* Add user form */}
              {showAddForm && (
                <form onSubmit={handleAddUser} className="bg-elevated border border-border-subtle rounded-lg p-4 space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Email *</label>
                      <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} required
                        className="w-full px-3 py-2 bg-surface border border-border-subtle rounded-lg text-sm text-text-primary outline-none focus:border-accent" />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Display Name</label>
                      <input type="text" value={newDisplayName} onChange={e => setNewDisplayName(e.target.value)}
                        className="w-full px-3 py-2 bg-surface border border-border-subtle rounded-lg text-sm text-text-primary outline-none focus:border-accent" />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Password * (min 8)</label>
                      <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required minLength={8}
                        className="w-full px-3 py-2 bg-surface border border-border-subtle rounded-lg text-sm text-text-primary outline-none focus:border-accent" />
                    </div>
                    <div>
                      <label className="block text-xs text-text-muted mb-1">Role</label>
                      <select value={newRole} onChange={e => setNewRole(e.target.value as 'user' | 'admin')}
                        className="w-full px-3 py-2 bg-surface border border-border-subtle rounded-lg text-sm text-text-primary outline-none focus:border-accent">
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button type="button" onClick={() => setShowAddForm(false)}
                      className="px-3 py-1.5 text-sm text-text-muted hover:text-text-secondary transition-colors">Cancel</button>
                    <button type="submit"
                      className="px-3 py-1.5 bg-accent text-white rounded-lg text-sm font-medium hover:bg-accent/90 transition-colors">Create User</button>
                  </div>
                </form>
              )}

              {/* User list */}
              {loading && users.length === 0 ? (
                <div className="text-center py-8 text-text-muted">Loading users...</div>
              ) : (
                <div className="space-y-2">
                  {users.map(user => {
                    const isSelf = user.id === currentUser?.id;
                    const isExpanded = expandedUser === user.id;
                    const assignedRepos = userRepos[user.id] || [];
                    const isResettingPassword = resetPasswordUserId === user.id;

                    return (
                      <div key={user.id} className="bg-elevated border border-border-subtle rounded-lg overflow-hidden">
                        <div className="flex items-center gap-3 px-4 py-3">
                          {/* Expand toggle */}
                          <button onClick={() => toggleExpandUser(user.id)} className="text-text-muted hover:text-text-secondary">
                            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>

                          {/* User info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-text-primary truncate">{user.displayName}</span>
                              {user.role === 'admin' && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-accent/20 text-accent text-[10px] font-medium rounded">
                                  <ShieldCheck className="w-3 h-3" />ADMIN
                                </span>
                              )}
                              {user.status === 'suspended' && (
                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-red-500/20 text-red-400 text-[10px] font-medium rounded">
                                  <Ban className="w-3 h-3" />SUSPENDED
                                </span>
                              )}
                              {isSelf && (
                                <span className="text-[10px] text-text-muted">(you)</span>
                              )}
                            </div>
                            <div className="text-xs text-text-muted">{user.email}</div>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-1">
                            {!isSelf && (
                              <>
                                <button
                                  onClick={() => handleToggleRole(user)}
                                  className="w-7 h-7 flex items-center justify-center rounded text-text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                                  title={user.role === 'admin' ? 'Demote to user' : 'Promote to admin'}
                                >
                                  <Shield className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleToggleStatus(user)}
                                  className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
                                    user.status === 'active'
                                      ? 'text-text-muted hover:text-red-400 hover:bg-red-400/10'
                                      : 'text-text-muted hover:text-emerald-400 hover:bg-emerald-400/10'
                                  }`}
                                  title={user.status === 'active' ? 'Suspend' : 'Activate'}
                                >
                                  {user.status === 'active' ? <Ban className="w-3.5 h-3.5" /> : <CheckCircle className="w-3.5 h-3.5" />}
                                </button>
                                <button
                                  onClick={() => { setResetPasswordUserId(isResettingPassword ? null : user.id); setResetPasswordValue(''); }}
                                  className="w-7 h-7 flex items-center justify-center rounded text-text-muted hover:text-yellow-400 hover:bg-yellow-400/10 transition-colors"
                                  title="Reset password"
                                >
                                  <Key className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={() => handleDeleteUser(user)}
                                  className="w-7 h-7 flex items-center justify-center rounded text-text-muted hover:text-red-400 hover:bg-red-400/10 transition-colors"
                                  title="Delete user"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Reset password inline */}
                        {isResettingPassword && (
                          <div className="px-4 pb-3 flex items-center gap-2">
                            <input
                              type="password"
                              value={resetPasswordValue}
                              onChange={e => setResetPasswordValue(e.target.value)}
                              placeholder="New password (min 8 chars)"
                              className="flex-1 px-3 py-1.5 bg-surface border border-border-subtle rounded-lg text-sm text-text-primary outline-none focus:border-accent"
                            />
                            <button
                              onClick={() => handleResetPassword(user.id)}
                              className="px-3 py-1.5 bg-yellow-600 text-white rounded-lg text-xs font-medium hover:bg-yellow-500 transition-colors"
                            >
                              Reset
                            </button>
                            <button
                              onClick={() => { setResetPasswordUserId(null); setResetPasswordValue(''); }}
                              className="px-2 py-1.5 text-xs text-text-muted hover:text-text-secondary"
                            >
                              Cancel
                            </button>
                          </div>
                        )}

                        {/* Expanded: repo assignment */}
                        {isExpanded && (
                          <div className="px-4 pb-4 border-t border-border-subtle pt-3">
                            <div className="flex items-center gap-2 mb-2">
                              <Database className="w-3.5 h-3.5 text-text-muted" />
                              <span className="text-xs font-medium text-text-secondary">Repository Access</span>
                              {user.role === 'admin' && (
                                <span className="text-[10px] text-text-muted">(admins have access to all repos)</span>
                              )}
                            </div>
                            {user.role !== 'admin' && (
                              <div className="grid grid-cols-2 gap-1.5">
                                {repos.map(repo => {
                                  const hasAccess = assignedRepos.includes(repo.name);
                                  return (
                                    <button
                                      key={repo.name}
                                      onClick={() => hasAccess ? handleRevokeRepo(user.id, repo.name) : handleGrantRepo(user.id, repo.name)}
                                      className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors ${
                                        hasAccess
                                          ? 'bg-accent/15 border border-accent/30 text-accent'
                                          : 'bg-surface border border-border-subtle text-text-muted hover:text-text-secondary hover:border-border-default'
                                      }`}
                                    >
                                      <span className={`w-2 h-2 rounded-full ${hasAccess ? 'bg-accent' : 'bg-text-muted/30'}`} />
                                      <span className="truncate">{repo.name}</span>
                                    </button>
                                  );
                                })}
                                {repos.length === 0 && (
                                  <span className="text-xs text-text-muted col-span-2">No repos available</span>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {tab === 'audit' && (
            <div className="space-y-4">
              {/* Filter */}
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-elevated border border-border-subtle rounded-lg">
                  <Search className="w-4 h-4 text-text-muted" />
                  <input
                    type="text"
                    value={auditFilter}
                    onChange={e => setAuditFilter(e.target.value)}
                    placeholder="Filter by email..."
                    className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                  />
                </div>
                <button onClick={loadAudit} className="w-9 h-9 flex items-center justify-center rounded-lg bg-elevated border border-border-subtle text-text-muted hover:text-text-primary transition-colors">
                  <RefreshCw className="w-4 h-4" />
                </button>
              </div>

              <div className="text-xs text-text-muted">{auditTotal} entries total</div>

              {/* Entries */}
              <div className="space-y-1">
                {auditEntries.map(entry => (
                  <div key={entry.id} className="flex items-start gap-3 px-3 py-2 bg-elevated rounded-lg">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-text-primary">{entry.userEmail}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                          entry.action.includes('login') ? 'bg-blue-500/20 text-blue-400'
                          : entry.action.includes('delete') ? 'bg-red-500/20 text-red-400'
                          : entry.action.includes('create') || entry.action.includes('grant') ? 'bg-emerald-500/20 text-emerald-400'
                          : 'bg-surface text-text-muted'
                        }`}>
                          {entry.action}
                        </span>
                      </div>
                      {entry.details && (
                        <div className="text-xs text-text-muted mt-0.5 truncate">{entry.details}</div>
                      )}
                    </div>
                    <div className="text-[10px] text-text-muted whitespace-nowrap">
                      {new Date(entry.createdAt).toLocaleString()}
                    </div>
                  </div>
                ))}
                {auditEntries.length === 0 && !loading && (
                  <div className="text-center py-8 text-text-muted text-sm">No audit entries found</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
