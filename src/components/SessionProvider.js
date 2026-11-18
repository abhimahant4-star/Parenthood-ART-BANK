"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { SESSION_CLEARED_EVENT, apiRequest, clearStoredSession, readStoredSession, storeSession } from "@/lib/api";

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = readStoredSession();
    if (stored) setUser(stored.user);
    else clearStoredSession();
    setReady(true);
    const onCleared = () => setUser(null);
    window.addEventListener(SESSION_CLEARED_EVENT, onCleared);
    return () => window.removeEventListener(SESSION_CLEARED_EVENT, onCleared);
  }, []);

  const signIn = useCallback((token, account) => {
    storeSession(token, account);
    setUser(account);
  }, []);

  // The session stays open if the server could not revoke it, so the user can retry.
  const signOut = useCallback(async () => {
    await apiRequest("/auth/logout", { method: "POST", body: {} });
    clearStoredSession();
    setUser(null);
  }, []);

  const value = useMemo(() => ({ user, ready, signIn, signOut }), [user, ready, signIn, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
