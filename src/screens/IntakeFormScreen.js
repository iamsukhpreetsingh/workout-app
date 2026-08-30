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
import {
  ACTIVITY_LEVELS,
  PRIMARY_GOALS,
  GOAL_INTENSITIES,
  DIETARY_PATTERNS,
  GENDERS,
  calculateRecommendation,
} from '../features/diet/domain/nutritionTargets';

const NUMS = { fontVariant: ['tabular-nums'] };
const COMMON_ALLERGENS = ['Nuts', 'Dairy', 'Gluten', 'Shellfish', 'Eggs', 'Soy', 'Fish', 'Sesame'];
const COMMON_GOALS = ['Weight Loss', 'Muscle Gain', 'Strength', 'Endurance', 'General Health'];

// Client nutrition & dietary profile — ONE form, TWO entry points (same
// endpoint): gate mode (right after connecting to a trainer, non-
// dismissible) and edit mode (Settings, prefilled).
//
// Structured as short guided sections (§15), not one intimidating form:
//   About You → Activity → Goal → Dietary Preferences → Allergies →
//   Health Context → RESULTS (live-calculated recommended targets)
//
// The recommended targets on the results card are calculated by the SAME
// centralized formula the backend uses (nutritionTargets mirror — both are
// test-asserted identical); the authoritative version is created server-
// side on save. Allergen behavior is completely unchanged.
export default function IntakeFormScreen({ route, navigation, gate: gateProp, onClose }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const isGate = gateProp != null ? !!gateProp : !!(route?.params || {}).gate;

  // ── about you ──
  const [age, setAge] = useState('');
  const [gender, setGender] = useState(null);
  const [height, setHeight] = useState('');
  const [weight, setWeight] = useState('');
  const [targetWeight, setTargetWeight] = useState('');
  // ── activity & goal ──
  const [activityLevel, setActivityLevel] = useState(null);
  const [primaryGoal, setPrimaryGoal] = useState(null);
  const [goalIntensity, setGoalIntensity] = useState(null);
  // ── dietary preferences ──
  const [dietaryPattern, setDietaryPattern] = useState(null);
  const [foodPreferences, setFoodPreferences] = useState([]);
  const [foodsAvoided, setFoodsAvoided] = useState([]);
  const [customPref, setCustomPref] = useState('');
  const [customAvoid, setCustomAvoid] = useState('');
  // ── existing health context (unchanged) ──
  const [allergens, setAllergens] = useState([]);
  const [goals, setGoals] = useState([]);
  const [injuries, setInjuries] = useState('');
  const [medical, setMedical] = useState('');
  const [customAllergen, setCustomAllergen] = useState('');
  const [customGoal, setCustomGoal] = useState('');
  // ── form state ──
  const [loading, setLoading] = useState(!isGate);
  const [busy, setBusy] = useState(false);

  React.useLayoutEffect(() => {
    if (!navigation?.setOptions) return;
    navigation.setOptions({
      title: isGate ? 'Nutrition Profile Setup' : 'My Nutrition Profile',
      ...(isGate ? { headerLeft: () => null, gestureEnabled: false } : {}),
    });
  }, [navigation, isGate]);

  useEffect(() => {
    if (!isGate) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, [isGate]);

  useEffect(() => {
    if (isGate) return;
    api('/client/intake-profile')
      .then((p) => {
        if (p) {
          setAge(p.age != null ? String(p.age) : '');
          setGender(p.gender || null);
          setHeight(p.height_cm != null ? String(p.height_cm) : '');
          setWeight(p.weight_kg != null ? String(p.weight_kg) : '');
          setTargetWeight(p.target_weight_kg != null ? String(p.target_weight_kg) : '');
          setActivityLevel(p.activity_level || null);
          setPrimaryGoal(p.primary_goal || null);
          setGoalIntensity(p.goal_intensity || null);
          setDietaryPattern(p.dietary_pattern || null);
          setFoodPreferences(p.food_preferences || []);
          setFoodsAvoided(p.foods_avoided || []);
          setAllergens(p.allergens || []);
          setGoals(p.goals || []);
          setInjuries(p.injuries || '');
          setMedical(p.medical_conditions || '');
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [isGate]);

  // live recommendation — identical formula to the backend (mirrored
  // domain module); the authoritative version is created on save
  const rec = calculateRecommendation({
    age,
    gender,
    height_cm: height,
    weight_kg: weight,
    target_weight_kg: targetWeight,
    activity_level: activityLevel,
    primary_goal: primaryGoal,
    goal_intensity: goalIntensity || 'standard',
  });

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
          age: age === '' ? null : Number(age),
          gender,
          height_cm: height === '' ? null : Number(height),
          weight_kg: weight === '' ? null : Number(weight),
          target_weight_kg: targetWeight === '' ? null : Number(targetWeight),
          activity_level: activityLevel,
          primary_goal: primaryGoal,
          goal_intensity:
            primaryGoal === 'weight_loss' || primaryGoal === 'muscle_gain'
              ? goalIntensity || 'standard'
              : null,
          dietary_pattern: dietaryPattern,
          food_preferences: foodPreferences,
          foods_avoided: foodsAvoided,
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
  const intensityRelevant = primaryGoal === 'weight_loss' || primaryGoal === 'muscle_gain';

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      {isGate ? (
        <View style={styles.introCard}>
          <Ionicons name="heart-circle-outline" size={26} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.introTitle}>Welcome! Let's set up your nutrition profile</Text>
            <Text style={styles.introSub}>
              This sets your daily calorie and macro targets and keeps your plans safe. It takes
              under two minutes, and you can change it anytime in Settings.
            </Text>
          </View>
        </View>
      ) : null}

      {/* STEP 1 — About You */}
      <Text style={styles.groupLabel}>About You</Text>
      <View style={styles.numRow}>
        <View style={styles.numCell}>
          <Text style={styles.numLabel}>Age</Text>
          <TextInput
            style={[styles.input, styles.numInput, NUMS]}
            keyboardType="number-pad"
            value={age}
            onChangeText={(v) => setAge(v.replace(/[^0-9]/g, ''))}
            placeholder="—"
            placeholderTextColor={colors.textDim}
          />
        </View>
        <View style={styles.numCell}>
          <Text style={styles.numLabel}>Height (cm)</Text>
          <TextInput
            style={[styles.input, styles.numInput, NUMS]}
            keyboardType="number-pad"
            value={height}
            onChangeText={(v) => setHeight(v.replace(/[^0-9.]/g, ''))}
            placeholder="—"
            placeholderTextColor={colors.textDim}
          />
        </View>
      </View>
      <View style={styles.numRow}>
        <View style={styles.numCell}>
          <Text style={styles.numLabel}>Weight (kg)</Text>
          <TextInput
            style={[styles.input, styles.numInput, NUMS]}
            keyboardType="decimal-pad"
            value={weight}
            onChangeText={(v) => setWeight(v.replace(/[^0-9.]/g, ''))}
            placeholder="—"
            placeholderTextColor={colors.textDim}
          />
        </View>
        <View style={styles.numCell}>
          <Text style={styles.numLabel}>Target weight (kg)</Text>
          <TextInput
            style={[styles.input, styles.numInput, NUMS]}
            keyboardType="decimal-pad"
            value={targetWeight}
            onChangeText={(v) => setTargetWeight(v.replace(/[^0-9.]/g, ''))}
            placeholder="Optional"
            placeholderTextColor={colors.textDim}
          />
        </View>
      </View>
      <View style={styles.chipRow}>
        {GENDERS.map((g) => (
          <Chip key={g.key} label={g.label} selected={gender === g.key} onPress={() => setGender(gender === g.key ? null : g.key)} styles={styles} />
        ))}
      </View>

      {/* STEP 2 — Activity */}
      <Text style={styles.groupLabel}>How active are you?</Text>
      <Text style={styles.groupHint}>Day-to-day movement outside workouts counts too.</Text>
      <View style={styles.chipRow}>
        {ACTIVITY_LEVELS.map((a) => (
          <Chip key={a.key} label={a.label} selected={activityLevel === a.key} onPress={() => setActivityLevel(activityLevel === a.key ? null : a.key)} styles={styles} />
        ))}
      </View>

      {/* STEP 3 — Goal */}
      <Text style={styles.groupLabel}>What is your goal?</Text>
      <View style={styles.chipRow}>
        {PRIMARY_GOALS.map((g) => (
          <Chip key={g.key} label={g.label} selected={primaryGoal === g.key} onPress={() => setPrimaryGoal(primaryGoal === g.key ? null : g.key)} styles={styles} />
        ))}
      </View>
      {intensityRelevant && (
        <>
          <Text style={styles.groupHint}>How quickly do you want to get there?</Text>
          <View style={styles.chipRow}>
            {GOAL_INTENSITIES.map((g) => (
              <Chip key={g.key} label={g.label} selected={goalIntensity === g.key} onPress={() => setGoalIntensity(g.key)} styles={styles} />
            ))}
          </View>
        </>
      )}

      {/* STEP 4 — Dietary preferences */}
      <Text style={styles.groupLabel}>Dietary pattern</Text>
      <View style={styles.chipRow}>
        {DIETARY_PATTERNS.map((d) => (
          <Chip key={d} label={d} selected={dietaryPattern === d} onPress={() => setDietaryPattern(dietaryPattern === d ? null : d)} styles={styles} />
        ))}
      </View>
      <Text style={styles.groupLabel}>Food preferences (optional)</Text>
      <TagEditor
        tags={foodPreferences}
        onToggle={(t) => toggleTag(foodPreferences, setFoodPreferences, t)}
        raw={customPref}
        setRaw={setCustomPref}
        onAdd={() => addCustomTag(foodPreferences, setFoodPreferences, customPref, setCustomPref)}
        placeholder="e.g. High protein, no cilantro"
        colors={colors}
        styles={styles}
      />
      <Text style={styles.groupLabel}>Foods you avoid (optional)</Text>
      <TagEditor
        tags={foodsAvoided}
        onToggle={(t) => toggleTag(foodsAvoided, setFoodsAvoided, t)}
        raw={customAvoid}
        setRaw={setCustomAvoid}
        onAdd={() => addCustomTag(foodsAvoided, setFoodsAvoided, customAvoid, setCustomAvoid)}
        placeholder="e.g. Pork, mushrooms"
        colors={colors}
        styles={styles}
      />

      {/* STEP 5 — Allergens (existing behavior, unchanged) */}
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
          <Chip key={a} label={a} danger selected onPress={() => toggleTag(allergens, setAllergens, a)} styles={styles} />
        ))}
      </View>
      <TagEditor
        tags={[]}
        raw={customAllergen}
        setRaw={setCustomAllergen}
        onAdd={() => addCustomTag(allergens, setAllergens, customAllergen, setCustomAllergen)}
        placeholder="Other allergy (e.g. Peanuts)"
        colors={colors}
        styles={styles}
      />

      {/* Personal goals + health context — existing display-only fields */}
      <Text style={styles.groupLabel}>Training goals</Text>
      <Text style={styles.groupHint}>What are you working towards? Tap to select.</Text>
      <View style={styles.chipRow}>
        {COMMON_GOALS.map((g) => (
          <Chip key={g} label={g} selected={goals.includes(g)} onPress={() => toggleTag(goals, setGoals, g)} styles={styles} />
        ))}
        {extraGoals.map((g) => (
          <Chip key={g} label={g} selected onPress={() => toggleTag(goals, setGoals, g)} styles={styles} />
        ))}
      </View>
      <TagEditor
        tags={[]}
        raw={customGoal}
        setRaw={setCustomGoal}
        onAdd={() => addCustomTag(goals, setGoals, customGoal, setCustomGoal)}
        placeholder="Other goal (e.g. Marathon prep)"
        colors={colors}
        styles={styles}
      />
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

      {/* STEP 6 — Results: live calculated recommendation */}
      <View style={styles.resultCard}>
        <Text style={styles.resultTitle}>Your Recommended Targets</Text>
        {rec.ok ? (
          <>
            <View style={styles.resultGrid}>
              <View style={styles.resultCell}>
                <Text style={[styles.resultValue, NUMS]}>{rec.recommendation.calories.toLocaleString()}</Text>
                <Text style={styles.resultLabel}>kcal / day</Text>
              </View>
              <View style={styles.resultCell}>
                <Text style={[styles.resultValue, NUMS]}>{rec.recommendation.protein_g}g</Text>
                <Text style={styles.resultLabel}>Protein</Text>
              </View>
              <View style={styles.resultCell}>
                <Text style={[styles.resultValue, NUMS]}>{rec.recommendation.carbs_g}g</Text>
                <Text style={styles.resultLabel}>Carbs</Text>
              </View>
              <View style={styles.resultCell}>
                <Text style={[styles.resultValue, NUMS]}>{rec.recommendation.fat_g}g</Text>
                <Text style={styles.resultLabel}>Fat</Text>
              </View>
            </View>
            <Text style={styles.resultNote}>
              Automatically calculated from the information above. These targets are estimates
              intended as a starting point — not medical advice. Your trainer may adjust these
              targets based on your individual plan.
            </Text>
          </>
        ) : (
          <Text style={styles.resultIncomplete}>
            We need a little more information to calculate your nutrition targets. Fill in your
            age, height, weight, activity and goal above.
          </Text>
        )}
      </View>

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

// tag list + custom entry row (used by preferences / avoided foods / and as
// a bare custom-input row where the chips live elsewhere)
function TagEditor({ tags, onToggle, raw, setRaw, onAdd, placeholder, colors, styles }) {
  return (
    <View>
      {(tags || []).length > 0 && (
        <View style={styles.chipRow}>
          {tags.map((t) => (
            <Chip key={t} label={t} selected onPress={() => onToggle(t)} styles={styles} />
          ))}
        </View>
      )}
      <View style={styles.customRow}>
        <TextInput
          style={styles.customInput}
          placeholder={placeholder}
          placeholderTextColor={colors.textDim}
          value={raw}
          onChangeText={setRaw}
          onSubmitEditing={onAdd}
          returnKeyType="done"
        />
        <TouchableOpacity style={styles.customAdd} onPress={onAdd}>
          <Ionicons name="add" size={16} color={colors.primary} />
        </TouchableOpacity>
      </View>
    </View>
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
      letterSpacing: 1, textTransform: 'uppercase', marginTop: 14, marginBottom: 4,
    },
    groupHint: { color: colors.textDim, fontSize: 12, marginBottom: 8, lineHeight: 16 },
    numRow: { flexDirection: 'row', gap: 8, marginTop: 6 },
    numCell: { flex: 1 },
    numLabel: { color: colors.textDim, fontSize: 11, marginBottom: 4 },
    numInput: { marginBottom: 6, paddingVertical: 10 },
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
    resultCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 16, marginTop: 20,
      alignItems: 'center',
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    resultTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
    resultGrid: { flexDirection: 'row', marginTop: 12, gap: 6 },
    resultCell: { alignItems: 'center', flex: 1 },
    resultValue: { color: colors.primary, fontSize: 17, fontWeight: '800' },
    resultLabel: { color: colors.textDim, fontSize: 10, marginTop: 2 },
    resultNote: {
      color: colors.textDim, fontSize: 11, marginTop: 12,
      textAlign: 'center', lineHeight: 15,
    },
    resultIncomplete: { color: colors.textDim, fontSize: 13, marginTop: 8, textAlign: 'center', lineHeight: 18 },
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
