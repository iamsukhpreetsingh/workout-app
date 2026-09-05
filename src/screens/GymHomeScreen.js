// Gym home — the member's gym hub (Mobile M1 foundation, revised M1.1).
//
// A calm, read-only home for the member's gym life: who the gym is, what
// their membership term looks like, an attendance summary and doors into
// the gym features that already exist (Classes, Documents, Notifications).
// Deliberately NO new feature surfaces here — payments, attendance marking,
// class booking and content browsing stay in their own screens/phases; this
// screen only links to things that work today.
//
// M1.1: this screen is NO LONGER a tab root. It is a shared-pool screen
// (registered in every tab stack like GymClasses/GymDocuments) pushed from
// MyGymCard on the Profile tab. The pool's default headerRight already
// provides the standard bell + gear pair, so no useHeaderActions here.
//
// State comes from GymContext (one server-authoritative snapshot shared
// with MyGymCard) — this screen never fetches on its own and never passes
// a gym id anywhere: authorization is server-side, resolved from the JWT.
//
// Standalone users cannot reach this screen (the only entry is MyGymCard,
// which renders nothing without a gym), but it still handles the empty
// state gracefully for safety — e.g. a membership cancelled mid-flight.
import React, { useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useFocusEffect } from '@react-navigation/native';
import { useColors, spacing } from '../theme';
import LoadError from '../shared/components/LoadError';
import { useGym } from '../store/GymContext';
import { statusColor } from '../lib/gymState';
import { GYM_CLASSES, GYM_DOCUMENTS, NOTIFICATION_CENTER } from '../shared/constants/routes';

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
    notificationsUnread,
    activeGymId,
    setActiveGymId,
  } = useGym();

  // refresh whenever this screen becomes visible again (terms/attendance move)
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload])
  );

  const styles = makeStyles(colors);

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
  const frozen = status === 'FROZEN';
  const multiGym = memberships.length > 1;

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

      {/* membership term */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Membership</Text>
        {membership?.plan_name ? (
          <Text style={styles.planName}>{membership.plan_name}</Text>
        ) : (
          <Text style={[styles.planName, { color: colors.textDim }]}>No plan assigned</Text>
        )}
        {membership?.ends_on ? (
          <Text style={styles.meta}>
            {frozen ? 'Frozen — valid until' : 'Valid until'} {String(membership.ends_on).slice(0, 10)}
          </Text>
        ) : (
          <Text style={styles.meta}>
            {frozen ? 'Frozen' : 'No active term — talk to the front desk'}
          </Text>
        )}
        {membership?.starts_on ? (
          <Text style={styles.meta}>Started {String(membership.starts_on).slice(0, 10)}</Text>
        ) : null}
      </View>

      {/* attendance summary — read-only by design in the foundation phase */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Attendance</Text>
        {attendance ? (
          <>
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
          </>
        ) : (
          <Text style={styles.meta}>No attendance in the last 90 days.</Text>
        )}
      </View>

      {/* doors into existing gym features */}
      <View style={styles.card}>
        <TouchableOpacity
          style={styles.row}
          onPress={() => navigation.navigate(GYM_CLASSES)}
          accessibilityRole="button"
          accessibilityLabel="Open the class schedule"
        >
          <Ionicons name="calendar-outline" size={16} color={colors.primary} />
          <Text style={styles.rowText}>Classes</Text>
          <Text style={styles.rowHint}>Book your spot</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.row}
          onPress={() => navigation.navigate(GYM_DOCUMENTS)}
          accessibilityRole="button"
          accessibilityLabel="Open your gym documents"
        >
          <Ionicons name="document-text-outline" size={16} color={colors.primary} />
          <Text style={styles.rowText}>Documents</Text>
          <Text style={styles.rowHint}>Waivers &amp; agreements</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.row, { borderBottomWidth: 0 }]}
          onPress={() => navigation.navigate(NOTIFICATION_CENTER)}
          accessibilityRole="button"
          accessibilityLabel="Open notifications"
        >
          <Ionicons name="notifications-outline" size={16} color={colors.primary} />
          <Text style={styles.rowText}>Notifications</Text>
          <Text style={styles.rowHint}>
            {notificationsUnread > 0 ? `${notificationsUnread} unread` : 'All caught up'}
          </Text>
          <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
        </TouchableOpacity>
      </View>
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
  planName: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 2 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  statRow: { flexDirection: 'row' },
  stat: { flex: 1, alignItems: 'flex-start' },
  statValue: { color: colors.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowText: { color: colors.text, fontSize: 13, fontWeight: '700', flex: 1 },
  rowHint: { color: colors.textDim, fontSize: 11 },
});
