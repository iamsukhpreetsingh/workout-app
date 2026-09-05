// Gym Workouts — the full program list behind the member home's
// "Gym Recommended → View Workouts" entry point (Mobile M5).
//
// The dashboard card only shows counts + this entry; the list itself lives
// here so the home stays a dashboard instead of becoming an endless feed
// (the same split the Classes/Documents screens already follow). Rows open
// the SAME detail screen the home used before (GYM_WORKOUT_DETAIL), so
// start-it / save-to-library behavior is untouched.
//
// Data: GET /gym/my/content (one call, sliced to the ACTIVE gym from
// GymContext — never a client-sent gym id). Assigned rows are the gym's
// direct assignments (window-aware server-side); Recommended rows are the
// gym's published recommendations and require an ACTIVE membership term —
// an expired member simply sees fewer rows, never a crash.
import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useColors, spacing } from '../theme';
import LoadError from '../shared/components/LoadError';
import useAsyncData from '../shared/hooks/useAsyncData';
import { useGym } from '../store/GymContext';
import { fetchMyGymContent } from '../lib/gymApi';
import { workoutMetaLine } from '../lib/gymContent';
import { GYM_WORKOUT_DETAIL } from '../shared/constants/routes';

export default function GymWorkoutsScreen() {
  const colors = useColors();
  const navigation = useNavigation();
  const gym = useGym();
  const content = useAsyncData(() => fetchMyGymContent(), []);

  // counts go stale after the gym edits content — refresh on every focus
  useFocusEffect(
    useCallback(() => {
      content.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  const styles = makeStyles(colors);

  const sections = useMemo(() => {
    const rows = Array.isArray(content.data) ? content.data : [];
    const mine = rows.find((g) => g && g.gym_id === (gym.gym || {}).gym_id) || null;
    return {
      assigned: mine?.workouts?.assigned || [],
      recommended: mine?.workouts?.recommended || [],
    };
  }, [content.data, gym.gym]);

  if (gym.loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (gym.error) {
    return <LoadError message="Couldn't load your gym." onRetry={gym.reload} />;
  }
  if (!gym.hasGym || !gym.gym) {
    // Defensive: the only entry is the gym home, which standalone users
    // cannot reach — but a mid-session membership cancellation can still
    // land here. Stay graceful, never fake data.
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Ionicons name="barbell-outline" size={40} color={colors.textDim} />
        <Text style={styles.emptyTitle}>You&apos;re not connected to a gym yet.</Text>
      </View>
    );
  }

  const openWorkout = (w, tag) =>
    navigation.navigate(GYM_WORKOUT_DETAIL, {
      workout: w,
      gymName: gym.gym.gym_name,
      tag,
    });

  const renderSection = (label, rows, tag) => (
    <View style={styles.card}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{label}</Text>
        <Text style={styles.sectionCount}>{rows.length}</Text>
      </View>
      {rows.length === 0 ? (
        <Text style={styles.emptyHint}>
          {label === 'Assigned'
            ? 'Workouts your gym assigns to you will appear here.'
            : 'Programs your gym recommends will appear here.'}
        </Text>
      ) : (
        rows.map((w, i) => (
          <TouchableOpacity
            key={`${tag}-${w.id}`}
            style={[styles.row, i === rows.length - 1 && { borderBottomWidth: 0 }]}
            onPress={() => openWorkout(w, tag)}
            accessibilityRole="button"
            accessibilityLabel={`Open gym workout ${w.title}`}
          >
            <Ionicons name="barbell-outline" size={16} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowText} numberOfLines={1}>{w.title}</Text>
              <Text style={styles.rowHint} numberOfLines={1}>
                {workoutMetaLine(w) || 'Gym program'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
          </TouchableOpacity>
        ))
      )}
    </View>
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {content.loading && !content.data ? (
        <View style={styles.card}>
          <SkeletonRows colors={colors} />
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
          </View>
        </View>
      ) : content.error && !content.data ? (
        <LoadError message="Couldn't load your gym's workouts." onRetry={content.reload} />
      ) : (
        <>
          {renderSection('Assigned', sections.assigned, 'Assigned')}
          {renderSection('Recommended', sections.recommended, 'Recommended')}
        </>
      )}
    </ScrollView>
  );
}

// static placeholder bars — the "shape of what's coming" while /my/content
// is in flight (matches the dashboard's loading language)
function SkeletonRows({ colors }) {
  const styles = makeStyles(colors);
  return (
    <View style={{ gap: spacing.sm }}>
      {[54, 40, 46].map((h, i) => (
        <View
          key={i}
          style={[styles.skeletonBar, { backgroundColor: colors.cardLight, height: h }]}
        />
      ))}
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: spacing.md, textAlign: 'center' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg - 2,
    marginBottom: spacing.md,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  sectionTitle: { color: colors.text, fontSize: 13, fontWeight: '800', letterSpacing: 0.3, flex: 1 },
  sectionCount: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: colors.cardLight,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  emptyHint: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  skeletonBar: { borderRadius: 10 },
  loadingRow: { alignItems: 'center', paddingTop: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  rowHint: { color: colors.textDim, fontSize: 11, marginTop: 1, textTransform: 'capitalize' },
});
