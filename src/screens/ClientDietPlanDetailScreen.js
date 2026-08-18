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
  const planKind = route.params?.plan?.kind || 'diet';
  const isSupplement = planKind === 'supplement';

  const [plan, setPlan] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [activeDay, setActiveDay] = useState(0);
  const [checkBusy, setCheckBusy] = useState(false);
  const [checkedToday, setCheckedToday] = useState(null);
  const [expandedItem, setExpandedItem] = useState(null); // diet_plan_meal_item id

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

  const load = useCallback(async () => {
    try {
      setError(null);
      const endpoint = isSupplement 
        ? `/client/supplement-plans/${planId}` 
        : `/client/diet-plans/${planId}`;
      const full = await api(endpoint);
      setPlan(full);
    } catch (e) {
      if (planFallback) setPlan(planFallback);
      else setError(e.message || 'Could not load plan');
    }
  }, [planId, planFallback, isSupplement]);

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
    const endpoint = isSupplement 
      ? `/client/supplement-plans/${planId}/checkins` 
      : `/client/diet-plans/${planId}/checkins`;
    api(endpoint)
      .then((rows) => {
        if (!mounted) return;
        const today = new Date().toISOString().slice(0, 10);
        const todays = (rows || []).find((c) => c.date.slice(0, 10) === today);
        if (todays) {
          // supplements use 'taken', diet uses 'followed'
          setCheckedToday(isSupplement ? todays.taken : todays.followed);
        }
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [planId, isSupplement]);

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
      const endpoint = isSupplement 
        ? `/client/supplement-plans/${planId}/checkins` 
        : `/client/diet-plans/${planId}/checkins`;
      const body = isSupplement 
        ? { date: today, taken: followed }
        : { date: today, followed };
      await api(endpoint, { method: 'POST', body });
      setCheckedToday(followed);
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
          onPress: async () => {
            try {
              const endpoint = isSupplement 
                ? `/client/supplement-plans/${planId}` 
                : `/client/diet-plans/${planId}`;
              await api(endpoint, { method: 'DELETE' });
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

          {/* meal sections for the selected day */}
          {day && (day.meals || []).length > 0 ? (
        (day.meals || []).map((m, mi) => (
          <View key={m.id || mi} style={{ marginTop: 16 }}>
            <Text style={styles.mealHeader}>{String(m.meal_type).toUpperCase()}</Text>
            {m.slot_note ? <Text style={styles.slotNote}>{m.slot_note}</Text> : null}
            {(m.items || []).map((i, ii) => {
              const itemKey = i.id || `i${ii}`;
              const isOpen = expandedItem === itemKey;
              const altServings = Array.isArray(i.alternate_servings) ? i.alternate_servings : [];
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
                      {/* allergens are a safety matter — visible WITHOUT expanding */}
                      {(i.allergens || []).length > 0 ? (
                        <View style={styles.allergenBadge}>
                          <Ionicons name="warning" size={10} color={colors.red} />
                          <Text style={styles.allergenBadgeText}>
                            Contains: {i.allergens.join(', ')}
                          </Text>
                        </View>
                      ) : null}
                    </View>
                  </View>
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

      {/* check-in — clearer phrasing: one clear statement + explicit
          outcome buttons, with today's recorded state shown up front */}
      <View style={styles.checkinCard}>
        <Text style={styles.checkinTitle}>
          {isSupplement ? "Today's supplements check-in" : "Today's check-in"}
        </Text>
        {checkedToday == null ? (
          <Text style={styles.checkinSub}>
            {isSupplement ? 'Did you take your supplements today?' : 'How did today go with this plan?'}
          </Text>
        ) : (
          <View style={styles.checkinStateRow}>
            <Ionicons
              name={checkedToday ? 'checkmark-circle' : 'close-circle'}
              size={15}
              color={checkedToday ? colors.green : colors.red}
            />
            <Text style={styles.checkinStateText}>
              {isSupplement 
                ? (checkedToday ? 'You took your supplements today' : "You didn't take your supplements today")
                : (checkedToday ? 'You followed this plan today' : "You didn't follow this plan today")
              }
            </Text>
          </View>
        )}
        <View style={styles.checkinRow}>
          <TouchableOpacity
            style={[styles.checkBtn, checkedToday === false && styles.noBtnOn]}
            disabled={checkBusy}
            onPress={() => checkIn(false)}
          >
            <Ionicons name="close" size={15} color={checkedToday === false ? '#fff' : colors.red} />
            <Text style={[styles.checkBtnLabel, checkedToday === false && { color: '#fff' }]}>
              {isSupplement ? "Didn't take" : "Not today"}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.checkBtn, styles.yesBtn, checkedToday === true && styles.yesBtnOn]}
            disabled={checkBusy}
            onPress={() => checkIn(true)}
          >
            <Ionicons name="checkmark" size={15} color={checkedToday === true ? '#fff' : colors.green} />
            <Text style={[styles.checkBtnLabel, checkedToday === true && { color: '#fff' }]}>
              {isSupplement ? 'Took them' : 'Followed it'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

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
