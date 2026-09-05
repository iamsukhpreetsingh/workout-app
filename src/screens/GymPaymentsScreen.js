// Gym Payments — the member's money history (Mobile M9).
//
// Pushed from the Payments card on the gym home. Everything is a READ of
// the server's immutable billing ledger:
//   • DUES       — "Payment Due ₹2,500 / Due: 10 Sep 2026" (+ OVERDUE badge),
//                  with the Pay Online action EXPOSED THROUGH THE BACKEND
//                  (`POST /gym/my/charges/:id/pay-online`). No gateway logic
//                  lives in this UI — the app surfaces the server's answer,
//                  which today is a 501 "pay at the front desk" until a
//                  gateway is wired up on the backend.
//   • HISTORY    — payment rows (date, ₹, method, status) exactly as the
//                  ledger recorded them.
//   • RECEIPT    — View (in-app, all fields: amount, date, method,
//                  membership, covered period, receipt number, status) and
//                  Share (RN Share API — the app's existing share surface).
//
// States: per-section skeleton, inline network error + Retry, empty state,
// duplicate-tap guards on every button, receipt-generation/link failures
// surfaced as alerts, and no way whatsoever to alter amount, status,
// receipt number or date from here.
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import { Share } from 'react-native';
import { useColors, spacing } from '../theme';
import LoadError from '../shared/components/LoadError';
import useAsyncData from '../shared/hooks/useAsyncData';
import { useGym } from '../store/GymContext';
import {
  fetchMyGymBilling,
  fetchMyPayments,
  fetchMyReceipt,
  payChargeOnline,
  fetchMyPaymentProofs,
  submitPaymentProof,
  cancelMyPaymentProof,
} from '../lib/gymApi';
import * as ImagePicker from 'expo-image-picker';
import { billingForGym, formatMoney, formatDayMonthYear } from '../lib/gymState';

const OPEN_STATUSES = ['DUE', 'OVERDUE', 'PARTIAL'];

const STATUS_COLORS = {
  PAID: '#16A34A',
  PARTIAL: '#D97706',
  REFUNDED: '#DC2626',
  DUE: '#5856D6',
  OVERDUE: '#DC2626',
};

