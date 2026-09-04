// My Gym — shown on the Profile tab for app-linked gym members (Phase 7):
//
//   My Gym
//   Premium Annual   [ACTIVE]
//   Valid until 31 Dec 2026
//
// Data comes from GET /gym/my/memberships (current plan term) and
// GET /gym/my/content (Phase 13 UNIFIED assigned + recommended gym content —
// one call for workouts AND nutrition; the diet strip on Diet home uses the
// same endpoint). A standalone user gets [] and the card renders nothing —
// a gym is never required. Assignment rows live on the gym member, so
// content assigned BEFORE the app account was linked shows up here too.
// Historical record integrity is unaffected by when the app account was
// linked: the term predating the link shows exactly the same.
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useColors } from '../theme';
import { GYM_CLASSES, GYM_DOCUMENTS } from '../shared/constants/routes';
import { api, fetchMyGymContent } from '../lib/gymApi';

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
  const navigation = useNavigation();
  const [memberships, setMemberships] = useState(null); // null = loading
  const [contentCounts, setContentCounts] = useState({});

  React.useEffect(() => {
    let cancelled = false;
    api('/gym/my/memberships')
      .then((rows) => { if (!cancelled) setMemberships(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setMemberships([]); });
    fetchMyGymContent()
      .then((perGym) => {
        if (cancelled || !Array.isArray(perGym)) return;
        const counts = {};
        for (const g of perGym) {
          counts[g.gym_id] = {
            workouts: (g.workouts?.assigned?.length || 0) + (g.workouts?.recommended?.length || 0),
            nutrition: (g.nutrition?.assigned?.length || 0) + (g.nutrition?.recommended?.length || 0),
          };
        }
        setContentCounts(counts);
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
              {contentCounts[m.gym_id]?.workouts ? (
                <Text style={[styles.gymMeta, { color: colors.primary }]}>
                  {contentCounts[m.gym_id].workouts} gym workout{contentCounts[m.gym_id].workouts > 1 ? 's' : ''} available
                </Text>
              ) : null}
              {contentCounts[m.gym_id]?.nutrition ? (
                <Text style={[styles.gymMeta, { color: colors.primary }]}>
                  {contentCounts[m.gym_id].nutrition} gym nutrition item{contentCounts[m.gym_id].nutrition > 1 ? 's' : ''} available
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
      {/* Gym Classes (Phase 17): the class schedule + one-tap booking */}
      <TouchableOpacity
        style={styles.classesRow}
        onPress={() => navigation.navigate(GYM_CLASSES)}
        accessibilityRole="button"
        accessibilityLabel="Open the class schedule"
      >
        <Ionicons name="calendar-outline" size={16} color={colors.primary} />
        <Text style={styles.classesText}>Classes</Text>
        <Text style={styles.classesHint}>Book your spot</Text>
        <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
      </TouchableOpacity>
      {/* Gym Documents (Phase 18): waivers & agreements + digital signing */}
      <TouchableOpacity
        style={styles.classesRow}
        onPress={() => navigation.navigate(GYM_DOCUMENTS)}
        accessibilityRole="button"
        accessibilityLabel="Open your gym documents"
      >
        <Ionicons name="document-text-outline" size={16} color={colors.primary} />
        <Text style={styles.classesText}>Documents</Text>
        <Text style={styles.classesHint}>Waivers & agreements</Text>
        <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
      </TouchableOpacity>
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
  classesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 6,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  classesText: { color: colors.text, fontSize: 13, fontWeight: '700', flex: 1 },
  classesHint: { color: colors.textDim, fontSize: 11 },
});
