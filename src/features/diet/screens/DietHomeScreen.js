import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, RefreshControl,
  TextInput, Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../../../lib/api';
import { useColors } from '../../../theme';
import { todayLocalISO, isFutureDate } from '../../../lib/checkinDates';
import { listEntriesForDate, deleteFoodEntry, updateFoodEntry } from '../../../db/diary';
import { getSettings, updateSettings } from '../../../db/settings';
import FoodSearchModal from '../components/FoodSearchModal';
import SetTargetsModal from '../components/SetTargetsModal';

const NUMS = { fontVariant: ['tabular-nums'] };

const shiftDateStr = (date, days) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const formatDateLabel = (date) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

// The four display sections are pure GROUPING (log-first: never a checklist,
// never compliance). 'other' entries get their own section only when present.
const SECTIONS = [
  { key: 'breakfast', label: 'Breakfast' },
  { key: 'lunch', label: 'Lunch' },
  { key: 'dinner', label: 'Dinner' },
  { key: 'snacks', label: 'Snacks' },
  { key: 'other', label: 'Other' },
];

// Daily food logger — the Diet tab's home (Phase 4). Works standalone with
// zero setup: a brand-new user with no trainer and no target gets plain
// calorie/macro counting (no bar, no status) from day one. Targets,
// suggestions, and trend history are optional overlays (Phases 5–6).
export default function DietHomeScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [viewDate, setViewDate] = useState(todayLocalISO());
  const [entries, setEntries] = useState([]);
  const [target, setTarget] = useState(null); // active nutrition target overlay
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [addForMeal, setAddForMeal] = useState(null); // meal_type for the search modal
  const [editEntry, setEditEntry] = useState(null); // entry being quantity-edited
  const [editQty, setEditQty] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const reloadEntries = useCallback(async () => {
    try {
      setEntries(await listEntriesForDate(viewDate));
    } catch {}
  }, [viewDate]);

  useFocusEffect(
    useCallback(() => {
      reloadEntries();
      api('/client/nutrition-targets')
        .then((t) => setTarget(t?.active || null))
        .catch(() => {});
      api('/client/nutrition-suggestions')
        .then((rows) => setSuggestions(rows || []))
        .catch(() => {});
      // the suggestions section is user-toggleable (Settings → Meal
      // suggestions) and permanently dismissible from the card itself
      getSettings()
        .then((s) => setShowSuggestions(s.show_meal_suggestions !== 0))
        .catch(() => {});
    }, [reloadEntries])
  );

  useEffect(() => {
    reloadEntries();
  }, [reloadEntries]);

  const totals = useMemo(() => {
    const t = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    for (const e of entries) {
      t.calories += Number(e.calories) || 0;
      t.protein_g += Number(e.protein_g) || 0;
      t.carbs_g += Number(e.carbs_g) || 0;
      t.fat_g += Number(e.fat_g) || 0;
    }
    return {
      calories: Math.round(t.calories),
      protein_g: Math.round(t.protein_g),
      carbs_g: Math.round(t.carbs_g),
      fat_g: Math.round(t.fat_g),
    };
  }, [entries]);

  const byMeal = useMemo(() => {
    const groups = { breakfast: [], lunch: [], dinner: [], snack: [], other: [] };
    for (const e of entries) (groups[e.meal_type] || groups.other).push(e);
    return groups;
  }, [entries]);

  const targetKcal = target ? Number(target.calories) || 0 : 0;
  const remaining = targetKcal ? targetKcal - totals.calories : null;
  const pct = targetKcal ? Math.min(100, Math.max(0, Math.round((totals.calories / targetKcal) * 100))) : 0;

  const confirmDelete = (e) =>
    Alert.alert('Remove food', `Remove "${e.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          await deleteFoodEntry(e.local_id);
          reloadEntries();
        },
      },
    ]);

  const saveEdit = async () => {
    const q = Number(editQty);
    if (!editEntry || !isFinite(q) || q <= 0) return;
    const factor = q / (Number(editEntry.quantity) || 1);
    const scale = (v) => (v == null ? null : Math.round(v * factor * 10) / 10);
    await updateFoodEntry(editEntry.local_id, {
      quantity: q,
      calories: scale(editEntry.calories),
      protein_g: scale(editEntry.protein_g),
      carbs_g: scale(editEntry.carbs_g),
      fat_g: scale(editEntry.fat_g),
    });
    setEditEntry(null);
    reloadEntries();
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await reloadEntries(); setRefreshing(false); }} tintColor={colors.primary} />}
    >
      {/* date nav — backfill past days allowed, future never loggable */}
      <View style={styles.dateNav}>
        <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setViewDate(shiftDateStr(viewDate, -1))}>
          <Ionicons name="chevron-back" size={17} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity hitSlop={{ top: 8, bottom: 8 }} onPress={() => setViewDate(todayLocalISO())}>
          <Text style={styles.dateText}>
            {formatDateLabel(viewDate)}
            {viewDate === todayLocalISO() ? ' · Today' : ''}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setViewDate(shiftDateStr(viewDate, 1))}>
          <Ionicons name="chevron-forward" size={17} color={colors.text} />
        </TouchableOpacity>
      </View>

      {/* summary — with a target: logged vs target + remaining; without one:
          plain totals (a completely valid, bar-free mode) */}
      <View style={styles.summaryCard}>
        {targetKcal > 0 ? (
          <>
            <Text style={[styles.totalCal, NUMS]}>
              {totals.calories.toLocaleString()} <Text style={styles.totalDim}>/ {targetKcal.toLocaleString()} cal</Text>
            </Text>
            <View style={styles.barTrack}>
              <View style={[styles.barFill, { width: `${pct}%` }]} />
            </View>
            <Text style={[styles.remainingText, NUMS]}>
              {remaining > 0 ? `${remaining.toLocaleString()} cal remaining` : remaining < 0 ? `${Math.abs(remaining).toLocaleString()} cal over` : 'Calorie target reached'}
            </Text>
          </>
        ) : (
          <Text style={[styles.totalCal, NUMS]}>{totals.calories.toLocaleString()} cal logged</Text>
        )}
        <Text style={[styles.macroLine, NUMS]}>
          P {totals.protein_g}g · C {totals.carbs_g}g · F {totals.fat_g}g
        </Text>
        {target ? (
          <Text style={styles.sourceNote}>
            {target.target_mode === 'weekly_average'
              ? 'Weekly-average target · '
              : ''}
            {target.target_source === 'trainer_override'
              ? 'Set by your trainer'
              : target.target_source === 'self'
              ? 'Set by you'
              : 'Based on your profile'}
          </Text>
        ) : (
          <TouchableOpacity onPress={() => setTargetsOpen(true)}>
            <Text style={styles.setTargetLink}>Set a calorie target →</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* header actions: trend view + targets overlay */}
      <View style={styles.actionsRow}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => navigation.navigate('DietTrends')}>
          <Ionicons name="trending-up-outline" size={14} color={colors.primary} />
          <Text style={styles.actionText}>Trends</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={() => navigation.navigate('BuildDish')}>
          <Ionicons name="restaurant-outline" size={14} color={colors.primary} />
          <Text style={styles.actionText}>Build a Dish</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={() => setTargetsOpen(true)}>
          <Ionicons name="flag-outline" size={14} color={colors.primary} />
          <Text style={styles.actionText}>Targets</Text>
        </TouchableOpacity>
      </View>

      {/* structure suggestions — advisory only, collapsible, dismissible */}
      {showSuggestions && suggestions.length > 0 && (
        <View style={styles.suggestionCard}>
          <TouchableOpacity style={styles.suggestionHead} onPress={() => setSuggestionsOpen((v) => !v)}>
            <Ionicons name="bulb-outline" size={14} color={colors.yellow} />
            <Text style={styles.suggestionTitle}>Today's Suggestions</Text>
            <TouchableOpacity
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              onPress={async () => {
                setShowSuggestions(false);
                try { await updateSettings({ show_meal_suggestions: 0 }); } catch {}
              }}
            >
              <Ionicons name="close" size={13} color={colors.textDim} />
            </TouchableOpacity>
            <Ionicons name={suggestionsOpen ? 'chevron-up' : 'chevron-down'} size={13} color={colors.textDim} />
          </TouchableOpacity>
          {suggestionsOpen && (
            <View style={styles.suggestionBody}>
              {suggestions.map((s) => (
                <Text key={s.id} style={styles.suggestionLine}>
                  {String(s.meal_type).charAt(0).toUpperCase() + String(s.meal_type).slice(1)}: {s.suggestion_text}
                </Text>
              ))}
            </View>
          )}
        </View>
      )}

      {/* meal sections */}
      {SECTIONS.map((sec) => {
        const list = sec.key === 'snacks' ? [...byMeal.snack, ...byMeal.other] : byMeal[sec.key];
        const kcal = list.reduce((n, e) => n + (Number(e.calories) || 0), 0);
        return (
          <View key={sec.key} style={styles.mealSection}>
            <View style={styles.mealHead}>
              <Text style={styles.mealTitle}>{sec.label.toUpperCase()}</Text>
              <Text style={[styles.mealKcal, NUMS]}>{Math.round(kcal)} cal</Text>
            </View>
            {list.map((e) => (
              <View key={e.local_id} style={styles.entryRow}>
                <TouchableOpacity style={{ flex: 1 }} onPress={() => { setEditEntry(e); setEditQty(String(e.quantity)); }}>
                  <Text style={styles.entryName}>{e.name}</Text>
                  <Text style={[styles.entryMeta, NUMS]}>
                    {`(${e.quantity} ${e.serving_unit || 'serving'})`}
                    {e.calories != null ? ` · ${Math.round(e.calories)} cal` : ''}
                    {e.suggested_by_trainer ? ' · suggested' : ''}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} onPress={() => confirmDelete(e)}>
                  <Ionicons name="close-circle-outline" size={17} color={colors.textDim} />
                </TouchableOpacity>
              </View>
            ))}
            <TouchableOpacity
              style={styles.addFoodBtn}
              disabled={isFutureDate(viewDate)}
              onPress={() => setAddForMeal(sec.key === 'snacks' ? 'snack' : sec.key)}
            >
              <Ionicons name="add" size={15} color={colors.primary} />
              <Text style={styles.addFoodText}>Add Food</Text>
            </TouchableOpacity>
          </View>
        );
      })}

      {/* add food — unified search/log flow (global DB + recipes + trainer
          catalog + custom dishes + barcode + recent/frequent + manual) */}
      <FoodSearchModal
        visible={!!addForMeal}
        onClose={() => setAddForMeal(null)}
        mealType={addForMeal || 'other'}
        viewDate={viewDate}
        onLogged={() => reloadEntries()}
      />

      {/* quantity edit — every logged item is adjustable/removable */}
      <Modal visible={!!editEntry} transparent animationType="fade" onRequestClose={() => setEditEntry(null)}>
        <View style={styles.editWrap}>
          <View style={styles.editSheet}>
            <Text style={styles.editTitle}>{editEntry?.name}</Text>
            <View style={styles.qtyRow}>
              <Text style={styles.qtyLabel}>Quantity</Text>
              <TextInput
                style={[styles.qtyInput, NUMS]}
                keyboardType="numeric"
                value={editQty}
                onChangeText={(v) => setEditQty(v.replace(/[^0-9.]/g, ''))}
              />
              <Text style={styles.qtyUnit}>{editEntry?.serving_unit || 'serving'}</Text>
            </View>
            <TouchableOpacity style={styles.primaryBtn} onPress={saveEdit}>
              <Text style={styles.primaryBtnText}>Update</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setEditEntry(null)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <SetTargetsModal
        visible={targetsOpen}
        onClose={() => setTargetsOpen(false)}
        target={target}
        onSaved={(t) => setTarget(t)}
      />
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    dateNav: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18,
      backgroundColor: colors.cardLight, borderRadius: 12,
      paddingVertical: 8, paddingHorizontal: 14, alignSelf: 'center',
    },
    dateText: { color: colors.text, fontSize: 13, fontWeight: '800' },
    summaryCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 16, marginTop: 12,
      alignItems: 'center',
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    totalCal: { color: colors.text, fontSize: 22, fontWeight: '800' },
    totalDim: { color: colors.textDim, fontSize: 14, fontWeight: '700' },
    barTrack: { height: 8, borderRadius: 4, backgroundColor: colors.cardLight, marginTop: 10, alignSelf: 'stretch', overflow: 'hidden' },
    barFill: { height: '100%', backgroundColor: colors.primary, borderRadius: 4 },
    remainingText: { color: colors.textDim, fontSize: 12, marginTop: 6 },
    macroLine: { color: colors.textDim, fontSize: 12, marginTop: 4 },
    sourceNote: { color: colors.textDim, fontSize: 10, marginTop: 4, fontStyle: 'italic' },
    setTargetLink: { color: colors.primary, fontSize: 12, fontWeight: '700', marginTop: 6 },
    actionsRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
    actionBtn: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      backgroundColor: colors.card, borderRadius: 11, paddingVertical: 9,
      borderWidth: 1, borderColor: colors.border,
    },
    actionText: { color: colors.primary, fontWeight: '700', fontSize: 12 },
    suggestionCard: {
      backgroundColor: colors.card, borderRadius: 12, padding: 12, marginTop: 12,
      borderWidth: 1, borderColor: colors.border,
    },
    suggestionHead: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    suggestionTitle: { color: colors.text, fontWeight: '800', fontSize: 13, flex: 1 },
    suggestionBody: { marginTop: 6, gap: 4 },
    suggestionLine: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
    mealSection: { marginTop: 16 },
    mealHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    mealTitle: { color: colors.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
    mealKcal: { color: colors.textDim, fontSize: 11, fontWeight: '700' },
    entryRow: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.card, borderRadius: 11, padding: 11, marginTop: 5,
    },
    entryName: { color: colors.text, fontSize: 14, fontWeight: '700' },
    entryMeta: { color: colors.textDim, fontSize: 11, marginTop: 1 },
    addFoodBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      borderWidth: 1.2, borderColor: colors.primary, borderRadius: 11,
      paddingVertical: 9, marginTop: 6,
    },
    addFoodText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
    editWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
    editSheet: { backgroundColor: colors.bg, borderRadius: 16, padding: 18 },
    editTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: 10 },
    qtyRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 10 },
    qtyLabel: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
    qtyInput: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 8,
      width: 80, textAlign: 'center', paddingVertical: 9, fontSize: 14,
    },
    qtyUnit: { color: colors.textDim, fontSize: 12 },
    primaryBtn: { backgroundColor: colors.primary, borderRadius: 12, padding: 13, alignItems: 'center' },
    primaryBtnText: { color: '#fff', fontWeight: '800' },
    cancelBtn: { alignItems: 'center', padding: 10 },
    cancelText: { color: colors.textDim, fontWeight: '700' },
  });
