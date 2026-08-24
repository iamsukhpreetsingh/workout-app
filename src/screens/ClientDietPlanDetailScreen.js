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
  Image,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../lib/api';
import { getDietPlan, checkInDiet, deleteDietPlan, listDietCheckins, isLocalDietPlanId } from '../db/dietPlans';
import { getSupplementPlan, checkInSupplement, deleteSupplementPlan, listSupplementCheckins, isLocalSupplementPlanId } from '../db/supplementPlans';
import { getSwapsForDate, swapDietItem, undoDietSwap } from '../db/dietSwaps';
import DishPickerModal from '../components/DishPickerModal';
import { listRecipes } from '../db/recipes';
import { todayLocalISO, isFutureDate, buildCheckinMap } from '../lib/checkinDates';
import { useColors } from '../theme';

const NUMS = { fontVariant: ['tabular-nums'] };

const scaled = (v, mult) => (v == null ? null : Number(v) * (mult || 1));

// Local calendar date — NEVER new Date().toISOString(), which is UTC-based
// and mislabels "today" near midnight in non-UTC timezones (an explicit
// acceptance criterion for the check-in feature).
const todayStr = () => todayLocalISO();

const shiftDateStr = (date, days) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const formatDateLabel = (date) => {
  const d = new Date(`${date}T12:00:00`);
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};

