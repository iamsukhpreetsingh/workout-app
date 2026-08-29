import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../lib/api';
import { useColors } from '../theme';
import DishPickerModal from '../components/DishPickerModal';
import { listRecipes, createRecipe, createDietPlan, updateDietPlan, getDietPlan, isLocalDietPlanId } from '../services/dietService';
import { getAllergenConflicts } from '../lib/allergens';
import DietDayCard from '../features/diet/components/DietDayCard';
import { nid } from '../features/diet/utils/dietPlanUtils';

const NUMS = { fontVariant: ['tabular-nums'] };






// Client Context section auto-expands on its first view per app session,
// then stays collapsed (one tap to reopen) — keeps the builder compact.
let contextSeenThisSession = false;





// Structured diet plan builder: plan targets + collapsible days → meal
// slots → items (catalog snapshots or custom). `self` mode is the
// client-authored variant — identical structure, no catalog access.
export default function DietPlanBuilderScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { clientId, clientName, self, editPlanId } = route.params || {};

  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [targets, setTargets] = useState({ cal: '', pro: '', car: '', fat: '' });
  const [trackingMode, setTrackingMode] = useState('simple');
  const [tolerance, setTolerance] = useState('10');
  const [days, setDays] = useState([]);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(new Set());

  const [picker, setPicker] = useState(null); // { mealKey, mealType }
  const [catalog, setCatalog] = useState(null);

  // Active/recommended nutrition targets (§14): plans default to the
  // user's targets from their nutrition profile — the trainer can accept
  // them with one tap or override by editing the fields below.
  const [recommended, setRecommended] = useState(null); // { targets, source, who }

  useEffect(() => {
    if (editPlanId) return;
    const fetchTargets = self
      ? api('/client/nutrition-targets')
      : api(`/trainer/clients/${clientId}/nutrition-targets`);
    fetchTargets
      .then((t) => {
        const active = t?.active || t?.recommendation;
        if (!active) return;
        setRecommended({
          targets: {
            cal: String(active.calories ?? ''),
            pro: String(active.protein_g ?? ''),
            car: String(active.carbs_g ?? ''),
            fat: String(active.fat_g ?? ''),
          },
          source: t?.active?.target_source || 'automatic',
        });
      })
      .catch(() => {});
  }, [self, clientId, editPlanId]);





// Client's intake profile (trainer mode only). null → no completed
// profile → ALL allergen warnings are skipped silently, by design.
const [clientProfile, setClientProfile] = useState(null);
// Client Context section (goals / injuries / medical) — display-only
const [contextOpen, setContextOpen] = useState(() => {
  if (contextSeenThisSession) return false;
  contextSeenThisSession = true;
  return true;
});

useEffect(() => {
  if (self || editPlanId || !clientId) return; // warnings are trainer-only
  api(`/trainer/clients/${clientId}/intake-profile`)
    .then((p) => setClientProfile(p && p.completed_at ? p : null))
    .catch(() => setClientProfile(null)); // silent: no profile → no warnings
}, [clientId, self, editPlanId]);

