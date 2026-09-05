// Attendance history (Mobile M6) — the member's ✓/− calendar, month by
// month, behind the gym home's Attendance card ("View full history").
//
// Spec shape:
//   September 2026
//   1 ✓
//   2 ✓
//   3 -
//
// Server-authoritative, as everywhere in the gym section: the ✓/− calendar
// comes from GET /gym/my/attendance/history?days=365 (gym-local dates, one
// row per app-linked gym) and every row carries the gym's `today`, so the
// device clock and its timezone never influence what counts as visited.
// Streaks / totals / month grouping are pure display aggregation of those
// server facts (lib/gymState.attendanceStats) — eligibility stays
// server-side exactly as before.
//
// States: gym-context skeleton → LoadError retry → per-request skeleton →
// honest empties (no visits yet / months older than the fetched window are
// not listed rather than faked as all-minus).
import React, { useCallback, useMemo, useState } from 'react';
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
import { fetchMyGymAttendanceHistory } from '../lib/gymApi';
import {
  availableMonths,
  attendanceMonthRows,
  attendanceStats,
  monthLabel,
} from '../lib/gymState';
import { GYM_CHECK_IN } from '../shared/constants/routes';

export default function GymAttendanceScreen() {
  const colors = useColors();
  const navigation = useNavigation();
  const gym = useGym();
  const history = useAsyncData(() => fetchMyGymAttendanceHistory({ days: 365 }), []);

  useFocusEffect(
    useCallback(() => {
      history.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  const styles = makeStyles(colors);

  // the ACTIVE gym's slice (switcher chips when the member belongs to
  // several gyms — same language as the dashboard)
  const mine = useMemo(() => {
    const rows = Array.isArray(history.data) ? history.data : [];
    return rows.find((g) => g && g.gym_id === (gym.gym || {}).gym_id) || null;
  }, [history.data, gym.gym]);

  const months = useMemo(
    () => (mine ? availableMonths(mine.history, mine.today) : []),
    [mine]
  );

  const [pickedMonth, setPickedMonth] = useState(null);
  // selection survives until it leaves the fetched window; the current
  // month is always the honest default (it is always in the window)
  const effMonth =
    pickedMonth && months.includes(pickedMonth) ? pickedMonth : months[0] || null;

  const stats = useMemo(
    () => (mine ? attendanceStats(mine.history, mine.today) : null),
    [mine]
  );
  const dayRows = useMemo(
    () => (mine && effMonth ? attendanceMonthRows(mine.history, effMonth, mine.today) : []),
    [mine, effMonth]
  );

  const openCheckIn = () => navigation.navigate(GYM_CHECK_IN);

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
        <Ionicons name="calendar-outline" size={40} color={colors.textDim} />
        <Text style={styles.emptyTitle}>You&apos;re not connected to a gym yet.</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {Array.isArray(gym.memberships) && gym.memberships.length > 1 ? (
        <View style={styles.switcher}>
          {gym.memberships.map((m) => {
            const active = m.gym_id === gym.activeGymId;
            return (
              <TouchableOpacity
                key={`${m.gym_id}-${m.member_code}`}
                style={[styles.chip, active && { borderColor: colors.primary, backgroundColor: `${colors.primary}14` }]}
                onPress={() => gym.setActiveGymId(m.gym_id)}
                accessibilityRole="button"
                accessibilityLabel={`Show gym ${m.gym_name}`}
              >
                <Text numberOfLines={1} style={[styles.chipText, active && { color: colors.primary }]}>
                  {m.gym_name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      {history.loading && !history.data ? (
        <View style={styles.card}>
          <View style={{ gap: spacing.sm }}>
            {[44, 40, 42, 38].map((h, i) => (
              <View key={i} style={[styles.skeletonBar, { backgroundColor: colors.cardLight, height: h }]} />
            ))}
          </View>
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
          </View>
        </View>
      ) : history.error && !history.data ? (
        <LoadError message="Couldn't load your attendance history." onRetry={history.reload} />
      ) : !mine ? (
        <View style={styles.card}>
          <Text style={styles.emptyHint}>No attendance recorded for this gym yet.</Text>
        </View>
      ) : (
        <>
          {/* headline numbers — display aggregation of server facts */}
          <View style={styles.card}>
            <View style={styles.statRow}>
              <View style={styles.stat}>
                <Text style={styles.statValue}>{stats.thisMonth}</Text>
                <Text style={styles.statLabel}>this month</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statValue}>{stats.streak}</Text>
                <Text style={styles.statLabel}>day streak</Text>
              </View>
              <View style={styles.stat}>
                <Text style={styles.statValue}>{stats.total}</Text>
                <Text style={styles.statLabel}>visits total</Text>
              </View>
            </View>
            {stats.total === 0 ? (
              <>
                <Text style={styles.emptyHint}>
                  No visits recorded in the last 12 months. Checked in at the desk or finished a
                  workout there? Your gym records it — it shows up here.
                </Text>
                {gym.membership?.status === 'ACTIVE' ? (
                  <TouchableOpacity style={styles.checkInLink} onPress={openCheckIn}>
                    <Ionicons name="qr-code-outline" size={15} color={colors.primary} />
                    <Text style={styles.checkInLinkText}>Check in with QR</Text>
                  </TouchableOpacity>
                ) : null}
              </>
            ) : null}
          </View>

          {/* month chips — only months the fetched window covers */}
          {months.length > 1 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.monthStrip}
              contentContainerStyle={styles.monthStripContent}
            >
              {months.map((ym) => {
                const active = ym === effMonth;
                return (
                  <TouchableOpacity
                    key={ym}
                    style={[styles.chip, active && { borderColor: colors.primary, backgroundColor: `${colors.primary}14` }]}
                    onPress={() => setPickedMonth(ym)}
                    accessibilityRole="button"
                    accessibilityLabel={`Show ${monthLabel(ym) || ym}`}
                  >
                    <Text numberOfLines={1} style={[styles.chipText, active && { color: colors.primary }]}>
                      {monthLabel(ym) || ym}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          ) : null}

          {/* the month itself */}
          <View style={styles.card}>
            <Text style={styles.monthTitle}>{monthLabel(effMonth) || effMonth}</Text>
            {dayRows.map((r, i) => {
              const isToday = r.iso === mine.today;
              return (
                <View
                  key={r.iso}
                  style={[
                    styles.dayRow,
                    i === dayRows.length - 1 && { borderBottomWidth: 0 },
                    isToday && { backgroundColor: `${colors.primary}0F`, borderRadius: 10 },
                  ]}
                >
                  <Text style={[styles.dayNum, isToday && { color: colors.primary }]}>{r.day}</Text>
                  {r.state === 'present' ? (
                    <>
                      <Text style={styles.presentMark}>✓</Text>
                      {r.sourceLabel ? <Text style={styles.sourceTag}>{r.sourceLabel}</Text> : null}
                    </>
                  ) : (
                    <Text
                      style={
                        r.state === 'absent'
                          ? styles.absentMark
                          : styles.dimMark
                      }
                    >
                      {r.state === 'absent' ? '−' : '·'}
                    </Text>
                  )}
                  {isToday ? <Text style={styles.todayTag}>Today</Text> : null}
                </View>
              );
            })}
            <Text style={styles.meta}>
              Dates follow your gym&apos;s local calendar
              {months.length < 12 ? ` · history covers the last ${months.length} month${months.length === 1 ? '' : 's'}` : ''}
              .
            </Text>
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
  skeletonBar: { borderRadius: 10 },
  loadingRow: { alignItems: 'center', paddingTop: spacing.md },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg - 2,
    marginBottom: spacing.md,
  },
  statRow: { flexDirection: 'row', marginBottom: spacing.sm },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { color: colors.text, fontSize: 22, fontWeight: '800' },
  statLabel: { color: colors.textDim, fontSize: 11, fontWeight: '600', marginTop: 2 },
  emptyHint: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  checkInLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.sm + 2,
    alignSelf: 'flex-start',
  },
  checkInLinkText: { color: colors.primary, fontSize: 13, fontWeight: '700' },
  monthStrip: { marginBottom: spacing.md },
  monthStripContent: { gap: spacing.sm, paddingRight: spacing.lg },
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
  monthTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: spacing.xs },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: 8,
    paddingHorizontal: 6,
    marginHorizontal: -6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  dayNum: { color: colors.text, fontSize: 13, fontWeight: '700', width: 26 },
  presentMark: { color: colors.green || '#16A34A', fontSize: 15, fontWeight: '800', width: 22 },
  absentMark: { color: colors.textDim, fontSize: 15, fontWeight: '700', width: 22 },
  dimMark: { color: colors.border, fontSize: 15, fontWeight: '700', width: 22 },
  sourceTag: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '600',
    backgroundColor: colors.cardLight,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
    flex: 1,
    alignSelf: 'flex-start',
  },
  todayTag: {
    marginLeft: 'auto',
    color: colors.primary,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
  meta: { color: colors.textDim, fontSize: 11, lineHeight: 16, marginTop: spacing.sm + 2 },
});
