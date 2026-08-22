import React, { createContext, useContext, useState, useEffect } from 'react';
import { useColorScheme } from 'react-native';
import { getSettings, updateSettings } from '../db/settings';
import { getColors, setPalette } from '../theme';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [weightUnit, setWeightUnit] = useState('kg');
  const [themeMode, setThemeModeState] = useState('system');
  const [hapticsEnabled, setHapticsEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const systemColor = useColorScheme();

  useEffect(() => {
    getSettings().then(s => {
      setWeightUnit(s.weight_unit || 'kg');
      setThemeModeState(s.theme_mode || 'system');
      setHapticsEnabled(s.haptics_enabled !== 0);
      setLoaded(true);
    });
  }, []);

  const isDark = themeMode === 'dark' || (themeMode === 'system' && systemColor === 'dark');
  const colors = getColors(isDark);

  // Push the resolved palette to every useColors() consumer (screens,
  // components) so the whole app restyles together — nav chrome uses
  // `colors` from this context directly.
  useEffect(() => {
    setPalette(isDark);
  }, [isDark]);

  // Persist + apply live so switching theme in Settings updates the app
  // without a restart.
  const setThemeMode = (mode) => {
    setThemeModeState(mode);
    updateSettings({ theme_mode: mode }).catch(() => {});
  };

  const value = {
    colors,
    isDark,
    weightUnit,
    setWeightUnit: (unit) => setWeightUnit(unit),
    themeMode,
    setThemeMode,
    hapticsEnabled,
    setHapticsEnabled: (enabled) => setHapticsEnabled(enabled),
    loaded,
  };

  return (
    <AppContext.Provider value={value}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside AppProvider');
  return ctx;
}
