import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../store/AuthContext';
import { useColors } from '../theme';

// Trainer View's Settings tab — profile summary, view switcher, logout.
// Deliberately minimal; app preferences live in User View's Settings.
export default function TrainerSettingsScreen({ navigation, onSwitchView }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { user, logout } = useAuth();

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
