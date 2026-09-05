// QR check-in (Mobile M6) — the member scans the QR poster at their gym
// (or types the code) and the visit is recorded by the backend.
//
// Security shape (the part that must never drift):
//   · The phone NEVER sends a gym id. The scanned code is the gym's
//     rotatable 128-bit secret (payload gymcheckin:v1:<code>) and the
//     backend resolves the gym from it — a QR that named only a gym id
//     would let anyone fabricate check-ins.
//   · The backend re-checks membership at THAT gym and applies the same
//     strict eligibility + one-visit-per-day idempotency rule as the desk
//     scan. The client renders the verdict; it never decides eligibility.
//
// Submission is disabled while a request is in flight; duplicates come
// back honestly ("Already checked in today") instead of being re-credited,
// and offline failures keep the entered code so Retry is one tap.
import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useColors, spacing } from '../theme';
import { useGym } from '../store/GymContext';
import { checkInWithGymQr, fetchMyGymBilling } from '../lib/gymApi';
import { paymentWarningForGym, formatMoney } from '../lib/gymState';
import { GYM_PAYMENTS } from '../shared/constants/routes';
import { ApiError } from '../lib/api';
import { normalizeCheckInCode } from '../lib/gymState';
import { GYM_ATTENDANCE } from '../shared/constants/routes';
import BarcodeScannerModal from '../components/BarcodeScannerModal';

const SCAN_TYPES = ['qr'];

