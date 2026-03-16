import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import {
  type AuthUser,
  checkAuthStatus,
  login as apiLogin,
  setupAdmin as apiSetup,
  logout as apiLogout,
  refreshToken,
  getStoredUser,
  getStoredTokens,
  clearAuth,
} from '../services/auth';
import { normalizeServerUrl } from '../services/server-connection';

interface AuthContextValue {
  user: AuthUser | null;
  /** True while checking auth on mount */
  loading: boolean;
  /** Server requires login */
  needsLogin: boolean;
  /** The server URL we're authenticating against */
  serverUrl: string | null;
  login: (email: string, password: string) => Promise<AuthUser>;
  setup: (email: string, password: string, displayName?: string) => Promise<AuthUser>;
  logout: () => Promise<void>;
  setUser: (user: AuthUser | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(getStoredUser);
  const [loading, setLoading] = useState(true); // start true — check on mount
  const [needsLogin, setNeedsLogin] = useState(false);
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  // On mount: check stored server URL for auth
  useEffect(() => {
    const saved = localStorage.getItem('gitnexus-server-url');
    if (!saved) {
      // No server URL stored — no auth needed, just show the app
      setLoading(false);
      return;
    }

    const baseUrl = normalizeServerUrl(saved);
    setServerUrl(baseUrl);

    (async () => {
      try {
        const { setupComplete } = await checkAuthStatus(baseUrl);
        if (!setupComplete) {
          // Server has no admin — no auth enforced
          setLoading(false);
          return;
        }

        // Auth is required — check if we have a valid session
        const { accessToken } = getStoredTokens();
        if (accessToken) {
          const storedUser = getStoredUser();
          if (storedUser) {
            setUser(storedUser);
            setLoading(false);
            return;
          }
          // Try refresh
          const refreshed = await refreshToken(baseUrl);
          if (refreshed) {
            setUser(refreshed);
            setLoading(false);
            return;
          }
        }

        // No valid session — need login
        setNeedsLogin(true);
        setLoading(false);
      } catch {
        // Can't reach server — skip auth, show app normally
        setLoading(false);
      }
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    if (!serverUrl) throw new Error('No server URL');
    const u = await apiLogin(serverUrl, email, password);
    setUser(u);
    setNeedsLogin(false);
    return u;
  }, [serverUrl]);

  const setup = useCallback(async (email: string, password: string, displayName?: string) => {
    if (!serverUrl) throw new Error('No server URL');
    const u = await apiSetup(serverUrl, email, password, displayName);
    setUser(u);
    setNeedsLogin(false);
    return u;
  }, [serverUrl]);

  // Listen for auth-expired events (401 after refresh failure)
  useEffect(() => {
    const handleAuthExpired = () => {
      clearAuth();
      setUser(null);
      setNeedsLogin(true);
    };
    window.addEventListener('auth-expired', handleAuthExpired);
    return () => window.removeEventListener('auth-expired', handleAuthExpired);
  }, []);

  const logoutFn = useCallback(async () => {
    if (serverUrl) await apiLogout(serverUrl);
    setUser(null);
    setNeedsLogin(true);
  }, [serverUrl]);

  return (
    <AuthContext.Provider value={{
      user, loading, needsLogin, serverUrl,
      login, setup, logout: logoutFn, setUser,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
