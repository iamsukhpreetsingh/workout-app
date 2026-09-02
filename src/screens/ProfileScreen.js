import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput, Modal, Alert, Share, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../store/AuthContext';
import { api } from '../lib/api';
import { useColors } from '../theme';
import { useHeaderActions } from '../components/HeaderActions';
import { TAB_CLIENTS, EDIT_PROFILE, INTAKE_FORM } from '../shared/constants/routes';
import ChangePasswordCard from '../components/ChangePasswordCard';
import MyGymCard from '../components/MyGymCard';

// Profile identity/info only — app preferences stay in Settings.
export default function ProfileScreen({ navigation, inTrainerView = false, onSwitchView }) {
  const colors = useColors();
  const { user, logout } = useAuth();
  const styles = makeStyles(colors);
  useHeaderActions(navigation);
  if (!user) return null;

  const isTrainer = user.role === 'trainer';
  return <ProfileBody navigation={navigation} colors={colors} styles={styles} user={user} isTrainer={isTrainer} logout={logout} inTrainerView={inTrainerView} onSwitchView={onSwitchView} />;
}

// Split so the trainer-view hook rules don't depend on the early return
function ProfileBody({ navigation, colors, styles, user, isTrainer, logout, inTrainerView, onSwitchView }) {
  const [inviteCode, setInviteCode] = useState('');
  const [assoc, setAssoc] = useState(null); // { status, trainer_name }
  const [assocMsg, setAssocMsg] = useState(null); // confirmation / error

  React.useEffect(() => {
    api('/client/trainer')
      .then(setAssoc)
      .catch(() => {});
  }, []);

  const [reconnect, setReconnect] = useState(null); // preview when is_reactivation

  // Invite code management (moved from the retired Trainer Settings tab) —
  // trainers in Trainer View generate/share the single-use client code here.
  const [invite, setInvite] = useState(null); // { code, expires_at }
  const [inviteLoading, setInviteLoading] = useState(false);
  const loadInvite = React.useCallback(async () => {
    setInviteLoading(true);
    try {
      setInvite(await api('/trainer/invite-code/latest'));
    } catch {
      setInvite(null);
    }
    setInviteLoading(false);
  }, []);
  const generateInvite = async () => {
    setInviteLoading(true);
    try {
      setInvite(await api('/trainer/invite-code', { method: 'POST' }));
    } catch (e) {
      Alert.alert('Could not generate code', e.message || 'Please try again.');
    }
    setInviteLoading(false);
  };
  const shareInvite = async () => {
    if (!invite) return;
    try {
      await Share.share({
        message: `Join me as your trainer on Workout Tracker! Invite code: ${invite.code} (valid until ${new Date(invite.expires_at).toLocaleDateString()})`,
        title: 'Trainer invite code',
      });
    } catch {}
  };
  React.useEffect(() => {
    if (inTrainerView && isTrainer) loadInvite();
  }, [inTrainerView, isTrainer, loadInvite]);

  const submitInviteCode = async () => {
    const code = inviteCode.trim().toUpperCase();
    if (!code) {
      setAssocMsg("Enter your trainer's invite code");
      return;
    }
    setAssocMsg(null);
    try {
      // preview first: reconnections need a restore/fresh preference
      const preview = await api(`/client/trainer-code-preview?code=${encodeURIComponent(code)}`);
      if (preview.is_reactivation) {
        setReconnect({ code, preview });
        return;
      }
      await sendRequest(code, null);
    } catch (e) {
      setAssocMsg(e.message || 'Could not send request'); // form keeps its value
    }
  };

  const sendRequest = async (code, restorePreference) => {
    try {
      const row = await api('/client/associations/request', {
        method: 'POST',
        body: { invite_code: code, restore_preference: restorePreference },
      });
      setInviteCode('');
      setReconnect(null);
      setAssoc({ status: row.status, trainer_name: row.trainer_name });
      setAssocMsg(row.trainer_name
        ? `Request sent to ${row.trainer_name}`
        : 'Request sent — waiting for your trainer to accept');
    } catch (e) {
      setAssocMsg(e.message || 'Could not send request');
    }
  };
  const initials = (user.name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
      <View style={styles.hero}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <Text style={styles.name}>{user.name}</Text>
        <View style={styles.roleBadge}>
          <Ionicons
            name={isTrainer ? 'fitness' : 'person'}
            size={12}
            color={isTrainer ? colors.yellow : colors.primary}
          />
          <Text style={[styles.roleText, { color: isTrainer ? colors.yellow : colors.primary }]}>
            {isTrainer ? 'Trainer' : 'User'}
          </Text>
        </View>
      </View>

      <View style={styles.card}>
        <View style={styles.row}>
          <Ionicons name="mail-outline" size={18} color={colors.textDim} />
          <Text style={styles.rowLabel}>Email</Text>
          <Text style={styles.rowValue} selectable>
            {user.email}
          </Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.row}>
          <Ionicons name="id-card-outline" size={18} color={colors.textDim} />
          <Text style={styles.rowLabel}>Name</Text>
          <Text style={styles.rowValue}>{user.name}</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.row}>
          <Ionicons
            name={isTrainer ? 'fitness-outline' : 'person-outline'}
            size={18}
            color={colors.textDim}
          />
          <Text style={styles.rowLabel}>Role</Text>
          <Text style={styles.rowValue}>{isTrainer ? 'Trainer' : 'User'}</Text>
        </View>
      </View>

      {/* Edit Profile — opens the dedicated editing view */}
      <TouchableOpacity style={styles.editBtn} onPress={() => navigation.navigate(EDIT_PROFILE)}>
        <Ionicons name="create-outline" size={16} color={colors.primary} />
        <Text style={styles.editBtnText}>Edit Profile</Text>
      </TouchableOpacity>

      {/* My Gym — only renders for app-linked gym members; standalone users
          (the default) never see it and never needed a gym to sign up */}
      {!inTrainerView && <MyGymCard />}

      {/* Health Profile — moved from Settings (same screen, same data) */}
      {!isTrainer && (
        <TouchableOpacity style={styles.navCard} onPress={() => navigation.navigate(INTAKE_FORM)}>
          <Ionicons name="heart-circle-outline" size={19} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.navCardTitle}>Health Profile</Text>
            <Text style={styles.navCardSub}>
              Goals, activity, dietary preferences and allergens — feeds your nutrition targets
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={17} color={colors.textDim} />
        </TouchableOpacity>
      )}

      {/* Trainer-only: invite code + view switch (merged from the retired
          Trainer Settings tab) */}
      {isTrainer && inTrainerView && (
        <>
          <View style={styles.inviteCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={styles.inviteTitle}>Invite Code</Text>
              <TouchableOpacity onPress={loadInvite} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Ionicons name="refresh" size={16} color={colors.textDim} />
              </TouchableOpacity>
            </View>
            {inviteLoading ? (
              <ActivityIndicator color={colors.primary} size="small" style={{ marginVertical: 18 }} />
            ) : invite ? (
              <>
                <Text style={styles.inviteCode}>{invite.code}</Text>
                <Text style={styles.inviteMeta}>
                  Expires {new Date(invite.expires_at).toLocaleDateString()} · single-use
                </Text>
                <View style={styles.inviteBtnRow}>
                  <TouchableOpacity style={[styles.inviteBtn, { backgroundColor: colors.blue }]} onPress={shareInvite}>
                    <Ionicons name="share-social-outline" size={15} color="#fff" />
                    <Text style={styles.inviteBtnTextOn}>Share</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.inviteBtn, { borderWidth: 1, borderColor: colors.border }]}
                    onPress={generateInvite}
                  >
                    <Ionicons name="add-circle-outline" size={15} color={colors.text} />
                    <Text style={styles.inviteBtnText}>Generate New</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <>
                <Text style={styles.inviteNone}>
                  No active code. Generate one and share it with a client to let them connect.
                </Text>
                <TouchableOpacity
                  style={[styles.inviteBtn, { backgroundColor: colors.blue, alignSelf: 'flex-start' }]}
                  onPress={generateInvite}
                >
                  <Ionicons name="add-circle-outline" size={15} color="#fff" />
                  <Text style={styles.inviteBtnTextOn}>Generate Code</Text>
                </TouchableOpacity>
              </>
            )}
            <Text style={styles.inviteHint}>
              Each code works exactly once — it expires the moment any client uses it.
            </Text>
          </View>

          <TouchableOpacity
            style={styles.switchBtn}
            onPress={() => onSwitchView && onSwitchView('user')}
          >
            <Ionicons name="swap-horizontal-outline" size={18} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.switchTitle}>Switch to User View</Text>
              <Text style={styles.switchSub}>Log your own workouts like a personal account</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
          </TouchableOpacity>
        </>
      )}

      {/* trainer browsing their own account in User View: switch back */}
      {isTrainer && !inTrainerView && onSwitchView && (
        <TouchableOpacity
          style={styles.switchBtn}
          onPress={() => onSwitchView('trainer')}
        >
          <Ionicons name="swap-horizontal-outline" size={18} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.switchTitle}>Switch to Trainer View</Text>
            <Text style={styles.switchSub}>Manage clients and assign plans</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
        </TouchableOpacity>
      )}

      <View style={styles.card}>
        <View style={styles.row}>
          <Ionicons name="fitness-outline" size={18} color={colors.textDim} />
          <Text style={styles.rowLabel}>Trainer</Text>
          <Text style={styles.rowValue}>
            {assoc?.status === 'active'
              ? (assoc.trainer_name || 'Connected')
              : assoc?.status === 'pending'
              ? 'Request pending'
              : 'None'}
          </Text>
        </View>
        {assoc?.status === 'pending' && (
          <Text style={styles.pendingHint}>
            Waiting for {assoc.trainer_name || 'your trainer'} to accept your request.
          </Text>
        )}
        {assoc?.status !== 'active' && assoc?.status !== 'pending' && (
          <>
            <TextInput
              style={styles.inviteInput}
              value={inviteCode}
              onChangeText={setInviteCode}
              placeholder="Trainer invite code"
              placeholderTextColor={colors.textDim}
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={16}
            />
            <TouchableOpacity style={styles.connectBtn} onPress={submitInviteCode}>
              <Ionicons name="person-add-outline" size={16} color="#fff" />
              <Text style={styles.connectBtnText}>Connect with Trainer</Text>
            </TouchableOpacity>
          </>
        )}
        {assocMsg && <Text style={styles.assocMsg}>{assocMsg}</Text>}
      </View>

      {reconnect && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setReconnect(null)}>
          <TouchableOpacity style={styles.reconnectBackdrop} activeOpacity={1} onPress={() => setReconnect(null)}>
            <View style={styles.reconnectSheet}>
              <Text style={styles.reconnectTitle}>
                Reconnect with {reconnect.preview.trainer_name || 'this trainer'}?
              </Text>
              <Text style={styles.reconnectSub}>
                You were previously connected with this trainer
                {reconnect.preview.archived_at
                  ? ` until ${new Date(reconnect.preview.archived_at).toLocaleDateString()}`
                  : ''}
                .
              </Text>
              {(reconnect.preview.counts?.assigned_workouts > 0 ||
                reconnect.preview.counts?.diet_plans > 0) && (
                <View style={styles.reconnectCounts}>
                  <Text style={styles.reconnectCountLine}>
                    • {reconnect.preview.counts.assigned_workouts} assigned workout
                    {reconnect.preview.counts.assigned_workouts === 1 ? '' : 's'}
                  </Text>
                  <Text style={styles.reconnectCountLine}>
                    • {reconnect.preview.counts.diet_plans} diet plan
                    {reconnect.preview.counts.diet_plans === 1 ? '' : 's'}
                  </Text>
                </View>
              )}
              <Text style={styles.reconnectQuestion}>What would you prefer?</Text>
              <TouchableOpacity
                style={styles.reconnectOpt}
                onPress={() => sendRequest(reconnect.code, 'restore')}
              >
                <Ionicons name="refresh" size={17} color={colors.primary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.reconnectOptTitle}>Restore my previous history</Text>
                  <Text style={styles.reconnectOptSub}>Keep everything as it was</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.reconnectOpt}
                onPress={() => sendRequest(reconnect.code, 'fresh')}
              >
                <Ionicons name="sparkles" size={17} color={colors.blue} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.reconnectOptTitle}>Start fresh</Text>
                  <Text style={styles.reconnectOptSub}>Begin a new relationship</Text>
                </View>
              </TouchableOpacity>
              <Text style={styles.reconnectNote}>
                Your trainer will confirm this before it takes effect.
              </Text>
              <TouchableOpacity style={styles.reconnectCancel} onPress={() => setReconnect(null)}>
                <Text style={styles.reconnectCancelText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>
      )}

      {/* Account — moved from Settings (existing implementations reused) */}
      <View style={styles.card}>
        <ChangePasswordCard defaultOpen collapsible={false} />
        <View style={[styles.divider, { marginVertical: 8 }]} />
        <TouchableOpacity
          style={styles.row}
          onPress={() =>
            Alert.alert('Log Out', 'Sign out of this device?', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Log Out', style: 'destructive', onPress: () => logout() },
            ])
          }
        >
          <Ionicons name="log-out-outline" size={18} color={colors.red} />
          <Text style={[styles.rowLabel, { color: colors.red }]}>Log Out</Text>
        </TouchableOpacity>
      </View>

      {isTrainer && (
        <TouchableOpacity
          style={styles.clientsRow}
          onPress={() => navigation.navigate(TAB_CLIENTS)}
        >
          <Ionicons name="people-outline" size={20} color={colors.primary} />
          <Text style={styles.clientsText}>Manage Clients</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    inviteCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 16, marginBottom: 12,
    },
    inviteTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
    inviteCode: {
      color: colors.text, fontSize: 28, fontWeight: '900', letterSpacing: 4,
      marginTop: 12, fontVariant: ['tabular-nums'],
    },
    inviteMeta: { color: colors.textDim, fontSize: 12, marginTop: 4 },
    inviteNone: { color: colors.textDim, fontSize: 13, marginTop: 10, marginBottom: 14 },
    inviteBtnRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
    inviteBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10,
    },
    inviteBtnText: { color: colors.text, fontWeight: '700', fontSize: 13 },
    inviteBtnTextOn: { color: '#fff', fontWeight: '700', fontSize: 13 },
    inviteHint: { color: colors.textDim, fontSize: 11, marginTop: 12 },
    switchBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.card, borderRadius: 14, padding: 16,
      borderLeftWidth: 3, borderLeftColor: colors.primary,
      borderTopLeftRadius: 4, borderBottomLeftRadius: 4,
    },
    switchTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
    switchSub: { color: colors.textDim, fontSize: 12, marginTop: 2 },
    editBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12,
      paddingVertical: 12, marginBottom: 12,
    },
    editBtnText: { color: colors.primary, fontWeight: '800', fontSize: 14 },
    navCard: {
      flexDirection: 'row', alignItems: 'center', gap: 11,
      backgroundColor: colors.card, borderRadius: 12, padding: 14, marginBottom: 12,
    },
    navCardTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
    navCardSub: { color: colors.textDim, fontSize: 11, marginTop: 2, lineHeight: 15 },
    hero: { alignItems: 'center', paddingVertical: 28 },
    avatar: {
      width: 84,
      height: 84,
      borderRadius: 42,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { color: '#fff', fontSize: 30, fontWeight: '800' },
    name: { color: colors.text, fontSize: 22, fontWeight: '800', marginTop: 14 },
    roleBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      backgroundColor: colors.card,
      borderRadius: 12,
      paddingHorizontal: 10,
      paddingVertical: 4,
      marginTop: 8,
    },
    roleText: { fontSize: 12, fontWeight: '700' },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 6, marginBottom: 12 },
    row: { flexDirection: 'row', alignItems: 'center', padding: 14, gap: 10 },
    rowLabel: { color: colors.textDim, fontSize: 13, width: 52 },
    rowValue: { color: colors.text, fontSize: 14, fontWeight: '600', flex: 1, textAlign: 'right' },
    divider: { height: 1, backgroundColor: colors.border, marginHorizontal: 14 },
    clientsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 16,
      marginTop: 4,
    },
    clientsText: { color: colors.primary, fontWeight: '700', flex: 1 },
    reconnectBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
    reconnectSheet: { backgroundColor: colors.card, borderRadius: 16, padding: 20 },
    reconnectTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
    reconnectSub: { color: colors.textDim, fontSize: 13, marginTop: 6 },
    reconnectCounts: { marginTop: 10 },
    reconnectCountLine: { color: colors.text, fontSize: 13 },
    reconnectQuestion: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 14, marginBottom: 8 },
    reconnectOpt: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.cardLight, borderRadius: 12, padding: 14, marginBottom: 8,
    },
    reconnectOptTitle: { color: colors.text, fontWeight: '700', fontSize: 14 },
    reconnectOptSub: { color: colors.textDim, fontSize: 12, marginTop: 2 },
    reconnectNote: { color: colors.textDim, fontSize: 11, marginTop: 4 },
    reconnectCancel: { alignItems: 'center', padding: 10, marginTop: 6 },
    reconnectCancelText: { color: colors.textDim, fontWeight: '700' },
    pendingHint: { color: colors.yellow, fontSize: 12, marginTop: 8 },
    inviteInput: {
      backgroundColor: colors.cardLight,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginTop: 12,
      fontSize: 15,
      fontWeight: '600',
      letterSpacing: 1,
    },
    connectBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingVertical: 11,
      marginTop: 10,
    },
    connectBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
    assocMsg: { color: colors.textDim, fontSize: 12, marginTop: 10 },
  });
