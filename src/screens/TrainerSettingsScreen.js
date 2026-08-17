import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Share, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../store/AuthContext';
import { useColors } from '../theme';
import { api } from '../lib/api';

// Trainer View's Settings tab — invite code, profile summary, view
// switcher, logout. Deliberately minimal; app preferences live in User
// View's Settings.
export default function TrainerSettingsScreen({ navigation, onSwitchView }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { user, logout } = useAuth();
  const [invite, setInvite] = useState(null); // { code, expires_at }
  const [inviteLoading, setInviteLoading] = useState(true);

  // Show the trainer's CURRENT still-valid code — never mint a new one just
  // by opening Settings (each tap of Generate New invalidates nothing, but
  // the previous code stays usable until one of them is redeemed).
  const loadInvite = useCallback(async () => {
    setInviteLoading(true);
    try {
      setInvite(await api('/trainer/invite-code/latest'));
    } catch {
      setInvite(null);
    }
    setInviteLoading(false);
  }, []);

  React.useEffect(() => { loadInvite(); }, [loadInvite]);

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
        message: `Join me as your trainer on Workout Tracker! Invite code: ${invite.code}`,
        title: 'Trainer invite code',
      });
    } catch {
      // user dismissed the sheet
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 40 }}>
      {/* mode badge — always unambiguous which view is active */}
      <View style={styles.badge}>
        <Ionicons name="people" size={12} color={colors.blue} />
        <Text style={styles.badgeText}>Trainer View</Text>
      </View>

      <View style={styles.card}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials(user?.name)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{user?.name || 'Trainer'}</Text>
          <Text style={styles.sub}>{user?.email}</Text>
          <Text style={styles.role}>Trainer account</Text>
        </View>
      </View>

      {/* Invite code — lives here (not the Clients header) so the code is
          always visible with an explicit generate/share, never a silent
          empty-state-only card */}
      <View style={styles.card}>
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
            <TouchableOpacity style={[styles.inviteBtn, { backgroundColor: colors.blue, alignSelf: 'flex-start' }]} onPress={generateInvite}>
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

      <TouchableOpacity style={styles.logoutBtn} onPress={() => logout()}>
        <Ionicons name="log-out-outline" size={17} color={colors.red} />
        <Text style={styles.logoutText}>Log Out</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function initials(name = '?') {
  return name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    badge: {
      flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
      backgroundColor: colors.cardLight, borderRadius: 10,
      paddingHorizontal: 10, paddingVertical: 5, marginBottom: 16,
    },
    badgeText: { color: colors.blue, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
    card: {
      flexDirection: 'row', alignItems: 'center', gap: 14,
      backgroundColor: colors.card, borderRadius: 14, padding: 16, marginBottom: 12,
    },
    avatar: {
      width: 48, height: 48, borderRadius: 24, backgroundColor: colors.blue,
      alignItems: 'center', justifyContent: 'center',
    },
    avatarText: { color: '#fff', fontWeight: '800', fontSize: 16 },
    name: { color: colors.text, fontSize: 17, fontWeight: '800' },
    sub: { color: colors.textDim, fontSize: 12, marginTop: 2 },
    role: { color: colors.blue, fontSize: 11, fontWeight: '700', marginTop: 4 },
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
    logoutBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      marginTop: 28, paddingVertical: 12, borderRadius: 12, borderWidth: 1,
      borderColor: colors.red, opacity: 0.85,
    },
    logoutText: { color: colors.red, fontWeight: '700', fontSize: 14 },
  });
