// Gym nutrition detail (Mobile M2) — the full view of ONE gym-provided
// nutrition item (recipe / meal plan / diet guide), pushed from the Gym
// home sections and from the Diet tab's gym strip. This is where a
// recommendation becomes USABLE inside the existing diet system:
//   Log to today's diet → meal picker → db/diary.logFoodEntry() — the SAME
//                         writer the Add-Food sheet uses; no parallel log.
//   Save to My Dishes   → db/recipes.createRecipe() — appears in My Dishes
//                         and (after sync) the personal_recipe search layer.
// Data model: gym_nutrition_items — { kind, title, description,
// content:{entries}, targets:{calories,protein_g,carbs_g,fat_g}, tags,
// version } (+ assigned rows carry starts_on/ends_on/notes). `content`
// entries are contractually strings but may be structured
// {type:'ingredient'|'step'|'day'|'guideline', text, day?} — they are
// normalized ONCE here via normalizeNutritionEntries() and rendered
// type-aware. No JSON.stringify anywhere.
import React, { useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRoute } from '@react-navigation/native';
import { useColors, spacing } from '../theme';
import {
  normalizeNutritionEntries,
  groupNutritionEntries,
  GYM_NUTRITION_KIND_LABELS,
} from '../lib/gymContent';
import { logFoodEntry, MEAL_TYPES } from '../db/diary';
import { createRecipe } from '../db/recipes';
import { todayLocalISO } from '../lib/checkinDates';

const MEAL_LABELS = {
  breakfast: 'Breakfast',
  lunch: 'Lunch',
  dinner: 'Dinner',
  snack: 'Snack',
  other: 'Other',
};

