// Gym Invitation gate (Mobile M4) — presents a gym invitation and performs
// the secure account linking. Rendered as a full-screen overlay by App.js
// whenever InvitationContext holds a pending token — ABOVE whichever
// navigator tree is mounted (auth stack or main tabs), so the flow behaves
// identically logged-in, logged-out, cold-started, resumed or mid-session.
//
// THE SECURITY MODEL (all server-side; this screen only presents):
//   • the token is the bearer credential — preview/decline are public;
//     NOTHING here can claim a member by id (no id input exists)
//   • Scenario 1 (has account): accept requires the JWT; the backend links
//     only when the logged-in email EXACTLY matches the invited email —
//     a different logged-in account gets the mismatch card and the server
//     still refuses (403) even if the UI were bypassed
//   • Scenario 2 (no account): registration happens THROUGH the token —
//     the new User's email IS the invitation's email (client never sends
//     one), and the existing GymMember is linked, never duplicated
//   • every terminal state / expired / cancelled / suspended-gym verdict
//     comes from the backend and is rendered as-is
//
// After a successful accept or register the Gym context reloads, so My Gym
// appears immediately — no reinstall, no data clearing.
import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator,
  TextInput, KeyboardAvoidingView, Platform, Modal, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import { useAuth } from '../store/AuthContext';
