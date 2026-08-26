import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../lib/api';
import { useColors } from '../theme';
import { LOGIN, RESET_PASSWORD as RESET_PASSWORD_ROUTE } from '../shared/constants/routes';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function ForgotPasswordScreen({ navigation }) {
  const colors = useColors();
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!email.trim()) {
      setError('Please enter your email address.');
      return;
    }
    if (!EMAIL_RE.test(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/auth/forgot-password', {
        method: 'POST',
        skipAuth: true,
        body: { email: email.trim() },
      });
      // always the same generic success — never reveal account existence
      setSent(true);
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
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Ionicons name="lock-closed-outline" size={40} color={colors.primary} />
      <Text style={styles.title}>Forgot Password?</Text>

      {!sent ? (
        <>
          <Text style={styles.subtitle}>
            Enter the email address associated with your account and we'll send you a link to reset your password.
          </Text>

          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            value={email}
            onChangeText={(t) => { setEmail(t); if (error) setError(null); }}
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <TouchableOpacity style={[styles.btn, busy && styles.btnDisabled]} onPress={submit} disabled={busy}>
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Send Reset Link</Text>}
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Ionicons name="mail-outline" size={36} color={colors.primary} style={{ marginBottom: 12 }} />
          <Text style={styles.sentTitle}>Check your email</Text>
          <View style={styles.successCard}>
            <Text style={styles.successText}>
              If an account exists for this email, a password reset link has been sent. Open it on this device to
              continue — or copy the link and paste it into the Reset Password screen.
            </Text>
          </View>
          <TouchableOpacity
            style={styles.btn}
            onPress={() => navigation.navigate(RESET_PASSWORD_ROUTE)}
          >
            <Text style={styles.btnText}>I have a reset code</Text>
          </TouchableOpacity>
        </>
      )}

      <TouchableOpacity onPress={() => navigation.navigate(LOGIN)} style={{ marginTop: 18 }}>
        <Text style={styles.link}>Back to Login</Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 28 },
    title: { color: colors.text, fontSize: 22, fontWeight: '800', marginTop: 12, marginBottom: 8 },
    subtitle: { color: colors.textDim, fontSize: 14, textAlign: 'center', lineHeight: 20, marginBottom: 20 },
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
    error: { color: colors.red, marginBottom: 10, width: '100%', fontSize: 13 },
    btn: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 14, width: '100%', alignItems: 'center', marginTop: 6 },
    btnDisabled: { opacity: 0.6 },
    btnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
    sentTitle: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: 10 },
    successCard: {
      width: '100%', backgroundColor: colors.card, borderRadius: 10, padding: 14, marginBottom: 16,
    },
    successText: { color: colors.text, fontSize: 13, lineHeight: 19, textAlign: 'center' },
    link: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  });
