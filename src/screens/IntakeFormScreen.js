import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  BackHandler,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../lib/api';
import { useColors } from '../theme';

const COMMON_ALLERGENS = ['Nuts', 'Dairy', 'Gluten', 'Shellfish', 'Eggs', 'Soy', 'Fish', 'Sesame'];
const COMMON_GOALS = ['Weight Loss', 'Muscle Gain', 'Strength', 'Endurance', 'General Health'];

// Client intake profile — ONE form, TWO entry points (same endpoint):
//   gate mode (gate: true) → right after a brand-new client first connects
//     to a trainer. Non-dismissible: no back button, hardware back blocked.
//     Saving (even with everything empty) completes onboarding.
//   edit mode → opened from Settings; prefilled, normal back button.
// allergens + goals are explicit tag chips; injuries / medical are free
// text. ONLY allergens are ever auto-matched anywhere in the app (diet
// plan conflict warnings) — goals/injuries/medical are display-only.
// Rendered both as a normal stack screen (route/navigation from React
// Navigation) and as a full-screen gate overlay above the navigator
// (App.js passes explicit `gate`/`onClose` props instead).
export default function IntakeFormScreen({ route, navigation, gate: gateProp, onClose }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  // Overlay mode: `gate` prop decides; screen mode: route params decide.
  const isGate = gateProp != null ? !!gateProp : !!(route?.params || {}).gate;

  const [allergens, setAllergens] = useState([]);
  const [goals, setGoals] = useState([]);
  const [injuries, setInjuries] = useState('');
  const [medical, setMedical] = useState('');
  const [customAllergen, setCustomAllergen] = useState('');
  const [customGoal, setCustomGoal] = useState('');
  const [loading, setLoading] = useState(!isGate); // prefill only in edit mode
  const [busy, setBusy] = useState(false);

  React.useLayoutEffect(() => {
    if (!navigation?.setOptions) return; // overlay mode — no header to configure
    navigation.setOptions({
      title: isGate ? 'Health Profile Setup' : 'My Health Profile',
      ...(isGate ? { headerLeft: () => null, gestureEnabled: false } : {}),
    });
  }, [navigation, isGate]);

  // gate mode: swallow the Android hardware back button — the form must
  // be saved before the client can continue
  useEffect(() => {
    if (!isGate) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [isGate]);

  // edit mode: prefill from the saved profile
  useEffect(() => {
    if (isGate) return;
    api('/client/intake-profile')
      .then((p) => {
        if (p) {
          setAllergens(p.allergens || []);
          setGoals(p.goals || []);
          setInjuries(p.injuries || '');
          setMedical(p.medical_conditions || '');
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isGate]);

  const toggleTag = (list, setList, value) => {
    const v = String(value).trim();
    if (!v) return;
    setList(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  };

  const addCustomTag = (list, setList, raw, setRaw) => {
    const v = String(raw).trim();
    if (!v) return setRaw('');
    if (list.some((x) => x.toLowerCase() === v.toLowerCase())) return setRaw('');
    setList([...list, v]);
    setRaw('');
  };

  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api('/client/intake-profile', {
        method: 'PUT',
        body: {
          allergens,
          goals,
          injuries: injuries.trim() || null,
          medical_conditions: medical.trim() || null,
        },
      });
      if (onClose) onClose();
      else navigation.goBack();
    } catch (e) {
      Alert.alert('Could not save', e.message || 'Please check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const extraAllergens = allergens.filter((a) => !COMMON_ALLERGENS.includes(a));
  const extraGoals = goals.filter((g) => !COMMON_GOALS.includes(g));

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      {isGate ? (
        <View style={styles.introCard}>
          <Ionicons name="heart-circle-outline" size={26} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.introTitle}>Welcome! Let's set up your health profile</Text>
            <Text style={styles.introSub}>
              Your trainer uses this to keep your plans safe. It takes under a minute, and you can
              change it anytime in Settings.
            </Text>
          </View>
        </View>
      ) : null}

      <Text style={styles.groupLabel}>Allergies</Text>
      <Text style={styles.groupHint}>
        Tap everything that applies. This is the only information used for automatic warnings on
        your diet plans.
      </Text>
      <View style={styles.chipRow}>
        {COMMON_ALLERGENS.map((a) => (
          <Chip
            key={a}
            label={a}
            danger
            selected={allergens.includes(a)}
            onPress={() => toggleTag(allergens, setAllergens, a)}
            styles={styles}
          />
        ))}
        {extraAllergens.map((a) => (
          <Chip
            key={a}
            label={a}
            danger
            selected
            onPress={() => toggleTag(allergens, setAllergens, a)}
            styles={styles}
          />
        ))}
      </View>
      <View style={styles.customRow}>
        <TextInput
          style={styles.customInput}
          placeholder="Other allergy (e.g. Peanuts)"
          placeholderTextColor={colors.textDim}
          value={customAllergen}
          onChangeText={setCustomAllergen}
          onSubmitEditing={() => addCustomTag(allergens, setAllergens, customAllergen, setCustomAllergen)}
          returnKeyType="done"
        />
        <TouchableOpacity
          style={styles.customAdd}
          onPress={() => addCustomTag(allergens, setAllergens, customAllergen, setCustomAllergen)}
        >
          <Ionicons name="add" size={16} color={colors.primary} />
        </TouchableOpacity>
      </View>

      <Text style={styles.groupLabel}>Goals</Text>
      <Text style={styles.groupHint}>What are you working towards? Tap to select.</Text>
      <View style={styles.chipRow}>
        {COMMON_GOALS.map((g) => (
          <Chip
            key={g}
            label={g}
            selected={goals.includes(g)}
            onPress={() => toggleTag(goals, setGoals, g)}
            styles={styles}
          />
        ))}
        {extraGoals.map((g) => (
          <Chip
            key={g}
            label={g}
            selected
            onPress={() => toggleTag(goals, setGoals, g)}
            styles={styles}
          />
        ))}
      </View>
      <View style={styles.customRow}>
        <TextInput
          style={styles.customInput}
          placeholder="Other goal (e.g. Marathon prep)"
          placeholderTextColor={colors.textDim}
          value={customGoal}
          onChangeText={setCustomGoal}
          onSubmitEditing={() => addCustomTag(goals, setGoals, customGoal, setCustomGoal)}
          returnKeyType="done"
        />
        <TouchableOpacity
          style={styles.customAdd}
          onPress={() => addCustomTag(goals, setGoals, customGoal, setCustomGoal)}
        >
          <Ionicons name="add" size={16} color={colors.primary} />
        </TouchableOpacity>
      </View>

      <Text style={styles.groupLabel}>Injuries (optional)</Text>
      <TextInput
        style={[styles.input, styles.textArea]}
        placeholder="e.g. Mild lower back pain"
        placeholderTextColor={colors.textDim}
        value={injuries}
        onChangeText={setInjuries}
        multiline
      />

      <Text style={styles.groupLabel}>Medical conditions (optional)</Text>
      <TextInput
        style={[styles.input, styles.textArea]}
        placeholder="e.g. Type 2 diabetes"
        placeholderTextColor={colors.textDim}
        value={medical}
        onChangeText={setMedical}
        multiline
      />

      <Text style={styles.privacyNote}>
        Only your trainers can see this, and only inside the app — never in notifications.
      </Text>

      <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={busy}>
        <Text style={styles.saveBtnText}>
          {busy ? 'Saving…' : isGate ? 'Save & Continue' : 'Save Changes'}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function Chip({ label, selected, onPress, danger, styles }) {
  const colors = useColors();
  const tone = danger ? colors.red : colors.primary;
  return (
    <TouchableOpacity
      style={[styles.chip, selected && { borderColor: tone, backgroundColor: colors.card }]}
      onPress={onPress}
    >
      {selected && <Ionicons name="checkmark" size={12} color={tone} />}
      <Text style={[styles.chipText, selected && { color: tone, fontWeight: '800' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    center: { justifyContent: 'center', alignItems: 'center' },
    introCard: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.card, borderRadius: 14, padding: 14, marginBottom: 16,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    introTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
    introSub: { color: colors.textDim, fontSize: 12, marginTop: 3, lineHeight: 17 },
    groupLabel: {
      color: colors.textDim, fontSize: 11, fontWeight: '800',
      letterSpacing: 1, textTransform: 'uppercase', marginTop: 10, marginBottom: 4,
    },
    groupHint: { color: colors.textDim, fontSize: 12, marginBottom: 8, lineHeight: 16 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      backgroundColor: colors.cardLight, borderRadius: 10,
      borderWidth: 1.5, borderColor: 'transparent',
      paddingHorizontal: 10, paddingVertical: 7,
    },
    chipText: { color: colors.text, fontWeight: '600', fontSize: 12 },
    customRow: { flexDirection: 'row', gap: 8, marginTop: 8, marginBottom: 6 },
    customInput: {
      flex: 1, backgroundColor: colors.cardLight, color: colors.text,
      borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14,
    },
    customAdd: {
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 10,
      paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center',
    },
    input: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 12,
      paddingHorizontal: 14, paddingVertical: 12, fontSize: 15,
    },
    textArea: { minHeight: 64, paddingTop: 12 },
    privacyNote: {
      color: colors.textDim, fontSize: 11, fontStyle: 'italic',
      marginTop: 14, marginBottom: 6, lineHeight: 15,
    },
    saveBtn: {
      backgroundColor: colors.primary, borderRadius: 14, padding: 15,
      alignItems: 'center', marginTop: 10,
    },
    saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  });