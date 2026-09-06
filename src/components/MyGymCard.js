// My Gym — a NORMAL Profile card (same visual hierarchy as the Health
// Profile card): one light row per app-linked gym membership; tapping it
// opens the EXISTING My Gym detail page (GymMain pool). Nothing gym-related
// is duplicated here — classes, documents, trainer, attendance all live on
// the detail page, which is the single gym hub.
//
// Snapshot comes from GymContext (Mobile M1) — ONE server-authoritative
// gym state shared with the detail screen; this card never fetches gym
// data itself. A standalone user gets no gym row and instead sees the
// manual invitation-code entry (M4) — the deep-link path lives in
// InvitationContext.
import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, TextInput, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useColors } from '../theme';
import { GYM_HOME } from '../shared/constants/routes';
import { useGym } from '../store/GymContext';
import { useInvitation } from '../store/InvitationContext';
import { extractInvitationToken } from '../lib/gymInvites';
import { leaveMyGym } from '../lib/gymApi';

export default function MyGymCard() {
  const colors = useColors();
  const navigation = useNavigation();
  // single source of truth — the gym home screen and this card share one
  // snapshot
  const { loading, hasGym, memberships, activeGymId, setActiveGymId, reload } = useGym();
  const { openInvitation } = useInvitation();
  const [leavingGymId, setLeavingGymId] = useState(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState(null);
  const [codeBusy, setCodeBusy] = useState(false);

  const styles = makeStyles(colors);

  // ── LEAVE GYM (user-initiated disassociation) ─────────────────────────
  // The confirmation spells out exactly what the member loses and what is
  // preserved. The member identity is resolved server-side from the JWT;
  // the call returns the fresh membership list and reload() re-resolves the
  // selected gym (last gym left → the app goes back to standalone mode).
  const confirmLeave = (m) => {
    Alert.alert(
      `Leave ${m.gym_name}?`,
      [
        'If you leave this gym:',
        '\u2022 You lose access to its active member features.',
        '\u2022 Gym attendance, check-in and announcements stop.',
        '\u2022 You can no longer submit payment proofs there.',
        '\u2022 Your personal fitness data and this gym\'s history are preserved.',
        '\u2022 Your other gyms are not affected.',
        'You can rejoin later if the gym allows.',
      ].join('\n'),
      [
        { text: 'Keep Gym', style: 'cancel' },
        { text: 'Leave Gym', style: 'destructive', onPress: () => doLeave(m) },
      ]
    );
  };

  const doLeave = async (m) => {
    if (leavingGymId) return; // duplicate tap guard
    setLeavingGymId(m.gym_id);
    try {
      await leaveMyGym(m.gym_id);
      Alert.alert(
        `You left ${m.gym_name}`,
        'Your history with this gym is preserved. You can rejoin later if the gym allows.'
      );
      reload();
    } catch (e) {
      Alert.alert('Could not leave gym', e?.message || 'Please try again later.');
    } finally {
      setLeavingGymId(null);
    }
  };

  const activeGyms = (memberships || []).filter((m) => m && m.status !== 'LEFT');
  const formerGyms = (memberships || []).filter((m) => m && m.status === 'LEFT');

  // history-only rows: flat (not tappable — the gym screens would 403), no
  // leave action; rejoining is a gym-side operation
  const formerSection = formerGyms.length ? (
    <View style={styles.formerWrap}>
      <Text style={styles.formerTitle}>Previous gyms</Text>
      {formerGyms.map((m) => (
        <View key={`former-${m.gym_id}-${m.member_code}`} style={[styles.card, styles.formerCard]}>
          <Ionicons name="business-outline" size={19} color={colors.textDim} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowTitle, { color: colors.textDim }]}>{m.gym_name}</Text>
            <Text style={styles.rowSub} numberOfLines={1}>
              {[
                'LEFT',
                m.left_at ? String(m.left_at).slice(0, 10) : null,
                m.left_reason === 'REMOVED_BY_ADMIN' ? 'removed by gym' : null,
              ].filter(Boolean).join(' · ')}
            </Text>
          </View>
        </View>
      ))}
    </View>
  ) : null;

  if (loading) return null; // still resolving the session's gym snapshot

  // M4: no gym connected — the MANUAL invitation entry point (desk reads
  // the one-time code over the counter / WhatsApp; the deep link path
  // lives in InvitationContext). The code is validated client-side only
  // for shape — the server remains the sole authority.
  if (!hasGym) {
    // former-gyms history stays visible even in standalone mode
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
        <View style={styles.emptyRow}>
          <Ionicons name="business-outline" size={18} color={colors.primary} />
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
        {formerSection}
      </View>
    );
  }

  return (
    <View>
      {activeGyms.map((m) => {
        // membership term status (ACTIVE/FROZEN/…) is what matters to the
        // member; fall back to the membership-record status when no term exists
        const status = m.membership_status || m.status;
        return (
          // one light row per gym — same shape as the Health Profile card
          // (icon · title + sub · chevron). M1.1 rule kept: the tapped gym
          // becomes the active gym BEFORE navigating, so the detail page
          // opens on THAT gym.
          <TouchableOpacity
            key={`${m.gym_id}-${m.member_code}`}
            style={styles.card}
            onPress={() => {
              if (m.gym_id && m.gym_id !== activeGymId) setActiveGymId(m.gym_id);
              navigation.navigate(GYM_HOME);
            }}
            accessibilityRole="button"
            accessibilityLabel={`Open the ${m.gym_name} gym page`}
          >
            <Ionicons name="business-outline" size={19} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle}>{m.gym_name}</Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {[
                  m.plan_name || `Member ${m.member_code}`,
                  status,
                ].filter(Boolean).join(' · ')}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.leaveBtn}
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              onPress={() => confirmLeave(m)}
              disabled={leavingGymId === m.gym_id}
              accessibilityRole="button"
              accessibilityLabel={`Leave ${m.gym_name}`}
            >
              {leavingGymId === m.gym_id
                ? <ActivityIndicator size="small" color={colors.textDim} />
                : <Ionicons name="log-out-outline" size={17} color={colors.textDim} />}
            </TouchableOpacity>
            <Ionicons name="chevron-forward" size={17} color={colors.textDim} />
          </TouchableOpacity>
        );
      })}
      {formerSection}
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 12,
  },
  leaveBtn: { paddingHorizontal: 6, paddingVertical: 6 },
  formerWrap: { marginTop: 6 },
  formerTitle: {
    color: colors.textDim, fontSize: 11.5, fontWeight: '800',
    letterSpacing: 0.4, marginBottom: 6, marginTop: 2,
  },
  formerCard: { opacity: 0.75 },
  rowTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  rowSub: { color: colors.textDim, fontSize: 11, marginTop: 2 },
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
