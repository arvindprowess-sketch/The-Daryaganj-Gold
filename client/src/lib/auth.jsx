import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import {
  api, getToken, setToken, getRefreshToken, setRefreshToken, clearTokens,
  setAuthFailureHandler,
} from './api.js';
import { setQueueUser, flushQueue, pendingCount } from './queue.js';

const AuthCtx = createContext(null);

// Cached profile so a reload restores the session instantly, before /auth/me
// returns — and so a network blip on startup does not look like a logout.
const USER_KEY = 'audix_user';
function readCachedUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || 'null'); } catch { return null; }
}
function writeCachedUser(u) {
  if (u) localStorage.setItem(USER_KEY, JSON.stringify(u));
  else localStorage.removeItem(USER_KEY);
}

export function AuthProvider({ children }) {
  // Optimistically trust the cached profile when a token exists. The session is
  // only torn down on a genuine auth failure, never on a failed fetch.
  const [user, setUser] = useState(() => (getToken() ? readCachedUser() : null));
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const refreshTimer = useRef(null);

  const endSession = useCallback(() => {
    clearTokens();
    writeCachedUser(null);
    setUser(null);
  }, []);

  // Only a rejected REFRESH token ends the session (see api.js).
  useEffect(() => {
    setAuthFailureHandler(() => endSession());
  }, [endSession]);

  // The retry queue files entries as the auditor who counted them, not as
  // whoever is signed in when the network comes back.
  useEffect(() => { setQueueUser(user?.id ?? null); }, [user]);

  // Validate the session in the background. A network failure leaves the
  // cached session intact — the user keeps working and we retry later.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getToken()) { setLoading(false); return; }
      try {
        const { user } = await api.get('/auth/me');
        if (cancelled) return;
        setUser(user);
        writeCachedUser(user);
        setOffline(false);
      } catch (err) {
        if (cancelled) return;
        if (err.isNetwork) {
          // Offline — KEEP the session. This was the logout bug.
          setOffline(true);
        } else if (err.status === 401) {
          // api.js already tried to refresh; a 401 here means it truly failed.
          endSession();
        }
        // Any other error (500, etc.) is not an auth problem — stay logged in.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [endSession]);

  // Proactively refresh the access token well before it expires so a long
  // counting session never hits an expired token at all.
  useEffect(() => {
    if (!user) return;
    const REFRESH_EVERY = 10 * 60 * 1000; // 10 min (access token lives 1h)
    async function tick() {
      if (!getRefreshToken()) return;
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: getRefreshToken() }),
        });
        if (res.ok) {
          const data = await res.json();
          setToken(data.token);
          setOffline(false);
        }
        // A non-ok response here is not fatal: the next real request will
        // attempt a refresh and only then decide the session is over.
      } catch {
        setOffline(true); // offline; keep the session
      }
    }
    refreshTimer.current = setInterval(tick, REFRESH_EVERY);
    // Also refresh when the tab regains focus / connectivity returns.
    const onFocus = () => tick();
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    return () => {
      clearInterval(refreshTimer.current);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onFocus);
    };
  }, [user]);

  async function login(username, password, remember) {
    const { token, refreshToken, user } = await api.post('/auth/login', { username, password });
    setToken(token);
    setRefreshToken(refreshToken);
    writeCachedUser(user);
    if (!remember) sessionStorage.setItem('audix_session_only', '1');
    setUser(user);
    setOffline(false);
    return user;
  }

  // Explicit user-initiated logout only. Drafts in localStorage are left
  // untouched so nothing typed is lost.
  //
  // Anything still queued is SENT FIRST, while the token is still valid. Signing
  // out with entries pending used to strand them on the login screen, where the
  // retry timer posted them without a token and the 401 destroyed them.
  async function logout() {
    if (pendingCount() > 0) {
      try { await flushQueue(); } catch { /* keep them queued; never block a logout */ }
    }
    endSession();
  }

  // Re-reads the profile from the server (used after a password change so the
  // must_change_password gate clears without a full re-login).
  async function refreshUser() {
    try {
      const { user: fresh } = await api.get('/auth/me');
      if (fresh) setUser(fresh);
      return fresh;
    } catch { return null; }
  }

  return (
    <AuthCtx.Provider value={{ user, loading, offline, login, logout, refreshUser }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  return useContext(AuthCtx);
}
