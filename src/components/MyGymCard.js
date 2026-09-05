// My Gym — shown on the Profile tab for app-linked gym members (Phase 7):
//
//   My Gym
//   Premium Annual   [ACTIVE]
//   Valid until 31 Dec 2026
//
// M2: this card is the GYM HUB entry — the gym row opens the gym home
// (programs + attendance); Classes and Documents stay reachable from here
// (they were de-duplicated off the gym home screen).
// Membership rows come from GymContext (Mobile M1) — ONE server-
// authoritative snapshot shared with the gym home screen; this card no
// longer fetches /gym/my/memberships itself. (This also fixes the latent crash
// from importing a non-exported `api` binding here.) Content counts still
// come from GET /gym/my/content (Phase 13 UNIFIED assigned + recommended
// gym content — one call for workouts AND nutrition; the diet strip on
// Diet home uses the same endpoint). A standalone user gets [] and the
// card renders nothing — a gym is never required. Assignment rows live on
// the gym member, so content assigned BEFORE the app account was linked
// shows up here too. Historical record integrity is unaffected by when
// the app account was linked: the term predating the link shows exactly
// the same.
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, TextInput, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useColors } from '../theme';
import { GYM_CLASSES, GYM_DOCUMENTS, GYM_HOME } from '../shared/constants/routes';
import { fetchMyGymContent } from '../lib/gymApi';
import { useGym } from '../store/GymContext';
import { useInvitation } from '../store/InvitationContext';
import { statusColor } from '../lib/gymState';
import { extractInvitationToken } from '../lib/gymInvites';

