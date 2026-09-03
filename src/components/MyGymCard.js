// My Gym — shown on the Profile tab for app-linked gym members (Phase 7):
//
//   My Gym
//   Premium Annual   [ACTIVE]
//   Valid until 31 Dec 2026
//
// Data comes from GET /gym/my/memberships (current plan term) and
// GET /gym/my/workouts (assigned + recommended gym workouts — Phase 11).
// A standalone user gets [] and the card renders nothing — a gym is never
// required. Assignment rows live on the gym member, so workouts assigned
// BEFORE the app account was linked show up here too.
// Historical record integrity is unaffected by when the app account was
// linked: the term predating the link shows exactly the same.
import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import { api } from '../lib/api';

const STATUS_COLORS = {
  ACTIVE: '#16A34A',
  FROZEN: '#D97706',
  UPCOMING: '#5856D6',
  PENDING: '#5856D6',
  EXPIRED: '#78716C',
  CANCELLED: '#DC2626',
};

export default function MyGymCard() {
  const colors = useColors();
  const [memberships, setMemberships] = useState(null); // null = loading
  const [workoutCounts, setWorkoutCounts] = useState({});

  React.useEffect(() => {
    let cancelled = false;
    api('/gym/my/memberships')
      .then((rows) => { if (!cancelled) setMemberships(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setMemberships([]); });
    api('/gym/my/workouts')
      .then((perGym) => {
        if (cancelled || !Array.isArray(perGym)) return;
        const counts = {};
        for (const g of perGym) counts[g.gym_id] = (g.assigned?.length || 0) + (g.recommended?.length || 0);
        setWorkoutCounts(counts);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!memberships || memberships.length === 0) return null; // standalone user

  const styles = makeStyles(colors);
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Ionicons name="business-outline" size={16} color={colors.primary} />
        <Text style={styles.title}>My Gym</Text>
      </View>
      {memberships.map((m) => {
        // membership term status (ACTIVE/FROZEN/…) is what matters to the
        // member; fall back to the membership-record status when no term exists
        const status = m.membership_status || m.status;
        const frozen = status === 'FROZEN';
        return (
          <View key={`${m.gym_id}-${m.member_code}`} style={styles.gymRow}>
            <View style={{ flex: 1 }}>
              {m.plan_name ? (
                <Text style={styles.gymName}>{m.plan_name}</Text>
              ) : (
                <Text style={styles.gymName}>{m.gym_name}</Text>
              )}
              <Text style={styles.gymMeta}>
                {m.gym_name} · Member {m.member_code}
              </Text>
              {m.ends_on ? (
                <Text style={styles.gymMeta}>
                  {frozen ? 'Frozen — valid until' : 'Valid until'} {String(m.ends_on).slice(0, 10)}
                </Text>
              ) : null}
              {workoutCounts[m.gym_id] ? (
                <Text style={[styles.gymMeta, { color: colors.primary }]}>
                  {workoutCounts[m.gym_id]} gym workout{workoutCounts[m.gym_id] > 1 ? 's' : ''} available
                </Text>
              ) : null}
            </View>
            <View style={[styles.badge, { backgroundColor: `${STATUS_COLORS[status] || colors.textDim}22` }]}>
              <Text style={[styles.badgeText, { color: STATUS_COLORS[status] || colors.textDim }]}>
                {status}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 12,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  title: { color: colors.text, fontSize: 13, fontWeight: '800', letterSpacing: 0.3 },
  gymRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  gymName: { color: colors.text, fontSize: 14, fontWeight: '700' },
  gymMeta: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
});