// Every client allergen present ANYWHERE in the current plan — drives the
// persistent banner. Recomputes live as items are added/removed.
const planConflicts = (() => {
  if (!clientProfile) return [];
  const seen = new Set();
  const found = [];
  for (const d of days) {
    for (const m of d.meals) {
      for (const it of m.items) {
        for (const a of getAllergenConflicts(clientProfile.allergens, it.allergens)) {
          const key = a.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            found.push(a);
          }
        }
      }
    }
  }
  return found;
})();





  React.useLayoutEffect(() => {
    navigation.setOptions({
      title: editPlanId
        ? 'Edit Diet Plan'
        : self
        ? 'New Diet Plan'
        : `Diet Plan → ${clientName || 'Client'}`,
    });
  }, [navigation, clientName, self]);

  useEffect(() => {
    if (!editPlanId) return;
    // // edit mode: prefill from the existing own plan
    // api(`/client/diet-plans/${editPlanId}`)
        // edit mode: prefill from the existing own plan — local plans from
    // SQLite, legacy server plans via the API
    const loadPromise = isLocalDietPlanId(editPlanId)
      ? getDietPlan(editPlanId)
      : api(`/client/diet-plans/${editPlanId}`);
    loadPromise
      .then((pl) => {
        setName(pl.name || '');
        setNotes(pl.notes || '');
        setTargets({
          cal: pl.daily_calorie_target != null ? String(pl.daily_calorie_target) : '',
          pro: pl.daily_protein_target != null ? String(pl.daily_protein_target) : '',
          car: pl.daily_carbs_target != null ? String(pl.daily_carbs_target) : '',
          fat: pl.daily_fat_target != null ? String(pl.daily_fat_target) : '',
        });
        setTrackingMode(pl.tracking_mode === 'detailed' ? 'detailed' : 'simple');
        setTolerance(pl.tolerance_pct != null ? String(pl.tolerance_pct) : '10');
        setDays(
          (pl.days || []).map((d, di) => ({
            key: `e${di}`,
            day_label: d.day_label,
            meals: (d.meals || []).map((m, mi) => ({
              key: `e${di}_${mi}`,
              meal_type: m.meal_type,
              slot_note: m.slot_note || '',
              items: (m.items || []).map((it, ii) => ({
                key: `e${di}_${mi}_${ii}`,
                catalog_item_id: it.catalog_item_id || null,
                name: it.name,
                calories: it.calories,
                protein_g: it.protein_g,
                carbs_g: it.carbs_g,
                fat_g: it.fat_g,
                serving_size: it.serving_size,
                recipe_url: it.recipe_url,
                // quantity_multiplier: it.quantity_multiplier || 1,
                // client_note: it.client_note || '',
                quantity_multiplier: it.quantity_multiplier || 1,
                client_note: it.client_note || '',
                photo_path: it.photo_path || null,
                ingredients: it.ingredients || [],
                allergens: it.allergens || [],
                prep_time_minutes: it.prep_time_minutes ?? null,
                cook_time_minutes: it.cook_time_minutes ?? null,
                difficulty: it.difficulty || null,
                alternate_servings: it.alternate_servings || [],
                tags: it.tags || [],
                // saved dish alternatives (shape varies by source: local
                // rows, backup JSONB, or server alternative rows)
                alternatives: (it.alternatives || []).map((a, ai) => ({
                  key: `e${di}_${mi}_${ii}_alt${ai}`,
                  name: a.name ?? a.alternative_name,
                  calories: a.calories ?? a.alternative_calories ?? null,
                  protein_g: a.protein_g ?? a.alternative_protein_g ?? null,
                  carbs_g: a.carbs_g ?? a.alternative_carbs_g ?? null,
                  fat_g: a.fat_g ?? a.alternative_fat_g ?? null,
                  catalog_item_id: a.catalog_item_id ?? a.recipe_local_id ?? null,
                })),
              })),
            })),
          }))
        );
      })
      .catch((e) => Alert.alert('Could not load plan', e.message || 'Please try again.'));
  }, [editPlanId]);

  useEffect(() => {
    // trainers browse their meal catalog; clients browse their My Dishes —
    // same picker, owner-appropriate source
    if (self) {
      listRecipes().then(setCatalog).catch(() => setCatalog([]));
    } else {
      api('/trainer/meal-catalog').then(setCatalog).catch(() => setCatalog([]));
    }
  }, [self]);

  const refreshCatalog = () =>
    (self ? listRecipes() : api('/trainer/meal-catalog')).then((c) => setCatalog(c));

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

  const setItemAlternatives = (mealKey, itemKey, alternatives) =>
    mutateDays((ds) =>
      ds.map((d) => ({
        ...d,
        meals: d.meals.map((m) =>
          m.key === mealKey
            ? { ...m, items: m.items.map((i) => (i.key === itemKey ? { ...i, alternatives } : i)) }
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
        tracking_mode: trackingMode,
        tolerance_pct: trackingMode === 'detailed' ? Math.max(1, Math.min(50, Number(tolerance) || 10)) : 10,
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
              // quantity_multiplier: i.quantity_multiplier || 1,
              // client_note: i.client_note || null,

              quantity_multiplier: i.quantity_multiplier || 1,
              client_note: i.client_note || null,
              photo_path: i.photo_path ?? null,
              ingredients: i.ingredients || [],
              allergens: i.allergens || [],
              prep_time_minutes: i.prep_time_minutes ?? null,
              cook_time_minutes: i.cook_time_minutes ?? null,
              difficulty: i.difficulty || null,
              alternate_servings: i.alternate_servings || [],
              tags: i.tags || [],
              // configured dish alternatives (0–3, macro snapshots)
              alternatives: (i.alternatives || []).map((a) => ({
                name: a.name,
                calories: a.calories ?? null,
                protein_g: a.protein_g ?? null,
                carbs_g: a.carbs_g ?? null,
                fat_g: a.fat_g ?? null,
                catalog_item_id: a.catalog_item_id || null,
              })),
            })),
          })),
        })),
      };
      // if (editPlanId) {
      //   await api(`/client/diet-plans/${editPlanId}`, { method: 'PATCH', body });
      // } else if (self) {
      //   await api('/client/diet-plans', { method: 'POST', body });
      // } else {

              if (editPlanId) {
        if (isLocalDietPlanId(editPlanId)) {
          await updateDietPlan(editPlanId, body); // local-first edit
        } else {
          await api(`/client/diet-plans/${editPlanId}`, { method: 'PATCH', body }); // legacy server plan
        }
      } else if (self) {
        await createDietPlan(body); // local-first create — works offline
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

  // one tap → snapshot attach → close (allergen soft-confirm lives inside
  // the shared DishPickerModal now)
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
      photo_path: c.photo_path,
      ingredients: c.ingredients,
      allergens: c.allergens,
      prep_time_minutes: c.prep_time_minutes,
      cook_time_minutes: c.cook_time_minutes,
      difficulty: c.difficulty,
      alternate_servings: c.alternate_servings,
    });
    setPicker(null);
  };

  // free-typed custom item; optionally saved to My Dishes / trainer catalog
  const pickCustom = async (item) => {
    if (item.saveToCatalog) {
      try {
        if (self) {
          await createRecipe(item);
        } else {
          await api('/trainer/meal-catalog', { method: 'POST', body: item });
        }
      } catch (e) {
        // non-fatal for the plan item, but surface duplicate-name errors
        Alert.alert('Could not save dish', e.message || 'Please try again.');
      }
    }
    addItemToMeal(picker.mealKey, item);
    setPicker(null);
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
          {/* persistent allergen warning — stays visible the whole session */}
      {planConflicts.length > 0 && (
        <View style={styles.allergenBanner}>
          <Ionicons name="warning" size={15} color={colors.red} />
          <Text style={styles.allergenBannerText}>
            Contains items with {clientName || 'client'}'s allergens: {planConflicts.join(', ')}
          </Text>
        </View>
      )}

      {/* Client Context — display-only reference. Never triggers warnings. */}
      {!self && !editPlanId && clientProfile && (clientProfile.goals?.length || clientProfile.injuries || clientProfile.medical_conditions) && (
        <TouchableOpacity style={styles.ctxCard} onPress={() => setContextOpen((v) => !v)} activeOpacity={0.7}>
          <View style={styles.ctxHeader}>
            <Ionicons name={contextOpen ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textDim} />
            <Text style={styles.ctxTitle}>Client Context</Text>
          </View>
          {contextOpen && (
            <View style={styles.ctxBody}>
              {!!clientProfile.goals?.length && (
                <Text style={styles.ctxLine}>
                  <Text style={styles.ctxLabel}>Goals: </Text>
                  {clientProfile.goals.join(', ')}
                </Text>
              )}
              {!!clientProfile.injuries && (
                <Text style={styles.ctxLine}>
                  <Text style={styles.ctxLabel}>Injuries: </Text>
                  {clientProfile.injuries}
                </Text>
              )}
              {!!clientProfile.medical_conditions && (
                <Text style={styles.ctxLine}>
                  <Text style={styles.ctxLabel}>Medical: </Text>
                  {clientProfile.medical_conditions}
                </Text>
              )}
            </View>
          )}
        </TouchableOpacity>
      )}
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

      {/* optional daily targets — prefilled from the nutrition profile's
          recommended targets with one tap */}
      <Text style={styles.groupLabel}>Daily Targets (optional)</Text>
      {recommended && (
        <View style={styles.recoCard}>
          <Ionicons name="calculator-outline" size={14} color={colors.primary} />
          <Text style={styles.recoText}>
            {recommended.source === 'trainer_override'
              ? `Trainer-set targets${self ? '' : ` for ${clientName || 'client'}`}`
              : `Automatically calculated from ${self ? 'your' : `${clientName || 'the'}'s`} profile`}
          </Text>
          <TouchableOpacity
            style={styles.recoBtn}
            onPress={() => setTargets((t) => ({ ...t, ...recommended.targets }))}
          >
            <Text style={styles.recoBtnText}>Use These</Text>
          </TouchableOpacity>
        </View>
      )}
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

      {/* tracking style — Simple stays a yes/no check-in; Detailed is the
          outcome-first food diary. Existing plans default to Simple. */}
      <Text style={styles.groupLabel}>Tracking Style</Text>
      <View style={styles.modeRow}>
        {[
          { key: 'simple', label: 'Simple' },
          { key: 'detailed', label: 'Detailed' },
        ].map((m) => (
          <TouchableOpacity
            key={m.key}
            style={[styles.modeBtn, trackingMode === m.key && styles.modeBtnOn]}
            onPress={() => setTrackingMode(m.key)}
          >
            <Text style={[styles.modeBtnText, trackingMode === m.key && { color: '#fff' }]}>{m.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.modeHint}>
        {trackingMode === 'simple'
          ? 'A daily yes/no check-in — did you follow your diet?'
          : 'Log the food you actually eat and see how it lands against your daily targets.'}
      </Text>
      {trackingMode === 'detailed' && (
        <View style={styles.toleranceRow}>
          <Text style={styles.toleranceLabel}>Target tolerance</Text>
          <TextInput
            style={[styles.input, styles.toleranceInput, NUMS]}
            keyboardType="numeric"
            value={tolerance}
            onChangeText={(v) => setTolerance(v.replace(/[^0-9]/g, ''))}
            placeholder="10"
            placeholderTextColor={colors.textDim}
          />
          <Text style={styles.toleranceUnit}>%</Text>
        </View>
      )}

      {/* days */}
      {days.map((d) => (
        <DietDayCard
          key={d.key}
          day={d}
          isCollapsed={collapsed.has(d.key)}
          styles={styles}
          colors={colors}
          clientName={clientName}
          self={self}
          catalog={catalog}
          refreshCatalog={refreshCatalog}
          clientProfile={clientProfile}
          onToggleCollapse={toggleCollapse}
          onRename={renameDay}
          onRemove={removeDay}
          onAddMealSlot={(type) => addMealSlot(d.key, type)}
          onOpenPicker={(mealKey, mealType) => setPicker({ mealKey, mealType })}
          onAdjustMultiplier={adjustMultiplier}
          onRemoveItem={removeItem}
          onSetItemNote={setItemNote}
          onSetItemAlternatives={setItemAlternatives}
        />
      ))}

      <TouchableOpacity style={styles.addDayBtn} onPress={addDay}>
        <Ionicons name="add" size={17} color={colors.primary} />
        <Text style={styles.addDayText}>Add Day</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.assignBtn} onPress={save} disabled={busy}>
        <Text style={styles.assignText}>{busy ? 'Saving…' : editPlanId ? 'Save Changes' : self ? 'Save Diet Plan' : 'Assign Diet Plan'}</Text>
      </TouchableOpacity>

      {/* Add-Item modal: From Catalog (searchable, one-tap attach) | Custom
          — ONE shared component for primary items AND alternatives */}
      <DishPickerModal
        visible={!!picker}
        onClose={() => setPicker(null)}
        title={`Add to ${picker?.mealType || 'Meal'}`}
        self={self}
        catalog={catalog}
        refreshCatalog={refreshCatalog}
        slotHint={picker?.mealType || ''}
        clientProfile={clientProfile}
        clientName={clientName}
        onPickCatalog={attachCatalogItem}
        onPickCustom={pickCustom}
      />
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
        allergenBanner: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      borderWidth: 1.5, borderColor: colors.red, borderRadius: 12,
      paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12,
    },
    allergenBannerText: { color: colors.red, fontSize: 13, fontWeight: '700', flex: 1 },
    ctxCard: {
      backgroundColor: colors.cardLight, borderRadius: 12,
      borderWidth: 1, borderColor: colors.border,
      paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12,
    },
    ctxHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    ctxTitle: { color: colors.text, fontWeight: '800', fontSize: 13 },
    ctxBody: { marginTop: 8, gap: 4 },
    ctxLine: { color: colors.text, fontSize: 12, lineHeight: 17 },
    ctxLabel: { color: colors.textDim, fontWeight: '700' },
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

    modeRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
    modeBtn: {
      flex: 1, alignItems: 'center', paddingVertical: 11,
      borderRadius: 12, backgroundColor: colors.cardLight, borderWidth: 1.5, borderColor: 'transparent',
    },
    modeBtnOn: { backgroundColor: colors.primary },
    modeBtnText: { color: colors.textDim, fontWeight: '800', fontSize: 13 },
    modeHint: { color: colors.textDim, fontSize: 12, marginBottom: 8 },
    toleranceRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
    toleranceLabel: { color: colors.text, fontSize: 13, flex: 1 },
    toleranceInput: { width: 70, textAlign: 'center', marginBottom: 0, paddingVertical: 9 },
    toleranceUnit: { color: colors.textDim, fontSize: 13 },

    recoCard: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.cardLight, borderRadius: 11,
      paddingHorizontal: 11, paddingVertical: 9, marginBottom: 8,
    },
    recoText: { color: colors.textDim, fontSize: 12, flex: 1 },
    recoBtn: {
      borderWidth: 1.2, borderColor: colors.primary, borderRadius: 9,
      paddingHorizontal: 10, paddingVertical: 5,
    },
    recoBtnText: { color: colors.primary, fontSize: 11, fontWeight: '800' },

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
    // fixed height (not maxHeight) so the flex:1 content area has real
    // bounds — auto-height + flex children collapsed the dish list to zero
    pickSheet: {
      backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
      padding: 18, height: '82%',
    },
    pickTitle: { color: colors.text, fontSize: 17, fontWeight: '800', marginBottom: 10 },
    pickTabs: { flexDirection: 'row', backgroundColor: colors.cardLight, borderRadius: 12, padding: 3, marginBottom: 10 },
    pickTab: { flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 8 },
    pickTabOn: { backgroundColor: colors.primary },
    pickTabText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },
    pickThumb: { width: 40, height: 40, borderRadius: 9, marginRight: 2 },
    pickAllergen: {
      flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4,
      alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.red,
      borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2,
    },
    pickAllergenText: { color: colors.red, fontSize: 10, fontWeight: '700' },
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
