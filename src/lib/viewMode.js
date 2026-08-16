// Persisted "last selected view" for trainer-role accounts.
// Stored in SecureStore alongside auth state; cleared on logout so a trainer
// is asked again on next login.
import * as SecureStore from 'expo-secure-store';

const KEY = 'wt_trainer_view';

// 'trainer' | 'user' | null
export async function getViewChoice() {
  try {
    return await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

export async function setViewChoice(mode) {
  try {
    if (mode) await SecureStore.setItemAsync(KEY, mode);
    else await SecureStore.deleteItemAsync(KEY);
  } catch {
    // best-effort persistence
  }
}

export async function clearViewChoice() {
  return setViewChoice(null);
}
