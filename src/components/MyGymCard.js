// My Gym — shown on the Profile tab for app-linked gym members (Phase 5).
// Data comes from GET /gym/my/memberships, which resolves the caller's
// gym_members rows server-side; a standalone user gets [] and the card
// renders nothing (a gym is never required in the app). The historical
// membership record stays intact from before the app account was linked.
import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import { api } from '../lib/api';

const STATUS_COLORS = {
  ACTIVE: '#16A34A',
  PENDING: '#5856D6',
  FROZEN: '#D97706',
  EXPIRED: '#78716C',
  CANCELLED: '#DC2626',
};

export default function MyGymCard() {
  const colors = useColors();
  const [memberships, setMemberships] = useState(null); // null = loading

  React.useEffect(() => {
    let cancelled = false;
    api('/gym/my/memberships')
      .then((rows) => { if (!cancelled) setMemberships(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setMemberships([]); });
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
      {memberships.map((m) => (
        <View key={`${m.gym_id}-${m.member_code}`} style={styles.gymRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.gymName}>{m.gym_name}</Text>
            <Text style={styles.gymMeta}>
              Member {m.member_code}
              {m.joined_at ? ` · joined ${String(m.joined_at).slice(0, 10)}` : ''}
            </Text>
          </View>
          <View style={[styles.badge, { backgroundColor: `${STATUS_COLORS[m.status] || colors.textDim}22` }]}>
            <Text style={[styles.badgeText, { color: STATUS_COLORS[m.status] || colors.textDim }]}>
              {m.status}
            </Text>
          </View>
        </View>
      ))}
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
