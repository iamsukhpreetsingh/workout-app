// Shared "Change Password" card for both Settings screens (user view and
// trainer view). Verifies the current password, rotates the session tokens
// (all other devices get logged out), keeps THIS device signed in.
import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../lib/api';
import { useAuth } from '../store/AuthContext';
import { useColors } from '../theme';

export default function ChangePasswordCard({ defaultOpen = false, collapsible = true }) {
  const colors = useColors();
  const { rotateSession } = useAuth();
  const [open, setOpen] = useState(defaultOpen);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!current) return setError('Enter your current password');
    if (next.length < 8) return setError('New password must be at least 8 characters');
    if (next !== confirm) return setError('Passwords do not match.');
    setBusy(true);
    setError(null);
    try {
      const res = await api('/auth/change-password', {
        method: 'POST',
        body: { currentPassword: current, newPassword: next },
      });
      // keep this device signed in with the fresh token pair
      await rotateSession(res.accessToken, res.refreshToken);
      setOpen(false);
      setCurrent('');
      setNext('');
      setConfirm('');
      Alert.alert('Password updated', 'Your password has been changed. Other devices have been logged out.');
    } catch (e) {
      setError(
        e?.status === 429
          ? 'Too many attempts. Please try again later.'
          : e?.message || 'Unable to reach the server. Please check your connection and try again.'
      );
    } finally {
      setBusy(false);
    }
  };

  const styles = makeStyles(colors);

  return (
    <View style={styles.card}>
      <View style={collapsible ? styles.header : [styles.header, { marginBottom: open ? 8 : 0 }]}>
        <Ionicons name="lock-closed-outline" size={18} color={colors.text} />
        <Text style={[styles.cardTitle, { color: colors.text, flex: 1 }]}>Change Password</Text>
        {collapsible && (
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={colors.textDim} />
        )}
      </View>

      {open && (
        <View style={{ marginTop: 10 }}>
          <TextInput
            style={styles.input}
            placeholder="Current password"
            placeholderTextColor={colors.textDim}
            secureTextEntry
            value={current}
            onChangeText={(t) => { setCurrent(t); if (error) setError(null); }}
          />
          <TextInput
            style={styles.input}
            placeholder="New password (min 8 characters)"
            placeholderTextColor={colors.textDim}
            secureTextEntry
            value={next}
            onChangeText={(t) => { setNext(t); if (error) setError(null); }}
          />
          <TextInput
            style={styles.input}
            placeholder="Confirm new password"
            placeholderTextColor={colors.textDim}
            secureTextEntry
            value={confirm}
            onChangeText={(t) => { setConfirm(t); if (error) setError(null); }}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <TouchableOpacity style={[styles.saveBtn, busy && { opacity: 0.6 }]} onPress={submit} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveBtnText}>Update Password</Text>}
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 16,
      marginBottom: 12,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    cardTitle: { fontSize: 15, fontWeight: '700' },
    input: {
      width: '100%',
      backgroundColor: colors.cardLight || colors.bg,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 11,
      marginBottom: 8,
      fontSize: 14,
    },
    error: { color: colors.red, marginBottom: 8, fontSize: 13 },
    saveBtn: {
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingVertical: 12,
      alignItems: 'center',
      marginTop: 4,
    },
    saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  });
