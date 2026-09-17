'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AuthResponse, RefreshResponse, UserSchema, type User } from '@confluo/shared';
import { api } from './api-client';

type Status = 'loading' | 'signed-out' | 'signed-in';

interface AuthContextValue {
  status: Status;
  user: User | null;
  login: (email: string, password: string) => Promise<User>;
  register: (email: string, password: string, displayName: string) => Promise<User>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const ACCESS_TTL_MS = 15 * 60 * 1000;

/**
 * Single in-flight refresh shared by every caller (boot effect, StrictMode double-mount, 401 retry).
 * Refresh tokens rotate on every call and reuse revokes the family, so two concurrent refreshes
 * would sign the user out.
 */
let inflightRefresh: Promise<string> | null = null;
function refreshOnce(): Promise<string> {
  if (!inflightRefresh) {
    inflightRefresh = (async () => {
      const r = RefreshResponse.parse(await api.post('/auth/refresh'));
      return r.accessToken;
    })().finally(() => {
      inflightRefresh = null;
    });
  }
  return inflightRefresh;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<User | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRefresh = useCallback((fn: () => Promise<string | null>) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void fn(), ACCESS_TTL_MS * 0.8);
  }, []);

  const refresh = useCallback(async (): Promise<string | null> => {
    try {
      const accessToken = await refreshOnce();
      api.setToken(accessToken);
      scheduleRefresh(refresh);
      return accessToken;
    } catch {
      api.setToken(null);
      setUser(null);
      setStatus('signed-out');
      return null;
    }
  }, [scheduleRefresh]);

  useEffect(() => {
    api.setRefresher(refresh);
    let cancelled = false;
    (async () => {
      const token = await refresh();
      if (cancelled) return;
      if (!token) return;
      try {
        const me = await api.get<{ user: unknown }>('/me');
        if (cancelled) return;
        setUser(UserSchema.parse(me.user));
        setStatus('signed-in');
      } catch {
        setStatus('signed-out');
      }
    })();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [refresh]);

  const adopt = useCallback(
    (r: AuthResponse) => {
      api.setToken(r.accessToken);
      setUser(r.user);
      setStatus('signed-in');
      scheduleRefresh(refresh);
      return r.user;
    },
    [refresh, scheduleRefresh],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      login: async (email, password) => adopt(AuthResponse.parse(await api.post('/auth/login', { email, password }))),
      register: async (email, password, displayName) =>
        adopt(AuthResponse.parse(await api.post('/auth/register', { email, password, displayName }))),
      logout: async () => {
        try {
          await api.post('/auth/logout');
        } catch {
          /* ignore */
        }
        api.setToken(null);
        setUser(null);
        setStatus('signed-out');
        if (timer.current) clearTimeout(timer.current);
      },
    }),
    [status, user, adopt],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
