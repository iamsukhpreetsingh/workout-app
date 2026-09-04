// Gym Classes — the member-facing class schedule (Phase 17).
//
// Shown from Profile → My Gym → Classes. Lists upcoming SCHEDULED classes
// across the member's ACTIVE gym memberships (branch-filtered server-side
// to what the member can access), with trainer, time, spots left and the
// member's own booking status. Booking is one tap: BOOKED, or WAITLISTED
// when the class is full (FIFO promotion frees nothing here — the gym
// promotes members as seats free up). Cancelling a seat hands it to the
// first waitlisted member.
import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useColors, spacing } from '../theme';
import useAsyncData from '../shared/hooks/useAsyncData';
import LoadError from '../shared/components/LoadError';
import { fetchMyGymClasses, bookGymClass, cancelMyGymClassBooking } from '../lib/gymApi';

const STATUS_COLORS = {
  BOOKED: '#16A34A',
  ATTENDED: '#5856D6',
  WAITLISTED: '#D97706',
  NO_SHOW: '#DC2626',
  CANCELLED: '#78716C',
};

function formatDate(iso) {
  // iso = YYYY-MM-DD (gym-local schedule date)
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export default function GymClassesScreen() {
  const colors = useColors();
  const [busyId, setBusyId] = useState(null);
  const { data, loading, error, reload } = useAsyncData(fetchMyGymClasses, []);

  // refresh whenever the tab becomes visible again (bookings may have changed)
  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  const classes = Array.isArray(data) ? data : [];

  const doBook = (cls) => {
    setBusyId(cls.id);
    bookGymClass(cls.id)
      .then((r) => {
        if (r?.status === 'WAITLISTED') {
          Alert.alert(
            'Class is full',
            r.waitlist_position
              ? `You are #${r.waitlist_position} on the waitlist. We will hold your spot in order.`
              : 'You are on the waitlist.',
          );
        } else {
          Alert.alert('Booked', 'Your spot is confirmed. See you there!');
        }
        reload();
      })
      .catch((e) => Alert.alert('Could not book', e?.message || 'Please try again.'))
      .finally(() => setBusyId(null));
  };

  const doCancel = (cls) => {
    Alert.alert(
      'Cancel your spot?',
      cls.my_status === 'WAITLISTED'
        ? 'You will leave the waitlist.'
        : 'Your seat goes to the first member on the waitlist.',
      [
        { text: 'Keep it', style: 'cancel' },
        {
          text: 'Cancel booking',
          style: 'destructive',
          onPress: () => {
            setBusyId(cls.id);
            cancelMyGymClassBooking(cls.id)
              .then(() => reload())
              .catch((e) => Alert.alert('Could not cancel', e?.message || 'Please try again.'))
              .finally(() => setBusyId(null));
          },
        },
      ],
    );
  };

  const styles = makeStyles(colors);

  if (loading && !classes.length) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (error) {
    return <LoadError message="Couldn't load the class schedule." onRetry={reload} />;
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={classes}
        keyExtractor={(c) => c.id}
        refreshing={loading && classes.length > 0}
        onRefresh={reload}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="calendar-outline" size={40} color={colors.textDim} />
            <Text style={styles.emptyTitle}>No upcoming classes</Text>
            <Text style={styles.emptyBody}>
              Your gym has not scheduled anything yet. Check back soon.
            </Text>
          </View>
        }
        renderItem={({ item: c }) => {
          const spotsLeft = Math.max(c.capacity - (c.booked_count || 0), 0);
          const full = spotsLeft === 0;
          const mine = c.my_status; // BOOKED | ATTENDED | WAITLISTED | undefined
          const held = mine === 'BOOKED' || mine === 'WAITLISTED';
          return (
            <View style={styles.card}>
              <View style={styles.topRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.type}>{c.class_type}</Text>
                  <Text style={styles.meta}>
                    {formatDate(c.class_date)} · {String(c.start_time).slice(0, 5)}–{String(c.end_time).slice(0, 5)}
                  </Text>
                  <Text style={styles.meta}>
                    {c.gym_name}
                    {c.trainer_name ? ` · ${c.trainer_name}` : ''}
                    {c.branch_name ? ` · ${c.branch_name}` : ''}
                    {c.room ? ` · ${c.room}` : ''}
                  </Text>
                </View>
                {mine ? (
                  <View style={[styles.badge, { backgroundColor: `${STATUS_COLORS[mine] || colors.textDim}22` }]}>
                    <Text style={[styles.badgeText, { color: STATUS_COLORS[mine] || colors.textDim }]}>
                      {mine === 'WAITLISTED' ? 'WAITLIST' : mine}
                    </Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.bottomRow}>
                <Text style={[styles.spots, { color: full ? colors.red : colors.green }]}>
                  {full ? 'Class full' : `${spotsLeft} spot${spotsLeft > 1 ? 's' : ''} left`}
                </Text>
                {busyId === c.id ? (
                  <ActivityIndicator color={colors.primary} />
                ) : held ? (
                  <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={() => doCancel(c)}>
                    <Text style={[styles.btnText, { color: colors.red }]}>
                      {mine === 'WAITLISTED' ? 'Leave waitlist' : 'Cancel booking'}
                    </Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary }]} onPress={() => doBook(c)}>
                    <Text style={[styles.btnText, { color: '#FFFFFF' }]}>Book</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
        }}
      />
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: spacing.md },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  type: { color: colors.text, fontSize: 16, fontWeight: '800' },
  meta: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  bottomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  spots: { fontSize: 12, fontWeight: '700' },
  btn: { paddingHorizontal: spacing.lg, paddingVertical: 8, borderRadius: 10 },
  btnGhost: { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  btnText: { fontSize: 13, fontWeight: '800' },
  empty: { alignItems: 'center', paddingTop: 80, paddingHorizontal: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: spacing.md },
  emptyBody: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: spacing.xs },
});