export default function MyGymCard() {
  const colors = useColors();
  const navigation = useNavigation();
  // single source of truth — the gym home screen and this card share one
  // snapshot
  const { loading, hasGym, memberships, activeGymId, setActiveGymId } = useGym();
  const { openInvitation } = useInvitation();
  const [contentCounts, setContentCounts] = useState({});
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState(null);
  const [codeBusy, setCodeBusy] = useState(false);

  // refresh on every focus too — counts go stale after a gym edits content
  useFocusEffect(
    React.useCallback(() => {
      let cancelled = false;
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
    }, [])
  );

  const styles = makeStyles(colors);

  if (loading) return null; // still resolving the session's gym snapshot

  // M4: no gym connected — previously rendered nothing. Now this is also
  // the MANUAL invitation entry point (desk reads the one-time code over
  // the counter / WhatsApp; the deep link path lives in InvitationContext).
  // The code is validated client-side only for shape — the server remains
  // the sole authority (no member ids, no claiming logic here).
  if (!hasGym) {
    const submitCode = async () => {
      if (codeBusy) return;
      const token = extractInvitationToken(code);
      if (!token) {
        setCodeError("That doesn't look like an invitation code.");
        return;
      }
      setCodeBusy(true);
      const opened = await openInvitation(token);
      setCodeBusy(false);
      if (opened) {
        setCodeOpen(false);
        setCode('');
        setCodeError(null);
      } else {
        setCodeError("That doesn't look like an invitation code.");
      }
    };
    return (
      <View style={styles.card}>
        <View style={styles.header}>
          <Ionicons name="business-outline" size={16} color={colors.primary} />
          <Text style={styles.title}>My Gym</Text>
        </View>
        <View style={styles.emptyRow}>
          <Ionicons name="ribbon-outline" size={18} color={colors.textDim} />
          <View style={{ flex: 1 }}>
            <Text style={styles.emptyTitle}>Connect your gym membership</Text>
            <Text style={styles.emptyBody}>
          Your gym's programs, classes and documents appear here once your
          membership is linked.
            </Text>
          </View>
        </View>
        <TouchableOpacity
          style={styles.codeBtn}
          onPress={() => { setCodeOpen(true); setCodeError(null); }}
          accessibilityRole="button"
          accessibilityLabel="Enter a gym invitation code"
        >
          <Ionicons name="key-outline" size={15} color={colors.primary} />
          <Text style={styles.codeBtnText}>Have an invitation code?</Text>
        </TouchableOpacity>

        <Modal visible={codeOpen} transparent animationType="fade" onRequestClose={() => setCodeOpen(false)}>
          <View style={styles.codeBackdrop}>
            <View style={styles.codeCard}>
              <Text style={styles.codeTitle}>Enter invitation code</Text>
              <Text style={styles.codeHint}>
            Your gym gives you a one-time code when they invite you. It links
            this account to your existing membership.
              </Text>
              <TextInput
                style={styles.codeInput}
                value={code}
                onChangeText={(v) => { setCode(v); setCodeError(null); }}
                placeholder="e.g. 9f2c7ab4…"
                placeholderTextColor={colors.textDim}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={72}
              />
              {codeError ? <Text style={styles.codeError}>{codeError}</Text> : null}
              <View style={styles.codeActions}>
                <TouchableOpacity style={styles.codeCancel} onPress={() => setCodeOpen(false)}>
                  <Text style={styles.codeCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.codeSubmit, codeBusy && { opacity: 0.5 }]}
                  onPress={submitCode}
                  disabled={codeBusy}
                >
                  {codeBusy
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={styles.codeSubmitText}>Open invitation</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </Modal>
      </View>
    );
  }

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
          // M1.1: tapping a gym row opens the gym home (GymMain, shared
          // detail pool). Multi-gym: the tapped row becomes the active gym
          // first, so the home screen shows THAT gym's term/attendance.
          <TouchableOpacity
            key={`${m.gym_id}-${m.member_code}`}
            style={styles.gymRow}
            onPress={() => {
              if (m.gym_id && m.gym_id !== activeGymId) setActiveGymId(m.gym_id);
              navigation.navigate(GYM_HOME);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Open the ${m.gym_name} gym home`}
          >
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
                  {status === 'EXPIRED'
                    ? `Expired on: ${String(m.ends_on).slice(0, 10)}`
                    : `${frozen ? 'Frozen — valid until' : 'Valid until'} ${String(m.ends_on).slice(0, 10)}`}
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
            <View style={[styles.badge, { backgroundColor: `${statusColor(status, colors.textDim)}22` }]}>
              <Text style={[styles.badgeText, { color: statusColor(status, colors.textDim) }]}>
                {status}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
          </TouchableOpacity>
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
  emptyRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', paddingTop: 4 },
  emptyTitle: { color: colors.text, fontSize: 13.5, fontWeight: '800' },
  emptyBody: { color: colors.textDim, fontSize: 11.5, lineHeight: 16, marginTop: 3 },
  codeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 7,
    alignSelf: 'flex-start',
    borderWidth: 1, borderColor: colors.primary,
    borderRadius: 9, paddingHorizontal: 11, paddingVertical: 7,
    marginTop: 12,
  },
  codeBtnText: { color: colors.primary, fontWeight: '800', fontSize: 12.5 },
  codeBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  codeCard: {
    backgroundColor: colors.card, borderRadius: 16, padding: 18, width: '100%',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  codeTitle: { color: colors.text, fontSize: 15, fontWeight: '800', marginBottom: 6 },
  codeHint: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginBottom: 12 },
  codeInput: {
    backgroundColor: colors.bg,
    color: colors.text,
    borderWidth: 1, borderColor: colors.border, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
    marginBottom: 8,
  },
  codeError: { color: colors.red, fontSize: 12, marginBottom: 6 },
  codeActions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  codeCancel: {
    flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  codeCancelText: { color: colors.textDim, fontWeight: '700' },
  codeSubmit: {
    flex: 1.4, alignItems: 'center', justifyContent: 'center', paddingVertical: 11,
    borderRadius: 10, backgroundColor: colors.primary,
  },
  codeSubmitText: { color: '#fff', fontWeight: '800' },
});
