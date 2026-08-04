import { createContext, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      if (!getToken()) { setLoading(false); return; }
      try {
        const { user } = await api.get('/auth/me');
        setUser(user);
      } catch {
        setToken(null);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function login(username, password, remember) {
    const { token, user } = await api.post('/auth/login', { username, password });
    setToken(token);
    // "remember me" simply keeps the token in localStorage (default). If not
    // remembered we still store it for the session; a stricter impl could use
    // sessionStorage — kept simple here.
    if (!remember) sessionStorage.setItem('audix_session_only', '1');
    setUser(user);
    return user;
  }

  function logout() {
    setToken(null);
    setUser(null);
  }

  return (
    <AuthCtx.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  return useContext(AuthCtx);
}
