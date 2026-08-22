import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import { api, registerTokenHooks, tryRefresh } from '../lib/api';
import { clearViewChoice } from '../lib/viewMode';
import { setCurrentUserId } from '../db/queries';
import { pullFromCloud } from '../lib/sync';
import { getSyncSettings } from '../lib/sync';
import { hasUnsyncedBackupData } from '../lib/localOnly';
import { Alert } from 'react-native';

// Hard auth gate for the whole app. authStatus:
//   'checking'        → splash while restoring the session
//   'unauthenticated' → login/signup stack
//   'authenticated'   → main app (tabs + mini-bar)
const AuthContext = createContext(null);

const KEY_ACCESS = 'wt_access_token';
const KEY_REFRESH = 'wt_refresh_token';
const KEY_USER = 'wt_user';

async function readJson(key) {
  try {
    const v = await SecureStore.getItemAsync(key);
    return v ? JSON.parse(v) : null;
  } catch {
    return null;
  }
}

async function writeJson(key, value) {
  try {
    await SecureStore.setItemAsync(key, JSON.stringify(value));
  } catch {
    // secure store unavailable — treat as logged out on next launch
  }
}

async function clearTokens() {
  try {
    await SecureStore.deleteItemAsync(KEY_ACCESS);
    await SecureStore.deleteItemAsync(KEY_REFRESH);
    await SecureStore.deleteItemAsync(KEY_USER);
  } catch {
    // ignore
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authStatus, setAuthStatus] = useState('checking');

  const applySession = useCallback(async (userData, accessToken, refreshToken) => {
    await writeJson(KEY_ACCESS, accessToken);
    await writeJson(KEY_REFRESH, refreshToken);
    await writeJson(KEY_USER, userData);
    setUser(userData);
    setCurrentUserId(userData.id);
    setAuthStatus('authenticated');
    
    // Pull data from cloud after successful login
    try {
      const result = await pullFromCloud();
      console.log('[AUTH] Pulled from cloud:', result);
    } catch (e) {
      console.log('[AUTH] Pull from cloud failed (non-fatal):', e.message);
    }
  }, []);

  // Launch sequence: splash → check stored tokens → silent refresh if
  // possible → main app, else login screen.
  useEffect(() => {
    (async () => {
      const storedUser = await readJson(KEY_USER);
      const access = await readJson(KEY_ACCESS);
      const refresh = await readJson(KEY_REFRESH);
      if (storedUser?.id) {
        setCurrentUserId(storedUser.id);
      }
      if (!refresh) {
        setAuthStatus('unauthenticated');
        return;
      }
      if (access) {
        // optimistic: verify against /me, refresh on 401 handled by api()
        try {
          await writeJson(KEY_ACCESS, access);
          const me = await api('/me');
          setUser(me);
          setCurrentUserId(me.id);
          setAuthStatus('authenticated');
          // Pull data from cloud after session restore
          pullFromCloud().catch(e => console.log('[AUTH] Pull failed:', e.message));
          return;
        } catch {
          // fall through to refresh attempt
        }
      }
      const ok = await tryRefresh();
      if (ok) {
        try {
          const me = await api('/me');
          setUser(me);
          setCurrentUserId(me.id);
          setAuthStatus('authenticated');
          // Pull data from cloud after session restore
          pullFromCloud().catch(e => console.log('[AUTH] Pull failed:', e.message));
          return;
        } catch {
          // fall through
        }
      }
      await clearTokens();
      setAuthStatus('unauthenticated');
    })();
  }, []);

  // Wire the api wrapper to our tokens
  useEffect(() => {
    registerTokenHooks({
      getAccessToken: async () => (await readJson(KEY_ACCESS)) || null,
      getRefreshToken: async () => (await readJson(KEY_REFRESH)) || null,
      onRefreshed: async (access, refresh) => {
        await writeJson(KEY_ACCESS, access);
        await writeJson(KEY_REFRESH, refresh);
      },
      onAuthFailed: () => {
        clearTokens();
        setUser(null);
        setAuthStatus('unauthenticated');
      },
    });
  }, []);

  const login = useCallback(
    async (email, password) => {
      const data = await api('/auth/login', { method: 'POST', body: { email, password }, skipAuth: true });
      await applySession(data.user, data.accessToken, data.refreshToken);
      return data.user;
    },
    [applySession]
  );

  const signup = useCallback(
    async (payload) => {
      const data = await api('/auth/signup', { method: 'POST', body: payload, skipAuth: true });
      await applySession(data.user, data.accessToken, data.refreshToken);
      return data.user;
    },
    [applySession]
  );

  // const logout = useCallback(async () => {

      const logout = useCallback(async () => {
    // System 7 #4: blocking confirmation when local_only + genuinely
    // unsynced data exists (local data is NOT deleted on same-device
    // logout — the warning corrects the "data follows the account" assumption)
    try {
      const settings = await getSyncSettings();
      if (settings.sync_mode === 'local' && (await hasUnsyncedBackupData())) {
        const proceed = await new Promise((resolve) => {
          Alert.alert(
            'Unsynced local-only data',
            'You have local-only data that has never been backed up. Logging out will not delete it from this device, but if you log in again on a different device, this data will not be there. Continue?',
            [
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
              { text: 'Continue', style: 'destructive', onPress: () => resolve(true) },
            ],
            { cancelable: true }
          );
        });
        if (!proceed) return;
      }
    } catch { /* warning is best-effort; logout proceeds */ }
    // logging out clears the trainer's persisted view choice — they choose
    // again on next login
    clearViewChoice();
    try {
      const refresh = await readJson(KEY_REFRESH);
      await api('/auth/logout', { method: 'POST', body: { refreshToken: refresh }, skipAuth: true });
    } catch {
      // best-effort server-side revoke; local clear happens regardless
    }
    await clearTokens();
    setUser(null);
    setCurrentUserId(null);
    setAuthStatus('unauthenticated');
  }, []);

  return (
    <AuthContext.Provider value={{ user, authStatus, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
