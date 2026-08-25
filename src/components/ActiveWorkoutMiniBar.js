import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useNavigationState } from '@react-navigation/native';
import { useWorkout, elapsedSeconds, formatDuration } from '../store/WorkoutContext';
import { useColors } from '../theme';
import { lightImpact } from '../lib/haptics';
import { ACTIVE_WORKOUT, MAIN_TABS } from '../shared/constants/routes';

// Spotify-style persistent bar for an active workout. Rendered at the app
// root: visible on every screen while a workout is in progress or paused,
// hidden completely otherwise. Whole bar is tappable to expand into the full
// logging view; pause/resume work inline without expanding.
export default function ActiveWorkoutMiniBar() {
  const { workout, dispatch } = useWorkout();
  const colors = useColors();
  const navigation = useNavigation();
  const [tick, setTick] = useState(0);
  const slide = new Animated.Value(0);
  // True when the tab bar sits beneath us → offset the bar above it
  const overTabs = useNavigationState(
    (state) => state?.routes?.[state.index ?? 0]?.name === MAIN_TABS
  );
  // Hide while the full logging view (expanded state) is on screen
  const expanded = useNavigationState(
    (state) => state?.routes?.[state.index ?? 0]?.name === ACTIVE_WORKOUT
  );

  // live timer refresh
  useEffect(() => {
    if (!workout) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [!!workout, workout?.pausedAt]);

  if (!workout || expanded) return null; // no active workout / already expanded

  const paused = !!workout.pausedAt;
  const elapsed = elapsedSeconds(workout);
  const doneSets = workout.exercises.reduce(
    (n, e) => n + e.sets.filter((s) => s.completed).length,
    0
  );
  const accent = paused ? colors.textDim : colors.primary;

  const expand = () => {
    lightImpact();
    Animated.timing(slide, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    navigation.navigate(ACTIVE_WORKOUT);
  };

  const togglePause = () => {
    lightImpact();
    dispatch({ type: paused ? 'RESUME_WORKOUT' : 'PAUSE_WORKOUT' });
  };

  const discard = () => {
    dispatch({ type: 'CLEAR_WORKOUT' });
  };

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={expand}
      style={[styles.bar, { backgroundColor: colors.card, borderColor: colors.border, bottom: overTabs ? 92 : 8 }]}
    >
      <View style={[styles.accent, { backgroundColor: accent }]} />
      <View style={styles.info}>
        <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
          {workout.name}
        </Text>
        <Text style={[styles.meta, { color: colors.textDim }]}>
          {formatDuration(elapsed)} · {doneSets} sets{paused ? ' · paused' : ''}
        </Text>
      </View>
      <TouchableOpacity style={styles.ctrl} onPress={togglePause}>
        <Ionicons
          name={paused ? 'play' : 'pause'}
          size={22}
          color={colors.text}
        />
      </TouchableOpacity>
      {paused && (
        <TouchableOpacity style={styles.ctrl} onPress={discard}>
          <Ionicons name="close-circle-outline" size={22} color={colors.red} />
        </TouchableOpacity>
      )}
      <TouchableOpacity style={styles.ctrl} onPress={expand}>
        <Ionicons name="chevron-up" size={22} color={colors.textDim} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    borderWidth: 1,
    paddingLeft: 4,
    paddingRight: 6,
    paddingVertical: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 10,
  },
  accent: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  info: { flex: 1, marginLeft: 10 },
  name: { fontSize: 14, fontWeight: '800' },
  meta: { fontSize: 11, marginTop: 1 },
  ctrl: { padding: 8 },
});