export default function GymNutritionDetailScreen() {
  const colors = useColors();
  const route = useRoute();
  const { item, gymName, tag } = route.params || {};
  const [showMeals, setShowMeals] = useState(false);
  const [loggedMeal, setLoggedMeal] = useState(null); // meal_type just logged
  const [busy, setBusy] = useState(null); // 'log' | 'save' | null
  const [savedDish, setSavedDish] = useState(false);

  const styles = makeStyles(colors);

  if (!item) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Ionicons name="restaurant-outline" size={40} color={colors.textDim} />
        <Text style={styles.emptyTitle}>Recommendation unavailable.</Text>
        <Text style={styles.emptyBody}>It may have been removed by your gym.</Text>
      </View>
    );
  }

  const kindLabel = GYM_NUTRITION_KIND_LABELS[item.kind] || item.kind || 'Nutrition';
  const targets = item.targets || {};
  const macroBits = [
    targets.calories != null ? `${targets.calories} kcal` : null,
    targets.protein_g != null ? `${targets.protein_g}g protein` : null,
    targets.carbs_g != null ? `${targets.carbs_g}g carbs` : null,
    targets.fat_g != null ? `${targets.fat_g}g fat` : null,
  ].filter(Boolean);
  const groups = groupNutritionEntries(normalizeNutritionEntries(item.content));
  const assigned = tag === 'Assigned';
  const tags = Array.isArray(item.tags) ? item.tags : [];

  const logToMeal = async (mealType) => {
    if (busy) return;
    setBusy('log');
    try {
      await logFoodEntry({
        date: todayLocalISO(),
        mealType,
        name: item.title,
        calories: targets.calories ?? null,
        protein_g: targets.protein_g ?? null,
        carbs_g: targets.carbs_g ?? null,
        fat_g: targets.fat_g ?? null,
        quantity: 1,
        servingUnit: 'serving',
        foodSourceType: 'manual',
      });
      setLoggedMeal(mealType);
      setShowMeals(false);
    } catch (e) {
      Alert.alert('Could not log food', e?.message || 'Please try again.');
    } finally {
      setBusy(null);
    }
  };

  const saveToDishes = async () => {
    if (busy || savedDish) return;
    setBusy('save');
    try {
      const norm = normalizeNutritionEntries(item.content);
      await createRecipe({
        name: item.title,
        description: item.description || null,
        prep_notes: norm.filter((e) => e.type === 'step').map((e) => e.text).join('\n') || null,
        calories: targets.calories ?? null,
        protein_g: targets.protein_g ?? null,
        carbs_g: targets.carbs_g ?? null,
        fat_g: targets.fat_g ?? null,
        ingredients: norm.filter((e) => e.type === 'ingredient').map((e) => e.text),
        tags: tags.slice(),
        suggested_meal_types: [],
      });
      setSavedDish(true);
    } catch (e) {
      Alert.alert('Could not save to My Dishes', e?.message || 'Please try again.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {/* header */}
      <View style={styles.card}>
        <View style={styles.titleRow}>
          <View style={styles.titleWrap}>
            <Text style={styles.kind}>{kindLabel}{gymName ? ` · ${gymName}` : ''}</Text>
            <Text style={styles.title}>{item.title}</Text>
          </View>
          <View style={[styles.tag, { backgroundColor: assigned ? `${colors.primary}22` : `${colors.textDim}22` }]}>
            <Text style={[styles.tagText, { color: assigned ? colors.primary : colors.textDim }]}>
              {assigned ? 'Assigned' : 'Recommended'}
            </Text>
          </View>
        </View>
        {item.description ? (
          <Text style={styles.description}>{item.description}</Text>
        ) : null}
        {macroBits.length ? (
          <View style={styles.macroRow}>
            {macroBits.map((b) => (
              <View key={b} style={styles.macroChip}>
                <Text style={styles.macroChipText}>{b}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {tags.length ? (
          <View style={styles.tagsRow}>
            {tags.map((t) => (
              <View key={String(t)} style={styles.tagChip}>
                <Text style={styles.tagChipText}>{String(t)}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {assigned && (item.starts_on || item.ends_on || item.notes) ? (
          <View style={styles.windowBox}>
            {item.starts_on || item.ends_on ? (
              <Text style={styles.windowText}>
                {item.starts_on ? `From ${String(item.starts_on).slice(0, 10)}` : ''}
                {item.starts_on && item.ends_on ? ' · ' : ''}
                {item.ends_on ? `Until ${String(item.ends_on).slice(0, 10)}` : ''}
              </Text>
            ) : null}
            {item.notes ? <Text style={styles.windowText}>&ldquo;{item.notes}&rdquo;</Text> : null}
          </View>
        ) : null}
      </View>

      {/* content — grouped by the structured entry type, strings included */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Details</Text>
        {groups.length === 0 ? (
          <Text style={styles.emptyHint}>
            Your gym hasn&apos;t added the details for this item yet.
          </Text>
        ) : (
          groups.map((g) => (
            <View key={g.type} style={styles.group}>
              {g.label ? <Text style={styles.groupLabel}>{g.label}</Text> : null}
              {g.items.map((e, i) => (
                <View key={`${i}-${e.text.slice(0, 24)}`} style={styles.entryRow}>
                  {g.type === 'step' ? (
                    <Text style={styles.stepIndex}>{i + 1}.</Text>
                  ) : (
                    <Text style={styles.bullet}>•</Text>
                  )}
                  <View style={{ flex: 1 }}>
                    {g.type === 'day' && e.day ? (
                      <Text style={styles.dayLabel}>{e.day}</Text>
                    ) : null}
                    <Text style={styles.entryText}>{e.text}</Text>
                  </View>
                </View>
              ))}
            </View>
          ))
        )}
      </View>

      {/* actions — into the EXISTING diet infrastructure */}
      {loggedMeal ? (
        <View style={styles.successBox}>
          <Ionicons name="checkmark-circle" size={16} color={colors.primary} />
          <Text style={styles.successText}>
            Logged to {MEAL_LABELS[loggedMeal] || loggedMeal} — see it in your Diet tab.
          </Text>
        </View>
      ) : (
        <TouchableOpacity
          style={[styles.primaryBtn, busy && { opacity: 0.5 }]}
          disabled={!!busy}
          onPress={() => setShowMeals((v) => !v)}
          accessibilityRole="button"
          accessibilityLabel="Log this recommendation to today's diet"
        >
          <Ionicons name="add" size={16} color="#fff" />
          <Text style={styles.primaryBtnText}>Log to Today&apos;s Diet</Text>
        </TouchableOpacity>
      )}
      {showMeals && !loggedMeal ? (
        <View style={styles.mealPicker}>
          {MEAL_TYPES.map((m) => (
            <TouchableOpacity
              key={m}
              style={[styles.mealChip, busy === 'log' && { opacity: 0.5 }]}
              disabled={busy === 'log'}
              onPress={() => logToMeal(m)}
              accessibilityRole="button"
              accessibilityLabel={`Log to ${MEAL_LABELS[m] || m}`}
            >
              <Text style={styles.mealChipText}>{MEAL_LABELS[m] || m}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}
      <TouchableOpacity
        style={[styles.secondaryBtn, (busy || savedDish) && { opacity: 0.5 }]}
        disabled={!!busy || savedDish}
        onPress={saveToDishes}
        accessibilityRole="button"
        accessibilityLabel="Save this recommendation to My Dishes"
      >
        {busy === 'save' ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <>
            <Ionicons name={savedDish ? 'checkmark' : 'bookmark-outline'} size={16} color={colors.primary} />
            <Text style={[styles.secondaryBtnText, savedDish && { color: colors.primary }]}>
              {savedDish ? 'Saved to My Dishes' : 'Save to My Dishes'}
            </Text>
          </>
        )}
      </TouchableOpacity>
      <Text style={styles.hint}>
        Logging writes to your normal food diary for today. Saving keeps it in My Dishes for reuse.
      </Text>
    </ScrollView>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: spacing.md, textAlign: 'center' },
  emptyBody: { color: colors.textDim, fontSize: 13, marginTop: spacing.sm, textAlign: 'center', lineHeight: 19 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg - 2,
    marginBottom: spacing.md,
  },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  titleWrap: { flex: 1 },
  kind: { color: colors.primary, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  title: { color: colors.text, fontSize: 18, fontWeight: '800', lineHeight: 23, marginTop: 2 },
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  tagText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  description: { color: colors.textDim, fontSize: 13, lineHeight: 19, marginTop: spacing.sm },
  macroRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
  macroChip: {
    backgroundColor: `${colors.primary}14`, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  macroChipText: { color: colors.primary, fontSize: 11, fontWeight: '700', fontVariant: ['tabular-nums'] },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  tagChip: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  tagChipText: { color: colors.textDim, fontSize: 10, fontWeight: '700' },
  windowBox: { marginTop: spacing.md, gap: 2 },
  windowText: { color: colors.textDim, fontSize: 11 },
  cardTitle: { color: colors.text, fontSize: 13, fontWeight: '800', letterSpacing: 0.3, marginBottom: spacing.sm },
  group: { marginBottom: spacing.md },
  groupLabel: {
    color: colors.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 1,
    textTransform: 'uppercase', marginBottom: 4,
  },
  entryRow: { flexDirection: 'row', gap: spacing.sm, paddingVertical: 3 },
  bullet: { color: colors.primary, fontSize: 13, fontWeight: '800', width: 12 },
  stepIndex: { color: colors.primary, fontSize: 12, fontWeight: '800', width: 18, paddingTop: 1, fontVariant: ['tabular-nums'] },
  dayLabel: { color: colors.text, fontSize: 11, fontWeight: '800', letterSpacing: 0.3 },
  entryText: { color: colors.text, fontSize: 13, lineHeight: 19 },
  emptyHint: { color: colors.textDim, fontSize: 12 },
  successBox: {
    flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: `${colors.primary}14`,
    borderRadius: 12, padding: 13, marginBottom: spacing.sm,
  },
  successText: { color: colors.primary, fontSize: 12, fontWeight: '700', flex: 1 },
  primaryBtn: {
    backgroundColor: colors.primary, borderRadius: 12, padding: 14,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
  },
  primaryBtnText: { color: '#fff', fontWeight: '800', fontSize: 14 },
  mealPicker: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  mealChip: {
    borderWidth: 1.5, borderColor: colors.primary, borderRadius: 999,
    paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.card,
  },
  mealChipText: { color: colors.primary, fontSize: 12, fontWeight: '800' },
  secondaryBtn: {
    borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12, padding: 13,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
    marginTop: spacing.sm,
  },
  secondaryBtnText: { color: colors.primary, fontWeight: '800', fontSize: 14 },
  hint: { color: colors.textDim, fontSize: 11, textAlign: 'center', marginTop: spacing.md, lineHeight: 16 },
});
