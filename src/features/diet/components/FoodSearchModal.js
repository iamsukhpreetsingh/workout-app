import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet, Modal, ActivityIndicator, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../lib/api';
import { useColors } from '../../../theme';
import { logFoodEntry, getRecentAndFrequent } from '../../../db/diary';
import { getAllergenConflicts } from '../../../lib/allergens';
import { listDishes, dishTotals } from '../../../db/customDishes';
import BarcodeScannerModal from '../../../components/BarcodeScannerModal';

const NUMS = { fontVariant: ['tabular-nums'] };

const LAYER_LABELS = {
  global_database: null, // curated — no label needed
  personal_recipe: 'My recipe',
  trainer_recipe: "Trainer's dish",
  custom_dish: 'My dish',
};

// THE unified Add Food flow for the Diet tab (Phase 2 + 4): three-layer
// search (global database incl. cached Open Food Facts results, personal
// recipes, trainer catalog, custom dishes) + barcode lookup + Recent +
// Frequent + manual entry. Every pick passes a quantity confirm; logging is
// local-first (works offline — search needs the network, logging never does).
export default function FoodSearchModal({
  visible, onClose, mealType, viewDate, onLogged, pickMode = false, onPickIngredient,
  trainerItems = [], trainerPlanName = null, intakeProfile = null,
}) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [tab, setTab] = useState('search');
  const [query, setQuery] = useState('');
  const [barcode, setBarcode] = useState('');
  const [scannerOpen, setScannerOpen] = useState(false);
  const [results, setResults] = useState(null); // null = loading
  const [recents, setRecents] = useState({ recent: [], frequent: [] });
  const [dishes, setDishes] = useState([]);
  const [picked, setPicked] = useState(null); // item awaiting quantity confirm
  const [qty, setQty] = useState('1');
  const [unit, setUnit] = useState('serving');
  const [manual, setManual] = useState({ name: '', calories: '', protein_g: '', carbs_g: '', fat_g: '' });
  const [searchTimer, setSearchTimer] = useState(null);
  // From Trainer grouping — the plan's OWN meal structure, not the section
  // the sheet was opened from (the picked item logs into the meal the user
  // tapped Add Food in, via mealType)
  const trainerGroups = (() => {
    const groups = new Map();
    for (const it of trainerItems) {
      const key = it.meal_type || 'Meal';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    return [...groups.entries()];
  })();

  useEffect(() => {
    if (visible) {
      setTab(trainerItems.length > 0 ? 'trainer' : 'search');
      setQuery('');
      setBarcode('');
      setResults(null);
      setPicked(null);
      setManual({ name: '', calories: '', protein_g: '', carbs_g: '', fat_g: '' });
      getRecentAndFrequent(10).then(setRecents).catch(() => {});
      listDishes().then(setDishes).catch(() => {});
    }
  }, [visible]);

  // debounced server-side search across all layers
  useEffect(() => {
    if (!visible || tab !== 'search') return;
    if (searchTimer) clearTimeout(searchTimer);
    if (!query.trim() && !barcode.trim()) { setResults(null); return; }
    const t = setTimeout(async () => {
      setResults(null);
      try {
        const params = barcode.trim() ? `barcode=${encodeURIComponent(barcode.trim())}` : `q=${encodeURIComponent(query.trim())}`;
        setResults(await api(`/client/food-search?${params}`));
      } catch {
        setResults([]); // offline: search is unavailable, logging still is
      }
    }, 350);
    setSearchTimer(t);
    return () => clearTimeout(t);
  }, [query, barcode, visible, tab]);

  const confirmAllergen = (item, conflicts) => {
    Alert.alert(
      'Allergen warning',
      `This item contains ${conflicts.join(', ')}, which you have listed as an allergen. Log it anyway?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Log Anyway', style: 'destructive', onPress: () => openPick(item) },
      ],
      { cancelable: true }
    );
  };

  const openPick = (item) => {
    // ingredient-picker mode (Build a Dish): hand the item back to the caller
    if (pickMode) {
      onPickIngredient?.(item);
      onClose();
      return;
    }
    const perServing = item.layer === 'custom_dish' || item.layer === 'trainer_recipe';
    setPicked(item);
    setQty(String(item.default_serving_size ?? 1));
    setUnit(perServing ? 'serving' : item.default_serving_unit || 'g');
  };

  const scaledMacros = () => {
    const n = Number(qty) || 0;
    const base = Number(picked?.default_serving_size) || 100;
    const baseUnit = picked?.default_serving_unit || 'g';
    // global-DB rows are per 100 g/ml (or per piece unit); everything else
    // (recipes, dishes, catalog) is per serving
    const perPieceUnits = ['piece', 'slice', 'clove', 'scoop', 'bar', 'cup', 'tbsp', 'tsp'];
    let factor;
    if (picked?.layer === 'trainer_recipe') {
      // trainer plan items arrive with macros ALREADY scaled to the
      // prescribed amount (quantity_multiplier applied upstream) — the
      // logged copy snapshots those values; the plan itself is untouched
      factor = n;
    } else if (picked?.layer === 'global_database') {
      factor = perPieceUnits.includes(String(unit).toLowerCase()) ? n : n / 100;
    } else {
      factor = n * (baseUnit === 'serving' ? 1 : 1) / (baseUnit === 'serving' ? 1 : base);
    }
    const sc = (v) => (v == null ? null : Math.round(v * factor * 10) / 10);
    return {
      calories: picked?.calories != null ? Math.round(picked.calories * factor) : null,
      protein_g: sc(picked?.protein_g),
      carbs_g: sc(picked?.carbs_g),
      fat_g: sc(picked?.fat_g),
    };
  };

  const confirmLog = async () => {
    if (!picked) return;
    const m = scaledMacros();
    try {
      await logFoodEntry({
        date: viewDate,
        mealType,
        name: picked.name,
        quantity: Number(qty) || 1,
        servingUnit: unit,
        foodSourceType: picked.layer || 'manual',
        foodSourceId: picked.food_source_id || (picked.layer === 'global_database' ? picked.id : null),
        ...m,
      });
      setPicked(null);
      onLogged?.();
      onClose();
    } catch (e) {
      Alert.alert('Could not log food', e.message || 'Please try again.');
    }
  };

  const logManual = async () => {
    if (!manual.name.trim()) return;
    try {
      await logFoodEntry({
        date: viewDate,
        mealType,
        name: manual.name.trim(),
        calories: manual.calories === '' ? null : Number(manual.calories),
        protein_g: manual.protein_g === '' ? null : Number(manual.protein_g),
        carbs_g: manual.carbs_g === '' ? null : Number(manual.carbs_g),
        fat_g: manual.fat_g === '' ? null : Number(manual.fat_g),
        quantity: 1,
        servingUnit: 'serving',
        foodSourceType: 'manual',
      });
      onLogged?.();
      onClose();
    } catch (e) {
      Alert.alert('Could not log food', e.message || 'Please try again.');
    }
  };

  const macroText = (r) =>
    [
      r.calories != null ? `${Math.round(r.calories)} kcal` : null,
      r.protein_g != null ? `${Math.round(r.protein_g)}P` : null,
      r.carbs_g != null ? `${Math.round(r.carbs_g)}C` : null,
      r.fat_g != null ? `${Math.round(r.fat_g)}F` : null,
    ].filter(Boolean).join(' · ');

  const renderRow = (r, key, onPress) => (
    <TouchableOpacity key={key} style={styles.row} onPress={onPress || (() => openPick(r))}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.rowName} numberOfLines={1}>{r.name}</Text>
          {r.verified === false && (
            <View style={styles.unverifiedChip}><Text style={styles.unverifiedText}>unverified</Text></View>
          )}
          {LAYER_LABELS[r.layer] && (
            <View style={styles.layerChip}><Text style={styles.layerText}>{LAYER_LABELS[r.layer]}</Text></View>
          )}
        </View>
        <Text style={[styles.rowMacro, NUMS]}>{macroText(r) || 'Nutrition unavailable'}</Text>
        {r._warn ? <Text style={styles.rowWarn}>{r._warn}</Text> : null}
      </View>
      <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
    </TouchableOpacity>
  );

  return (
    <>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
        <View style={styles.wrap}>
          <View style={styles.sheet}>
            <Text style={styles.title}>Add Food</Text>
            <View style={styles.tabs}>
              {[
                { key: 'search', label: 'Search' },
                { key: 'recent', label: 'Recent' },
                ...(trainerItems.length > 0 ? [{ key: 'trainer', label: 'From Trainer' }] : []),
                { key: 'dishes', label: 'My Dishes' },
                { key: 'manual', label: 'Manual' },
              ].map((t) => (
                <TouchableOpacity key={t.key} style={[styles.tab, tab === t.key && styles.tabOn]} onPress={() => setTab(t.key)}>
                  <Text style={[styles.tabText, tab === t.key && { color: '#fff' }]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {tab === 'search' && (
              <>
                <TextInput
                  style={styles.field}
                  placeholder="Search foods, dishes, recipes…"
                  placeholderTextColor={colors.textDim}
                  value={query}
                  onChangeText={setQuery}
                />
                  <View style={styles.barcodeRow}>
                  <Text style={styles.barcodeLabel}>Barcode:</Text>
                  <TextInput
                    style={[styles.field, styles.barcodeInput, NUMS]}
                    placeholder="Type product barcode"
                    placeholderTextColor={colors.textDim}
                    keyboardType="number-pad"
                    value={barcode}
                    onChangeText={(v) => { setBarcode(v); if (v.trim()) setQuery(''); }}
                  />
                  <TouchableOpacity
                    style={styles.scanBtn}
                    onPress={() => setScannerOpen(true)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="barcode-outline" size={22} color={colors.primary} />
                  </TouchableOpacity>
                </View>
              </>
            )}

            <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
              {tab === 'search' && (
                results == null ? (
                  (query.trim() || barcode.trim())
                    ? <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
                    : <Text style={styles.empty}>Search the shared food database, your recipes and dishes, and your trainer's suggestions. Packaged products fall through to Open Food Facts and are cached for next time.</Text>
                ) : results.length === 0 ? (
                  <Text style={styles.empty}>No matches. Use Manual entry below — or add it as a custom dish.</Text>
                ) : (
                  results.map((r, i) => renderRow(r, r.id || i))
                )
              )}

              {tab === 'recent' && (
                recents.recent.length === 0
                  ? <Text style={styles.empty}>Foods you log will appear here for one-tap re-logging.</Text>
                  : recents.recent.map((r, i) => renderRow({ ...r, layer: r.food_source_type }, `rec${i}`))
              )}
              {tab === 'trainer' && (
                trainerItems.length === 0 ? (
                  <Text style={styles.empty}>No foods or recipes have been added to your trainer plan yet.</Text>
                ) : (
                  <>
                    {trainerPlanName ? <Text style={styles.planHint}>From: {trainerPlanName}</Text> : null}
                    {trainerGroups.map(([mealType, items]) => (
                      <View key={mealType}>
                        <Text style={styles.trainerMealLabel}>{String(mealType).toUpperCase()}</Text>
                        {items.map((it) => {
                          const conflicts = intakeProfile
                            ? getAllergenConflicts(intakeProfile.allergens, it.allergens)
                            : [];
                          return renderRow(
                            {
                              ...it,
                              layer: 'trainer_recipe',
                              default_serving_size: 1,
                              default_serving_unit: 'serving',
                              _warn: conflicts.length ? `⚠ Contains ${conflicts.join(', ')}` : null,
                            },
                            it.id,
                            () => (conflicts.length ? confirmAllergen(it, conflicts) : openPick(it))
                          );
                        })}
                      </View>
                    ))}
                  </>
                )
              )}
              {tab === 'dishes' && (
                dishes.length === 0
                  ? <Text style={styles.empty}>No custom dishes yet — build one from the Diet tab's "Build a Dish".</Text>
                  : dishes.map((d) => {
                      const t = dishTotals(d.ingredients, d.total_servings);
                      return renderRow({
                        ...t.perServing, name: d.name, layer: 'custom_dish',
                        food_source_id: d.local_id, default_serving_size: 1, default_serving_unit: 'serving',
                      }, d.local_id);
                    })
              )}
              {tab === 'manual' && (
                <View>
                  <TextInput style={styles.field} placeholder="Food name" placeholderTextColor={colors.textDim} value={manual.name} onChangeText={(v) => setManual((m) => ({ ...m, name: v }))} />
                  <View style={styles.macroRow}>
                    {[['calories', 'Cal'], ['protein_g', 'P'], ['carbs_g', 'C'], ['fat_g', 'F']].map(([k, label]) => (
                      <View key={k} style={styles.macroCell}>
                        <Text style={styles.macroLabel}>{label}</Text>
                        <TextInput
                          style={[styles.field, styles.macroInput, NUMS]}
                          keyboardType="numeric"
                          value={manual[k]}
                          onChangeText={(v) => setManual((m) => ({ ...m, [k]: v }))}
                          placeholder="—"
                          placeholderTextColor={colors.textDim}
                        />
                      </View>
                    ))}
                  </View>
                  <TouchableOpacity style={styles.primaryBtn} onPress={logManual}>
                    <Text style={styles.primaryBtnText}>Log Food</Text>
                  </TouchableOpacity>
                </View>
              )}
            </ScrollView>

            <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

            {/* camera barcode scanner — feeds the existing barcode search path */}
      <BarcodeScannerModal
        visible={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onScanned={(code) => {
          setBarcode(code);
          setQuery('');
        }}
      />


      {/* quantity confirm for the picked food */}
      <Modal visible={!!picked} transparent animationType="fade" onRequestClose={() => setPicked(null)}>
        <View style={styles.wrap}>
          <View style={[styles.sheet, { height: undefined }]}>
            <Text style={styles.title}>{picked?.name}</Text>
            <Text style={[styles.preview, NUMS]}>
              {picked ? `${scaledMacros().calories ?? '—'} kcal` : ''}
              {picked?.protein_g != null ? ` · ${scaledMacros().protein_g}P` : ''}
              {picked?.carbs_g != null ? ` · ${scaledMacros().carbs_g}C` : ''}
              {picked?.fat_g != null ? ` · ${scaledMacros().fat_g}F` : ''}
            </Text>
            <View style={styles.qtyRow}>
              <Text style={styles.qtyLabel}>Quantity</Text>
              <TextInput style={[styles.field, styles.qtyInput, NUMS]} keyboardType="numeric" value={qty} onChangeText={(v) => setQty(v.replace(/[^0-9.]/g, ''))} />
              <TextInput
                style={[styles.field, styles.unitInput]}
                value={unit}
                onChangeText={setUnit}
                placeholder="unit"
                placeholderTextColor={colors.textDim}
              />
            </View>
            <TouchableOpacity style={styles.primaryBtn} onPress={confirmLog}>
              <Text style={styles.primaryBtnText}>Log</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setPicked(null)}>
              <Text style={styles.cancelText}>Back</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    wrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
      padding: 18, height: '80%',
    },
    title: { color: colors.text, fontSize: 17, fontWeight: '800', marginBottom: 10 },
    tabs: { flexDirection: 'row', backgroundColor: colors.cardLight, borderRadius: 12, padding: 3, marginBottom: 10 },
    tab: { flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 8 },
    tabOn: { backgroundColor: colors.primary },
    tabText: { color: colors.textDim, fontWeight: '700', fontSize: 11 },
    field: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 9, marginBottom: 8, fontSize: 14,
    },
    barcodeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    barcodeLabel: { color: colors.textDim, fontSize: 11, fontWeight: '700' },
    barcodeInput: { flex: 1, marginBottom: 8 },
        scanBtn: {
      width: 42, height: 42, borderRadius: 10,
      backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center', marginBottom: 8,
    },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 6,
    },
    rowName: { color: colors.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
    rowMacro: { color: colors.textDim, fontSize: 11, marginTop: 2 },
    unverifiedChip: { borderWidth: 1, borderColor: colors.orange, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
    unverifiedText: { color: colors.orange, fontSize: 9, fontWeight: '800' },
    layerChip: { borderWidth: 1, borderColor: colors.blue, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
    layerText: { color: colors.blue, fontSize: 9, fontWeight: '800' },
    empty: { color: colors.textDim, fontSize: 13, textAlign: 'center', paddingVertical: 24, lineHeight: 19 },
    planHint: { color: colors.primary, fontSize: 11, fontWeight: '700', marginBottom: 8 },
    trainerMealLabel: {
      color: colors.textDim, fontSize: 10, fontWeight: '800',
      letterSpacing: 1, marginTop: 8, marginBottom: 4,
    },
    rowWarn: { color: colors.red, fontSize: 10, fontWeight: '700', marginTop: 2 },
    macroRow: { flexDirection: 'row', gap: 8 },
    macroCell: { flex: 1 },
    macroLabel: { color: colors.textDim, fontSize: 11, marginBottom: 4, textAlign: 'center' },
    macroInput: { textAlign: 'center', paddingVertical: 9 },
    primaryBtn: { backgroundColor: colors.primary, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 6 },
    primaryBtnText: { color: '#fff', fontWeight: '800' },
    cancelBtn: { alignItems: 'center', padding: 10 },
    cancelText: { color: colors.textDim, fontWeight: '700' },
    preview: { color: colors.textDim, fontSize: 12, marginBottom: 8 },
    qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
    qtyLabel: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
    qtyInput: { width: 70, textAlign: 'center', marginBottom: 0 },
    unitInput: { width: 90, marginBottom: 0 },
  });
