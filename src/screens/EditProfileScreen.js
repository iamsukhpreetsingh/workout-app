import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ScrollView, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../lib/api';
import { useAuth } from '../store/AuthContext';
import { useColors } from '../theme';

// Edit Profile — dedicated editing view (spec §19/§20/§21). The users row is
// the authoritative profile source; `PATCH /auth/profile` updates the display
// name. EMAIL IS DELIBERATELY READ-ONLY: it is the authentication identity —
// changing it would require a verification flow that the auth system does
// not currently implement, so no fake email editing is offered (§21).
export default function EditProfileScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { user, updateUser } = useAuth();
  const [name, setName] = useState(user?.name || '');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) return Alert.alert('Name required', 'Enter your display name.');
    setBusy(true);
    try {
      const updated = await api('/auth/profile', {
        method: 'PATCH',
        body: { name: trimmed },
      });
      // update the authoritative in-memory session user so Profile (and the
      // header) reflect the change immediately
      if (updateUser && updated?.name) updateUser({ ...user, name: updated.name });
      Alert.alert('Profile updated', 'Your display name has been saved.');
      navigation.goBack();
    } catch (e) {
      Alert.alert('Could not save', e.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      <View style={styles.field}>
        <Text style={styles.label}>Display name</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="Your name"
          placeholderTextColor={colors.textDim}
          autoCapitalize="words"
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Email</Text>
        <View style={[styles.input, styles.readOnlyRow]}>
          <Ionicons name="lock-closed-outline" size={13} color={colors.textDim} />
          <Text style={[styles.readOnlyValue, { color: colors.textDim }]}>{user?.email || '—'}</Text>
        </View>
        <Text style={styles.hint}>
          Your email is your login identity and can't be changed here.
        </Text>
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Body & nutrition profile</Text>
        <Text style={styles.hint}>
          Age, height, weight, activity and goal live in your Health Profile (Profile → Health
          Profile). Updating them feeds your nutrition target calculation.
        </Text>
      </View>

      <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={busy}>
        {busy ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.saveText}>Save Changes</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    field: { marginBottom: 16 },
    label: { color: colors.textDim, fontSize: 12, fontWeight: '700', marginBottom: 5 },
    input: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 12,
      paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
    },
    readOnlyRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    readOnlyValue: { fontSize: 14 },
    hint: { color: colors.textDim, fontSize: 11, marginTop: 5, lineHeight: 15 },
    saveBtn: {
      backgroundColor: colors.primary, borderRadius: 13, padding: 15,
      alignItems: 'center', marginTop: 8,
    },
    saveText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  });
