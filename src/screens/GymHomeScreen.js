// Gym home — the member's gym hub (Mobile M1 foundation, revised M1.1/M2).
//
// A calm, read-only home for the member's gym life: who the gym is, an
// attendance summary, and the gym's own program content — workouts and
// nutrition the gym assigned or recommended to THIS member. Tapping a
// workout opens its full detail (start it or add it to your routines);
// tapping a nutrition item opens its detail (log it to a meal or save it
// to My Dishes) — both ride the existing workout/diet infrastructure.
//
// M2 de-duplication: the Membership card was removed (MyGymCard on the
// Profile tab, right above this screen's entry point, already shows plan/
// status/validity), and the Classes / Documents / Notifications rows were
// removed — Classes and Documents stay reachable from MyGymCard, and
// notifications have their own section (the header bell). Underlying
// functionality is untouched; only the duplicate entry points are gone.
//
// M1.1: this screen is a shared-pool screen (registered in every tab stack
// like GymClasses/GymDocuments) pushed from MyGymCard on the Profile tab.
// The pool's default headerRight provides the standard bell + gear pair.
//
// Membership/attendance state comes from GymContext (one server-
// authoritative snapshot shared with MyGymCard); program content comes
// from GET /gym/my/content, sliced to the active gym. Nothing here passes
// a gym id anywhere: authorization is server-side, resolved from the JWT.
//
// Standalone users cannot reach this screen (the only entry is MyGymCard,
// which renders nothing without a gym), but it still handles the empty
// state gracefully for safety — e.g. a membership cancelled mid-flight.
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
import { statusColor } from '../lib/gymState';
import { fetchMyGymContent } from '../lib/gymApi';
import { workoutMetaLine, GYM_NUTRITION_KIND_LABELS } from '../lib/gymContent';
import { GYM_WORKOUT_DETAIL, GYM_NUTRITION_DETAIL } from '../shared/constants/routes';