// normalize an alternative row (shape varies by source: server rows use
// alternative_name/alternative_*, local rows and backup JSONB use name/*)
const altName = (a) => a?.name ?? a?.alternative_name;
const altMacro = (a, k) => a?.[k] ?? a?.[`alternative_${k}`];

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
  const planKind = route.params?.plan?.kind || 'diet';
  const isSupplement = planKind === 'supplement';

  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [activeDay, setActiveDay] = useState(0);
  const [checkBusy, setCheckBusy] = useState(false);
  // Check-in state keyed PER EXACT DATE ('YYYY-MM-DD' -> true/false).
  // Missing key = unanswered. Never a single plan-wide value: that original
  // shape made one date's answer bleed into every other date's display.
  const [checkinsByDate, setCheckinsByDate] = useState({});
  const [expandedItem, setExpandedItem] = useState(null); // diet_plan_meal_item id

  // ── date-scoped swap state (diet only) ────────────────────────────────
  // A diet plan is followed day after day, so a swap is keyed to the exact
  // calendar date being viewed — never a permanent plan edit. viewDate
  // defaults to real today; stepping dates shows that date's swaps.
  const [viewDate, setViewDate] = useState(todayStr());
  const [swapsByItem, setSwapsByItem] = useState({}); // itemRef -> swap row
  const [swapSheetItem, setSwapSheetItem] = useState(null); // item being swapped
  const [fallbackPicker, setFallbackPicker] = useState(false); // ad-hoc dish picker
  const [fallbackItem, setFallbackItem] = useState(null); // item for the ad-hoc picker
  const [pickerCatalog, setPickerCatalog] = useState(null);

  // reload this date's swaps whenever the viewed date or plan changes
  useEffect(() => {
    if (isSupplement) return;
    let mounted = true;
    getSwapsForDate(planId, viewDate)
      .then((map) => {
        if (!mounted) return;
        const obj = {};
        for (const [k, v] of map) obj[k] = v;
        setSwapsByItem(obj);
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [planId, viewDate, isSupplement]);

  const reloadSwaps = async () => {
    try {
      const map = await getSwapsForDate(planId, viewDate);
      const obj = {};
      for (const [k, v] of map) obj[k] = v;
      setSwapsByItem(obj);
    } catch {}
  };

  // effective display values for one item on the viewed date
  const resolveItem = (i) => {
    const swap = swapsByItem[String(i.id)];
    if (!swap) return { ...i, activeSwap: null };
    return {
      ...i,
      name: swap.swapped_name,
      calories: swap.swapped_calories,
      protein_g: swap.swapped_protein_g,
      carbs_g: swap.swapped_carbs_g,
      fat_g: swap.swapped_fat_g,
      serving_size: null,
      activeSwap: swap,
    };
  };

  const doSwap = async (item, alt) => {
    try {
      await swapDietItem({
        planRef: planId,
        itemRef: String(item.id),
        originalName: item.name,
        date: viewDate,
        swapped: {
          name: altName(alt),
          calories: altMacro(alt, 'calories'),
          protein_g: altMacro(alt, 'protein_g'),
          carbs_g: altMacro(alt, 'carbs_g'),
          fat_g: altMacro(alt, 'fat_g'),
        },
      });
      await reloadSwaps();
      setSwapSheetItem(null);
      setFallbackPicker(false);
    } catch (e) {
      Alert.alert('Could not swap', e.message || 'Please try again.');
    }
  };

  const doUndoSwap = async (item) => {
    try {
      await undoDietSwap(String(item.id), viewDate);
      await reloadSwaps();
    } catch (e) {
      Alert.alert('Could not undo swap', e.message || 'Please try again.');
    }
  };

  // "Choose a different dish" fallback source: personal My Dishes for
  // self-authored plans; the coach's Meal Catalog (read-only) for assigned
  // ones. Custom Item entry is always available inside the same modal.
  const openFallbackPicker = async () => {
    setPickerCatalog(null);
    setFallbackPicker(true);
    const source =
      self && isLocalDietPlanId(planId) && !isSupplement
        ? listRecipes()
        : api('/client/coach-dishes');
    source.then(setPickerCatalog).catch(() => setPickerCatalog([]));
  };

  // union of allergens across the WHOLE plan (all days) — shown once at top
  const planAllergens = React.useMemo(() => {
    const set = new Set();
    for (const d of plan?.days || []) {
      for (const m of d.meals || []) {
        for (const it of m.items || []) (it.allergens || []).forEach((a) => set.add(a));
      }
    }
    return [...set];
  }, [plan]);

  React.useLayoutEffect(() => {
    navigation.setOptions({ 
      title: (plan || planFallback)?.name || (isSupplement ? 'Supplement Plan' : 'Diet Plan') 
    });
  }, [navigation, plan?.name, planFallback?.name, isSupplement]);

  // const load = useCallback(async () => {
  //   try {
  //     setError(null);
  //     const endpoint = isSupplement 
  //       ? `/client/supplement-plans/${planId}` 
  //       : `/client/diet-plans/${planId}`;
  //     const full = await api(endpoint);
  //     setPlan(full);
  //   } catch (e) {
  //     if (planFallback) setPlan(planFallback);
  //     else setError(e.message || 'Could not load plan');
  //   }
  // }, [planId, planFallback, isSupplement]);

    const load = useCallback(async () => {
    try {
      setError(null);
      let full;
      if (isSupplement) {
        full = (self && isLocalSupplementPlanId(planId))
          ? await getSupplementPlan(planId)
          : await api(`/client/supplement-plans/${planId}`);
      } else {
        full = (self && isLocalDietPlanId(planId))
          ? await getDietPlan(planId)
          : await api(`/client/diet-plans/${planId}`);
      }
      setPlan(full);
    } catch (e) {
      if (planFallback) setPlan(planFallback);
      else setError(e.message || 'Could not load plan');
    }
  }, [planId, planFallback, isSupplement, self]);

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

  // useEffect(() => {
  //   if (!planId) return;
  //   let mounted = true;
  //   const endpoint = isSupplement 
  //     ? `/client/supplement-plans/${planId}/checkins` 
  //     : `/client/diet-plans/${planId}/checkins`;
  //   api(endpoint)
  //     .then((rows) => {
  //       if (!mounted) return;
  //       const today = new Date().toISOString().slice(0, 10);
  //       const todays = (rows || []).find((c) => c.date.slice(0, 10) === today);
  //       if (todays) {
  //         // supplements use 'taken', diet uses 'followed'
  //         setCheckedToday(isSupplement ? todays.taken : todays.followed);
  //       }
  //     })
  //     .catch(() => {});
  //   return () => { mounted = false; };
  // }, [planId, isSupplement]);


    useEffect(() => {
    if (!planId) return;
    let mounted = true;
    const isLocal = self && (isSupplement ? isLocalSupplementPlanId(planId) : isLocalDietPlanId(planId));
    const fetchCheckins = isLocal
      ? (isSupplement ? listSupplementCheckins(planId) : listDietCheckins(planId))
      : api(isSupplement
          ? `/client/supplement-plans/${planId}/checkins`
          : `/client/diet-plans/${planId}/checkins`);
    fetchCheckins
      .then((rows) => {
        if (!mounted) return;
        // per-date map — each date reads ONLY its own row (the backend
        // already stores one row per date via UNIQUE(plan, date); the old
        // code collapsed everything into a single plan-wide value)
        setCheckinsByDate(buildCheckinMap(rows, isSupplement ? 'taken' : 'followed'));
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [planId, isSupplement, self]);

  const days = plan?.days || [];
  const day = days[Math.min(activeDay, Math.max(0, days.length - 1))];
  const multiDay = days.length > 1;

  const totals = useMemo(() => {
    const t = { cal: 0, pro: 0, car: 0, fat: 0 };
    for (const m of day?.meals || []) {
      for (const raw of m.items || []) {
        // a swap in effect for THIS viewed date feeds its own macros into
        // the running total — only for this exact calendar date
        const i = isSupplement ? raw : resolveItem(raw);
        t.cal += scaled(i.calories, i.quantity_multiplier) || 0;
        t.pro += scaled(i.protein_g, i.quantity_multiplier) || 0;
        t.car += scaled(i.carbs_g, i.quantity_multiplier) || 0;
        t.fat += scaled(i.fat_g, i.quantity_multiplier) || 0;
      }
    }
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, swapsByItem]);

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

  // const checkIn = async (followed) => {
  //   if (checkBusy) return;
  //   setCheckBusy(true);
  //   const today = new Date().toISOString().slice(0, 10);
  //   try {
  //     const endpoint = isSupplement 
  //       ? `/client/supplement-plans/${planId}/checkins` 
  //       : `/client/diet-plans/${planId}/checkins`;
  //     const body = isSupplement 
  //       ? { date: today, taken: followed }
  //       : { date: today, followed };
  //     await api(endpoint, { method: 'POST', body });
  //     setCheckedToday(followed);
  //   } catch (e) {
  //     Alert.alert('Check-in failed', e.message || 'Please try again.');
  //   } finally {
  //     setCheckBusy(false);
  //   }
  // };

    const checkIn = async (followed) => {
    if (checkBusy) return;
    setCheckBusy(true);
    // the check-in belongs to the VIEWED date (backfilling a past day is
    // allowed; future dates are blocked in the UI and re-guarded here)
    const date = isSupplement ? todayStr() : viewDate;
    if (isFutureDate(date)) {
      setCheckBusy(false);
      Alert.alert('Not yet', 'You can check in once this date arrives.');
      return;
    }
    try {
      if (isSupplement) {
        if (self && isLocalSupplementPlanId(planId)) {
          await checkInSupplement(planId, date, followed); // local-first
        } else {
          await api(`/client/supplement-plans/${planId}/checkins`, { method: 'POST', body: { date, taken: followed } });
        }
      } else {
        if (self && isLocalDietPlanId(planId)) {
          await checkInDiet(planId, date, followed); // local-first
        } else {
          await api(`/client/diet-plans/${planId}/checkins`, { method: 'POST', body: { date, followed } });
        }
      }
      // update ONLY this date's key — every other date's answer untouched
      setCheckinsByDate((prev) => ({ ...prev, [date]: followed }));
    } catch (e) {
      Alert.alert('Check-in failed', e.message || 'Please try again.');
    } finally {
      setCheckBusy(false);
    }
  };

  const confirmDelete = () =>
    Alert.alert(
      'Delete plan',
      `"${plan?.name || 'This plan'}" will be permanently removed. Past check-ins are deleted with it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          // onPress: async () => {
          //   try {
          //     const endpoint = isSupplement 
          //       ? `/client/supplement-plans/${planId}` 
          //       : `/client/diet-plans/${planId}`;
          //     await api(endpoint, { method: 'DELETE' });
          //     navigation.goBack();
          //   } catch (e) {
          //     Alert.alert('Could not delete', e.message || 'Please try again.');
          //   }
          // },

            onPress: async () => {
            try {
              if (isSupplement) {
                if (self && isLocalSupplementPlanId(planId)) {
                  await deleteSupplementPlan(planId); // local-first
                } else {
                  await api(`/client/supplement-plans/${planId}`, { method: 'DELETE' });
                }
              } else {
                if (self && isLocalDietPlanId(planId)) {
                  await deleteDietPlan(planId); // local-first
                } else {
                  await api(`/client/diet-plans/${planId}`, { method: 'DELETE' });
                }
              }
              navigation.goBack();
            } catch (e) {
              Alert.alert('Could not delete', e.message || 'Please try again.');
            }
          },
        },
      ]
    );

  const openRecipe = async (url) => {
    try {
      await Linking.openURL(url);
    } catch {
      Alert.alert('Could not open link', url);
    }
  };

  // Render supplements list (flat structure)
  const renderSupplementItems = () => {
    const items = plan.items || [];
    if (items.length === 0) {
      return (
        <View style={{ marginTop: 16 }}>
          <Text style={styles.emptyDay}>No supplements added yet.</Text>
        </View>
      );
    }
    return (
      <View style={{ marginTop: 16 }}>
        {items.map((item, idx) => (
          <View key={item.id || idx} style={styles.itemCard}>
            <View style={styles.itemRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemName} numberOfLines={2}>
                  {item.supplement_name}
                </Text>
                <Text style={[styles.itemMacro, NUMS]}>
                  {[item.dosage, item.timing].filter(Boolean).join(' · ')}
                </Text>
                {item.notes ? (
                  <Text style={[styles.noteText, { marginTop: 4 }]}>{item.notes}</Text>
                ) : null}
              </View>
            </View>
          </View>
        ))}
      </View>
    );
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

      {/* Supplements: flat item list - no targets, no allergens for supplements */}
      {isSupplement ? (
        renderSupplementItems()
      ) : (
        <>
          {/* Diet: target summary — top */}
          {target > 0 || tPro ? (
            <View style={styles.targetCard}>
              <Text style={styles.targetCal}>
                {target > 0 ? `Daily Target: ${target.toLocaleString()} cal` : 'Daily Targets'}
              </Text>
              <Text style={[styles.targetMacros, NUMS]}>
                {(tPro ? `P ${tPro}g` : '') + (tCar ? ` · C ${tCar}g` : '') + (tFat ? ` · F ${tFat}g` : '')}
              </Text>
            </View>
          ) : null}

          {/* consolidated allergen notice — one glance before scrolling */}
          {planAllergens.length > 0 ? (
            <View style={styles.planAllergenCard}>
              <Ionicons name="warning" size={13} color={colors.red} />
              <Text style={styles.planAllergenText}>
                This plan contains: {planAllergens.join(', ')}
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

          {/* date navigator — swaps are DATE-scoped ("on Aug 24 I ate X
              instead"), so the viewer must say which calendar date you're
              looking at. Defaults to today; stepping shows that date's
              swaps only — nothing carries forward across dates. */}
          {!isSupplement && (
            <View style={styles.dateNav}>
              <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setViewDate(shiftDateStr(viewDate, -1))}>
                <Ionicons name="chevron-back" size={17} color={colors.text} />
              </TouchableOpacity>
              <TouchableOpacity hitSlop={{ top: 8, bottom: 8 }} onPress={() => setViewDate(todayStr())}>
                <Text style={styles.dateNavText}>
                  {formatDateLabel(viewDate)}
                  {viewDate === todayStr() ? ' · Today' : ''}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setViewDate(shiftDateStr(viewDate, 1))}>
                <Ionicons name="chevron-forward" size={17} color={colors.text} />
              </TouchableOpacity>
            </View>
          )}

          {/* meal sections for the selected day */}
          {day && (day.meals || []).length > 0 ? (
        (day.meals || []).map((m, mi) => (
          <View key={m.id || mi} style={{ marginTop: 16 }}>
            <Text style={styles.mealHeader}>{String(m.meal_type).toUpperCase()}</Text>
            {m.slot_note ? <Text style={styles.slotNote}>{m.slot_note}</Text> : null}
            {(m.items || []).map((raw, ii) => {
              // resolve any swap in effect for the VIEWED date — the plan's
              // stored definition itself is never changed by a swap
              const i = isSupplement ? raw : resolveItem(raw);
              const itemKey = i.id || `i${ii}`;
              const isOpen = expandedItem === itemKey;
              const altServings = Array.isArray(i.alternate_servings) ? i.alternate_servings : [];
              const configuredAlts = Array.isArray(raw.alternatives) ? raw.alternatives : [];
              const metaBits = [
                i.prep_time_minutes != null ? `${i.prep_time_minutes} min prep` : null,
                i.cook_time_minutes != null
                  ? (i.cook_time_minutes === 0 ? 'No cook' : `${i.cook_time_minutes} min cook`)
                  : null,
                i.difficulty ? i.difficulty[0].toUpperCase() + i.difficulty.slice(1) : null,
              ].filter(Boolean);
              // !! — every operand here can be 0/'' which React would render
              // as a RAW STRING inside a View ("Text strings must be
              // rendered within a <Text> component" crash) if it leaked
              // through the && gates below
              const hasDetail = Boolean(
                i.client_note || i.recipe_url || (i.ingredients || []).length || altServings.length || metaBits.length
              );
              return (
                <TouchableOpacity
                  key={itemKey}
                  style={styles.itemCard}
                  activeOpacity={0.85}
                  onPress={() => setExpandedItem(isOpen ? null : itemKey)}
                >
                  <View style={styles.itemRow}>
                    {i.photo_path ? (
                      <Image source={{ uri: i.photo_path }} style={styles.itemThumb} />
                    ) : null}
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={styles.itemName} numberOfLines={2}>
                          {i.name}
                          {(i.quantity_multiplier || 1) !== 1 ? (
                            <Text style={styles.mult}> · {i.quantity_multiplier}x</Text>
                          ) : null}
                        </Text>
                        {hasDetail ? (
                          <Ionicons
                            name={isOpen ? 'chevron-up' : 'chevron-down'}
                            size={15}
                            color={colors.textDim}
                          />
                        ) : null}
                      </View>
                      <Text style={[styles.itemMacro, NUMS]}>{macroLine(i)}</Text>
                      {i.activeSwap ? (
                        <View style={styles.swapBadge}>
                          <Ionicons name="arrow-undo" size={10} color={colors.blue} />
                          <Text style={styles.swapBadgeText}>
                            Swapped from {i.activeSwap.original_name}
                          </Text>
                        </View>
                      ) : null}
                      {/* allergens are a safety matter — visible WITHOUT expanding */}
                      {(i.allergens || []).length > 0 && !i.activeSwap ? (
                        <View style={styles.allergenBadge}>
                          <Ionicons name="warning" size={10} color={colors.red} />
                          <Text style={styles.allergenBadgeText}>
                            Contains: {i.allergens.join(', ')}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
                  {/* swap actions — apply ONLY to viewDate; Undo deletes the
                      (item, date) swap row and reverts the display */}
                  {!isSupplement && (
                    <View style={styles.swapActionsRow}>
                      {i.activeSwap ? (
                        <TouchableOpacity
                          style={styles.undoSwapBtn}
                          hitSlop={{ top: 6, bottom: 6 }}
                          onPress={() => doUndoSwap(raw)}
                        >
                          <Ionicons name="arrow-undo" size={12} color={colors.blue} />
                          <Text style={styles.undoSwapText}>Undo Swap</Text>
                        </TouchableOpacity>
                      ) : (
                        <TouchableOpacity
                          style={styles.swapBtn}
                          hitSlop={{ top: 6, bottom: 6 }}
                          onPress={() => setSwapSheetItem(raw)}
                        >
                          <Ionicons name="swap-horizontal" size={12} color={colors.primary} />
                          <Text style={styles.swapBtnText}>Swap</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                  {isOpen ? (
                    <View style={styles.expandedWrap}>
                      {(i.ingredients || []).length > 0 && (
                        <View style={styles.ingWrap}>
                          <Text style={styles.ingLabel}>Ingredients</Text>
                          {(i.ingredients || []).map((ing, k) => (
                            <Text key={k} style={styles.ingLine}>• {ing}</Text>
                          ))}
                        </View>
                      )}
                      {metaBits.length > 0 && (
                        <View style={styles.metaRow}>
                          {metaBits.map((b, k) => (
                            <View key={k} style={styles.metaChip}>
                              <Text style={styles.metaChipText}>{b}</Text>
                            </View>
                          ))}
                        </View>
                      )}
                      {altServings.length > 0 && (
                        <View style={styles.ingWrap}>
                          <Text style={styles.ingLabel}>Also available as:</Text>
                          {altServings.map((a, k) => (
                            <Text key={k} style={[styles.ingLine, NUMS]}>
                              {a.label + (a.calories != null ? ` — ${a.calories} cal` : '') + (a.protein_g != null ? ` · ${Math.round(a.protein_g)}P` : '') + (a.carbs_g != null ? ` ${Math.round(a.carbs_g)}C` : '') + (a.fat_g != null ? ` ${Math.round(a.fat_g)}F` : '')}
                            </Text>
                          ))}
                        </View>
                      )}
                      {i.client_note ? (
                        <View style={styles.noteRow}>
                          <Ionicons name="document-text-outline" size={11} color={colors.yellow} />
                          <Text style={styles.noteText}>{i.client_note}</Text>
                        </View>
                      ) : null}
                      {i.recipe_url ? (
                        <TouchableOpacity style={styles.recipeRow} onPress={() => openRecipe(i.recipe_url)}>
                          <Ionicons name="link-outline" size={11} color={colors.primary} />
                          <Text style={styles.recipeText}>View Full Recipe</Text>
                        </TouchableOpacity>
                      ) : null}
                    </View>
                  ) : null}
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
            {Math.round(totals.cal).toLocaleString() + (target > 0 ? ` / ${target.toLocaleString()} cal` : '')}
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
        </>
      )}

      {/* check-in — PER-DATE and never answerable for a future date.
          The control targets the VIEWED date (diet) / real today
          (supplement); each date's answer is stored and displayed
          independently of every other date's. */}
      {(() => {
        const effectiveDate = isSupplement ? todayStr() : viewDate;
        const isViewingToday = effectiveDate === todayStr();
        const isFuture = isFutureDate(effectiveDate);
        const answered = checkinsByDate[effectiveDate];
        const dateLabel = formatDateLabel(effectiveDate);
        return (
          <View style={[styles.checkinCard, isFuture && styles.checkinCardFuture]}>
            <Text style={styles.checkinTitle}>
              {isSupplement
                ? "Today's supplements check-in"
                : isViewingToday
                  ? "Today's check-in"
                  : `Check-in — ${dateLabel}`}
            </Text>
            {isFuture ? (
              // future dates are NEVER answerable — visible but disabled
              <>
                <Text style={styles.checkinSub}>
                  You can check in starting {dateLabel}.
                </Text>
                <View style={[styles.checkinRow, { opacity: 0.4 }]} pointerEvents="none">
                  <TouchableOpacity style={styles.checkBtn} disabled>
                    <Ionicons name="close" size={15} color={colors.red} />
                    <Text style={styles.checkBtnLabel}>{isSupplement ? "Didn't take" : 'Not today'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={[styles.checkBtn, styles.yesBtn]} disabled>
                    <Ionicons name="checkmark" size={15} color={colors.green} />
                    <Text style={styles.checkBtnLabel}>{isSupplement ? 'Took them' : 'Followed it'}</Text>
                  </TouchableOpacity>
                </View>
              </>
            ) : (
              <>
                {answered == null ? (
                  <Text style={styles.checkinSub}>
                    {isSupplement
                      ? 'Did you take your supplements today?'
                      : isViewingToday
                        ? 'How did today go with this plan?'
                        : `How did ${dateLabel} go with this plan?`}
                  </Text>
                ) : (
                  <View style={styles.checkinStateRow}>
                    <Ionicons
                      name={answered ? 'checkmark-circle' : 'close-circle'}
                      size={15}
                      color={answered ? colors.green : colors.red}
                    />
                    <Text style={styles.checkinStateText}>
                      {isSupplement
                        ? (answered ? 'You took your supplements today' : "You didn't take your supplements today")
                        : (isViewingToday
                            ? (answered ? 'You followed this plan today' : "You didn't follow this plan today")
                            : (answered ? `You followed this plan on ${dateLabel}` : `You didn't follow this plan on ${dateLabel}`))
                      }
                    </Text>
                  </View>
                )}
                <View style={styles.checkinRow}>
                  <TouchableOpacity
                    style={[styles.checkBtn, answered === false && styles.noBtnOn]}
                    disabled={checkBusy}
                    onPress={() => checkIn(false)}
                  >
                    <Ionicons name="close" size={15} color={answered === false ? '#fff' : colors.red} />
                    <Text style={[styles.checkBtnLabel, answered === false && { color: '#fff' }]}>
                      {isSupplement ? "Didn't take" : 'Not today'}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.checkBtn, styles.yesBtn, answered === true && styles.yesBtnOn]}
                    disabled={checkBusy}
                    onPress={() => checkIn(true)}
                  >
                    <Ionicons name="checkmark" size={15} color={answered === true ? '#fff' : colors.green} />
                    <Text style={[styles.checkBtnLabel, answered === true && { color: '#fff' }]}>
                      {isSupplement ? 'Took them' : 'Followed it'}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
          </View>
        );
      })()}

      {/* own-plan management (self-authored only) */}
      {self && (
        <View style={styles.manageRow}>
          <TouchableOpacity
            style={styles.editBtn}
            onPress={() => {
              if (isSupplement) {
                navigation.navigate('CoachingPlanBuilder', { kind: 'supplement', self: true, editPlanId: planId });
              } else {
                navigation.navigate('DietPlanBuilder', { self: true, editPlanId: planId });
              }
            }}
          >
            <Ionicons name="create-outline" size={15} color={colors.primary} />
            <Text style={styles.editBtnText}>Edit Plan</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.deleteBtn} onPress={confirmDelete}>
            <Ionicons name="trash-outline" size={15} color={colors.red} />
            <Text style={styles.deleteBtnText}>Delete</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Swap sheet: configured alternatives first (one tap each), then the
          "Choose a different dish" fallback into the SAME catalog/custom
          search modal used everywhere else. Applies to viewDate only. */}
      <Modal
        visible={!!swapSheetItem}
        transparent
        animationType="slide"
        onRequestClose={() => setSwapSheetItem(null)}
      >
        <View style={styles.swapSheetWrap}>
          <View style={styles.swapSheet}>
            <Text style={styles.swapSheetTitle}>
              Swap {swapSheetItem?.name || ''} for {viewDate === todayStr() ? 'today' : formatDateLabel(viewDate)}
            </Text>
            {configuredAltsOf(swapSheetItem).length === 0 && (
              <Text style={styles.swapSheetEmpty}>No pre-configured alternatives for this dish.</Text>
            )}
            {configuredAltsOf(swapSheetItem).map((a, k) => (
              <TouchableOpacity
                key={k}
                style={styles.swapOptionRow}
                onPress={() => doSwap(swapSheetItem, a)}
              >
                <Text style={styles.swapOptionName} numberOfLines={1}>{altName(a)}</Text>
                <Text style={[styles.swapOptionMacro, NUMS]}>
                  {altMacro(a, 'calories') != null ? `${altMacro(a, 'calories')} cal` : ''}
                </Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.swapOtherBtn} onPress={() => { setFallbackItem(swapSheetItem); setSwapSheetItem(null); openFallbackPicker(); }}>
              <Text style={styles.swapOtherText}>Choose a different dish →</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setSwapSheetItem(null)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* ad-hoc fallback dish picker (same component as every other dish
          search; source = My Dishes or coach catalog per plan origin) */}
      <DishPickerModal
        visible={fallbackPicker}
        onClose={() => { setFallbackPicker(false); setFallbackItem(null); }}
        title={`Swap ${fallbackItem?.name || 'dish'} for ${formatDateLabel(viewDate)}`}
        self={self}
        catalog={pickerCatalog}
        refreshCatalog={openFallbackPicker}
        slotHint=""
        excludeNames={(day?.meals || []).flatMap((mm) => (mm.items || []).map((x) => x.name))}
        onPickCatalog={(c) => (fallbackItem || swapSheetItem) && doSwap(fallbackItem || swapSheetItem, c)}
        onPickCustom={(it) => (fallbackItem || swapSheetItem) && doSwap(fallbackItem || swapSheetItem, it)}
      />
    </ScrollView>
  );
}