export default function GymCheckInScreen() {
  const colors = useColors();
  const navigation = useNavigation();
  const gym = useGym();
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  // result: { kind: 'success' | 'duplicate' | 'error', gymName?, date?, message? }
  const [result, setResult] = useState(null);

  const styles = makeStyles(colors);

  const submit = async (rawCode) => {
    const trimmed = normalizeCheckInCode(rawCode);
    if (!trimmed) {
      setResult({
        kind: 'error',
        message: "That doesn't look like a check-in code — scan the poster or ask the front desk.",
      });
      return;
    }
    setCode(trimmed);
    setSubmitting(true);
    setResult(null);

    // Mobile M11 — payment WARNING (not a block): if the member has dues or
    // an overdue charge, show the warning first. [Continue Check-in] then
    // performs the same idempotent check-in — the record is never duplicated
    // by warning + retry.
    try {
      const rows = await fetchMyGymBilling();
      const warn = paymentWarningForGym(rows, null, undefined);
      if (warn) {
        setSubmitting(false);
        const amountLine = `${formatMoney(warn.outstanding_cents, warn.currency)}${warn.overdue ? ` — overdue by ${warn.overdue_days} day${warn.overdue_days === 1 ? '' : 's'}` : ' is due'}`;
        const dueLine = warn.next_due_on ? `\nDue date: ${warn.next_due_on}` : '';
        Alert.alert(
          warn.overdue ? 'Overdue gym payment' : 'Outstanding gym payment',
          `You have an outstanding gym payment.\n${amountLine}${dueLine}\n\nPlease clear your payment to keep your membership up to date.`,
          [
            {
              text: 'View Payment',
              onPress: () => navigation.navigate(GYM_PAYMENTS),
            },
            { text: 'Continue Check-in', onPress: () => performCheckIn(trimmed) },
          ]
        );
        return;
      }
    } catch {
      // billing lookup failed — never block check-in on that
    }

    performCheckIn(trimmed);
  };

  const performCheckIn = async (trimmed) => {
    setSubmitting(true);
    setResult(null);
    try {
      const res = await checkInWithGymQr(trimmed);
      setResult({
        kind: res.duplicate ? 'duplicate' : 'success',
        gymName: res.gym_name,
        date: res.attendance && res.attendance.local_date,
      });
    } catch (e) {
      const offline = e instanceof ApiError && e.status === 0;
      setResult({
        kind: 'error',
        offline,
        message: offline
          ? "No connection — your check-in didn't go through. Move somewhere with signal and retry."
          : e instanceof ApiError
            ? e.message
            : 'Something went wrong — try again.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const openHistory = () => navigation.navigate(GYM_ATTENDANCE);

  const canRetry = result && result.kind === 'error' && (code || result.offline);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.card}>
        <View style={styles.heroRow}>
          <View style={[styles.badgeWrap, { backgroundColor: `${colors.primary}14` }]}>
            <Ionicons name="qr-code-outline" size={20} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Check in at your gym</Text>
            <Text style={styles.meta}>
              Scan the QR poster at the front desk — the visit is recorded instantly and counts
              exactly once, however many times you scan.
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.scanBtn, submitting && { opacity: 0.6 }]}
          disabled={submitting}
          onPress={() => setScannerOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="Scan the gym's QR poster"
        >
          <Ionicons name="camera-outline" size={18} color="#fff" />
          <Text style={styles.scanBtnText}>{submitting ? 'Checking in…' : 'Scan QR Code'}</Text>
        </TouchableOpacity>

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or type the code</Text>
          <View style={styles.dividerLine} />
        </View>

        <View style={styles.manualRow}>
          <TextInput
            style={[styles.input, submitting && { opacity: 0.6 }]}
            value={code}
            onChangeText={(t) => setCode(t.trim())}
            placeholder="Poster code"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!submitting}
            returnKeyType="go"
            onSubmitEditing={() => submit(code)}
          />
          <TouchableOpacity
            style={[styles.manualBtn, (submitting || !code) && { opacity: 0.5 }]}
            disabled={submitting || !code}
            onPress={() => submit(code)}
            accessibilityRole="button"
            accessibilityLabel="Check in with the typed code"
          >
            {submitting ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text style={styles.manualBtnText}>Check In</Text>
            )}
          </TouchableOpacity>
        </View>
        {submitting ? (
          <Text style={styles.submittingNote}>Recording your visit…</Text>
        ) : null}
      </View>

      {result && result.kind === 'success' ? (
        <View style={[styles.card, styles.resultCard, { borderColor: '#16A34A55' }]}>
          <Ionicons name="checkmark-circle" size={30} color="#16A34A" />
          <Text style={styles.resultTitle}>Checked in{result.gymName ? ` — ${result.gymName}` : ''}</Text>
          <Text style={styles.meta}>
            {result.date ? `Recorded for ${result.date}. ` : ''}
            See you at your next visit.
          </Text>
          <TouchableOpacity style={styles.historyLink} onPress={openHistory}>
            <Text style={styles.historyLinkText}>View attendance history</Text>
            <Ionicons name="chevron-forward" size={13} color={colors.primary} />
          </TouchableOpacity>
        </View>
      ) : null}

      {result && result.kind === 'duplicate' ? (
        <View style={[styles.card, styles.resultCard, { borderColor: `${colors.blue}55` }]}>
          <Ionicons name="information-circle" size={30} color={colors.blue} />
          <Text style={styles.resultTitle}>Already checked in today</Text>
          <Text style={styles.meta}>
            {result.gymName ? `${result.gymName} already counted your visit` : 'Your visit was already counted'}
            {result.date ? ` (recorded for ${result.date})` : ''} — scanning again never creates a
            second one.
          </Text>
          <TouchableOpacity style={styles.historyLink} onPress={openHistory}>
            <Text style={styles.historyLinkText}>View attendance history</Text>
            <Ionicons name="chevron-forward" size={13} color={colors.primary} />
          </TouchableOpacity>
        </View>
      ) : null}

      {result && result.kind === 'error' ? (
        <View style={[styles.card, styles.resultCard, { borderColor: '#DC262655' }]}>
          <Ionicons
            name={result.offline ? 'cloud-offline-outline' : 'alert-circle'}
            size={30}
            color="#DC2626"
          />
          <Text style={styles.resultTitle}>{result.offline ? 'No connection' : "Couldn't check in"}</Text>
          <Text style={styles.meta}>{result.message}</Text>
          {canRetry ? (
            <TouchableOpacity
              style={[styles.retryBtn, submitting && { opacity: 0.6 }]}
              disabled={submitting}
              onPress={() => submit(code)}
              accessibilityRole="button"
              accessibilityLabel="Retry check-in"
            >
              <Text style={styles.retryBtnText}>Retry</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : null}

      {!gym.hasGym ? (
        <Text style={styles.meta}>
          You&apos;re not connected to a gym yet — connect your membership from Profile → My Gym
          first.
        </Text>
      ) : null}

      <BarcodeScannerModal
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScanned={(scanned) => submit(scanned)}
        barcodeTypes={SCAN_TYPES}
        title="Scan Gym QR"
        hint="Point at the check-in poster"
      />
    </ScrollView>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg - 2,
    marginBottom: spacing.md,
  },
  resultCard: { alignItems: 'flex-start' },
  heroRow: { flexDirection: 'row', gap: spacing.sm + 2, marginBottom: spacing.md },
  badgeWrap: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: colors.text, fontSize: 16, fontWeight: '800' },
  meta: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: 2 },
  scanBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 13,
  },
  scanBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginVertical: spacing.md,
  },
  dividerLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  dividerText: { color: colors.textDim, fontSize: 11, fontWeight: '700' },
  manualRow: { flexDirection: 'row', gap: spacing.sm },
  input: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: colors.text,
    fontSize: 13,
    backgroundColor: colors.cardLight,
  },
  manualBtn: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  manualBtnText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  submittingNote: { color: colors.textDim, fontSize: 11, marginTop: spacing.sm, textAlign: 'center' },
  resultTitle: { color: colors.text, fontSize: 15, fontWeight: '800', marginTop: spacing.sm },
  historyLink: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm + 2 },
  historyLinkText: { color: colors.primary, fontSize: 13, fontWeight: '700' },
  retryBtn: {
    backgroundColor: '#DC2626',
    borderRadius: 10,
    paddingHorizontal: 18,
    paddingVertical: 9,
    marginTop: spacing.sm + 2,
  },
  retryBtnText: { color: '#fff', fontSize: 13, fontWeight: '800' },
});
