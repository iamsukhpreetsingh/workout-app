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
  // Mobile M10 — "About you" body profile (user accounts only). Optional at
  // signup; everything lands in the health profile so it is never asked twice.
  const [dob, setDob] = useState('');
  const [gender, setGender] = useState(null);
  const [weight, setWeight] = useState('');
  const [height, setHeight] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // age is DERIVED from the date of birth — one source of truth, never a
  // second input that can contradict it
  const derivedAge = (() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return null;
    const b = new Date(`${dob}T00:00:00Z`);
    if (Number.isNaN(b.getTime()) || b > new Date()) return null;
    const age = Math.floor((Date.now() - b.getTime()) / (365.25 * 86400000));
    return age >= 10 && age <= 100 ? age : null;
  })();

  const submit = async () => {
    if (busy) return;
    if (!name.trim()) return setError('Enter your name');
    if (!EMAIL_RE.test(email.trim())) return setError('Enter a valid email');
    if (password.length < 8) return setError('Password must be at least 8 characters');
    if (!role) return setError('Choose an account type');
    if (dob && !/^\d{4}-\d{2}-\d{2}$/.test(dob)) return setError('Date of birth must be YYYY-MM-DD');
    if (dob) {
      const b = new Date(`${dob}T00:00:00Z`);
      if (Number.isNaN(b.getTime()) || b > new Date()) return setError('Enter a real date of birth in the past');
      const age = Math.floor((Date.now() - b.getTime()) / (365.25 * 86400000));
      if (age < 10 || age > 100) return setError('Age from date of birth must be between 10 and 100');
    }
    if (weight && (Number.isNaN(Number(weight)) || Number(weight) < 1 || Number(weight) > 500)) {
      return setError('Weight must be between 1 and 500 kg');
    }
    if (height && (Number.isNaN(Number(height)) || Number(height) < 30 || Number(height) > 300)) {
      return setError('Height must be between 30 and 300 cm');
    }
    setBusy(true);
    setError(null);
    try {
      const profile = role === 'user' ? {
        ...(dob ? { date_of_birth: dob } : {}),
        ...(gender ? { gender } : {}),
        ...(weight ? { weight_kg: Number(weight) } : {}),
        ...(height ? { height_cm: Number(height) } : {}),
      } : undefined;
      await signup({ name: name.trim(), email: email.trim(), password, role, profile });
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

        {/* Mobile M10 — "About you" (user accounts only). Optional; saved to
            the health profile so gyms and the intake form get the same facts
            without asking twice. Age is derived from the date of birth. */}
        {role === 'user' && (
          <>
            <Text style={styles.label}>About you (optional — feeds your health profile)</Text>
            <TextInput
              style={styles.input}
              placeholder="Date of birth (YYYY-MM-DD)"
              placeholderTextColor={colors.textDim}
              value={dob}
              onChangeText={setDob}
              maxLength={10}
            />
            {derivedAge != null && (
              <Text style={styles.derivedNote}>Age: {derivedAge}</Text>
            )}
            <Text style={styles.label}>Gender</Text>
            <View style={styles.roleRow}>
              {[
                { value: 'male', label: 'Male' },
                { value: 'female', label: 'Female' },
                { value: 'other', label: 'Other' },
                { value: 'prefer_not_to_say', label: 'Rather not say' },
              ].map((g) => (
                <TouchableOpacity
                  key={g.value}
                  style={[styles.genderChip, gender === g.value && styles.genderChipOn]}
                  onPress={() => setGender(gender === g.value ? null : g.value)}
                >
                  <Text style={[styles.genderChipText, gender === g.value && styles.genderChipTextOn]}>{g.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={styles.bodyRow}>
              <TextInput
                style={[styles.input, styles.bodyInput]}
                placeholder="Weight (kg)"
                placeholderTextColor={colors.textDim}
                keyboardType="decimal-pad"
                value={weight}
                onChangeText={setWeight}
              />
              <TextInput
                style={[styles.input, styles.bodyInput]}
                placeholder="Height (cm)"
                placeholderTextColor={colors.textDim}
                keyboardType="number-pad"
                value={height}
                onChangeText={setHeight}
              />
            </View>
          </>
        )}

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
    derivedNote: { color: colors.primary, fontSize: 12, fontWeight: '700', marginBottom: 10 },
    genderChip: {
      flex: 1, backgroundColor: colors.card, borderRadius: 10, borderWidth: 2,
      borderColor: 'transparent', paddingVertical: 10, alignItems: 'center',
    },
    genderChipOn: { borderColor: colors.primary, backgroundColor: colors.cardLight },
    genderChipText: { color: colors.text, fontSize: 12, fontWeight: '600' },
    genderChipTextOn: { color: colors.primary, fontWeight: '800' },
    bodyRow: { flexDirection: 'row', gap: 10 },
    bodyInput: { flex: 1 },
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
