import { createContext, useContext, useState, type ReactNode } from 'react';
import { apiRequest, TOKEN_KEY } from '../api/client';

interface AuthUser {
  id: number;
  email: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const USER_KEY = 'mentat_fc_user';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [user, setUser] = useState<AuthUser | null>(() => {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as AuthUser) : null;
  });

  function persist(nextToken: string, nextUser: AuthUser): void {
    localStorage.setItem(TOKEN_KEY, nextToken);
    localStorage.setItem(USER_KEY, JSON.stringify(nextUser));
    setToken(nextToken);
    setUser(nextUser);
  }

  async function login(email: string, password: string): Promise<void> {
    const result = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    });
    persist(result.token, result.user);
  }

  async function register(email: string, password: string): Promise<void> {
    const result = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/register', {
      method: 'POST',
      body: { email, password },
    });
    persist(result.token, result.user);
  }

  function logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    setToken(null);
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, token, login, register, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

// Read directly from storage (not the context) for the one-off fetches
// bets.tsx makes outside of apiRequest -- avoids threading the token through
// every call site as a parameter.
export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
