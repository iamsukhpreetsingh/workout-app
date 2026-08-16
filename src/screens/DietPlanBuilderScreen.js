import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Modal,
  FlatList,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../lib/api';
import { useColors } from '../theme';
import CatalogSearch from '../components/CatalogSearch';
import DishForm from '../components/DishForm';

const NUMS = { fontVariant: ['tabular-nums'] };
const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Pre-Workout', 'Post-Workout'];

let uid = 0;
const nid = () => `x${Date.now()}_${++uid}`;

const scaled = (v, mult) => (v == null ? null : Math.round(Number(v) * mult));
const macroLine = (it) => {
  const m = it.quantity_multiplier || 1;
  const parts = [];
  if (it.calories != null) parts.push(`${scaled(it.calories, m)} cal`);
  if (it.protein_g != null) parts.push(`${scaled(it.protein_g, m)}P`);
  if (it.carbs_g != null) parts.push(`${scaled(it.carbs_g, m)}C`);
  if (it.fat_g != null) parts.push(`${scaled(it.fat_g, m)}F`);
  return parts.join(' · ') || 'macros not set';
};

// Structured diet plan builder: plan targets + collapsible days → meal
// slots → items (catalog snapshots or custom). `self` mode is the
// client-authored variant — identical structure, no catalog access.
export default function DietPlanBuilderScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { clientId, clientName, self } = route.params || {};

  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [targets, setTargets] = useState({ cal: '', pro: '', car: '', fat: '' });
  const [days, setDays] = useState([]);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(new Set());

  const [picker, setPicker] = useState(null); // { mealKey, mealType, mode }
  const [pickQuery, setPickQuery] = useState('');
  const [pickTag, setPickTag] = useState(null);
  const [quickCreate, setQuickCreate] = useState(false); // nested DishForm inside the picker
  const [catalog, setCatalog] = useState(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [customForm, setCustomForm] = useState(null); // { mealKey, form, saveToCatalog }

  React.useLayoutEffect(() => {
    navigation.setOptions({
      title: self ? 'New Diet Plan' : `Diet Plan → ${clientName || 'Client'}`,
    });
  }, [navigation, clientName, self]);

  useEffect(() => {
    if (!self) {
      api('/trainer/meal-catalog')
        .then(setCatalog)
        .catch(() => setCatalog([]));
    }
  }, [self]);

  const mutateDays = (fn) => setDays((prev) => fn(prev.map((d) => ({ ...d, meals: [...d.meals] }))));

  const addDay = () =>
    setDays((prev) => [
      ...prev,
      { key: nid(), day_label: `Day ${prev.length + 1}`, meals: [] },
    ]);

  const renameDay = (key, label) => mutateDays((ds) => ds.map((d) => (d.key === key ? { ...d, day_label: label } : d)));
  const removeDay = (key) => setDays((prev) => prev.filter((d) => d.key !== key));
  const toggleCollapse = (key) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const addMealSlot = (dayKey, mealType) =>
    mutateDays((ds) =>
      ds.map((d) =>
        d.key === dayKey
          ? { ...d, meals: [...d.meals, { key: nid(), meal_type: mealType, slot_note: '', items: [] }] }
          : d
      )
    );

  const findMeal = (mealKey) => {
    for (const d of days) for (const m of d.meals) if (m.key === mealKey) return m;
    return null;
  };

  const addItemToMeal = (mealKey, item) =>
    mutateDays((ds) =>
      ds.map((d) => ({
        ...d,
        meals: d.meals.map((m) =>
          m.key === mealKey
            ? { ...m, items: [...m.items, { key: nid(), quantity_multiplier: 1, client_note: '', ...item }] }
            : m
        ),
      }))
    );

  const removeItem = (mealKey, itemKey) =>
    mutateDays((ds) =>
      ds.map((d) => ({
        ...d,
        meals: d.meals.map((m) =>
          m.key === mealKey ? { ...m, items: m.items.filter((i) => i.key !== itemKey) } : m
        ),
      }))
    );

  const adjustMultiplier = (mealKey, itemKey, delta) =>
    mutateDays((ds) =>
      ds.map((d) => ({
        ...d,
        meals: d.meals.map((m) =>
          m.key === mealKey
            ? {
                ...m,
                items: m.items.map((i) =>
                  i.key === itemKey
                    ? { ...i, quantity_multiplier: Math.max(0.5, Math.round(((i.quantity_multiplier || 1) + delta) * 2) / 2) }
                    : i
                ),
              }
            : m
        ),
      }))
    );

  const setItemNote = (mealKey, itemKey, note) =>
    mutateDays((ds) =>
      ds.map((d) => ({
        ...d,
        meals: d.meals.map((m) =>
          m.key === mealKey
            ? { ...m, items: m.items.map((i) => (i.key === itemKey ? { ...i, client_note: note } : i)) }
            : m
        ),
      }))
    );

  const save = async () => {
    if (busy) return;
    if (!name.trim()) return Alert.alert('Name required', 'Give this plan a name.');
    if (!days.length) return Alert.alert('No days', 'Add at least one day.');
    for (const d of days) {
      if (!d.meals.length) return Alert.alert('Empty day', `"${d.day_label}" has no meal slots.`);
    }
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        notes: notes.trim() || null,
        daily_calorie_target: targets.cal === '' ? null : Number(targets.cal),
        daily_protein_target: targets.pro === '' ? null : Number(targets.pro),
        daily_carbs_target: targets.car === '' ? null : Number(targets.car),
        daily_fat_target: targets.fat === '' ? null : Number(targets.fat),
        days: days.map((d) => ({
          day_label: d.day_label.trim() || 'Day',
          meals: d.meals.map((m) => ({
            meal_type: m.meal_type,
            slot_note: m.slot_note || null,
            items: m.items.map((i) => ({
              catalog_item_id: i.catalog_item_id || null,
              name: i.name,
              calories: i.calories ?? null,
              protein_g: i.protein_g ?? null,
              carbs_g: i.carbs_g ?? null,
              fat_g: i.fat_g ?? null,
              serving_size: i.serving_size || null,
              recipe_url: i.recipe_url || null,
              quantity_multiplier: i.quantity_multiplier || 1,
              client_note: i.client_note || null,
            })),
          })),
        })),
      };
      if (self) {
        await api('/client/diet-plans', { method: 'POST', body });
      } else {
        await api(`/trainer/clients/${clientId}/diet-plans`, { method: 'POST', body });
      }
      navigation.goBack(); // lists refresh on focus
    } catch (e) {
      Alert.alert('Could not save plan', e.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  // catalog picker data (shared search + tag filter)
  const pickFiltered = (catalog || []).filter((c) => {
    const q = pickQuery.trim().toLowerCase();
    const matchesText = !q || c.name.toLowerCase().includes(q) || (c.tags || []).some((t) => t.toLowerCase().includes(q));
    const matchesTag = !pickTag || (c.tags || []).includes(pickTag);
    return matchesText && matchesTag;
  });

  // one tap → snapshot attach → close
  const attachCatalogItem = (c) => {
    addItemToMeal(picker.mealKey, {
      catalog_item_id: c.id,
      name: c.name,
      calories: c.calories,
      protein_g: c.protein_g,
      carbs_g: c.carbs_g,
      fat_g: c.fat_g,
      serving_size: c.serving_size,
      recipe_url: c.recipe_url,
    });
    setPicker(null);
  };

  const submitCustom = async () => {
    const f = customForm.form;
    if (!f.name?.trim()) {
      Alert.alert('Name required', 'Give this item a name.');
      return;
    }
    const item = {
      name: f.name.trim(),
      calories: f.calories === '' ? null : Number(f.calories),
      protein_g: f.protein_g === '' ? null : Number(f.protein_g),
      carbs_g: f.carbs_g === '' ? null : Number(f.carbs_g),
      fat_g: f.fat_g === '' ? null : Number(f.fat_g),
      serving_size: f.serving_size || null,
      recipe_url: f.recipe_url || null,
      client_note: f.client_note?.trim() || null,
    };
    if (customForm.saveToCatalog && !self) {
      try {
        await api('/trainer/meal-catalog', { method: 'POST', body: item });
      } catch {
        // non-fatal: plan item still saves
      }
    }
    addItemToMeal(customForm.mealKey, item);
    setCustomForm(null);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      <TextInput
        style={styles.input}
        placeholder="Plan name (e.g. Push Day Nutrition)"
        placeholderTextColor={colors.textDim}
        value={name}
        onChangeText={setName}
      />
      <TextInput
        style={[styles.input, { minHeight: 56 }]}
        placeholder="Notes for client (optional)"
        placeholderTextColor={colors.textDim}
        value={notes}
        onChangeText={setNotes}
        multiline
      />

      {/* optional daily targets */}
      <Text style={styles.groupLabel}>Daily Targets (optional)</Text>
      <View style={styles.macroRow}>
        {[
          ['cal', 'Cal'],
          ['pro', 'P (g)'],
          ['car', 'C (g)'],
          ['fat', 'F (g)'],
        ].map(([k, label]) => (
          <View key={k} style={styles.macroCell}>
            <Text style={styles.macroLabel}>{label}</Text>
            <TextInput
              style={[styles.input, styles.macroInput, NUMS]}
              keyboardType="numeric"
              value={targets[k]}
              onChangeText={(v) => setTargets((t) => ({ ...t, [k]: v }))}
              placeholder="—"
              placeholderTextColor={colors.textDim}
            />
          </View>
        ))}
      </View>

      {/* days */}
      {days.map((d, di) => {
        const isCollapsed = collapsed.has(d.key);
        return (
          <View key={d.key} style={styles.dayCard}>
            <View style={styles.dayHeader}>
              <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 6 }} onPress={() => toggleCollapse(d.key)}>
                <Ionicons name={isCollapsed ? 'chevron-forward' : 'chevron-down'} size={15} color={colors.textDim} />
                <TextInput
                  style={styles.dayLabel}
                  value={d.day_label}
                  onChangeText={(v) => renameDay(d.key, v)}
                />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => removeDay(d.key)} style={{ padding: 4 }}>
                <Ionicons name="close" size={16} color={colors.red} />
              </TouchableOpacity>
            </View>

            {!isCollapsed && (
              <View>
                {d.meals.map((m) => (
                  <View key={m.key} style={styles.mealSlot}>
                    <Text style={styles.mealType}>{String(m.meal_type).toUpperCase()}</Text>
                    <TouchableOpacity
                      style={styles.addItemMini}
                      onPress={() => {
                        setPickQuery('');
                        setPickTag(null);
                        setPicker({ mealKey: m.key, mealType: m.meal_type, mode: 'catalog' });
                      }}
                    >
                      <Ionicons name="add" size={13} color={colors.primary} />
                      <Text style={styles.addItemMiniText}>Item</Text>
                    </TouchableOpacity>
                    {m.items.map((i) => (
                      <View key={i.key} style={styles.itemCard}>
                        <View style={styles.itemHeader}>
                          <Text style={styles.itemName} numberOfLines={1}>
                            {i.name}
                            {i.catalog_item_id ? ' ★' : ''}
                          </Text>
                          <View style={styles.multStepper}>
                            <TouchableOpacity onPress={() => adjustMultiplier(m.key, i.key, -0.5)}>
                              <Ionicons name="remove" size={13} color={colors.text} />
                            </TouchableOpacity>
                            <Text style={[styles.multText, NUMS]}>{i.quantity_multiplier || 1}x</Text>
                            <TouchableOpacity onPress={() => adjustMultiplier(m.key, i.key, 0.5)}>
                              <Ionicons name="add" size={13} color={colors.text} />
                            </TouchableOpacity>
                          </View>
                          <TouchableOpacity onPress={() => removeItem(m.key, i.key)} style={{ padding: 3 }}>
                            <Ionicons name="close" size={14} color={colors.textDim} />
                          </TouchableOpacity>
                        </View>
                        <Text style={[styles.itemMacro, NUMS]}>{macroLine(i)}</Text>
                        <TextInput
                          style={styles.itemNote}
                          value={i.client_note}
                          onChangeText={(v) => setItemNote(m.key, i.key, v)}
                          placeholder={`Note for ${clientName || 'client'} on this item (optional)`}
                          placeholderTextColor={colors.textDim}
                        />
                      </View>
                    ))}
                  </View>
                ))}
                <AddMealSlot onPick={(type) => addMealSlot(d.key, type)} styles={styles} colors={colors} />
              </View>
            )}
          </View>
        );
      })}

      <TouchableOpacity style={styles.addDayBtn} onPress={addDay}>
        <Ionicons name="add" size={17} color={colors.primary} />
        <Text style={styles.addDayText}>Add Day</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.assignBtn} onPress={save} disabled={busy}>
        <Text style={styles.assignText}>{busy ? 'Saving…' : self ? 'Save Diet Plan' : 'Assign Diet Plan'}</Text>
      </TouchableOpacity>

      {/* Add-Item modal: From Catalog (searchable, one-tap attach) | Custom */}
      <Modal visible={!!picker} transparent animationType="slide" onRequestClose={() => !quickCreate && setPicker(null)}>
        <View style={styles.pickWrap}>
          <View style={styles.pickSheet}>
            <Text style={styles.pickTitle}>Add to {picker?.mealType || 'Meal'}</Text>
            <View style={styles.pickTabs}>
              {[
                { key: 'catalog', label: 'From Catalog' },
                { key: 'custom', label: 'Custom Item' },
              ].map((t) => {
                const on = picker?.mode === t.key;
                return (
                  <TouchableOpacity
                    key={t.key}
                    style={[styles.pickTab, on && styles.pickTabOn]}
                    onPress={() => setPicker((p) => (p ? { ...p, mode: t.key } : p))}
                  >
                    <Text style={[styles.pickTabText, on && { color: '#fff' }]}>{t.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {picker?.mode === 'catalog' ? (
              !self ? (
                <View style={{ flex: 1 }}>
                  <CatalogSearch
                    query={pickQuery}
                    onQuery={setPickQuery}
                    tag={pickTag}
                    onTag={setPickTag}
                  />
                  {catalog === null ? (
                    <ActivityIndicator color={colors.primary} size="small" style={{ marginTop: 20 }} />
                  ) : pickFiltered.length === 0 ? (
                    <View style={styles.pickEmpty}>
                      <Text style={styles.pickEmptyText}>
                        {catalog.length === 0 ? 'Your catalog is empty' : 'No dishes found'}
                      </Text>
                      <TouchableOpacity
                        style={styles.pickQuickBtn}
                        onPress={() => setQuickCreate(true)}
                      >
                        <Ionicons name="add" size={15} color={colors.primary} />
                        <Text style={styles.pickQuickText}>Add New Dish</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    <FlatList
                      data={pickFiltered}
                      keyExtractor={(c) => String(c.id)}
                      contentContainerStyle={{ paddingBottom: 10 }}
                      renderItem={({ item: c }) => (
                        <TouchableOpacity
                          style={styles.pickRow}
                          // one tap attaches the snapshot and closes
                          onPress={() => attachCatalogItem(c)}
                        >
                          <View style={{ flex: 1 }}>
                            <Text style={styles.pickName} numberOfLines={1}>
                              {c.name}
                            </Text>
                            <Text style={[styles.pickMacro, NUMS]}>
                              {c.calories != null ? `${c.calories} cal` : ''}
                              {c.protein_g != null ? ` · ${Math.round(c.protein_g)}P` : ''}
                              {c.carbs_g != null ? ` ${Math.round(c.carbs_g)}C` : ''}
                              {c.fat_g != null ? ` ${Math.round(c.fat_g)}F` : ''}
                            </Text>
                          </View>
                          <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
                        </TouchableOpacity>
                      )}
                    />
                  )}
                </View>
              ) : (
                <View style={styles.pickEmpty}>
                  <Text style={styles.pickEmptyText}>
                    The meal catalog is a trainer feature — use Custom Item for your own dishes.
                  </Text>
                  <TouchableOpacity
                    style={styles.pickQuickBtn}
                    onPress={() => setPicker((p) => (p ? { ...p, mode: 'custom' } : p))}
                  >
                    <Ionicons name="create-outline" size={15} color={colors.primary} />
                    <Text style={styles.pickQuickText}>Custom Item</Text>
                  </TouchableOpacity>
                </View>
              )
            ) : (
              <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
                <TextInput
                  style={styles.sheetField}
                  placeholder="Item name"
                  placeholderTextColor={colors.textDim}
                  value={customForm?.form?.name || ''}
                  onChangeText={(v) => setCustomForm((c) => (c ? { ...c, form: { ...c.form, name: v } } : { form: { name: v } }))}
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
                        style={[styles.sheetField, styles.macroInput, NUMS]}
                        keyboardType="numeric"
                        value={customForm?.form?.[k] || ''}
                        onChangeText={(v) => setCustomForm((c) => ((c && c.form) ? { ...c, form: { ...c.form, [k]: v } } : { form: { [k]: v } }))}
                        placeholder="—"
                        placeholderTextColor={colors.textDim}
                      />
                    </View>
                  ))}
                </View>
                <TextInput
                  style={styles.sheetField}
                  placeholder="Serving size (optional)"
                  placeholderTextColor={colors.textDim}
                  value={customForm?.form?.serving_size || ''}
                  onChangeText={(v) => setCustomForm((c) => ((c && c.form) ? { ...c, form: { ...c.form, serving_size: v } } : { form: { serving_size: v } }))}
                />
                <TextInput
                  style={styles.sheetField}
                  placeholder="Recipe link (optional)"
                  placeholderTextColor={colors.textDim}
                  autoCapitalize="none"
                  value={customForm?.form?.recipe_url || ''}
                  onChangeText={(v) => setCustomForm((c) => ((c && c.form) ? { ...c, form: { ...c.form, recipe_url: v } } : { form: { recipe_url: v } }))}
                />
                <TextInput
                  style={[styles.sheetField, { minHeight: 52 }]}
                  placeholder={`Note for ${clientName || 'client'} on this item (optional)`}
                  placeholderTextColor={colors.textDim}
                  value={customForm?.form?.client_note || ''}
                  onChangeText={(v) => setCustomForm((c) => ((c && c.form) ? { ...c, form: { ...c.form, client_note: v } } : { form: { client_note: v } }))}
                  multiline
                />
                {!self && (
                  <TouchableOpacity
                    style={styles.checkRow}
                    onPress={() => setCustomForm((c) => (c ? { ...c, saveToCatalog: !c.saveToCatalog } : { form: {}, saveToCatalog: true }))}
                  >
                    <Ionicons
                      name={customForm?.saveToCatalog ? 'checkbox' : 'square-outline'}
                      size={18}
                      color={colors.primary}
                    />
                    <Text style={styles.checkText}>Save to my catalog too</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={styles.pickAttachBtn}
                  onPress={() => {
                    submitCustom();
                    setPicker(null);
                  }}
                >
                  <Text style={styles.pickAttachText}>Add Item</Text>
                </TouchableOpacity>
              </ScrollView>
            )}

            <TouchableOpacity style={styles.cancelBtn} onPress={() => setPicker(null)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>

          {/* empty-catalog escape hatch: create a dish without leaving the
              picker; lands back in the catalog tab, ready to attach */}
          <DishForm
            visible={quickCreate}
            dish={{}}
            onClose={() => setQuickCreate(false)}
            onSave={async (item) => {
              try {
                const created = await api('/trainer/meal-catalog', { method: 'POST', body: item });
                setCatalog((prev) => (prev || []).concat([created]));
                setCustomForm(null);
              } catch (e) {
                Alert.alert('Could not save dish', e.message || 'Please try again.');
              }
              setQuickCreate(false);
            }}
            onDelete={null}
          />
        </View>
      </Modal>
    </ScrollView>
  );
}

function AddMealSlot({ onPick, styles, colors }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {MEAL_TYPES.map((t) => (
        <TouchableOpacity key={t} style={styles.mealChip} onPress={() => onPick(t)}>
          <Ionicons name="add" size={11} color={colors.primary} />
          <Text style={styles.mealChipText}>{t}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    input: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 12,
      paddingHorizontal: 14, paddingVertical: 12, marginBottom: 10, fontSize: 15,
    },
    groupLabel: {
      color: colors.textDim, fontSize: 11, fontWeight: '800',
      letterSpacing: 1, textTransform: 'uppercase', marginTop: 6, marginBottom: 6,
    },
    macroRow: { flexDirection: 'row', gap: 8 },
    macroCell: { flex: 1 },
    macroLabel: { color: colors.textDim, fontSize: 11, marginBottom: 4, textAlign: 'center' },
    macroInput: { textAlign: 'center', paddingVertical: 9 },

    dayCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 12, marginTop: 12,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    dayHeader: { flexDirection: 'row', alignItems: 'center' },
    dayLabel: { color: colors.text, fontSize: 15, fontWeight: '800', flex: 1 },

    mealSlot: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8 },
    mealType: { color: colors.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 6 },
    addItemMini: {
      position: 'absolute', right: 0, top: 4, flexDirection: 'row', alignItems: 'center', gap: 4,
      backgroundColor: colors.cardLight, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4,
    },
    addItemMiniText: { color: colors.primary, fontWeight: '700', fontSize: 11 },

    itemCard: {
      backgroundColor: colors.cardLight, borderRadius: 10, padding: 10, marginBottom: 6,
    },
    itemHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    itemName: { color: colors.text, fontWeight: '700', fontSize: 13, flex: 1 },
    itemMacro: { color: colors.textDim, fontSize: 11, marginTop: 3 },
    itemNote: {
      color: colors.text, fontSize: 11, marginTop: 6,
      backgroundColor: colors.card, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 6,
    },
    multStepper: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: colors.card, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3,
    },
    multText: { color: colors.text, fontSize: 11, fontWeight: '700' },

    mealChip: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      backgroundColor: colors.cardLight, borderRadius: 10,
      paddingHorizontal: 9, paddingVertical: 6,
    },
    mealChipText: { color: colors.primary, fontWeight: '600', fontSize: 11 },

    addDayBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 14,
      paddingVertical: 13, marginTop: 14,
    },
    addDayText: { color: colors.primary, fontWeight: '700', fontSize: 14 },
    assignBtn: {
      backgroundColor: colors.primary, borderRadius: 14, padding: 15,
      alignItems: 'center', marginTop: 14,
    },
    assignText: { color: '#fff', fontWeight: '800', fontSize: 15 },

    pickWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    pickSheet: {
      backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
      padding: 18, maxHeight: '80%',
    },
    pickTitle: { color: colors.text, fontSize: 17, fontWeight: '800', marginBottom: 10 },
    pickTabs: { flexDirection: 'row', backgroundColor: colors.cardLight, borderRadius: 12, padding: 3, marginBottom: 10 },
    pickTab: { flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 8 },
    pickTabOn: { backgroundColor: colors.primary },
    pickTabText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },
    pickRow: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 6,
      shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1, shadowRadius: 6, elevation: 2,
    },
    pickName: { color: colors.text, fontSize: 14, fontWeight: '700' },
    pickMacro: { color: colors.textDim, fontSize: 11, marginTop: 2 },
    pickEmpty: { alignItems: 'center', paddingVertical: 28 },
    pickEmptyText: { color: colors.textDim, fontSize: 13, marginBottom: 12 },
    pickQuickBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 7,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12,
      paddingHorizontal: 16, paddingVertical: 10,
    },
    pickQuickText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
    pickAttachBtn: { backgroundColor: colors.primary, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 6 },
    pickAttachText: { color: '#fff', fontWeight: '800' },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
    sheet: { backgroundColor: colors.card, borderRadius: 16, padding: 18 },
    sheetTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: 10 },
    sheetSection: { color: colors.textDim, fontSize: 11, fontWeight: '700', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 },
    sheetDim: { color: colors.textDim, fontSize: 12 },
    sheetSearch: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 8, marginBottom: 8,
    },
    sheetRow: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: colors.cardLight, borderRadius: 10, padding: 10, marginBottom: 6,
    },
    sheetField: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 9, marginBottom: 8, fontSize: 14,
    },
    customBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 10, paddingVertical: 10,
    },
    customBtnText: { color: colors.primary, fontWeight: '700' },
    checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 8 },
    checkText: { color: colors.text, fontSize: 13 },
    cancelBtn: { alignItems: 'center', padding: 10, marginTop: 4 },
    cancelText: { color: colors.textDim, fontWeight: '700' },
  });