// configured alternatives of the item currently in the swap sheet
function configuredAltsOf(item) {
  if (!item || !Array.isArray(item.alternatives)) return [];
  return item.alternatives;
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

    // date navigator (swap scoping)
    dateNav: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 18,
      backgroundColor: colors.cardLight, borderRadius: 12,
      paddingVertical: 8, paddingHorizontal: 14, marginTop: 12, alignSelf: 'center',
    },
    dateNavText: { color: colors.text, fontSize: 13, fontWeight: '800' },

    swapBadge: {
      flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4,
      alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.blue,
      borderRadius: 7, paddingHorizontal: 6, paddingVertical: 2,
    },
    swapBadgeText: { color: colors.blue, fontSize: 10, fontWeight: '700' },
    swapActionsRow: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 8 },
    swapBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      borderWidth: 1.2, borderColor: colors.border, borderRadius: 9,
      paddingHorizontal: 11, paddingVertical: 5,
    },
    swapBtnText: { color: colors.primary, fontSize: 11, fontWeight: '700' },
    undoSwapBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      borderWidth: 1.2, borderColor: colors.blue, borderRadius: 9,
      paddingHorizontal: 11, paddingVertical: 5,
    },
    undoSwapText: { color: colors.blue, fontSize: 11, fontWeight: '700' },

    swapSheetWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    swapSheet: {
      backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
      padding: 18,
    },
    swapSheetTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: 12 },
    swapSheetEmpty: { color: colors.textDim, fontSize: 12, marginBottom: 8 },
    swapOptionRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      backgroundColor: colors.card, borderRadius: 12, padding: 13, marginBottom: 7,
    },
    swapOptionName: { color: colors.text, fontSize: 14, fontWeight: '700', flex: 1 },
    swapOptionMacro: { color: colors.textDim, fontSize: 12, marginLeft: 8 },
    swapOtherBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
    swapOtherText: { color: colors.primary, fontSize: 13, fontWeight: '700' },
    cancelBtn: { alignItems: 'center', paddingVertical: 10 },
    cancelText: { color: colors.textDim, fontWeight: '700' },

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
    itemRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    itemThumb: { width: 46, height: 46, borderRadius: 9 },
    allergenBadge: {
      flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5,
      alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.red,
      borderRadius: 7, paddingHorizontal: 6, paddingVertical: 2,
      backgroundColor: colors.card,
    },
    allergenBadgeText: { color: colors.red, fontSize: 10, fontWeight: '700' },
    planAllergenCard: {
      flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10,
      borderWidth: 1, borderColor: colors.red, borderRadius: 12,
      paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.card,
    },
    planAllergenText: { color: colors.red, fontSize: 12, fontWeight: '700', flex: 1 },
    ingWrap: { marginBottom: 8 },
    ingLabel: { color: colors.textDim, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 3 },
    ingLine: { color: colors.text, fontSize: 12, lineHeight: 18 },
    metaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
    metaChip: {
      backgroundColor: colors.cardLight, borderRadius: 8,
      paddingHorizontal: 8, paddingVertical: 3,
    },
    metaChipText: { color: colors.textDim, fontSize: 10, fontWeight: '600' },
    noteRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
    noteText: { color: colors.yellow, fontSize: 11, fontStyle: 'italic', flex: 1 },
    expandedWrap: {
      marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border,
    },
    recipeRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
    recipeText: { color: colors.primary, fontSize: 12, fontWeight: '700' },

    emptyDay: { color: colors.textDim, fontSize: 13, fontStyle: 'italic', textAlign: 'center', paddingVertical: 12 },


    checkedLabel: { color: colors.textDim, fontSize: 11, textAlign: 'center', marginTop: 4 },
    checkinRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
    checkBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
      borderRadius: 12, paddingVertical: 12, paddingHorizontal: 28,
      backgroundColor: colors.cardLight, borderWidth: 1.5, borderColor: 'transparent',
    },
    yesBtnOn: { backgroundColor: colors.green, borderColor: colors.green },
    noBtnOn: { borderColor: colors.red },
    yesText: { color: '#fff', fontWeight: '800' },
    noText: { color: colors.red, fontWeight: '800' },
    checkinCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 16, marginTop: 22,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    checkinCardFuture: { opacity: 0.6 },
    checkinTitle: { color: colors.text, fontSize: 15, fontWeight: '800' },
    checkinSub: { color: colors.textDim, fontSize: 13, marginTop: 3 },
    checkinStateRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 5 },
    checkinStateText: { color: colors.text, fontSize: 13 },
    checkinRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
    checkBtn: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
      borderRadius: 12, paddingVertical: 12,
      backgroundColor: colors.cardLight, borderWidth: 1.5, borderColor: 'transparent',
    },
    yesBtn: {},
    yesBtnOn: { backgroundColor: colors.green, borderColor: colors.green },
    noBtnOn: { backgroundColor: colors.red, borderColor: colors.red },
    checkBtnLabel: { fontWeight: '800', fontSize: 13, color: colors.text },
    manageRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
    editBtn: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12, paddingVertical: 12,
    },
    editBtnText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
    deleteBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
      borderWidth: 1, borderColor: colors.red, borderRadius: 12,
      paddingHorizontal: 18, paddingVertical: 12, opacity: 0.85,
    },
    deleteBtnText: { color: colors.red, fontWeight: '700', fontSize: 13 },
  });
