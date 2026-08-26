import { useEffect, useState } from 'react';

// Palette: warm "effort/ember" system — ember primary, warm charcoal/paper
// neutrals, amber reserved for the streak. Functional colors stay familiar.
export const defaultColors = {
  bg: '#FAF8F5',
  card: '#FFFFFF',
  cardLight: '#F0EDE8',
  border: '#E5E0D8',
  primary: '#E8481F',
  primaryDark: '#C43A15',
  text: '#1C1917',
  textDim: '#78716C',
  green: '#16A34A',
  blue: '#5856D6',
  red: '#DC2626',
  orange: '#EA580C',
  yellow: '#D97706', // amber in light mode
};

export const darkColors = {
  bg: '#141210',
  card: '#1E1B18',
  cardLight: '#2A2622',
  border: '#322D28',
  primary: '#FF5A36',
  primaryDark: '#E8481F',
  text: '#F5F1EC',
  textDim: '#8A8578',
  green: '#30D158',
  blue: '#5E5CE6',
  red: '#FF453A',
  orange: '#FF9F0A',
  yellow: '#FFB020', // amber in dark mode
};

export function getColors(isDark) {
  return isDark ? darkColors : defaultColors;
}

export const colors = darkColors;

// Spacing scale — 4pt grid. Use for margins/padding/gaps instead of magic
// numbers in new code; existing styles migrate opportunistically.
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
};

// ---- Live palette store -------------------------------------------------
// useColors() must return the palette matching the app's current theme mode,
// not a fixed one. AppContext calls setPalette() whenever the resolved theme
// changes; every useColors() consumer re-renders with the new palette.
let currentPalette = darkColors; // app renders dark-first (see app.json)
const listeners = new Set();

export function setPalette(isDark) {
  const next = isDark ? darkColors : defaultColors;
  if (next === currentPalette) return;
  currentPalette = next;
  listeners.forEach((l) => l(next));
}

export function useColors() {
  const [colors, setLocal] = useState(currentPalette);
  useEffect(() => {
    listeners.add(setLocal);
    // sync in case the palette changed between render and effect
    setLocal(currentPalette);
    return () => listeners.delete(setLocal);
  }, []);
  return colors;
}