export default function GymPaymentsScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const gym = useGym();
  const colors = useColors();
  // the gym whose money this screen shows: explicit param (card tap) or the
  // ACTIVE gym from GymContext — never a gym id typed anywhere client-side
  const gymId = route.params?.gymId || (gym.gym || {}).gym_id || null;

  const billing = useAsyncData(() => fetchMyGymBilling(), [], { immediate: false });
  const [payments, setPayments] = useState(null); // null = loading
  const [paymentsError, setPaymentsError] = useState(null);
  const [receipt, setReceipt] = useState(null); // full receipt object (View modal)
  const [receiptLoading, setReceiptLoading] = useState(null); // payment id being fetched
  const [sharing, setSharing] = useState(false);
  const [payingCharge, setPayingCharge] = useState(null); // charge id in flight
  // M11 — payment proofs
  const [proofs, setProofs] = useState(null); // null = loading
  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitCharge, setSubmitCharge] = useState(null);
  const [proofBusy, setProofBusy] = useState(false);
  const [screenshot, setScreenshot] = useState(null); // { base64, mime }
  const [proofForm, setProofForm] = useState({ amount: '', method: 'UPI', transaction_id: '', paid_on: '', notes: '' });

  const loadPayments = useCallback(async () => {
    if (!gymId) return;
    setPaymentsError(null);
    try {
      const rows = await fetchMyPayments(gymId);
      setPayments(Array.isArray(rows) ? rows : []);
    } catch (e) {
      setPaymentsError(e);
    }
  }, [gymId]);

  const loadProofs = useCallback(async () => {
    if (!gymId) return;
    try {
      const rows = await fetchMyPaymentProofs(gymId);
      setProofs(Array.isArray(rows) ? rows : []);
    } catch {
      setProofs([]);
    }
  }, [gymId]);

  useFocusEffect(
    useCallback(() => {
      billing.reload();
      loadPayments();
      loadProofs();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [gymId, billing.reload, loadPayments, loadProofs])
  );

  const styles = makeStyles(colors);
  const myBilling = billingForGym(billing.data, gymId);
  const openCharges = (myBilling?.charges || []).filter((c) => OPEN_STATUSES.includes(c.status));

  // ── Pay Online: the action EXPOSED THROUGH THE BACKEND. The button only
  // renders when the server says a gateway exists; the call surfaces
  // whatever the backend answers (today a 501 stub). Duplicate taps are
  // blocked by the in-flight charge id.
  const doPayOnline = async (charge) => {
    if (payingCharge) return; // duplicate tap guard
    setPayingCharge(charge.id);
    try {
      const result = await payChargeOnline(charge.id);
      Alert.alert('Payment started', result?.checkout_url
        ? 'Opening the payment page…'
        : 'Your payment was accepted.');
      billing.reload();
      loadPayments();
    } catch (e) {
      // the server's message is the truth (today: "pay at the front desk")
      Alert.alert('Online payment unavailable', e.message || 'Please try again later.');
    } finally {
      setPayingCharge(null);
    }
  };

  // ── M11: submit payment proof (evidence for admin verification) ────────
  const pickScreenshot = async () => {
    // Best effort only: on iOS 14+ (PHPicker) and Android 13+ (system photo
    // picker) selecting an image needs NO media-library permission, and the
    // request can answer granted:false (limited access, stale OS reply) even
    // when picking works — so never hard-block on it.
    await ImagePicker.requestMediaLibraryPermissionsAsync().catch(() => {});
    let result;
    try {
      result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.7,
        base64: true,
        allowsMultipleSelection: false,
      });
    } catch (e) {
      Alert.alert(
        'Could not open gallery',
        'Allow photo access for this app in Settings, then try again.'
      );
      return;
    }
    if (result.canceled || !result.assets?.[0]?.base64) return;
    const asset = result.assets[0];
    const mime = asset.mimeType || 'image/jpeg';
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
      Alert.alert('Unsupported file', 'Use a PNG, JPEG or WEBP screenshot.');
      return;
    }
    setScreenshot({ base64: asset.base64, mime });
  };

  const openSubmit = (charge) => {
    setSubmitCharge(charge);
    setProofForm({
      amount: String(charge.outstanding_cents / 100),
      method: 'UPI',
      transaction_id: '',
      paid_on: new Date().toISOString().slice(0, 10),
      notes: '',
    });
    setScreenshot(null);
    setSubmitOpen(true);
  };

  const submitProof = async () => {
    if (proofBusy || !submitCharge) return; // duplicate tap guard
    const txn = proofForm.transaction_id.trim();
    if (txn.length < 4) return Alert.alert('Missing details', 'Enter the transaction ID (min 4 characters).');
    if (!screenshot) return Alert.alert('Missing screenshot', 'Attach a payment screenshot for verification.');
    setProofBusy(true);
    try {
      await submitPaymentProof({
        charge_id: submitCharge.id,
        amount_cents: Math.round(Number(proofForm.amount) * 100),
        method: proofForm.method,
        transaction_id: txn,
        paid_on: proofForm.paid_on,
        notes: proofForm.notes || undefined,
        screenshot_base64: screenshot.base64,
        content_type: screenshot.mime,
      });
      Alert.alert('Submitted', 'Your payment proof is pending verification by the gym.');
      setSubmitOpen(false);
      setSubmitCharge(null);
      billing.reload();
      loadPayments();
      loadProofs();
    } catch (e) {
      Alert.alert('Could not submit', e.message || 'Please try again later.');
    } finally {
      setProofBusy(false);
    }
  };

  const cancelProof = (proof) => {
    Alert.alert(
      'Cancel payment verification request?',
      'This will cancel the submitted payment proof.\nYour original membership due will remain unpaid.',
      [
        { text: 'Keep Request', style: 'cancel' },
        {
          text: 'Cancel Request', style: 'destructive',
          onPress: async () => {
            try {
              await cancelMyPaymentProof(proof.id);
              Alert.alert('Cancelled', 'Your payment verification request was cancelled.');
              billing.reload();
              loadPayments();
              loadProofs();
            } catch (e) {
              Alert.alert('Could not cancel', e.message || 'Please try again later.');
            }
          },
        },
      ]
    );
  };

  // ── View Receipt: ownership-checked server fetch. Duplicate taps guarded
  // by receiptLoading; a 404 (expired/removed link) and network failures
  // surface as alerts instead of dead taps.
  const openReceipt = async (payment) => {
    if (receiptLoading) return; // duplicate tap guard
    setReceiptLoading(payment.id);
    try {
      const r = await fetchMyReceipt(payment.id);
      setReceipt(r);
    } catch (e) {
      Alert.alert(
        'Receipt unavailable',
        e.message || 'The receipt link is no longer valid. Pull down to refresh and try again.'
      );
    } finally {
      setReceiptLoading(null);
    }
  };

  // ── Share Receipt: RN Share (the app's existing share surface — the same
  // mechanism the trainer invite code uses). Sharing failures are silent by
  // platform contract (user dismisses the sheet).
  const shareReceipt = async () => {
    if (!receipt || sharing) return;
    setSharing(true);
    try {
      const period = receipt.covered_period
        ? `\nCovered period: ${receipt.covered_period.from} → ${receipt.covered_period.to}`
        : '';
      await Share.share({
        title: `Receipt ${receipt.receipt_number}`,
        message:
          `Receipt ${receipt.receipt_number}\n` +
          `${receipt.gym.name}\n` +
          `Member: ${receipt.member.name} (${receipt.member.member_code})\n` +
          `${receipt.plan}\n` +
          `Amount: ${formatMoney(receipt.amount_cents, receipt.currency)}\n` +
          `Date: ${receipt.date}\n` +
          `Method: ${receipt.method}${period}\n` +
          `Status: ${receipt.status}`,
      });
    } catch {
      // dismissed by the user — not an error
    } finally {
      setSharing(false);
    }
  };

  if (!gymId) {
    return (
      <View style={[styles.container, { paddingTop: spacing.xl }]}>
        <Text style={styles.meta}>No active gym.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      {/* ── dues ─────────────────────────────────────────────────────────── */}
      <Text style={styles.sectionTitle}>Payment Due</Text>
      {billing.error && !billing.data ? (
        <LoadError message="Couldn't load your dues." onRetry={billing.reload} />
      ) : !myBilling ? (
        <View style={styles.card}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : openCharges.length === 0 ? (
        <View style={styles.card}>
          <View style={styles.settledRow}>
            <Ionicons name="checkmark-circle" size={20} color={colors.green} />
            <View style={{ flex: 1 }}>
              <Text style={styles.settledText}>All settled</Text>
              <Text style={styles.meta}>No dues right now.</Text>
            </View>
          </View>
        </View>
      ) : (
        openCharges.map((c) => {
          const cColor = STATUS_COLORS[c.status] || colors.text;
          return (
            <View key={c.id} style={styles.card}>
              <View style={styles.duesRow}>
                <Text style={styles.duesTitle}>Payment Due</Text>
                <View style={[styles.badge, { backgroundColor: `${cColor}22` }]}>
                  <Text style={[styles.badgeText, { color: cColor }]}>{c.status}</Text>
                </View>
              </View>
              <Text style={[styles.duesAmount, { color: c.status === 'OVERDUE' ? colors.red : colors.text }]}>
                {formatMoney(c.outstanding_cents, c.currency)}
              </Text>
              <Text style={styles.meta}>
                {c.description}
              </Text>
              <Text style={styles.meta}>
                {c.status === 'OVERDUE' ? 'Was due ' : 'Due '}
                {formatDayMonthYear(c.due_on) || String(c.due_on || '').slice(0, 10)}
                {c.period_start ? ` · ${c.period_start} → ${c.period_end}` : ''}
              </Text>
              <TouchableOpacity
                style={[styles.payBtn, { backgroundColor: colors.primary }]}
                onPress={() => openSubmit(c)}
                accessibilityRole="button"
                accessibilityLabel={`Submit payment proof for ${formatMoney(c.outstanding_cents, c.currency)}`}
              >
                <Text style={styles.payBtnText}>Submit Payment Proof</Text>
              </TouchableOpacity>
              {myBilling.online_payment_available && payingCharge !== c.id && (
                <TouchableOpacity
                  style={[styles.payBtn, { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.primary }]}
                  onPress={() => doPayOnline(c)}
                  disabled={payingCharge != null}
                >
                  <Text style={[styles.payBtnText, { color: colors.primary }]}>Pay online instead</Text>
                </TouchableOpacity>
              )}
              {!myBilling.online_payment_available && (
                <Text style={styles.frontDeskNote}>
                  Online payments aren&apos;t available yet — submit a proof or pay at the front desk.
                </Text>
              )}
            </View>
          );
        })
      )}

      {/* ── pending verification (M11) ───────────────────────────────────── */}
      {(proofs || []).some((p) => p.status === 'PENDING_VERIFICATION') && (
        <>
          <Text style={styles.sectionTitle}>Pending Verification</Text>
          {(proofs || []).filter((p) => p.status === 'PENDING_VERIFICATION').map((p) => (
            <View key={p.id} style={styles.card}>
              <View style={styles.duesRow}>
                <Text style={[styles.duesAmount, { color: colors.text }]}>
                  {formatMoney(p.amount_cents, p.currency)}
                </Text>
                <View style={[styles.badge, { backgroundColor: '#D9770622' }]}>
                  <Text style={[styles.badgeText, { color: '#D97706' }]}>PENDING VERIFICATION</Text>
                </View>
              </View>
              <Text style={styles.meta}>
                {p.method} · Txn {p.transaction_id}
              </Text>
              <Text style={styles.meta}>
                Submitted {String(p.created_at).slice(0, 10)} — being reviewed by the gym.
              </Text>
              <TouchableOpacity
                style={[styles.cancelProofBtn, { borderColor: colors.red }]}
                onPress={() => cancelProof(p)}
                accessibilityRole="button"
                accessibilityLabel="Cancel payment verification request"
              >
                <Text style={[styles.cancelProofText, { color: colors.red }]}>Cancel Request</Text>
              </TouchableOpacity>
            </View>
          ))}
        </>
      )}

      {/* ── payment history ──────────────────────────────────────────────── */}
      <Text style={styles.sectionTitle}>Payments</Text>
      {paymentsError ? (
        <LoadError
          message={paymentsError.message || "Couldn't load your payments."}
          onRetry={loadPayments}
        />
      ) : !payments || payments.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.meta}>No payments recorded yet.</Text>
        </View>
      ) : (
        <View style={styles.card}>
          {(payments || []).map((p, i) => {
            const pColor = STATUS_COLORS[p.status] || colors.textDim;
            return (
              <TouchableOpacity
                key={p.id}
                style={[styles.payRow, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }]}
                onPress={() => openReceipt(p)}
                disabled={receiptLoading === p.id}
                accessibilityRole="button"
                accessibilityLabel={`View receipt for ${formatMoney(p.amount_cents, p.currency)} paid ${p.paid_on}`}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.payAmount}>{formatMoney(p.amount_cents, p.currency)}</Text>
                  <Text style={styles.meta}>
                    {formatDayMonthYear(p.paid_on) || String(p.paid_on || '').slice(0, 10)} · {p.method}
                    {p.receiptLoading ? ' · loading…' : ''}
                  </Text>
                </View>
                {receiptLoading === p.id ? (
                  <ActivityIndicator color={colors.primary} size="small" />
                ) : (
                  <View style={[styles.badge, { backgroundColor: `${pColor}22` }]}>
                    <Text style={[styles.badgeText, { color: pColor }]}>{p.status}</Text>
                  </View>
                )}
                <Ionicons name="chevron-forward" size={15} color={colors.textDim} />
              </TouchableOpacity>
            );
          })}
        </View>
      )}

      {/* ── submit payment proof (M11) ────────────────────────────────────── */}
      <Modal visible={submitOpen} animationType="slide" transparent onRequestClose={() => setSubmitOpen(false)}>
        <View style={styles.sheetBackdrop}>
          <View style={[styles.sheet, { backgroundColor: colors.card }]}>
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: colors.text }]}>Submit Payment</Text>
              <TouchableOpacity onPress={() => setSubmitOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={colors.textDim} />
              </TouchableOpacity>
            </View>
            {/* scrollable body: the form is taller than the sheet on small
                screens and when the keyboard is open — without this the
                Submit button sits below the fold and is unreachable */}
            <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, flexShrink: 1 }}>
            {submitCharge && (
              <Text style={[styles.meta, { marginBottom: spacing.sm }]}>
                {submitCharge.description} — outstanding {formatMoney(submitCharge.outstanding_cents, submitCharge.currency)}
              </Text>
            )}
            <Text style={styles.label}>Amount (₹)</Text>
            <TextInput
              style={styles.input}
              keyboardType="decimal-pad"
              value={proofForm.amount}
              onChangeText={(v) => setProofForm((f) => ({ ...f, amount: v }))}
            />
            <Text style={styles.label}>Payment method</Text>
            <View style={styles.roleRow}>
              {['UPI', 'CARD', 'BANK_TRANSFER', 'OTHER'].map((m) => (
                <TouchableOpacity
                  key={m}
                  style={[styles.genderChip, proofForm.method === m && styles.genderChipOn]}
                  onPress={() => setProofForm((f) => ({ ...f, method: m }))}
                >
                  <Text style={[styles.genderChipText, proofForm.method === m && styles.genderChipTextOn]}>{m}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.label}>Transaction ID</Text>
            <TextInput
              style={styles.input}
              placeholder="UPI reference / txn number"
              value={proofForm.transaction_id}
              onChangeText={(v) => setProofForm((f) => ({ ...f, transaction_id: v }))}
            />
            <Text style={styles.label}>Payment date (YYYY-MM-DD)</Text>
            <TextInput
              style={styles.input}
              keyboardType="numbers-and-punctuation"
              value={proofForm.paid_on}
              onChangeText={(v) => setProofForm((f) => ({ ...f, paid_on: v }))}
            />
            <Text style={styles.label}>Payment screenshot</Text>
            <TouchableOpacity style={[styles.proofModalShot, { justifyContent: 'center', alignItems: 'center' }]}
              onPress={pickScreenshot}>
              {screenshot ? (
                <Text style={[styles.genderChipText, { color: colors.green }]}>Screenshot attached ✓ (tap to change)</Text>
              ) : (
                <Text style={[styles.genderChipText, { color: colors.textDim }]}>Tap to attach a screenshot</Text>
              )}
            </TouchableOpacity>
            <Text style={styles.label}>Notes (optional)</Text>
            <TextInput
              style={styles.input}
              value={proofForm.notes}
              onChangeText={(v) => setProofForm((f) => ({ ...f, notes: v }))}
            />
            <TouchableOpacity
              style={[styles.payBtn, { backgroundColor: colors.primary, marginTop: spacing.sm }]}
              onPress={submitProof}
              disabled={proofBusy}
            >
              {proofBusy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.payBtnText}>Submit for Verification</Text>
              )}
            </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* ── receipt viewer (View Receipt) ────────────────────────────────── */}
      <Modal visible={!!receipt} animationType="slide" transparent onRequestClose={() => setReceipt(null)}>
        <View style={styles.sheetBackdrop}>
          <View style={[styles.sheet, { backgroundColor: colors.card }]}>
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: colors.text }]}>Receipt</Text>
              <TouchableOpacity onPress={() => setReceipt(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={colors.textDim} />
              </TouchableOpacity>
            </View>
            {receipt && (
              <ScrollView style={{ maxHeight: 420 }}>
                <View style={[styles.receiptCard, { borderColor: colors.border }]}>
                  <Text style={[styles.receiptGym, { color: colors.text }]}>{receipt.gym.name}</Text>
                  {receipt.gym.address ? (
                    <Text style={[styles.receiptMeta, { color: colors.textDim }]}>{receipt.gym.address}</Text>
                  ) : null}
                  <View style={[styles.receiptDivider, { borderBottomColor: colors.border }]} />
                  <View style={styles.receiptRow}>
                    <Text style={[styles.receiptLabel, { color: colors.textDim }]}>Receipt #</Text>
                    <Text style={[styles.receiptValue, { color: colors.text }]}>{receipt.receipt_number}</Text>
                  </View>
                  <View style={styles.receiptRow}>
                    <Text style={[styles.receiptLabel, { color: colors.textDim }]}>Member</Text>
                    <Text style={[styles.receiptValue, { color: colors.text }]}>
                      {receipt.member.name} ({receipt.member.member_code})
                    </Text>
                  </View>
                  <View style={styles.receiptRow}>
                    <Text style={[styles.receiptLabel, { color: colors.textDim }]}>Membership</Text>
                    <Text style={[styles.receiptValue, { color: colors.text }]}>{receipt.plan}</Text>
                  </View>
                  {receipt.covered_period && (
                    <View style={styles.receiptRow}>
                      <Text style={[styles.receiptLabel, { color: colors.textDim }]}>Covered period</Text>
                      <Text style={[styles.receiptValue, { color: colors.text }]}>
                        {receipt.covered_period.from} → {receipt.covered_period.to}
                      </Text>
                    </View>
                  )}
                  <View style={styles.receiptRow}>
                    <Text style={[styles.receiptLabel, { color: colors.textDim }]}>Date</Text>
                    <Text style={[styles.receiptValue, { color: colors.text }]}>{receipt.date}</Text>
                  </View>
                  <View style={styles.receiptRow}>
                    <Text style={[styles.receiptLabel, { color: colors.textDim }]}>Method</Text>
                    <Text style={[styles.receiptValue, { color: colors.text }]}>{receipt.method}</Text>
                  </View>
                  <View style={styles.receiptRow}>
                    <Text style={[styles.receiptLabel, { color: colors.textDim }]}>Status</Text>
                    <Text style={[styles.receiptValue, { color: STATUS_COLORS[receipt.status] || colors.text }]}>
                      {receipt.status}
                    </Text>
                  </View>
                  <View style={[styles.receiptDivider, { borderBottomColor: colors.border }]} />
                  <View style={styles.receiptRow}>
                    <Text style={[styles.receiptTotal, { color: colors.text }]}>Total paid</Text>
                    <Text style={[styles.receiptTotal, { color: colors.text }]}>
                      {formatMoney(receipt.amount_cents, receipt.currency)}
                    </Text>
                  </View>
                </View>
                <TouchableOpacity
                  style={[styles.shareBtn, { backgroundColor: colors.primary }]}
                  onPress={shareReceipt}
                  disabled={sharing}
                  accessibilityRole="button"
                  accessibilityLabel="Share receipt"
                >
                  {sharing ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="share-social-outline" size={16} color="#fff" />
                      <Text style={styles.shareBtnText}>Share Receipt</Text>
                    </>
                  )}
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  sectionTitle: {
    color: colors.text, fontSize: 16, fontWeight: '800',
    marginTop: spacing.md, marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  duesRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  duesTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  duesAmount: { fontSize: 30, fontWeight: '900', marginBottom: spacing.xs },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  meta: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  payBtn: {
    marginTop: spacing.md, paddingVertical: 12, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  payBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  frontDeskNote: {
    marginTop: spacing.md, color: colors.textDim, fontSize: 12, fontStyle: 'italic',
  },
  cancelProofBtn: {
    marginTop: spacing.md, paddingVertical: 10, borderRadius: 10,
    borderWidth: 1, alignItems: 'center',
  },
  cancelProofText: { fontSize: 13, fontWeight: '700' },
  proofModalShot: {
    width: '100%', height: 180, borderRadius: 10, marginBottom: spacing.sm,
    backgroundColor: colors.cardLight,
  },
  settledRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  settledText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  payRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    paddingVertical: spacing.sm + 2,
  },
  payAmount: { color: colors.text, fontSize: 15, fontWeight: '800' },
  sheetBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    padding: spacing.lg, maxHeight: '85%',
  },
  sheetHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: spacing.md,
  },
  sheetTitle: { fontSize: 17, fontWeight: '800' },
  receiptCard: {
    borderWidth: 1, borderRadius: 12, padding: spacing.md, marginBottom: spacing.md,
  },
  receiptGym: { fontSize: 16, fontWeight: '900', textAlign: 'center' },
  receiptMeta: { fontSize: 11, textAlign: 'center', marginBottom: spacing.sm },
  receiptDivider: { borderBottomWidth: StyleSheet.hairlineWidth, marginVertical: spacing.sm },
  receiptRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 4,
  },
  receiptLabel: { fontSize: 12 },
  receiptValue: { fontSize: 12, fontWeight: '700', maxWidth: '60%', textAlign: 'right' },
  receiptTotal: { fontSize: 15, fontWeight: '900' },
  shareBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm,
    paddingVertical: 12, borderRadius: 10, marginBottom: spacing.md,
  },
  shareBtnText: { color: '#fff', fontSize: 14, fontWeight: '800' },
  label: { color: colors.textDim, fontSize: 12, marginBottom: 6, marginTop: 10 },
  input: {
    backgroundColor: colors.cardLight, color: colors.text, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, marginBottom: 10, fontSize: 14,
  },
  roleRow: { flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
  genderChip: {
    flex: 1, minWidth: 70, backgroundColor: colors.cardLight, borderRadius: 10,
    borderWidth: 2, borderColor: 'transparent', paddingVertical: 8, alignItems: 'center',
  },
  genderChipOn: { borderColor: colors.primary },
  genderChipText: { color: colors.text, fontSize: 11, fontWeight: '600' },
  genderChipTextOn: { color: colors.primary, fontWeight: '800' },
});
