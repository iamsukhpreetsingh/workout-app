import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../../../theme';
import DishPickerModal from '../../../components/DishPickerModal';
import { suggestFoodsToFit } from '../domain/nutritionCore';

const NUMS = { fontVariant: ['tabular-nums'] };

// THE "Add Food" sheet for Detailed-mode food logging (§14): low-friction,
// diary-first — Search Food (shared DishPickerModal), Recent Foods with
// quantity memory, From Plan (unlogged planned items), Enter Manually.
// Every pick lands in a quantity-confirm step before the parent logs it.
//
// Props:
//   visible / onClose
//   title            — sheet heading
//   catalog / refreshCatalog / self — passed through to DishPickerModal
//   recents          — recent foods (last quantity preloaded)
//   plannedItems     — [{ id, name, calories, protein_g, ... }] not yet logged
//   hasPlanFood      — plan has items today (drives 'extra' vs 'free_logged')
//   mealTypes        — meal choices for the entry
//   defaultMealType
//   remaining        — { calories, protein_g } for "fits remaining" ranking
//   onLog(entry)     — { name, calories, protein_g, carbs_g, fat_g,
//                        serving_size, quantity, mealType, source,
//                        plannedItemRef }
export default function AddFoodModal({
  visible,
  onClose,
  title = 'Add Food',
  catalog,
  refreshCatalog,
  self,
  recents = [],
  plannedItems = [],
  hasPlanFood = false,
  mealTypes = ['Anytime'],
  defaultMealType,
  remaining = null,
  onLog,
}) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [tab, setTab] = useState('recent');
  const [searchOpen, setSearchOpen] = useState(false);
  const [picked, setPicked] = useState(null); // item awaiting quantity confirm
  const [quantity, setQuantity] = useState('1');
  const [mealType, setMealType] = useState(defaultMealType || mealTypes[0] || 'Anytime');
  const [manual, setManual] = useState({ name: '', calories: '', protein_g: '', carbs_g: '', fat_g: '', serving_size: '' });

  // fresh state per open
  useEffect(() => {
    if (visible) {
      setTab('recent');
      setSearchOpen(false);
      setPicked(null);
      setQuantity('1');
      setMealType(defaultMealType || mealTypes[0] || 'Anytime');
      setManual({ name: '', calories: '', protein_g: '', carbs_g: '', fat_g: '', serving_size: '' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // deterministic "what fits my remaining budget" — recents + plan items
  const fits = useMemo(
    () => suggestFoodsToFit(remaining, [...recents, ...plannedItems], 5),
    [remaining, recents, plannedItems]
  );
  const fitsNames = new Set(fits.map((f) => String(f.name).toLowerCase()));

  const openPick = (item, { fromPlan = false } = {}) => {
    const q = fromPlan ? 1 : Number(item.quantity) || 1;
    setPicked({ ...item, fromPlan });
    setQuantity(String(q));
  };

  const scaled = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return null;
    return Math.round(n * (Number(quantity) || 1));
  };

  const confirmLog = () => {
    if (!picked) return;
    onLog({
      name: picked.name,
      calories: picked.calories != null ? scaled(picked.calories) : null,
      protein_g: picked.protein_g != null ? Number((Number(picked.protein_g) * (Number(quantity) || 1)).toFixed(1)) : null,
      carbs_g: picked.carbs_g != null ? Number((Number(picked.carbs_g) * (Number(quantity) || 1)).toFixed(1)) : null,
      fat_g: picked.fat_g != null ? Number((Number(picked.fat_g) * (Number(quantity) || 1)).toFixed(1)) : null,
      serving_size: picked.serving_size || null,
      quantity: Number(quantity) || 1,
      mealType,
      source: picked.fromPlan ? 'planned' : hasPlanFood ? 'extra' : 'free_logged',
      plannedItemRef: picked.fromPlan ? picked.id : null,
    });
    setPicked(null);
    onClose();
  };

  const submitManual = () => {
    if (!manual.name.trim()) return;
    // manual totals are for the amount actually eaten — quantity stays 1
    onLog({
      name: manual.name.trim(),
      calories: manual.calories === '' ? null : Number(manual.calories),
      protein_g: manual.protein_g === '' ? null : Number(manual.protein_g),
      carbs_g: manual.carbs_g === '' ? null : Number(manual.carbs_g),
      fat_g: manual.fat_g === '' ? null : Number(manual.fat_g),
      serving_size: manual.serving_size || null,
      quantity: 1,
      mealType,
      source: hasPlanFood ? 'extra' : 'free_logged',
      plannedItemRef: null,
    });
    onClose();
  };

  const macroText = (item) =>
    [
      item.calories != null ? `${Math.round(item.calories)} kcal` : null,
      item.protein_g != null ? `${Math.round(item.protein_g)}P` : null,
      item.carbs_g != null ? `${Math.round(item.carbs_g)}C` : null,
      item.fat_g != null ? `${Math.round(item.fat_g)}F` : null,
    ]
      .filter(Boolean)
      .join(' · ');

  const renderPickRow = (item, { fromPlan = false } = {}) => (
    <TouchableOpacity key={`${item.id ?? item.name}`} style={styles.row} onPress={() => openPick(item, { fromPlan })}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
          {fitsNames.has(String(item.name).toLowerCase()) && (
            <View style={styles.fitsChip}><Text style={styles.fitsChipText}>fits</Text></View>
          )}
        </View>
        <Text style={[styles.rowMacro, NUMS]}>
          {macroText(item)}
          {item.quantity && item.quantity !== 1 ? ` · last: ${item.quantity}x` : ''}
          {item.serving_size ? ` · ${item.serving_size}` : ''}
        </Text>
      </View>
      <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
    </TouchableOpacity>
  );

  return (
    <>
      <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
        <View style={styles.wrap}>
          <View style={styles.sheet}>
            <Text style={styles.title}>{title}</Text>

            <TouchableOpacity style={styles.searchBtn} onPress={() => setSearchOpen(true)}>
              <Ionicons name="search" size={16} color={colors.primary} />
              <Text style={styles.searchBtnText}>Search Food</Text>
            </TouchableOpacity>

            <View style={styles.tabs}>
              {[
                { key: 'recent', label: 'Recent' },
                { key: 'plan', label: 'From Plan' },
                { key: 'manual', label: 'Manual' },
              ].map((t) => (
                <TouchableOpacity key={t.key} style={[styles.tab, tab === t.key && styles.tabOn]} onPress={() => setTab(t.key)}>
                  <Text style={[styles.tabText, tab === t.key && { color: '#fff' }]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
              {tab === 'recent' ? (
                recents.length === 0 ? (
                  <Text style={styles.empty}>Foods you log will appear here for one-tap re-logging.</Text>
                ) : (
                  recents.map((r) => renderPickRow(r))
                )
              ) : null}

              {tab === 'plan' ? (
                plannedItems.length === 0 ? (
                  <Text style={styles.empty}>No planned meals left to log for this day.</Text>
                ) : (
                  <>
                    <Text style={styles.hint}>Log a planned meal exactly as prescribed.</Text>
                    {plannedItems.map((p) => renderPickRow(p, { fromPlan: true }))}
                  </>
                )
              ) : null}

              {tab === 'manual' ? (
                <View>
                  <TextInput
                    style={styles.field}
                    placeholder="Food name"
                    placeholderTextColor={colors.textDim}
                    value={manual.name}
                    onChangeText={(v) => setManual((m) => ({ ...m, name: v }))}
                  />
                  <View style={styles.macroRow}>
                    {[
                      ['calories', 'Cal'],
                      ['protein_g', 'P'],
                      ['carbs_g', 'C'],
                      ['fat_g', 'F'],
                    ].map(([k, label]) => (
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
                  <TextInput
                    style={styles.field}
                    placeholder="Serving description (e.g. 1 bowl) — optional"
                    placeholderTextColor={colors.textDim}
                    value={manual.serving_size}
                    onChangeText={(v) => setManual((m) => ({ ...m, serving_size: v }))}
                  />
                  <TouchableOpacity style={styles.primaryBtn} onPress={submitManual}>
                    <Text style={styles.primaryBtnText}>Log Food</Text>
                  </TouchableOpacity>
                </View>
              ) : null}
            </ScrollView>

            <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* quantity confirm — every pick passes through here before logging */}
      <Modal visible={!!picked} transparent animationType="fade" onRequestClose={() => setPicked(null)}>
        <View style={styles.wrap}>
          <View style={[styles.sheet, { height: undefined }]}>
            <Text style={styles.title}>{picked?.name}</Text>
            <Text style={[styles.hint, NUMS]}>
              {picked
                ? `${scaled(picked.calories) ?? '—'} kcal · ${picked.protein_g != null ? `${Math.round(Number(picked.protein_g) * (Number(quantity) || 1))}P ` : ''}${picked.carbs_g != null ? `${Math.round(Number(picked.carbs_g) * (Number(quantity) || 1))}C ` : ''}${picked.fat_g != null ? `${Math.round(Number(picked.fat_g) * (Number(quantity) || 1))}F` : ''}`
                : ''}
            </Text>
            <View style={styles.qtyRow}>
              <Text style={styles.qtyLabel}>Quantity</Text>
              <TextInput
                style={[styles.field, styles.qtyInput, NUMS]}
                keyboardType="numeric"
                value={quantity}
                onChangeText={setQuantity}
              />
              {picked?.serving_size ? <Text style={styles.qtyUnit}>{picked.serving_size}</Text> : null}
            </View>
            <Text style={styles.mealLabel}>Meal</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {mealTypes.map((mt) => (
                <TouchableOpacity key={mt} style={[styles.mealChip, mealType === mt && styles.mealChipOn]} onPress={() => setMealType(mt)}>
                  <Text style={[styles.mealChipText, mealType === mt && { color: '#fff' }]}>{mt}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.primaryBtn} onPress={confirmLog}>
              <Text style={styles.primaryBtnText}>Log</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setPicked(null)}>
              <Text style={styles.cancelText}>Back</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* full dish search (My Dishes / coach catalog) — the ONE shared picker */}
      <DishPickerModal
        visible={searchOpen}
        onClose={() => setSearchOpen(false)}
        title="Search Food"
        self={self}
        catalog={catalog}
        refreshCatalog={refreshCatalog}
        slotHint={mealType}
        onPickCatalog={(c) => { setSearchOpen(false); openPick(c); }}
        onPickCustom={(it) => {
          setSearchOpen(false);
          // free-typed entry: totals are for what was eaten — log directly
          onLog({
            name: it.name,
            calories: it.calories ?? null,
            protein_g: it.protein_g ?? null,
            carbs_g: it.carbs_g ?? null,
            fat_g: it.fat_g ?? null,
            serving_size: it.serving_size || null,
            quantity: 1,
            mealType,
            source: hasPlanFood ? 'extra' : 'free_logged',
            plannedItemRef: null,
          });
          onClose();
        }}
      />
    </>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    wrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    sheet: {
      backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
      padding: 18, height: '78%',
    },
    title: { color: colors.text, fontSize: 17, fontWeight: '800', marginBottom: 10 },
    searchBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12,
      paddingVertical: 11, marginBottom: 12,
    },
    searchBtnText: { color: colors.primary, fontWeight: '800', fontSize: 14 },
    tabs: { flexDirection: 'row', backgroundColor: colors.cardLight, borderRadius: 12, padding: 3, marginBottom: 10 },
    tab: { flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 8 },
    tabOn: { backgroundColor: colors.primary },
    tabText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },
    row: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 6,
      shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1, shadowRadius: 6, elevation: 2,
    },
    rowName: { color: colors.text, fontSize: 14, fontWeight: '700' },
    rowMacro: { color: colors.textDim, fontSize: 11, marginTop: 2 },
    fitsChip: {
      borderWidth: 1, borderColor: colors.green, borderRadius: 6,
      paddingHorizontal: 5, paddingVertical: 1,
    },
    fitsChipText: { color: colors.green, fontSize: 9, fontWeight: '800' },
    hint: { color: colors.textDim, fontSize: 12, marginBottom: 8 },
    empty: { color: colors.textDim, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
    field: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 9, marginBottom: 8, fontSize: 14,
    },
    macroRow: { flexDirection: 'row', gap: 8 },
    macroCell: { flex: 1 },
    macroLabel: { color: colors.textDim, fontSize: 11, marginBottom: 4, textAlign: 'center' },
    macroInput: { textAlign: 'center', paddingVertical: 9 },
    primaryBtn: { backgroundColor: colors.primary, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 6 },
    primaryBtnText: { color: '#fff', fontWeight: '800' },
    cancelBtn: { alignItems: 'center', padding: 10, marginTop: 4 },
    cancelText: { color: colors.textDim, fontWeight: '700' },
    qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
    qtyLabel: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
    qtyInput: { width: 80, textAlign: 'center', marginBottom: 0 },
    qtyUnit: { color: colors.textDim, fontSize: 12 },
    mealLabel: {
      color: colors.textDim, fontSize: 10, fontWeight: '800',
      textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6,
    },
    mealChip: {
      backgroundColor: colors.cardLight, borderRadius: 10,
      paddingHorizontal: 11, paddingVertical: 7,
    },
    mealChipOn: { backgroundColor: colors.primary },
    mealChipText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },
  });
