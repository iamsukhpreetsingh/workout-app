import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../store/AuthContext';
import { useColors } from '../theme';

// Inline validation only — nothing blocks until submit, and a failed request
// never wipes what the user typed.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function SignupScreen({ navigation }) {
  const colors = useColors();
  const { signup } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) return setError('Enter your name');
    if (!EMAIL_RE.test(email.trim())) return setError('Enter a valid email');
    if (password.length < 8) return setError('Password must be at least 8 characters');
    if (!role) return setError('Choose an account type');
    setBusy(true);
    setError(null);
    try {
      await signup({ name: name.trim(), email: email.trim(), password, role });
    } catch (e) {
      setError(e.message || 'Signup failed');
    } finally {
      setBusy(false);
    }
  };

  const styles = makeStyles(colors);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.container} contentContainerStyle={{ padding: 28, paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Create Account</Text>

        <TextInput
          style={styles.input}
          placeholder="Name"
          placeholderTextColor={colors.textDim}
          value={name}
          onChangeText={setName}
        />
        <TextInput
          style={styles.input}
          placeholder="Email"
          placeholderTextColor={colors.textDim}
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password (min 8 characters)"
          placeholderTextColor={colors.textDim}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />

        {/* Role choice — same two-option pattern as the workout start sheet */}
        <Text style={styles.label}>I am a…</Text>
        <View style={styles.roleRow}>
          {[
            { value: 'user', label: 'User', icon: 'person-outline', hint: 'Log workouts, train solo or with a trainer' },
            { value: 'trainer', label: 'Trainer', icon: 'fitness-outline', hint: 'Coach clients and assign workouts' },
          ].map((r) => (
            <TouchableOpacity
              key={r.value}
              style={[styles.roleCard, role === r.value && styles.roleCardOn]}
              onPress={() => setRole(r.value)}
            >
              <Ionicons name={r.icon} size={22} color={role === r.value ? '#fff' : colors.primary} />
              <Text style={[styles.roleText, role === r.value && styles.roleTextOn]}>{r.label}</Text>
              <Text style={[styles.roleHint, role === r.value && styles.roleHintOn]}>{r.hint}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        <TouchableOpacity style={styles.btn} onPress={submit} disabled={busy}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Create Account</Text>}
        </TouchableOpacity>

        <TouchableOpacity onPress={() => navigation.goBack()}>
          <Text style={styles.link}>
            Already have an account? <Text style={styles.linkBold}>Log in</Text>
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    title: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: 18, marginTop: 30 },
    input: {
      backgroundColor: colors.card,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 10,
      fontSize: 15,
    },
    label: { color: colors.textDim, fontSize: 13, marginBottom: 8, marginTop: 4 },
    roleRow: { flexDirection: 'row', gap: 10, marginBottom: 14 },
    roleCard: {
      flex: 1,
      backgroundColor: colors.card,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: 'transparent',
      padding: 14,
      alignItems: 'center',
    },
    roleCardOn: { borderColor: colors.primary, backgroundColor: colors.cardLight },
    roleText: { color: colors.text, fontWeight: '800', marginTop: 8 },
    roleTextOn: { color: colors.primary },
    roleHint: { color: colors.textDim, fontSize: 11, textAlign: 'center', marginTop: 4 },
    roleHintOn: { color: colors.textDim },
    error: { color: colors.red, marginBottom: 10, fontSize: 13 },
    btn: { backgroundColor: colors.primary, borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
    btnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
    link: { color: colors.textDim, marginTop: 18, textAlign: 'center', fontSize: 13 },
    linkBold: { color: colors.primary, fontWeight: '700' },
  });
