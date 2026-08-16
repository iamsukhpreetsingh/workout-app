import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Linking,
  RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../lib/api';
import { useColors } from '../theme';

const NUMS = { fontVariant: ['tabular-nums'] };

const scaled = (v, mult) => (v == null ? null : Number(v) * (mult || 1));

const macroLine = (i) => {
  const m = i.quantity_multiplier || 1;
  const parts = [];
  if (i.calories != null) parts.push(`${Math.round(scaled(i.calories, m))} cal`);
  if (i.protein_g != null) parts.push(`${Math.round(scaled(i.protein_g, m))}P`);
  if (i.carbs_g != null) parts.push(`${Math.round(scaled(i.carbs_g, m))}C`);
  if (i.fat_g != null) parts.push(`${Math.round(scaled(i.fat_g, m))}F`);
  if (i.serving_size) parts.push(i.serving_size);
  return parts.join(' · ') || 'macros not set';
};

// Day-by-day diet chart viewer for BOTH trainer-assigned and self-authored
// plans. Fetches the full nested structure from GET /client/diet-plans/:id
// (never trusts a partial list payload), renders day tabs when multi-day,
// meal-slot sections with slot notes, item cards (macros scaled by quantity
// multiplier, client notes, recipe links), a day total vs targets computed
// from the rendered items, and the unchanged daily check-in at the bottom.
export default function ClientDietPlanDetailScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { planId, self, plan: planFallback } = route.params || {};
  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [activeDay, setActiveDay] = useState(0);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkedToday, setCheckedToday] = useState(null);
  const [expandedItem, setExpandedItem] = useState(null); // diet_plan_meal_item id

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: (plan || planFallback)?.name || 'Diet Plan' });
  }, [navigation, plan?.name, planFallback?.name]);

  const load = useCallback(async () => {
    try {
      setError(null);
      // authoritative nested fetch — the list payload is only a fallback
      const full = await api(`/client/diet-plans/${planId}`);
      setPlan(full);
    } catch (e) {
      if (planFallback) setPlan(planFallback);
      else setError(e.message || 'Could not load plan');
    }
  }, [planId, planFallback]);

  useFocusEffect(
    useCallback(() => {
      load().finally(() => setLoading(false));
    }, [load])
  );

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  useEffect(() => {
    if (!planId) return;
    let mounted = true;
    api(`/client/diet-plans/${planId}/checkins`)
      .then((rows) => {
        if (!mounted) return;
        const today = new Date().toISOString().slice(0, 10);
        const todays = (rows || []).find((c) => c.date.slice(0, 10) === today);
        if (todays) setCheckedToday(todays.followed);
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [planId]);

  const days = plan?.days || [];
  const day = days[Math.min(activeDay, Math.max(0, days.length - 1))];
  const multiDay = days.length > 1;

  const totals = useMemo(() => {
    const t = { cal: 0, pro: 0, car: 0, fat: 0 };
    for (const m of day?.meals || []) {
      for (const i of m.items || []) {
        t.cal += scaled(i.calories, i.quantity_multiplier) || 0;
        t.pro += scaled(i.protein_g, i.quantity_multiplier) || 0;
        t.car += scaled(i.carbs_g, i.quantity_multiplier) || 0;
        t.fat += scaled(i.fat_g, i.quantity_multiplier) || 0;
      }
    }
    return t;
  }, [day]);

  if (loading && !plan) {
    return (
      <View style={[styles.container, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (error && !plan) {
    return (
      <View style={[styles.container, styles.centerWrap]}>
        <Ionicons name="alert-circle-outline" size={34} color={colors.textDim} />
        <Text style={styles.emptySub}>{error}</Text>
      </View>
    );
  }

  const target = Number(plan.daily_calorie_target) || 0;
  const tPro = Number(plan.daily_protein_target) || 0;
  const tCar = Number(plan.daily_carbs_target) || 0;
  const tFat = Number(plan.daily_fat_target) || 0;
  const pct = target > 0 ? Math.min(100, Math.round((totals.cal / target) * 100)) : 0;

  const checkIn = async (followed) => {
    if (checkBusy) return;
    setCheckBusy(true);
    const today = new Date().toISOString().slice(0, 10);
    try {
      await api(`/client/diet-plans/${planId}/checkins`, {
        method: 'POST',
        body: { date: today, followed },
      });
      setCheckedToday(followed);
    } catch (e) {
      Alert.alert('Check-in failed', e.message || 'Please try again.');
    } finally {
      setCheckBusy(false);
    }
  };

  const openRecipe = async (url) => {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Could not open link', url);
    }
  };

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
    >
      {!self && plan.trainer_name ? (
        <Text style={styles.byline}>Assigned by {plan.trainer_name}</Text>
      ) : null}
      {plan.notes ? <Text style={styles.planNotes}>{plan.notes}</Text> : null}

      {/* target summary — top */}
      {target > 0 || tPro ? (
        <View style={styles.targetCard}>
          <Text style={styles.targetCal}>
            {target > 0 ? `Daily Target: ${target.toLocaleString()} cal` : 'Daily Targets'}
          </Text>
          <Text style={[styles.targetMacros, NUMS]}>
            {tPro ? `P ${tPro}g` : ''}
            {tCar ? ` · C ${tCar}g` : ''}
            {tFat ? ` · F ${tFat}g` : ''}
          </Text>
        </View>
      ) : null}

      {/* day tabs — only when the plan truly has multiple days */}
      {multiDay && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dayTabScroll} contentContainerStyle={{ gap: 8 }}>
          {days.map((d, i) => (
            <TouchableOpacity
              key={d.id || i}
              style={[styles.dayTab, i === activeDay && styles.dayTabOn]}
              onPress={() => setActiveDay(i)}
            >
              <Text style={[styles.dayTabText, i === activeDay && { color: '#fff' }]}>{d.day_label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* meal sections for the selected day */}
      {day && (day.meals || []).length > 0 ? (
        (day.meals || []).map((m, mi) => (
          <View key={m.id || mi} style={{ marginTop: 16 }}>
            <Text style={styles.mealHeader}>{String(m.meal_type).toUpperCase()}</Text>
            {m.slot_note ? <Text style={styles.slotNote}>{m.slot_note}</Text> : null}
            {(m.items || []).map((i, ii) => {
              const itemKey = i.id || `i${ii}`;
              const isOpen = expandedItem === itemKey;
              const hasDetail = i.client_note || i.recipe_url;
              return (
                <TouchableOpacity
                  key={itemKey}
                  style={styles.itemCard}
                  activeOpacity={hasDetail ? 0.85 : 1}
                  onPress={() => hasDetail && setExpandedItem(isOpen ? null : itemKey)}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.itemName}>
                        {i.name}
                        {(i.quantity_multiplier || 1) !== 1 ? (
                          <Text style={styles.mult}> · {i.quantity_multiplier}x</Text>
                        ) : null}
                      </Text>
                      <Text style={[styles.itemMacro, NUMS]}>{macroLine(i)}</Text>
                    </View>
                    {hasDetail && (
                      <Ionicons
                        name={isOpen ? 'chevron-up' : 'chevron-down'}
                        size={15}
                        color={colors.textDim}
                      />
                    )}
                  </View>
                  {isOpen && (
                    <View style={styles.expandedWrap}>
                      {i.client_note ? (
                        <View style={styles.noteRow}>
                          <Ionicons name="document-text-outline" size={11} color={colors.yellow} />
                          <Text style={styles.noteText}>{i.client_note}</Text>
                        </View>
                      ) : null}
                      {i.recipe_url ? (
                        <TouchableOpacity style={styles.recipeRow} onPress={() => openRecipe(i.recipe_url)}>
                          <Ionicons name="link-outline" size={11} color={colors.primary} />
                          <Text style={styles.recipeText}>View Recipe</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
        ))
      ) : (
        <View style={{ marginTop: 16 }}>
          <Text style={styles.emptyDay}>No meals added to this day yet.</Text>
        </View>
      )}

      {/* running total — after the meal list, summed from rendered items */}
      <View style={[styles.targetCard, { marginTop: 20 }]}>
        <Text style={[styles.totalLine, NUMS]}>
          {Math.round(totals.cal).toLocaleString()}
          {target > 0 ? ` / ${target.toLocaleString()} cal` : ' cal'}
        </Text>
        {target > 0 && (
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${pct}%` }]} />
          </View>
        )}
        {target > 0 ? <Text style={styles.pctText}>{pct}%</Text> : null}
        <Text style={[styles.targetMacros, NUMS]}>
          {`P ${Math.round(totals.pro)}${tPro ? `/${tPro}` : ''}g · C ${Math.round(totals.car)}${tCar ? `/${tCar}` : ''}g · F ${Math.round(totals.fat)}${tFat ? `/${tFat}` : ''}g`}
        </Text>
      </View>

      {/* check-in — unchanged function, positioned below the content */}
      <Text style={styles.checkinQuestion}>Did you follow your plan today?</Text>
      {checkedToday != null ? (
        <Text style={styles.checkedLabel}>
          Checked in today: {checkedToday ? 'followed' : 'not followed'} — tap to change
        </Text>
      ) : null}
      <View style={styles.checkinRow}>
        <TouchableOpacity style={[styles.checkBtn, !checkedToday && styles.noBtnOn]} disabled={checkBusy} onPress={() => checkIn(false)}>
          <Ionicons name="close" size={16} color={colors.red} />
          <Text style={styles.noText}>No</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.checkBtn, checkedToday && styles.yesBtnOn]} disabled={checkBusy} onPress={() => checkIn(true)}>
          <Ionicons name="checkmark" size={16} color="#fff" />
          <Text style={styles.yesText}>Yes</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centerWrap: { alignItems: 'center', justifyContent: 'center', padding: 32 },
    byline: { color: colors.textDim, fontSize: 12, marginBottom: 4 },
    planNotes: { color: colors.textDim, fontSize: 13, fontStyle: 'italic', marginBottom: 10 },
    emptySub: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 10 },

    targetCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    targetCal: { color: colors.text, fontSize: 15, fontWeight: '800' },
    targetMacros: { color: colors.textDim, fontSize: 12, marginTop: 3 },
    totalLine: { color: colors.primary, fontSize: 17, fontWeight: '800' },
    pctText: { color: colors.textDim, fontSize: 11, marginTop: 4, textAlign: 'right' },
    progressTrack: {
      height: 8, borderRadius: 4, backgroundColor: colors.cardLight,
      marginTop: 8, overflow: 'hidden',
    },
    progressFill: { height: '100%', backgroundColor: colors.primary, borderRadius: 4 },

    dayTabScroll: { flexGrow: 0, marginTop: 14 },
    dayTab: {
      borderRadius: 14, paddingHorizontal: 13, paddingVertical: 7,
      backgroundColor: colors.cardLight,
    },
    dayTabOn: { backgroundColor: colors.primary },
    dayTabText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },

    mealHeader: {
      color: colors.textDim, fontSize: 11, fontWeight: '800',
      letterSpacing: 1, textTransform: 'uppercase', marginBottom: 4,
    },
    slotNote: { color: colors.textDim, fontSize: 11, fontStyle: 'italic', marginBottom: 8 },
    itemCard: {
      backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 6,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    itemName: { color: colors.text, fontSize: 14, fontWeight: '700' },
    mult: { color: colors.textDim, fontWeight: '600', fontSize: 12 },
    itemMacro: { color: colors.textDim, fontSize: 11, marginTop: 2 },
    noteRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
    noteText: { color: colors.yellow, fontSize: 11, fontStyle: 'italic', flex: 1 },
    expandedWrap: {
      marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border,
    },
    recipeRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
    recipeText: { color: colors.primary, fontSize: 12, fontWeight: '700' },

    emptyDay: { color: colors.textDim, fontSize: 13, fontStyle: 'italic', textAlign: 'center', paddingVertical: 12 },

    checkinQuestion: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 24, textAlign: 'center' },
    checkedLabel: { color: colors.textDim, fontSize: 11, textAlign: 'center', marginTop: 4 },
    checkinRow: { flexDirection: 'row', gap: 12, marginTop: 10, justifyContent: 'center' },
    checkBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
      borderRadius: 12, paddingVertical: 12, paddingHorizontal: 28,
      backgroundColor: colors.cardLight, borderWidth: 1.5, borderColor: 'transparent',
    },
    yesBtnOn: { backgroundColor: colors.green, borderColor: colors.green },
    noBtnOn: { borderColor: colors.red },
    yesText: { color: '#fff', fontWeight: '800' },
    noText: { color: colors.red, fontWeight: '800' },
  });
