import React, { useState } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../../../theme';
import { api } from '../../../lib/api';
import { saveDish, dishTotals } from '../../../db/customDishes';
import { scaleFoodMacros } from '../utils/foodScaling';
import FoodSearchModal from '../components/FoodSearchModal';

const NUMS = { fontVariant: ['tabular-nums'] };

// Build a Dish (Phase 3): ingredient-based macro calculation for home-cooked
// mixed meals that exist in no packaged database. Ingredients come from the
// global food database (with a manual fallback), macros are SNAPSHOTTED at
// add time, and both whole-dish and per-serving totals update live.
export default function BuildDishScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [name, setName] = useState('');
  const [servings, setServings] = useState('1');
  const [ingredients, setIngredients] = useState([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingIngredient, setPendingIngredient] = useState(null); // picked food awaiting qty
  const [qty, setQty] = useState('100');
  const [unit, setUnit] = useState('g');
  const [manualIng, setManualIng] = useState(null); // {name} fallback
  const [manualForm, setManualForm] = useState({ calories: '', protein_g: '', carbs_g: '', fat_g: '' });
  const [busy, setBusy] = useState(false);

  const totals = dishTotals(ingredients, servings);

  // a pick from food search becomes a pending ingredient (global-DB rows
  // scale per 100 g/ml or per piece; anything else is per serving)
  const onPick = (item) => {
    setPickerOpen(false);
    if (item.layer === 'global_database' || !item.layer) {
      setPendingIngredient(item);
      setQty(String(item.default_serving_size ?? 100));
      setUnit(item.default_serving_unit || 'g');
    } else {
      // recipe / dish layers are per-serving snapshots — add directly
      addIngredient({
        global_food_id: item.food_source_id || null,
        ingredient_name: item.name,
        quantity: 1, unit: 'serving',
        calories_snapshot: item.calories || 0,
        protein_g_snapshot: item.protein_g || 0,
        carbs_g_snapshot: item.carbs_g || 0,
        fat_g_snapshot: item.fat_g || 0,
      });
    }
  };

  const confirmIngredient = () => {
    const f = scaleFoodMacros(pendingIngredient, Number(qty) || 0, unit);
    addIngredient({
      global_food_id: pendingIngredient.id || null,
      ingredient_name: pendingIngredient.name,
      quantity: Number(qty) || 0, unit,
      calories_snapshot: f.calories || 0,
      protein_g_snapshot: f.protein_g || 0,
      carbs_g_snapshot: f.carbs_g || 0,
      fat_g_snapshot: f.fat_g || 0,
    });
    setPendingIngredient(null);
  };

  const addIngredient = (ing) => setIngredients((list) => [...list, ing]);

  const confirmManual = () => {
    if (!manualIng?.name?.trim()) return;
    addIngredient({
      global_food_id: null,
      ingredient_name: manualIng.name.trim(),
      quantity: 1, unit: 'serving',
      calories_snapshot: Number(manualForm.calories) || 0,
      protein_g_snapshot: Number(manualForm.protein_g) || 0,
      carbs_g_snapshot: Number(manualForm.carbs_g) || 0,
      fat_g_snapshot: Number(manualForm.fat_g) || 0,
    });
    setManualIng(null);
    setManualForm({ calories: '', protein_g: '', carbs_g: '', fat_g: '' });
  };

  const save = async () => {
    if (busy) return;
    if (!name.trim()) return Alert.alert('Name required', 'Give this dish a name.');
    if (!ingredients.length) return Alert.alert('No ingredients', 'Add at least one ingredient.');
    setBusy(true);
    try {
      await saveDish({ name, totalServings: Number(servings) || 1, ingredients });
      navigation.goBack();
    } catch (e) {
      Alert.alert('Could not save dish', e.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <Text style={styles.groupLabel}>Dish name</Text>
      <TextInput style={styles.input} placeholder="e.g. Dal Tadka, Pad Thai, Chili" placeholderTextColor={colors.textDim} value={name} onChangeText={setName} />
      <Text style={styles.groupLabel}>Makes how many servings?</Text>
      <TextInput style={[styles.input, styles.servingsInput, NUMS]} keyboardType="numeric" value={servings} onChangeText={(v) => setServings(v.replace(/[^0-9.]/g, ''))} />

      <Text style={styles.groupLabel}>Ingredients</Text>
      {ingredients.map((ing, i) => (
        <View key={i} style={styles.ingRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.ingName}>{ing.ingredient_name}</Text>
            <Text style={[styles.ingMeta, NUMS]}>
              {ing.quantity} {ing.unit} · {Math.round(ing.calories_snapshot)} cal ·{' '}
              {Math.round(ing.protein_g_snapshot)}P {Math.round(ing.carbs_g_snapshot)}C {Math.round(ing.fat_g_snapshot)}F
            </Text>
          </View>
          <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} onPress={() => setIngredients((l) => l.filter((_, j) => j !== i))}>
            <Ionicons name="close-circle-outline" size={17} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      ))}

      <TouchableOpacity style={styles.addIngBtn} onPress={() => setPickerOpen(true)}>
        <Ionicons name="add" size={15} color={colors.primary} />
        <Text style={styles.addIngText}>Add Ingredient</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.manualBtn} onPress={() => setManualIng({ name: '' })}>
        <Text style={styles.manualText}>Ingredient not in the database? Enter manually</Text>
      </TouchableOpacity>

      <View style={styles.totalsCard}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Total (whole dish)</Text>
          <Text style={[styles.totalValue, NUMS]}>
            {totals.total.calories} cal · {totals.total.protein_g}P {totals.total.carbs_g}C {totals.total.fat_g}F
          </Text>
        </View>
        <View style={[styles.totalRow, { marginTop: 6 }]}>
          <Text style={styles.totalLabel}>Per serving (÷{Number(servings) || 1})</Text>
          <Text style={[styles.totalValue, { ...styles.totalValue, color: colors.primary }, NUMS]}>
            {totals.perServing.calories} cal · {totals.perServing.protein_g}P {totals.perServing.carbs_g}C {totals.perServing.fat_g}F
          </Text>
        </View>
      </View>

      <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={busy}>
        <Text style={styles.saveText}>{busy ? 'Saving…' : 'Save Dish'}</Text>
      </TouchableOpacity>

      <FoodSearchModal
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        mealType="other"
        viewDate={null}
        onPickIngredient={onPick}
        pickMode
      />

      {/* ingredient quantity confirm */}
      {pendingIngredient && (
        <View style={styles.qtyOverlay}>
          <View style={styles.qtySheet}>
            <Text style={styles.qtyTitle}>{pendingIngredient.name}</Text>
            <View style={styles.qtyRow}>
              <TextInput style={[styles.input, styles.qtyInput, NUMS]} keyboardType="numeric" value={qty} onChangeText={(v) => setQty(v.replace(/[^0-9.]/g, ''))} />
              <TextInput style={[styles.input, styles.unitInput]} value={unit} onChangeText={setUnit} />
            </View>
            <Text style={[styles.qtyPreview, NUMS]}>
              {scaleFoodMacros(pendingIngredient, Number(qty) || 0, unit).calories} cal
            </Text>
            <TouchableOpacity style={styles.saveBtn} onPress={confirmIngredient}>
              <Text style={styles.saveText}>Add Ingredient</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.manualBtn} onPress={() => setPendingIngredient(null)}>
              <Text style={styles.manualText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* manual ingredient fallback */}
      {manualIng && (
        <View style={styles.qtyOverlay}>
          <View style={styles.qtySheet}>
            <Text style={styles.qtyTitle}>Manual ingredient</Text>
            <TextInput style={styles.input} placeholder="Ingredient name" placeholderTextColor={colors.textDim} value={manualIng.name} onChangeText={(v) => setManualIng({ name: v })} />
            <View style={styles.macroRow}>
              {[['calories', 'Cal'], ['protein_g', 'P'], ['carbs_g', 'C'], ['fat_g', 'F']].map(([k, label]) => (
                <View key={k} style={{ flex: 1 }}>
                  <Text style={styles.label}>{label}</Text>
                  <TextInput
                    style={[styles.input, NUMS]}
                    keyboardType="numeric"
                    value={manualForm[k]}
                    onChangeText={(v) => setManualForm((m) => ({ ...m, [k]: v }))}
                    placeholder="—"
                    placeholderTextColor={colors.textDim}
                  />
                </View>
              ))}
            </View>
            <Text style={styles.modeHint}>Enter totals for the amount you'll use in the whole dish.</Text>
            <TouchableOpacity style={styles.saveBtn} onPress={confirmManual}>
              <Text style={styles.saveText}>Add Ingredient</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.manualBtn} onPress={() => setManualIng(null)}>
              <Text style={styles.manualText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    groupLabel: {
      color: colors.textDim, fontSize: 11, fontWeight: '800',
      letterSpacing: 1, textTransform: 'uppercase', marginTop: 12, marginBottom: 5,
    },
    input: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 12,
      paddingHorizontal: 14, paddingVertical: 11, fontSize: 15,
    },
    servingsInput: { width: 110, textAlign: 'center' },
    ingRow: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.card, borderRadius: 11, padding: 11, marginBottom: 5,
    },
    ingName: { color: colors.text, fontSize: 14, fontWeight: '700' },
    ingMeta: { color: colors.textDim, fontSize: 11, marginTop: 1 },
    addIngBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12, paddingVertical: 11, marginTop: 8,
    },
    addIngText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
    manualBtn: { alignItems: 'center', paddingVertical: 10 },
    manualText: { color: colors.textDim, fontSize: 12 },
    totalsCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14, marginTop: 16,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    totalLabel: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
    totalValue: { color: colors.text, fontSize: 13, fontWeight: '800' },
    saveBtn: { backgroundColor: colors.primary, borderRadius: 13, padding: 14, alignItems: 'center', marginTop: 12 },
    saveText: { color: '#fff', fontWeight: '800', fontSize: 14 },
    qtyOverlay: {
      position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24,
    },
    qtySheet: { backgroundColor: colors.bg, borderRadius: 16, padding: 18 },
    qtyTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: 10 },
    qtyRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
    qtyInput: { width: 90, textAlign: 'center' },
    unitInput: { width: 80, textAlign: 'center' },
    qtyPreview: { color: colors.textDim, fontSize: 12, marginBottom: 8 },
    macroRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
    label: { color: colors.textDim, fontSize: 10, marginBottom: 3 },
    modeHint: { color: colors.textDim, fontSize: 11, marginTop: 8 },
  });
