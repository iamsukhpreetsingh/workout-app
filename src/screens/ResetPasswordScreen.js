import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../lib/api';
import { useColors } from '../theme';
import { LOGIN, FORGOT_PASSWORD } from '../shared/constants/routes';

export default function ResetPasswordScreen({ navigation, route }) {
  const colors = useColors();
  // token arrives via deep link (workouttracker://reset-password?token=...)
  // or manual paste as fallback
  const [token, setToken] = useState(String(route?.params?.token || ''));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const missingToken = !token.trim();

  const submit = async () => {
    if (busy) return;
    if (missingToken) {
      setError('Invalid password reset link. Please request a new reset link.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reset-password', {
        method: 'POST',
        skipAuth: true,
        body: { token: token.trim(), password },
      });
      setDone(true);
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

  const requestNewLink = () => navigation.navigate(FORGOT_PASSWORD);

  const styles = makeStyles(colors);

  if (done) {
    return (
      <View style={styles.container}>
        <Ionicons name="checkmark-circle" size={56} color="#22c55e" />
        <Text style={styles.title}>Password Reset Successful</Text>
        <View style={styles.successCard}>
          <Text style={styles.successText}>
            Your password has been updated successfully. You can now log in using your new password.
          </Text>
        </View>
        <TouchableOpacity style={styles.btn} onPress={() => navigation.navigate(LOGIN)}>
          <Text style={styles.btnText}>Go to Login</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Ionicons name="key-outline" size={40} color={colors.primary} />
        <Text style={styles.title}>Reset Password</Text>
        <Text style={styles.subtitle}>Create a new password for your account.</Text>

        <TextInput
          style={[styles.input, styles.tokenInput]}
          placeholder="Reset code (paste from email)"
          placeholderTextColor={colors.textDim}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          value={token}
          onChangeText={(t) => { setToken(t); if (error) setError(null); }}
        />
        {route?.params?.token ? (
          <Text style={styles.tokenHint}>Reset code loaded from your link.</Text>
        ) : null}

        <TextInput
          style={styles.input}
          placeholder="New Password"
          placeholderTextColor={colors.textDim}
          secureTextEntry
          value={password}
          onChangeText={(t) => { setPassword(t); if (error) setError(null); }}
        />
        <TextInput
          style={styles.input}
          placeholder="Confirm Password"
          placeholderTextColor={colors.textDim}
          secureTextEntry
          value={confirm}
          onChangeText={(t) => { setConfirm(t); if (error) setError(null); }}
        />

        <View style={styles.rulesRow}>
          <Ionicons name={password.length >= 8 ? 'checkmark-circle' : 'ellipse-outline'} size={14} color={password.length >= 8 ? '#22c55e' : colors.textDim} />
          <Text style={styles.ruleText}>At least 8 characters</Text>
        </View>
        <View style={styles.rulesRow}>
          <Ionicons name={confirm && password === confirm ? 'checkmark-circle' : 'ellipse-outline'} size={14} color={confirm && password === confirm ? '#22c55e' : colors.textDim} />
          <Text style={styles.ruleText}>Passwords match</Text>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}
        {missingToken && !error && (
          <Text style={styles.error}>No reset code found. Paste it from your email below.</Text>
        )}

        <TouchableOpacity style={[styles.btn, busy && styles.btnDisabled]} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Reset Password</Text>}
        </TouchableOpacity>

        <TouchableOpacity onPress={requestNewLink} style={{ marginTop: 18 }}>
          <Text style={styles.link}>Request New Reset Link</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flexGrow: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 28 },
    title: { color: colors.text, fontSize: 22, fontWeight: '800', marginTop: 12, marginBottom: 6 },
    subtitle: { color: colors.textDim, fontSize: 14, marginBottom: 20 },
    input: {
      width: '100%',
      backgroundColor: colors.card,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 10,
      fontSize: 15,
    },
    tokenInput: { minHeight: 64, textAlignVertical: 'top', fontSize: 12 },
    tokenHint: { alignSelf: 'flex-start', color: colors.primary, fontSize: 11, marginBottom: 10, marginTop: -4 },
    rulesRow: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', marginBottom: 4 },
    ruleText: { color: colors.textDim, fontSize: 12, marginLeft: 6 },
    error: { color: colors.red, marginVertical: 10, width: '100%', fontSize: 13 },
    btn: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 14, width: '100%', alignItems: 'center', marginTop: 10 },
    btnDisabled: { opacity: 0.6 },
    btnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
    successCard: { width: '100%', backgroundColor: colors.card, borderRadius: 10, padding: 14, marginVertical: 16 },
    successText: { color: colors.text, fontSize: 13, lineHeight: 19, textAlign: 'center' },
    link: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  });