export default function GymHomeScreen() {
  const colors = useColors();
  const navigation = useNavigation();
  const {
    loading,
    error,
    reload,
    hasGym,
    memberships,
    gym,
    gymMember,
    membership,
    attendance,
    activeGymId,
    setActiveGymId,
  } = useGym();
  // program content — one call covers every gym; sliced to the active one
  const content = useAsyncData(() => fetchMyGymContent(), []);

  // refresh whenever this screen becomes visible again (terms/attendance move)
  useFocusEffect(
    useCallback(() => {
      reload();
      content.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reload])
  );

  const styles = makeStyles(colors);

  const activeContent = useMemo(() => {
    const rows = Array.isArray(content.data) ? content.data : [];
    return rows.find((g) => g && g.gym_id === (gym || {}).gym_id) || null;
  }, [content.data, gym]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (error) {
    return <LoadError message="Couldn't load your gym." onRetry={reload} />;
  }
  if (!hasGym || !gym) {
    // Defensive: standalone users cannot get here (MyGymCard renders
    // nothing for them); if we still land here (membership cancelled
    // mid-session), show the graceful state.
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Ionicons name="business-outline" size={40} color={colors.textDim} />
        <Text style={styles.emptyTitle}>You&apos;re not connected to a gym yet.</Text>
        <Text style={styles.emptyBody}>
          When your gym links your membership to this account, it will show up here.
        </Text>
      </View>
    );
  }

  // membership-term status is what matters to the member; fall back to the
  // membership-record status when no term exists (same rule as MyGymCard)
  const status = membership?.status || gym.status;
  const badgeColor = statusColor(status, colors.textDim);
  const multiGym = memberships.length > 1;

  const workouts = [
    ...(activeContent?.workouts?.assigned || []).map((w) => ({ w, tag: 'Assigned' })),
    ...(activeContent?.workouts?.recommended || []).map((w) => ({ w, tag: 'Recommended' })),
  ];
  const nutrition = [
    ...(activeContent?.nutrition?.assigned || []).map((n) => ({ n, tag: 'Assigned' })),
    ...(activeContent?.nutrition?.recommended || []).map((n) => ({ n, tag: 'Recommended' })),
  ];

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {multiGym && (
        <View style={styles.switcher}>
          {memberships.map((m) => {
            const active = m.gym_id === activeGymId;
            return (
              <TouchableOpacity
                key={`${m.gym_id}-${m.member_code}`}
                style={[styles.chip, active && { borderColor: colors.primary, backgroundColor: `${colors.primary}14` }]}
                onPress={() => setActiveGymId(m.gym_id)}
                accessibilityRole="button"
                accessibilityLabel={`Show gym ${m.gym_name}`}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.chipText, active && { color: colors.primary }]}
                >
                  {m.gym_name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* gym identity */}
      <View style={styles.card}>
        <View style={styles.gymHeader}>
          <View style={[styles.gymBadgeWrap, { backgroundColor: `${colors.primary}18` }]}>
            <Ionicons name="barbell" size={18} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.gymName} numberOfLines={1}>{gym.gym_name}</Text>
            <Text style={styles.meta}>
              Member {gymMember?.member_code}
              {gym.joined_at ? ` · since ${String(gym.joined_at).slice(0, 10)}` : ''}
            </Text>
          </View>
          <View style={[styles.badge, { backgroundColor: `${badgeColor}22` }]}>
            <Text style={[styles.badgeText, { color: badgeColor }]}>{status}</Text>
          </View>
        </View>
      </View>

      {/* attendance summary — read-only by design in the foundation phase */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Attendance</Text>
        {attendance ? (
          <View style={styles.statRow}>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{attendance.visits7}</Text>
              <Text style={styles.statLabel}>last 7 days</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statValue}>{attendance.visits30}</Text>
              <Text style={styles.statLabel}>last 30 days</Text>
            </View>
            <View style={styles.stat}>
              <Text style={[styles.statValue, { fontSize: 13, paddingTop: 6 }]}>
                {attendance.lastVisit ? String(attendance.lastVisit).slice(0, 10) : '—'}
              </Text>
              <Text style={styles.statLabel}>last visit</Text>
            </View>
          </View>
        ) : (
          <Text style={styles.meta}>No attendance in the last 90 days.</Text>
        )}
      </View>

      {/* program content — shared loader state for both sections; keep the
          lists on screen while a background refetch runs */}
      {content.loading && !content.data ? (
        <View style={styles.contentLoading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : content.error && !content.data ? (
        <LoadError message="Couldn't load your gym's programs." onRetry={content.reload} />
      ) : (
        <>
          {/* gym workouts */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Gym Workouts</Text>
            {workouts.length === 0 ? (
              <Text style={styles.emptyHint}>
                Nothing right now — programs your gym assigns or recommends will appear here.
              </Text>
            ) : (
              workouts.map(({ w, tag }, i) => (
                <TouchableOpacity
                  key={`${tag}-${w.id}`}
                  style={[styles.row, i === workouts.length - 1 && { borderBottomWidth: 0 }]}
                  onPress={() => navigation.navigate(GYM_WORKOUT_DETAIL, {
                    workout: w,
                    gymName: gym.gym_name,
                    tag,
                  })}
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
                  <Text style={[styles.rowTag, { color: tag === 'Assigned' ? colors.primary : colors.textDim }]}>
                    {tag}
                  </Text>
                  <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
                </TouchableOpacity>
              ))
            )}
          </View>

          {/* gym nutrition */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Gym Nutrition</Text>
            {nutrition.length === 0 ? (
              <Text style={styles.emptyHint}>
                Nothing right now — recipes and diet guides from your gym will appear here.
              </Text>
            ) : (
              nutrition.map(({ n, tag }, i) => (
                <TouchableOpacity
                  key={`${tag}-${n.id}`}
                  style={[styles.row, i === nutrition.length - 1 && { borderBottomWidth: 0 }]}
                  onPress={() => navigation.navigate(GYM_NUTRITION_DETAIL, {
                    item: n,
                    gymName: gym.gym_name,
                    tag,
                  })}
                  accessibilityRole="button"
                  accessibilityLabel={`Open gym nutrition ${n.title}`}
                >
                  <Ionicons name="restaurant-outline" size={16} color={colors.primary} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowText} numberOfLines={1}>{n.title}</Text>
                    <Text style={styles.rowHint} numberOfLines={1}>
                      {[
                        GYM_NUTRITION_KIND_LABELS[n.kind] || n.kind,
                        n.targets?.calories != null ? `${n.targets.calories} kcal` : null,
                      ].filter(Boolean).join(' · ')}
                    </Text>
                  </View>
                  <Text style={[styles.rowTag, { color: tag === 'Assigned' ? colors.primary : colors.textDim }]}>
                    {tag}
                  </Text>
                  <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
                </TouchableOpacity>
              ))
            )}
          </View>
        </>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: spacing.md, textAlign: 'center' },
  emptyBody: { color: colors.textDim, fontSize: 13, marginTop: spacing.sm, textAlign: 'center', lineHeight: 19 },
  switcher: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  chip: {
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: colors.card,
    maxWidth: '100%',
  },
  chipText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg - 2,
    marginBottom: spacing.md,
  },
  cardTitle: { color: colors.text, fontSize: 13, fontWeight: '800', letterSpacing: 0.3, marginBottom: spacing.sm },
  gymHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  gymBadgeWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gymName: { color: colors.text, fontSize: 17, fontWeight: '800' },
  meta: { color: colors.textDim, fontSize: 12, marginTop: 3 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  statRow: { flexDirection: 'row' },
  stat: { flex: 1, alignItems: 'flex-start' },
  statValue: { color: colors.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  contentLoading: { padding: spacing.xl, alignItems: 'center' },
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
  rowTag: { fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  emptyHint: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
});
