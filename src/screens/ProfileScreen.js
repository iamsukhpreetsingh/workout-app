import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, TextInput, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../store/AuthContext';
import { api } from '../lib/api';
import { useColors } from '../theme';
import { MAIN_TABS, TAB_CLIENTS } from '../shared/constants/routes';

// Profile identity/info only — app preferences stay in Settings.
export default function ProfileScreen({ navigation }) {
  const colors = useColors();
  const { user } = useAuth();
  const styles = makeStyles(colors);
  if (!user) return null;

  const isTrainer = user.role === 'trainer';
  return <ProfileBody navigation={navigation} colors={colors} styles={styles} user={user} isTrainer={isTrainer} />;
}

// Split so the trainer-view hook rules don't depend on the early return
function ProfileBody({ navigation, colors, styles, user, isTrainer }) {
  const [inviteCode, setInviteCode] = useState('');
  const [assoc, setAssoc] = useState(null); // { status, trainer_name }
  const [assocMsg, setAssocMsg] = useState(null); // confirmation / error

  React.useEffect(() => {
    api('/client/trainer')
      .then(setAssoc)
      .catch(() => {});
  }, []);

  const [reconnect, setReconnect] = useState(null); // preview when is_reactivation

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

      {isTrainer && (
        <TouchableOpacity
          style={styles.clientsRow}
          onPress={() => navigation.navigate(MAIN_TABS, { screen: TAB_CLIENTS })}
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