import { useInvitation } from '../store/InvitationContext';
import { useGym } from '../store/GymContext';
import {
  fetchInvitationPreview, acceptInvitationByToken, declineInvitationByToken,
  registerWithInvitation, describeInvitationState, gymUnavailableReason, emailsMatch,
} from '../lib/gymInvites';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function GymInvitationScreen({ onClose, onGoToGym }) {
  const colors = useColors();
  const { user, authStatus, login, logout } = useAuth();
  const { token, close } = useInvitation();
  const { reload } = useGym();

  const [inv, setInv] = useState(null); // preview payload
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null); // { message, notFound }
  const [busy, setBusy] = useState(null); // 'accept' | 'decline' | 'login' | 'register'
  const [actionError, setActionError] = useState(null);
  const [stage, setStage] = useState('preview'); // preview | login | register | success
  const [connected, setConnected] = useState(null); // { gymName } after linking
  // form fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [name, setName] = useState('');

  const styles = makeStyles(colors);

  const loadPreview = useCallback(async (silent = false) => {
    if (!token) return;
    if (!silent) setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchInvitationPreview(token);
      setInv(data);
    } catch (e) {
      setLoadError({
        message: e?.message || "Couldn't load this invitation.",
        notFound: e?.status === 404,
      });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    setStage('preview');
    setActionError(null);
    loadPreview();
    // prefill the invited email for the login/register stages
    // (refetched preview keeps it current)
  }, [loadPreview]);

  useEffect(() => {
    if (inv?.email) setEmail(inv.email);
  }, [inv?.email]);

  // Any action failure may mean the state moved (already accepted,
  // cancelled since…) — silently re-sync the preview afterwards.
  const afterActionError = () => loadPreview(true);

  const doAccept = async () => {
    if (busy) return;
    setBusy('accept');
    setActionError(null);
    try {
      const result = await acceptInvitationByToken(token);
      setConnected({ gymName: result?.gymName || inv?.gymName || 'your gym' });
      setStage('success');
      reload(); // Gym section becomes available immediately
    } catch (e) {
      setActionError(e?.message || 'Could not accept this invitation.');
      afterActionError();
    } finally {
      setBusy(null);
    }
  };

  const confirmDecline = () => {
    Alert.alert(
      'Decline invitation?',
      `${inv?.gymName || 'Your gym'} would need to invite you again.`,
      [
        { text: 'Keep it', style: 'cancel' },
        { text: 'Decline', style: 'destructive', onPress: doDecline },
      ],
      { cancelable: true }
    );
  };

  const doDecline = async () => {
    if (busy) return;
    setBusy('decline');
    setActionError(null);
    try {
      await declineInvitationByToken(token);
      await loadPreview(true); // renders the DECLINED state card
    } catch (e) {
      setActionError(e?.message || 'Could not decline this invitation.');
      afterActionError();
    } finally {
      setBusy(null);
    }
  };

  const doLogin = async () => {
    if (busy) return;
    if (!EMAIL_RE.test(email.trim()) || !password) {
      setActionError('Enter the email and password for your account.');
      return;
    }
    setBusy('login');
    setActionError(null);
    try {
      await login(email.trim(), password);
      // authenticated now — the preview view re-renders with Accept/Decline
      setStage('preview');
      setPassword('');
    } catch (e) {
      setActionError(e?.message || 'Login failed.');
    } finally {
      setBusy(null);
    }
  };

  const doRegister = async () => {
    if (busy) return;
    if (!name.trim()) return setActionError('Enter your name');
    if (password.length < 8) return setActionError('Password must be at least 8 characters');
    if (password !== confirm) return setActionError('Passwords do not match');
    setBusy('register');
    setActionError(null);
    try {
      // The email is NOT sent — the backend derives it from the invitation.
      await registerWithInvitation(token, { name: name.trim(), password });
      // No session comes back — log in with the credentials just entered.
      await login(inv.email, password);
      setConnected({ gymName: inv?.gymName || 'your gym' });
      setStage('success');
      reload();
    } catch (e) {
      setActionError(e?.message || 'Could not create the account.');
      if (e?.status === 409) {
        // email already registered → the invitation flow becomes a login
        setStage('login');
      }
    } finally {
      setBusy(null);
    }
  };

  const switchToInvitedAccount = async () => {
    if (busy) return;
    setBusy('decline');
    try {
      await logout();
      setStage('preview');
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    await close();
    onClose?.();
  };

  const goToMyGym = async () => {
    await close();
    onClose?.();
    onGoToGym?.();
  };

  // ── derived presentation state ──
  const authed = authStatus === 'authenticated' && !!user;
  const stateInfo = inv ? describeInvitationState(inv.status) : null;
  const unavailable = inv ? gymUnavailableReason(inv.gymStatus) : null;
  const memberInactive = inv?.type === 'member' && inv.memberStatus && inv.memberStatus !== 'ACTIVE' && inv.status === 'PENDING';
  const pending = inv?.status === 'PENDING';
  const matches = authed && inv ? emailsMatch(user.email, inv.email) : false;
  const mismatch = authed && inv && inv.status === 'PENDING' && !matches;

  const roleLabel = (inv?.role || 'MEMBER')
    .split('_')
    .map((w) => (w ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ');

  const renderRow = (label, value) => (
    <View style={styles.detailRow} key={label}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} numberOfLines={1}>{value || '—'}</Text>
    </View>
  );

  const body = () => {
    if (loading) {
      return (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.loadingText}>Loading invitation…</Text>
        </View>
      );
    }
    if (loadError) {
      return (
        <View style={styles.center}>
          <Ionicons
            name={loadError.notFound ? 'search-outline' : 'cloud-offline-outline'}
            size={40}
            color={colors.textDim}
          />
          <Text style={styles.cardTitle}>
            {loadError.notFound ? 'Invitation not found' : 'Could not load invitation'}
          </Text>
          <Text style={styles.bodyText}>
            {loadError.notFound
              ? 'This link is unknown or no longer valid. Check the link, or ask your gym for a fresh invitation.'
              : loadError.message}
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={() => loadPreview()}>
            <Text style={styles.primaryBtnText}>Try again</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.ghostBtn} onPress={finish}>
            <Text style={styles.ghostBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      );
    }
    if (!inv) return null;

    // ── success (post accept / register) ──
    if (stage === 'success') {
      return (
        <View style={styles.center}>
          <View style={[styles.successIcon, { backgroundColor: '#16A34A22' }]}>
            <Ionicons name="checkmark-circle" size={44} color="#16A34A" />
          </View>
          <Text style={styles.cardTitle}>You're connected!</Text>
          <Text style={styles.bodyText}>
            Your {connected?.gymName || 'gym'} membership is now linked to this account.
            Your gym's programs, classes and documents are ready under Profile → My Gym.
          </Text>
          {authed && (
            <TouchableOpacity style={styles.primaryBtn} onPress={goToMyGym}>
              <Ionicons name="business-outline" size={15} color="#fff" />
              <Text style={styles.primaryBtnText}>Go to My Gym</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.ghostBtn} onPress={finish}>
            <Text style={styles.ghostBtnText}>Done</Text>
          </TouchableOpacity>
        </View>
      );
    }

    // ── terminal states (expired / cancelled / declined / already accepted) ──
    if (stateInfo) {
      const toneColor = stateInfo.tone === 'ok' ? '#16A34A'
        : stateInfo.tone === 'warn' ? '#D97706' : colors.textDim;
      return (
        <View style={styles.center}>
          <View style={[styles.successIcon, { backgroundColor: `${toneColor}22` }]}>
            <Ionicons name={stateInfo.icon} size={40} color={toneColor} />
          </View>
          <Text style={styles.cardTitle}>{stateInfo.title}</Text>
          <Text style={styles.bodyText}>{stateInfo.body}</Text>
          {inv.status === 'ACCEPTED' && authed && (
            <TouchableOpacity style={styles.primaryBtn} onPress={goToMyGym}>
              <Text style={styles.primaryBtnText}>Open My Gym</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.ghostBtn} onPress={finish}>
            <Text style={styles.ghostBtnText}>Close</Text>
          </TouchableOpacity>
        </View>
      );
    }

    // ── PENDING invitation card ──
    return (
      <View>
        <View style={styles.heroRow}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{(inv.gymName || 'G').slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.headline}>
              {inv.gymName || 'A gym'} invited you to join their gym.
            </Text>
            <Text style={styles.invitedAt}>Invited {formatDate(inv.invitedAt)}</Text>
          </View>
        </View>

        <View style={styles.detailsCard}>
          {renderRow('Gym', inv.gymName)}
          {renderRow('Role', roleLabel)}
          {renderRow('Membership', inv.membershipPlan)}
          {inv.memberName ? renderRow('Member record', inv.memberName) : null}
          {renderRow('Invited email', inv.email)}
        </View>

        {unavailable && (
          <View style={[styles.noteCard, { borderLeftColor: '#DC2626' }]}>
            <Ionicons name="warning-outline" size={16} color="#DC2626" />
            <Text style={[styles.noteText, { color: '#DC2626' }]}>{unavailable}</Text>
          </View>
        )}
        {!unavailable && memberInactive && (
          <View style={[styles.noteCard, { borderLeftColor: '#D97706' }]}>
            <Ionicons name="information-circle-outline" size={16} color="#D97706" />
            <Text style={[styles.noteText, { color: '#D97706' }]}>
              This membership record is {String(inv.memberStatus).toLowerCase()} — ask the gym to reactivate it before connecting.
            </Text>
          </View>
        )}

        {actionError && (
          <View style={[styles.noteCard, { borderLeftColor: '#DC2626' }]}>
            <Ionicons name="alert-circle-outline" size={16} color="#DC2626" />
            <Text style={[styles.noteText, { color: '#DC2626' }]}>{actionError}</Text>
          </View>
        )}

        {stage === 'login' && (
          <View style={styles.formCard}>
            <Text style={styles.formTitle}>Log in to accept</Text>
            <Text style={styles.formHint}>
              Sign in with the account this invitation was sent to ({inv.email}).
            </Text>
            <TextInput
              style={styles.input}
              value={email}
              onChangeText={setEmail}
              placeholder="Email"
              placeholderTextColor={colors.textDim}
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="Password"
              placeholderTextColor={colors.textDim}
              secureTextEntry
            />
            <TouchableOpacity
              style={[styles.primaryBtn, busy === 'login' && { opacity: 0.5 }]}
              onPress={doLogin}
              disabled={busy === 'login'}
            >
              {busy === 'login'
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.primaryBtnText}>Log in</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.ghostBtn} onPress={() => { setStage('preview'); setActionError(null); }}>
              <Text style={styles.ghostBtnText}>Back</Text>
            </TouchableOpacity>
          </View>
        )}

        {stage === 'register' && (
          <View style={styles.formCard}>
            <Text style={styles.formTitle}>Create your account</Text>
            <Text style={styles.formHint}>
              Your account will use {inv.email} — the email your gym invited. Set a
              password and you're in.
            </Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Your full name"
              placeholderTextColor={colors.textDim}
              autoCapitalize="words"
            />
            <TextInput
              style={styles.input}
              value={password}
              onChangeText={setPassword}
              placeholder="Password (min 8 characters)"
              placeholderTextColor={colors.textDim}
              secureTextEntry
            />
            <TextInput
              style={styles.input}
              value={confirm}
              onChangeText={setConfirm}
              placeholder="Confirm password"
              placeholderTextColor={colors.textDim}
              secureTextEntry
            />
            <TouchableOpacity
              style={[styles.primaryBtn, busy === 'register' && { opacity: 0.5 }]}
              onPress={doRegister}
              disabled={busy === 'register'}
            >
              {busy === 'register'
                ? <ActivityIndicator size="small" color="#fff" />
                : <Text style={styles.primaryBtnText}>Create account & connect</Text>}
            </TouchableOpacity>
            <TouchableOpacity style={styles.ghostBtn} onPress={() => { setStage('preview'); setActionError(null); }}>
              <Text style={styles.ghostBtnText}>Back</Text>
            </TouchableOpacity>
          </View>
        )}

        {stage === 'preview' && !unavailable && (
          <>
            {pending && authed && matches && (
              <View style={styles.actionsRow}>
                <TouchableOpacity
                  style={[styles.declineBtn, busy && { opacity: 0.5 }]}
                  onPress={confirmDecline}
                  disabled={!!busy}
                  accessibilityRole="button"
                  accessibilityLabel={`Decline the ${inv.gymName || 'gym'} invitation`}
                >
                  <Text style={styles.declineBtnText}>Decline</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.acceptBtn, busy && { opacity: 0.5 }]}
                  onPress={doAccept}
                  disabled={!!busy}
                  accessibilityRole="button"
                  accessibilityLabel={`Accept the ${inv.gymName || 'gym'} invitation`}
                >
                  {busy === 'accept'
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={styles.acceptBtnText}>Accept</Text>}
                </TouchableOpacity>
              </View>
            )}

            {pending && authed && mismatch && (
              <View style={styles.mismatchCard}>
                <Ionicons name="person-circle-outline" size={20} color="#D97706" />
                <Text style={styles.mismatchTitle}>Different account</Text>
                <Text style={styles.mismatchBody}>
                  You're signed in as {user.email}, but this invitation was sent to{' '}
                  {inv.email}. Only that account can accept it.
                </Text>
                <View style={styles.mismatchActions}>
                  <TouchableOpacity
                    style={[styles.ghostBtn, { flex: 1, marginTop: 0 }]}
                    onPress={confirmDecline}
                    disabled={!!busy}
                  >
                    <Text style={styles.ghostBtnText}>Decline</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.primaryBtn, { flex: 1.4, marginTop: 0 }, busy && { opacity: 0.5 }]}
                    onPress={switchToInvitedAccount}
                    disabled={!!busy}
                  >
                    {busy === 'decline'
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Text style={styles.primaryBtnText}>Switch account</Text>}
                  </TouchableOpacity>
                </View>
              </View>
            )}

            {pending && !authed && authStatus !== 'checking' && (
              <View style={styles.actionsColumn}>
                <TouchableOpacity
                  style={styles.acceptBtn}
                  onPress={() => { setActionError(null); setStage('login'); }}
                  accessibilityRole="button"
                  accessibilityLabel="Log in to accept the invitation"
                >
                  <Text style={styles.acceptBtnText}>Log in to accept</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.ghostBtn}
                  onPress={() => { setActionError(null); setStage('register'); }}
                >
                  <Text style={styles.ghostBtnText}>Create an account</Text>
                </TouchableOpacity>
              </View>
            )}

            <Text style={styles.securityNote}>
              Verified by your gym. The invitation can only be used with{' '}
              {inv.email} — never shared or claimed by another account.
            </Text>
          </>
        )}
      </View>
    );
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={finish}>
      <KeyboardAvoidingView
        style={styles.screen}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.topBar}>
            <TouchableOpacity
              style={styles.closeBtn}
              onPress={finish}
              accessibilityRole="button"
              accessibilityLabel="Close the invitation"
            >
              <Ionicons name="close" size={22} color={colors.textDim} />
            </TouchableOpacity>
          </View>
          {body()}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  scroll: { flexGrow: 1, padding: 24, paddingTop: 8 },
  topBar: { flexDirection: 'row', justifyContent: 'flex-end' },
  closeBtn: { padding: 6 },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48 },
  loadingText: { color: colors.textDim, marginTop: 14, fontSize: 13 },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 18 },
  avatar: {
    width: 56, height: 56, borderRadius: 18, backgroundColor: colors.primary,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 24, fontWeight: '900' },
  headline: { color: colors.text, fontSize: 17, fontWeight: '800', lineHeight: 23 },
  invitedAt: { color: colors.textDim, fontSize: 12, marginTop: 3 },
  detailsCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    marginTop: 18,
    paddingHorizontal: 14,
  },
  detailRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 11,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
  },
  detailLabel: { color: colors.textDim, fontSize: 12.5 },
  detailValue: { color: colors.text, fontSize: 13.5, fontWeight: '700', marginLeft: 12, flexShrink: 1 },
  noteCard: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: colors.card,
    borderLeftWidth: 3,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 12,
  },
  noteText: { fontSize: 12.5, lineHeight: 18, flex: 1 },
  actionsRow: { flexDirection: 'row', gap: 10, marginTop: 18 },
  actionsColumn: { gap: 10, marginTop: 18 },
  acceptBtn: {
    flex: 1.4,
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
  },
  acceptBtnText: { color: '#fff', fontWeight: '800', fontSize: 14.5 },
  declineBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  declineBtnText: { color: colors.textDim, fontWeight: '800', fontSize: 14.5 },
  primaryBtn: {
    backgroundColor: colors.primary,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    marginTop: 16,
    alignSelf: 'stretch',
  },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  ghostBtn: {
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 20,
    alignItems: 'center',
    marginTop: 10,
    alignSelf: 'stretch',
  },
  ghostBtnText: { color: colors.textDim, fontWeight: '700', fontSize: 14 },
  formCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 14,
    marginTop: 16,
  },
  formTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
  formHint: { color: colors.textDim, fontSize: 12, lineHeight: 17, marginTop: 4, marginBottom: 12 },
  input: {
    backgroundColor: colors.bg,
    color: colors.text,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 10,
  },
  mismatchCard: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 14,
    marginTop: 14,
  },
  mismatchTitle: { color: colors.text, fontWeight: '800', fontSize: 14, marginTop: 6 },
  mismatchBody: { color: colors.textDim, fontSize: 12.5, lineHeight: 18, marginTop: 4 },
  mismatchActions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  securityNote: {
    color: colors.textDim, fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 18,
  },
  successIcon: {
    width: 72, height: 72, borderRadius: 24, alignItems: 'center', justifyContent: 'center',
  },
  cardTitle: { color: colors.text, fontSize: 17, fontWeight: '800', marginTop: 14 },
  bodyText: { color: colors.textDim, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: 8 },
});
