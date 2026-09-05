// Gym member home — the member-facing DASHBOARD (Mobile M5).
//
// One screen answers "what is my gym life right now": membership term
// (ACTIVE / FROZEN / EXPIRED — exactly as the server says it), attendance
// this month, the gym's recommended programs, the member's BOOKED classes
// (the enrolled list — never the whole schedule), outstanding payments and
// the latest announcements. The trainer lives on Profile (+ Settings
// disconnect) only — one trainer surface, not two. It stays a dashboard: the program LISTS moved to their own pool
// screens (GymWorkouts / GymNutrition), reachable from the "Gym Recommended"
// card, the way Classes and Documents already live on their own screens.
//
// Server-authoritative, like every gym surface:
//   - membership status/expiry come from /gym/my/memberships (GymContext);
//     the client never derives whether a term is active, frozen or expired
//   - payment dues come from /gym/my/billing, derived server-side from the
//     immutable ledger (the same chargeStatus rule the desk ledger uses);
//     the app renders the amount, it never computes it
//   - attendance eligibility is enforced server-side (booking/check-in);
//     the home only displays the ✓-days the server recorded
//   - every per-gym slice keys on the ACTIVE gym from GymContext — no gym
//     id is ever sent from the client
//
// States: first-load skeleton (GymContext), per-section skeletons while a
// section loads, per-section inline error + Retry (one failing section
// never kills the dashboard), empty states everywhere, and a graceful
// not-connected state (defensive — standalone users can't reach this
// screen; a mid-session cancellation can).
//
// EXPIRED membership: the page still loads and history stays visible —
// the membership card shows "Expired on …" plus a Contact Gym action
// (call/email via the gym's own contact columns, address as fallback).
// FROZEN: shows the open freeze's start date and reason, straight from
// the server's membership_freezes row.
//
// M1.1: this screen is a shared-pool screen (registered in every tab
// stack), pushed from MyGymCard on the Profile tab. Same section, same
// entry point — only the content of the screen grows up.
import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Linking,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useColors, spacing } from '../theme';
import LoadError from '../shared/components/LoadError';
import useAsyncData from '../shared/hooks/useAsyncData';
import { useGym } from '../store/GymContext';
import {
  fetchMyGymContent,
  fetchMyGymClasses,
  fetchMyGymAnnouncements,
  fetchMyGymBilling,
} from '../lib/gymApi';
import {
  statusColor,
  formatMoney,
  formatDayMonthYear,
  myBookedClasses,
  billingForGym,
} from '../lib/gymState';
import { GYM_WORKOUTS, GYM_NUTRITION, GYM_CLASSES, GYM_ATTENDANCE, GYM_CHECK_IN, GYM_DOCUMENTS, GYM_PAYMENTS } from '../shared/constants/routes';

