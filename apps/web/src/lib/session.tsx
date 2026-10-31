'use client';

import type { OrganisationDto, UserDto } from '@monty/validation';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api, ApiError } from './api';

interface SessionValue {
  user: UserDto;
  organisations: OrganisationDto[];
  refreshOrganisations: () => Promise<void>;
  logout: () => Promise<void>;
}

const SessionCtx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(SessionCtx);
  if (!v) throw new Error('useSession must be used inside <RequireSession>');
  return v;
}

/** Loads the signed-in user; redirects to /login when there is no valid session. */
export function RequireSession({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<{ user: UserDto; organisations: OrganisationDto[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ user }, { organisations }] = await Promise.all([api.auth.me(), api.organisations.list()]);
      setState({ user, organisations });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        const next = typeof window !== 'undefined' ? window.location.pathname + window.location.search : pathname;
        router.replace(`/login?next=${encodeURIComponent(next)}`);
        return;
      }
      setError(err instanceof ApiError ? err.message : 'Could not load your account.');
    }
  }, [router, pathname]);

  useEffect(() => {
    void load();
    // Load once per mount; navigation inside the app keeps the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshOrganisations = useCallback(async () => {
    const { organisations } = await api.organisations.list();
    setState((s) => (s ? { ...s, organisations } : s));
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } finally {
      router.replace('/login');
    }
  }, [router]);

  if (error) {
    return (
      <div className="p-8">
        <p className="text-danger">{error}</p>
        <button className="mt-2 underline" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }
  if (!state) return <>{fallback}</>;
  return (
    <SessionCtx.Provider value={{ ...state, refreshOrganisations, logout }}>{children}</SessionCtx.Provider>
  );
}