// "Tue, 1 Sep" — the same UTC-safe class date rendering GymClassesScreen
// uses (gym-local schedule dates must not shift with the device timezone).
function classDayLabel(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const OPEN_CHARGE_STATUSES = ['DUE', 'OVERDUE', 'PARTIAL'];

// charge badge palette — same hues the Classes screen and the membership
// badge use, so status colors stay consistent across the app
const CHARGE_STATUS_COLORS = {
  DUE: '#5856D6',
  OVERDUE: '#DC2626',
  PARTIAL: '#D97706',
};

export default function GymHomeScreen() {
  const colors = useColors();
  const navigation = useNavigation();
  const gym = useGym();

  // one async surface per dashboard section — each loads, fails and retries
  // INDEPENDENTLY so a dead section never blinds the whole dashboard.
  // immediate:false → the useFocusEffect below drives the first fetch
  // (single fetch per focus instead of mount + focus double-fire).
  const content = useAsyncData(() => fetchMyGymContent(), [], { immediate: false });
  const classes = useAsyncData(() => fetchMyGymClasses(), [], { immediate: false });
  const announcements = useAsyncData(() => fetchMyGymAnnouncements({ limit: 20 }), [], { immediate: false });
  const billing = useAsyncData(() => fetchMyGymBilling(), [], { immediate: false });

  // refresh everything whenever the dashboard becomes visible again
  // (terms move, dues get paid at the desk, classes get booked, gyms post)
  useFocusEffect(
    useCallback(() => {
      gym.reload();
      content.reload();
      classes.reload();
      announcements.reload();
      billing.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gym.reload, content.reload, classes.reload, announcements.reload, billing.reload])
  );

  const styles = makeStyles(colors);

  // ── per-gym slices (pure selection — the server already ordered/sized) ──
  const gymId = (gym.gym || {}).gym_id || null;
  const activeContent = useMemo(() => {
    const rows = Array.isArray(content.data) ? content.data : [];
    return rows.find((g) => g && g.gym_id === gymId) || null;
  }, [content.data, gymId]);
  // MY booked classes — the enrolled list, not a teaser: enrolled in 2 of 10
  // → exactly those 2 rows (a waitlist spot is not a seat; the full schedule
  // lives on the Classes screen and is never echoed here). The waitlist
  // count keeps the empty state / footnote honest instead of silently
  // hiding a pending spot.
  const myBooked = useMemo(() => myBookedClasses(classes.data, gymId), [classes.data, gymId]);
  const waitlistedCount = useMemo(() =>
    (Array.isArray(classes.data) ? classes.data : [])
      .filter((c) => c && c.my_status === 'WAITLISTED' && (!gymId || c.gym_id === gymId)).length,
    [classes.data, gymId]);
  const myBilling = useMemo(() => billingForGym(billing.data, gymId), [billing.data, gymId]);
  const myAnnouncements = useMemo(() => {
    const rows = Array.isArray(announcements.data) ? announcements.data : [];
    return rows.filter((a) => a && a.gym_id === gymId).slice(0, 2);
  }, [announcements.data, gymId]);

  // ── early states (after every hook) ─────────────────────────────────────
  if (gym.loading) {
    return <DashboardSkeleton colors={colors} styles={styles} />;
  }
  if (gym.error) {
    return <LoadError message="Couldn't load your gym." onRetry={gym.reload} />;
  }
  if (!gym.hasGym || !gym.gym) {
    // Defensive: standalone users cannot get here (MyGymCard renders
    // nothing for them); if we still land here (membership cancelled
    // mid-session), show the graceful state — never fake gym data.
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Ionicons name="business-outline" size={40} color={colors.textDim} />
        <Text style={styles.emptyTitle}>You&apos;re not connected to a gym yet.</Text>
        <Text style={styles.emptyBody}>
          When your gym links your membership to this account, your dashboard will show up here.
        </Text>
      </View>
    );
  }

  const { gym: gymRow, gymMember, membership, attendance } = gym;

  // section shell: loading → skeleton, error → inline retry, ready → body
  const sectionState = (section) =>
    section.loading && !section.data ? 'loading'
      : section.error && !section.data ? 'error'
        : 'ready';

  const card = (title, section, body, onPress) => {
    const state = sectionState(section);
    const content = (
      <>
        <View style={styles.cardTitleRow}>
          <Text style={styles.cardTitle}>{title}</Text>
          {onPress && state === 'ready' ? (
            <Ionicons name="chevron-forward" size={15} color={colors.textDim} />
          ) : null}
        </View>
        {state === 'loading' ? <SectionSkeleton colors={colors} styles={styles} /> : null}
        {state === 'error' ? (
          <View style={styles.sectionError}>
            <Ionicons name="cloud-offline-outline" size={15} color={colors.textDim} />
            <Text style={styles.sectionErrorText}>Couldn&apos;t load this section.</Text>
            <TouchableOpacity
              onPress={section.reload}
              accessibilityRole="button"
              accessibilityLabel={`Retry loading ${title}`}
            >
              <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        {state === 'ready' ? body : null}
      </>
    );
    if (!onPress) return <View style={styles.card}>{content}</View>;
    return (
      <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}
        accessibilityRole="button" accessibilityLabel={`${title} — open details`}>
        {content}
      </TouchableOpacity>
    );
  };
  // ── membership card ───────────────────────────────────────────────────────
  // term status is what matters; fall back to the member-record status when
  // no term exists (same rule MyGymCard uses)
  const termStatus = membership?.status || gymRow.status;
  const badgeColor = statusColor(termStatus, colors.textDim);
  const contactRows = [
    gymRow.gym_phone ? { icon: 'call-outline', label: gymRow.gym_phone, url: `tel:${gymRow.gym_phone}` } : null,
    gymRow.gym_email ? { icon: 'mail-outline', label: gymRow.gym_email, url: `mailto:${gymRow.gym_email}` } : null,
  ].filter(Boolean);

  const openContact = (url) => {
    Linking.openURL(url).catch(() =>
      Alert.alert('Could not open', 'Nothing on this device can handle that action.')
    );
  };

  const membershipBody = (
    <>
      <View style={styles.gymHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.planName} numberOfLines={1}>
            {membership?.plan_name || 'No membership plan yet'}
          </Text>
          {membership?.starts_on && termStatus === 'UPCOMING' ? (
            <Text style={styles.meta}>Starts {formatDayMonthYear(membership.starts_on) || String(membership.starts_on).slice(0, 10)}</Text>
          ) : null}
          {membership?.status === 'ACTIVE' && membership?.ends_on ? (
            <Text style={styles.meta}>
              Expires {formatDayMonthYear(membership.ends_on) || String(membership.ends_on).slice(0, 10)}
            </Text>
          ) : null}
          {membership?.status === 'FROZEN' ? (
            <>
              {membership.freeze_starts_on ? (
                <Text style={styles.meta}>
                  Frozen since {formatDayMonthYear(membership.freeze_starts_on) || String(membership.freeze_starts_on).slice(0, 10)}
                </Text>
              ) : null}
              {membership.freeze_reason ? (
                <Text style={styles.meta} numberOfLines={2}>Reason: {membership.freeze_reason}</Text>
              ) : null}
              {membership.ends_on ? (
                <Text style={styles.meta}>
                  Valid until {formatDayMonthYear(membership.ends_on) || String(membership.ends_on).slice(0, 10)}
                </Text>
              ) : null}
            </>
          ) : null}
          {membership?.status === 'EXPIRED' && membership?.ends_on ? (
            <Text style={styles.meta}>
              Expired on: {formatDayMonthYear(membership.ends_on) || String(membership.ends_on).slice(0, 10)}
            </Text>
          ) : null}
          {!membership?.plan_name ? (
            <Text style={styles.meta}>
              Your gym hasn&apos;t added a plan for you yet — ask at the front desk.
            </Text>
          ) : null}
        </View>
        <View style={[styles.badge, { backgroundColor: `${badgeColor}22` }]}>
          <Text style={[styles.badgeText, { color: badgeColor }]}>{termStatus}</Text>
        </View>
      </View>
      {membership?.status === 'EXPIRED' ? (
        <View style={styles.contactWrap}>
          <Text style={styles.contactHint}>
            Your membership has ended — reach out to your gym to renew.
          </Text>
          <View style={styles.contactRow}>
            {contactRows.map((c) => (
              <TouchableOpacity
                key={c.url}
                style={styles.contactBtn}
                onPress={() => openContact(c.url)}
                accessibilityRole="button"
                accessibilityLabel={`Contact gym: ${c.label}`}
              >
                <Ionicons name={c.icon} size={14} color={colors.primary} />
                <Text style={[styles.contactText, { color: colors.primary }]} numberOfLines={1}>
                  {c.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          {contactRows.length === 0 ? (
            <Text style={styles.meta}>
              {[gymRow.gym_address_line1, gymRow.gym_city].filter(Boolean).join(', ') ||
                'Ask at the front desk on your next visit.'}
            </Text>
          ) : null}
        </View>
      ) : null}
    </>
  );

  // ── attendance card ───────────────────────────────────────────────────────
  const attendanceBody = attendance ? (
    <>
      <View style={styles.statRow}>
        <View style={styles.stat}>
          <Text style={styles.statValue}>{attendance.visitsThisMonth}</Text>
          <Text style={styles.statLabel}>visits this month</Text>
        </View>
        <View style={styles.stat}>
          <Text style={[styles.statValue, { fontSize: 15, paddingTop: 6 }]}>
            {attendance.lastVisit
              ? formatDayMonthYear(attendance.lastVisit) || String(attendance.lastVisit).slice(0, 10)
              : '—'}
          </Text>
          <Text style={styles.statLabel}>last visit</Text>
        </View>
      </View>
      {!attendance.lastVisit ? (
        <Text style={styles.meta}>No visits in the last 90 days.</Text>
      ) : null}
      {/* M6 — attendance experience entries. Check In only when the server
          says the membership is ACTIVE (the endpoint re-validates anyway);
          history stays open for EXPIRED/FROZEN members — recorded visits
          are facts, not privileges. */}
      <View style={styles.attActions}>
        {membership?.status === 'ACTIVE' ? (
          <TouchableOpacity
            style={[styles.attAction, styles.attActionPrimary]}
            onPress={() => navigation.navigate(GYM_CHECK_IN)}
            accessibilityRole="button"
            accessibilityLabel="Check in with QR"
          >
            <Ionicons name="qr-code-outline" size={15} color="#fff" />
            <Text style={styles.attActionPrimaryText}>Check in with QR</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          style={styles.attAction}
          onPress={() => navigation.navigate(GYM_ATTENDANCE)}
          accessibilityRole="button"
          accessibilityLabel="View full attendance history"
        >
          <Ionicons name="calendar-outline" size={15} color={colors.primary} />
          <Text style={styles.attActionText}>View full history</Text>
          <Ionicons name="chevron-forward" size={13} color={colors.textDim} />
        </TouchableOpacity>
      </View>
    </>
  ) : (
    <Text style={styles.meta}>No attendance recorded yet.</Text>
  );

  // ── gym recommended card (entry points — lists live on their own screens) ─
  const workoutCount =
    (activeContent?.workouts?.assigned?.length || 0) +
    (activeContent?.workouts?.recommended?.length || 0);
  const nutritionCount =
    (activeContent?.nutrition?.assigned?.length || 0) +
    (activeContent?.nutrition?.recommended?.length || 0);

  const entryRow = (icon, label, hint, route, accessLabel) => (
    <TouchableOpacity
      style={styles.entryRow}
      onPress={() => navigation.navigate(route)}
      accessibilityRole="button"
      accessibilityLabel={accessLabel}
    >
      <Ionicons name={icon} size={16} color={colors.primary} />
      <Text style={styles.entryText}>{label}</Text>
      <Text style={styles.entryHint}>{hint}</Text>
      <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
    </TouchableOpacity>
  );

  const recommendedBody = (
    <>
      {entryRow(
        'barbell-outline', 'View Workouts',
        workoutCount ? `${workoutCount} available` : 'Nothing yet',
        GYM_WORKOUTS, 'View gym workouts'
      )}
      {entryRow(
        'restaurant-outline', 'View Nutrition',
        nutritionCount ? `${nutritionCount} available` : 'Nothing yet',
        GYM_NUTRITION, 'View gym nutrition'
      )}
    </>
  );

  // ── upcoming classes card — the member's enrolled list, display-only ──────
  // Every row is a confirmed BOOKED seat, so no per-row badge and no
  // tap-through: the dashboard never opens the full schedule (booking and
  // cancelling live on the Classes screen, reached via Classes & Documents
  // below). Server order = soonest first; nothing here re-sorts it.
  const classBody = myBooked.length === 0 ? (
    <Text style={styles.meta}>
      {waitlistedCount
        ? `No booked classes — you're on the waitlist for ${waitlistedCount} upcoming class${waitlistedCount > 1 ? 'es' : ''}. See Classes & Documents below.`
        : 'No booked classes yet — book one under Classes & Documents below.'}
    </Text>
  ) : (
    <>
      {myBooked.map((c, i) => (
        <View key={c.id} style={[styles.classRow, i > 0 && styles.classRowNext]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.planName} numberOfLines={1}>{c.class_type}</Text>
            <Text style={styles.meta}>
              {classDayLabel(c.class_date)} · {String(c.start_time).slice(0, 5)}–{String(c.end_time).slice(0, 5)}
            </Text>
            {c.trainer_name || c.branch_name || c.room ? (
              <Text style={styles.meta} numberOfLines={1}>
                {[c.trainer_name, c.branch_name, c.room].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
          </View>
        </View>
      ))}
      {waitlistedCount > 0 ? (
        <Text style={styles.footnote}>
          You&apos;re also on the waitlist for {waitlistedCount} upcoming class{waitlistedCount > 1 ? 'es' : ''} — a waitlist spot is not a seat yet.
        </Text>
      ) : null}
      <Text style={styles.footnote}>Book or cancel under Classes &amp; Documents below.</Text>
    </>
  );

  // ── payments card (amounts straight from the server's ledger) ─────────────
  const openCharges = (myBilling?.charges || []).filter((c) => OPEN_CHARGE_STATUSES.includes(c.status));
  const hasDues = !!myBilling && myBilling.outstanding_cents > 0;
  const dueColor = myBilling?.overdue_cents > 0 ? colors.red : colors.text;

  const paymentsBody = hasDues ? (
    <>
      <View style={styles.duesRow}>
        <Text style={[styles.duesAmount, { color: dueColor }]}>
          {formatMoney(myBilling.outstanding_cents, myBilling.currency)}
        </Text>
        <Text style={styles.duesLabel}>due</Text>
      </View>
      {myBilling.overdue_cents > 0 ? (
        <Text style={[styles.overdueNote, { color: colors.red }]}>
          {formatMoney(myBilling.overdue_cents, myBilling.currency)} is overdue
        </Text>
      ) : null}
      {openCharges.slice(0, 4).map((c) => {
        const cColor = CHARGE_STATUS_COLORS[c.status] || colors.textDim;
        return (
          <View key={c.id} style={styles.chargeRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.chargeDesc} numberOfLines={1}>{c.description}</Text>
              <Text style={styles.meta}>
                {c.status === 'OVERDUE' ? 'Overdue · was due ' : 'Due '}
                {formatDayMonthYear(c.due_on) || String(c.due_on || '').slice(0, 10)}
              </Text>
            </View>
            <View style={[styles.badge, { backgroundColor: `${cColor}22` }]}>
              <Text style={[styles.badgeText, { color: cColor }]}>{c.status}</Text>
            </View>
            <Text style={styles.chargeAmount}>
              {formatMoney(c.outstanding_cents, c.currency)}
            </Text>
          </View>
        );
      })}
      {openCharges.length > 4 ? (
        <Text style={styles.meta}>+{openCharges.length - 4} more open charge{openCharges.length - 4 > 1 ? 's' : ''}</Text>
      ) : null}
      <Text style={styles.footnote}>Tap for full payment history & receipts.</Text>
    </>
  ) : (
    <View style={styles.settledRow}>
      <Ionicons name="checkmark-circle" size={18} color={colors.green} />
      <View style={{ flex: 1 }}>
        <Text style={styles.settledText}>All settled</Text>
        <Text style={styles.meta}>No dues right now.</Text>
      </View>
    </View>
  );

  // ── announcements card ────────────────────────────────────────────────────
  const announcementsBody = myAnnouncements.length === 0 ? (
    <Text style={styles.meta}>No announcements right now.</Text>
  ) : (
    myAnnouncements.map((a, i) => (
      <View key={a.id} style={[styles.annRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.sm }]}>
        <View style={styles.annHead}>
          <Text style={styles.annTitle} numberOfLines={1}>{a.title}</Text>
          <Text style={styles.annDate}>
            {formatDayMonthYear(a.published_at) || String(a.published_at || '').slice(0, 10)}
          </Text>
        </View>
        {a.body ? <Text style={styles.annBody} numberOfLines={3}>{a.body}</Text> : null}
      </View>
    ))
  );

  const multiGym = gym.memberships.length > 1;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {multiGym && (
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
            <Text style={styles.gymName} numberOfLines={1}>{gymRow.gym_name}</Text>
            <Text style={styles.meta}>
              Member {gymMember?.member_code}
              {gymRow.joined_at ? ` · since ${String(gymRow.joined_at).slice(0, 10)}` : ''}
            </Text>
          </View>
        </View>
      </View>

      {card('Membership', { loading: false, error: null, data: membership !== undefined ? membership : null, reload: gym.reload }, membershipBody)}
      {card('Attendance', { loading: false, error: null, data: attendance, reload: gym.reload }, attendanceBody)}
      {card('Gym Recommended', content, recommendedBody)}
      {card('Upcoming Classes', classes, classBody)}
      {card('Payments', billing, paymentsBody, () => navigation.navigate(GYM_PAYMENTS, { gymId }))}
      {card('Announcements', announcements, announcementsBody)}
      {/* Classes & Documents: the permanent entries that used to sit on the
          Profile My Gym card — the detail page is the single gym hub now */}
      {card('Classes & Documents', { loading: false, error: null, data: true, reload: () => {} }, (
        <>
          {entryRow(
            'calendar-outline', 'Classes', 'Schedule & booking',
            GYM_CLASSES, 'Open the class schedule'
          )}
          {entryRow(
            'document-text-outline', 'Documents', 'Waivers & agreements',
            GYM_DOCUMENTS, 'Open your gym documents'
          )}
        </>
      ))}
    </ScrollView>
  );
}

// ── static skeletons (the shape of what's coming) ───────────────────────────
function DashboardSkeleton({ colors, styles }) {
  return (
    <ScrollView
      style={[styles.screen, { backgroundColor: colors.bg }]}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {[0, 1, 2, 3].map((i) => (
        <View key={i} style={styles.card}>
          <View style={[styles.skeletonTitle, { backgroundColor: colors.cardLight }]} />
          <SectionSkeleton colors={colors} styles={styles} />
        </View>
      ))}
    </ScrollView>
  );
}

function SectionSkeleton({ colors, styles }) {
  return (
    <View style={{ gap: spacing.sm }}>
      {[44, 30].map((h, i) => (
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
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  cardTitle: { color: colors.text, fontSize: 13, fontWeight: '800', letterSpacing: 0.3, marginBottom: spacing.sm },
  skeletonTitle: { height: 12, borderRadius: 6, width: 110, marginBottom: spacing.sm },
  skeletonBar: { borderRadius: 10 },
  sectionError: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm,
  },
  sectionErrorText: { color: colors.textDim, fontSize: 12, flex: 1 },
  retryText: { fontSize: 13, fontWeight: '800' },
  gymHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  gymBadgeWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gymName: { color: colors.text, fontSize: 17, fontWeight: '800' },
  planName: { color: colors.text, fontSize: 15, fontWeight: '800' },
  meta: { color: colors.textDim, fontSize: 12, marginTop: 3 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  contactWrap: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  contactHint: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  contactRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  contactBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    borderWidth: 1, borderColor: colors.primary, borderRadius: 9,
    paddingHorizontal: 11, paddingVertical: 7,
    maxWidth: '100%',
  },
  contactText: { fontWeight: '800', fontSize: 12.5 },
  statRow: { flexDirection: 'row' },
  stat: { flex: 1, alignItems: 'flex-start' },
  statValue: { color: colors.text, fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  entryRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  entryText: { color: colors.text, fontSize: 13, fontWeight: '700', flex: 1 },
  entryHint: { color: colors.textDim, fontSize: 11 },
  classRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  classRowNext: {
    paddingTop: spacing.sm, marginTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  duesRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
  duesAmount: { fontSize: 24, fontWeight: '800', fontVariant: ['tabular-nums'] },
  duesLabel: { color: colors.textDim, fontSize: 13, fontWeight: '700' },
  overdueNote: { fontSize: 12, fontWeight: '700', marginTop: 2 },
  chargeRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingTop: spacing.sm, marginTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  chargeDesc: { color: colors.text, fontSize: 12.5, fontWeight: '700' },
  chargeAmount: { color: colors.text, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'] },
  footnote: { color: colors.textDim, fontSize: 11, marginTop: spacing.sm },
  settledRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  settledText: { color: colors.text, fontSize: 14, fontWeight: '800' },
  annRow: { paddingTop: 0, paddingBottom: spacing.sm },
  annHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  annTitle: { color: colors.text, fontSize: 13, fontWeight: '700', flex: 1 },
  annDate: { color: colors.textDim, fontSize: 11 },
  annBody: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: 3 },
});
