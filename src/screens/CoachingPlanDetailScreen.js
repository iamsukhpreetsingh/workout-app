import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, StyleSheet, ActivityIndicator, Modal, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../lib/api';
import { useColors } from '../theme';
import { getAllergenConflicts } from '../lib/allergens';
import { STATUS_META } from '../features/diet/domain/nutritionCore';

const NUMS = { fontVariant: ['tabular-nums'] };

const STATUS_COLORS = {
  on_target: 'green',
  under_target: 'orange',
  over_target: 'red',
  in_progress: 'blue',
  simple_followed: 'green',
  simple_missed: 'orange',
  not_logged: 'cardLight',
};

// Trainer view of a diet/supplement plan. Diet: exception-first monitoring
// (status, prioritized alerts, 7-day OUTCOME strip with drill-down, notes)
// on top of the read-only plan chart. Supplements keep the check-in strip.
export default function CoachingPlanDetailScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { planId, kind, clientId, clientName } = route.params || {};
  const seg = kind === 'diet' ? 'diet-plans' : 'supplement-plans';
  const [plan, setPlan] = useState(null);
  const [checkins, setCheckins] = useState([]);
  const [busy, setBusy] = useState(false);
  const [clientProfile, setClientProfile] = useState(null); // client's intake profile
  const [contextOpen, setContextOpen] = useState(false); // Client Context section
  // diet monitoring: daily outcome statuses + prioritized alerts
  const [monitoring, setMonitoring] = useState(null);
  const [dayDetail, setDayDetail] = useState(null); // { date, entries, summary }
  const [note, setNote] = useState('');
  const [notes, setNotes] = useState([]);
  const [noteBusy, setNoteBusy] = useState(false);
  // nutrition targets: active + app recommendation + trainer override form
  const [targetsData, setTargetsData] = useState(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideForm, setOverrideForm] = useState({ cal: '', pro: '', car: '', fat: '' });
  const [overrideNote, setOverrideNote] = useState('');
  const [targetsBusy, setTargetsBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, cis, prof, mon, noteRows, tgts] = await Promise.all([
        api(`/trainer/clients/${clientId}/${seg}/${planId}`),
        api(`/trainer/clients/${clientId}/${seg}/${planId}/checkins`).catch(() => []),
        api(`/trainer/clients/${clientId}/intake-profile`).catch(() => null),
        kind === 'diet'
          ? api(`/trainer/clients/${clientId}/diet-monitoring?days=7`).catch(() => null)
          : Promise.resolve(null),
        kind === 'diet'
          ? api(`/trainer/clients/${clientId}/diet-notes`).catch(() => [])
          : Promise.resolve([]),
        kind === 'diet'
          ? api(`/trainer/clients/${clientId}/nutrition-targets`).catch(() => null)
          : Promise.resolve(null),
      ]);
      setPlan(p);
      setCheckins(cis);
      setMonitoring(mon);
      setNotes(noteRows || []);
      setTargetsData(tgts);
      // BUGFIX: this previously referenced an undefined `profile`, throwing
      // inside the try and surfacing "Could not load plan" on every open
      setClientProfile(prof && prof.completed_at ? prof : null);
      navigation.setOptions({ title: p.name || 'Plan' });
    } catch (e) {
      Alert.alert('Could not load plan', e.message || 'Please try again.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    }
  }, [clientId, seg, planId, navigation, kind]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const openDay = async (date) => {
    try {
      const entries = await api(
        `/trainer/clients/${clientId}/diet-food-log?from=${date}&to=${date}${monitoring?.plan_id ? `&plan_id=${monitoring.plan_id}` : ''}`
      );
      setDayDetail({ date, entries: entries || [] });
    } catch {
      Alert.alert('Could not load day', 'Please try again.');
    }
  };

  const sendNote = async () => {
    if (!note.trim() || noteBusy) return;
    setNoteBusy(true);
    try {
      await api(`/trainer/clients/${clientId}/diet-notes`, {
        method: 'POST',
        body: { note: note.trim(), plan_id: planId },
      });
      setNote('');
      const rows = await api(`/trainer/clients/${clientId}/diet-notes`).catch(() => []);
      setNotes(rows || []);
    } catch (e) {
      Alert.alert('Could not send note', e.message || 'Please try again.');
    } finally {
      setNoteBusy(false);
    }
  };

  const reloadTargets = async () => {
    const t = await api(`/trainer/clients/${clientId}/nutrition-targets`).catch(() => null);
    setTargetsData(t);
  };

  const useRecommendation = async () => {
    setTargetsBusy(true);
    try {
      await api(`/trainer/clients/${clientId}/nutrition-targets/use-recommendation`, { method: 'POST' });
      await reloadTargets();
      setOverrideOpen(false);
    } catch (e) {
      Alert.alert('Could not apply recommendation', e.message || 'Please try again.');
    } finally {
      setTargetsBusy(false);
    }
  };

  const saveOverride = async () => {
    if (targetsBusy) return;
    const f = overrideForm;
    const calories = Number(f.cal);
    if (!calories || calories < 1000 || calories > 6000) {
      return Alert.alert('Invalid calories', 'Enter a calorie target between 1000 and 6000.');
    }
    const macros = [f.pro, f.car, f.fat].map((v) => Number(v));
    if (macros.some((v) => !isFinite(v) || v < 0 || v > 1000)) {
      return Alert.alert('Invalid macros', 'Protein, carbs and fat must be between 0 and 1000 g.');
    }
    setTargetsBusy(true);
    try {
      await api(`/trainer/clients/${clientId}/nutrition-targets/override`, {
        method: 'POST',
        body: {
          calories,
          protein_g: macros[0],
          carbs_g: macros[1],
          fat_g: macros[2],
          note: overrideNote.trim() || null,
        },
      });
      await reloadTargets();
      setOverrideOpen(false);
      setOverrideNote('');
    } catch (e) {
      Alert.alert('Could not save targets', e.message || 'Please try again.');
    } finally {
      setTargetsBusy(false);
    }
  };


  // every client allergen present ANYWHERE in the plan — drives the
  // persistent banner on this trainer read-only view
  const planConflicts = React.useMemo(() => {
    if (kind !== 'diet' || !clientProfile || !plan) return [];
    const seen = new Set();
    const found = [];
    for (const d of plan.days || []) {
      for (const m of d.meals || []) {
        for (const it of m.items || []) {
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
  }, [kind, clientProfile, plan]);

  const confirmArchive = () =>
    Alert.alert(
      'Archive plan',
      `"${plan.name}" will be removed from ${clientName || 'your client'}'s active plans.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await api(`/trainer/clients/${clientId}/${seg}/${planId}`, {
                method: 'PATCH',
                body: { status: 'archived' },
              });
              navigation.goBack();
            } catch (e) {
              Alert.alert('Could not archive', e.message || 'Please try again.');
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );

  if (!plan) {
    return (
      <View style={[styles.container, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const doneCol = kind === 'diet' ? 'followed' : 'taken';
  const byDay = new Map(checkins.map((c) => [c.date.slice(0, 10), c[doneCol]]));
  const days = Array.from({ length: 28 }, (_, i) => {
    const d = new Date(Date.now() - (27 - i) * 86400000);
    const key = d.toISOString().slice(0, 10);
    return { key, day: d.getDate(), state: byDay.has(key) ? (byDay.get(key) ? 'yes' : 'no') : 'none' };
  });
  const followed = days.filter((d) => d.state === 'yes').length;
  const checkedIn = days.filter((d) => d.state !== 'none').length;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      <Text style={styles.name}>{plan.name}</Text>
      <Text style={styles.sub}>
        {kind === 'diet' ? 'Diet' : 'Supplement'} plan for {clientName || 'client'} ·{' '}
        {new Date(plan.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
      </Text>
      {plan.notes ? <Text style={styles.notes}>{plan.notes}</Text> : null}


      {planConflicts.length > 0 && (
        <View style={styles.allergenBanner}>
          <Ionicons name="warning" size={15} color={colors.red} />
          <Text style={styles.allergenBannerText}>
            Contains items with {clientName || 'client'}'s allergens: {planConflicts.join(', ')}
          </Text>
        </View>
      )}

      {kind === 'diet' && clientProfile && (clientProfile.goals?.length || clientProfile.injuries || clientProfile.medical_conditions) && (
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

      {/* Diet renders the nested day → meal → item chart; supplements flat */}
      {kind === 'diet'
        ? (plan.days || []).map((d, di) => (
            <View key={d.id || di}>
              <Text style={[styles.groupLabel, { marginTop: di === 0 ? 8 : 16 }]}>{d.day_label}</Text>
              {(d.meals || []).map((m, mi) => (
                <View key={m.id || mi} style={styles.card}>
                  <Text style={styles.mealTypeLabel}>{String(m.meal_type).toUpperCase()}</Text>
                  {m.slot_note ? <Text style={styles.itemDesc}>{m.slot_note}</Text> : null}
                  {(m.items || []).map((it, ii) => (
                    <View key={it.id || ii} style={styles.nestedItem}>
                      <Text style={styles.itemTitle} numberOfLines={1}>
                        {it.name}
                        {(it.quantity_multiplier || 1) !== 1 ? ` · ${it.quantity_multiplier}x` : ''}
                      </Text>
                      <Text style={styles.itemDesc}>
                        {it.calories != null ? `${it.calories} cal` : ''}
                        {it.protein_g != null ? ` · ${Math.round(it.protein_g)}P` : ''}
                        {it.carbs_g != null ? ` ${Math.round(it.carbs_g)}C` : ''}
                        {it.fat_g != null ? ` ${Math.round(it.fat_g)}F` : ''}
                      </Text>
                      {it.client_note ? (
                        <Text style={styles.clientNote}>Note: {it.client_note}</Text>
                      ) : null}
                    </View>
                  ))}
                </View>
              ))}
            </View>
          ))
        : (plan.items || []).map((item, i) => (
            <View key={item.id || i} style={styles.card}>
              <View style={styles.rowHeader}>
                <View style={styles.idxBadge}>
                  <Text style={styles.idxText}>{i + 1}</Text>
                </View>
                <Text style={styles.itemTitle}>{item.supplement_name}</Text>
                {item.dosage ? (
                  <View style={styles.doseChip}>
                    <Text style={styles.doseText}>{item.dosage}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.itemDesc}>
                {[item.timing, item.notes].filter(Boolean).join(' · ')}
              </Text>
            </View>
          ))}

      {/* Recent substitutions — date-scoped dish swaps the client logged
          while following THIS assigned plan (self-authored swaps are never
          visible here). Same adherence-signal purpose as workout swaps:
          constant substitution of one dish means change the plan. */}
      {kind === 'diet' && (plan.recent_swaps || []).length > 0 && (
        <View style={styles.card}>
          <Text style={styles.groupLabel}>Recent substitutions</Text>
          {plan.recent_swaps.map((s) => (
            <View key={s.id} style={styles.swapRow}>
              <Ionicons name="swap-horizontal" size={12} color={colors.blue} />
              <Text style={styles.swapText} numberOfLines={1}>
                {new Date(`${String(s.swap_date).slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, {
                  weekday: 'short', month: 'short', day: 'numeric',
                })}
                : {s.original_name} → {s.swapped_name}
              </Text>
            </View>
          ))}
        </View>
      )}

      {/* DIET — exception-first monitoring: status, prioritized alerts, and
          a 7-day OUTCOME strip (target outcome is the primary daily
          indicator; plan follow-through is secondary). Supplements keep the
          simple check-in strip below. */}
      {kind === 'diet' && monitoring ? (
        <View style={styles.card}>
          <Text style={styles.groupLabel}>This week</Text>
          {(() => {
            const m = monitoring;
            const hasIssue = (m.alerts || []).some((a) => a.level !== 'info');
            const statusColor = hasIssue ? colors.red : colors.green;
            const statusIcon = hasIssue ? 'warning' : 'checkmark-circle';
            const statusText = !m.has_plan
              ? 'No assigned diet plan'
              : hasIssue
              ? 'Needs attention'
              : 'No major issues';
            return (
              <>
                <View style={styles.statusRow}>
                  <Ionicons name={statusIcon} size={16} color={statusColor} />
                  <Text style={[styles.statusText, { color: statusColor }]}>{statusText}</Text>
                </View>
                <View style={styles.weekGrid}>
                  <View style={styles.weekCell}>
                    <Text style={[styles.weekVal, NUMS]}>{m.metrics.daysOnTarget} / {m.metrics.daysTracked || '–'}</Text>
                    <Text style={styles.weekLabel}>Target hit</Text>
                  </View>
                  <View style={styles.weekCell}>
                    <Text style={[styles.weekVal, NUMS]}>{m.metrics.daysTracked} / 7</Text>
                    <Text style={styles.weekLabel}>Food logged</Text>
                  </View>
                  <View style={styles.weekCell}>
                    <Text style={[styles.weekVal, NUMS]}>{m.metrics.planFollowedDays} / 7</Text>
                    <Text style={styles.weekLabel}>Plan followed</Text>
                  </View>
                  <View style={styles.weekCell}>
                    <Text style={[styles.weekVal, NUMS]}>
                      {m.avgCalories != null ? m.avgCalories.toLocaleString() : '–'}
                      {m.avgCaloriesTarget ? ` / ${m.avgCaloriesTarget.toLocaleString()}` : ''}
                    </Text>
                    <Text style={styles.weekLabel}>Avg calories</Text>
                  </View>
                </View>

                {/* prioritized alerts — high first, then medium, informational */}
                {(m.alerts || []).length > 0 && (
                  <View style={styles.alertsWrap}>
                    {m.alerts.map((a) => (
                      <View key={a.key} style={[styles.alertRow, a.level === 'high' && styles.alertHigh, a.level === 'medium' && styles.alertMedium]}>
                        <Ionicons
                          name={a.level === 'info' ? 'information-circle' : 'warning'}
                          size={13}
                          color={a.level === 'info' ? colors.blue : a.level === 'medium' ? colors.orange : colors.red}
                        />
                        <Text style={styles.alertText}>{a.message}</Text>
                      </View>
                    ))}
                  </View>
                )}

                {/* 7-day outcome strip — tap a day for its diary */}
                <View style={styles.outcomeStrip}>
                  {m.days.map((d) => {
                    const colorKey = STATUS_COLORS[d.status] || 'cardLight';
                    const meta = STATUS_META[d.status === 'simple_followed' ? 'on_target' : d.status === 'simple_missed' ? 'under_target' : d.status] || STATUS_META.not_logged;
                    return (
                      <TouchableOpacity key={d.date} style={styles.outcomeCell} onPress={() => openDay(d.date)}>
                        <Text style={styles.outcomeDow}>
                          {new Date(`${d.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' })}
                        </Text>
                        <View style={[styles.outcomeDot, { backgroundColor: colors[colorKey] || colors.cardLight }]}>
                          <Text style={[styles.outcomeDotText, d.status === 'not_logged' && { color: colors.textDim }]}>
                            {d.status === 'not_logged' ? '—' : meta.symbol}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={styles.outcomeLegend}>
                  {m.metrics.daysTracked} / 7 days tracked ·{' '}
                  {m.metrics.daysUnder} under · {m.metrics.daysOver} over
                </Text>
              </>
            );
          })()}
        </View>
      ) : null}

      {/* adherence strip (supplements) — neutral for days with no check-in */}
      {kind !== 'diet' && (
      <View style={styles.card}>
        <Text style={styles.groupLabel}>Adherence — last 4 weeks</Text>
        <View style={styles.stripRow}>
          {days.map((d) => (
            <View
              key={d.key}
              style={[
                styles.stripCell,
                d.state === 'yes' && styles.stripYes,
                d.state === 'no' && styles.stripNo,
              ]}
            >
              <Text style={[styles.stripText, d.state === 'none' && { color: colors.textDim }]}>{d.day}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.stripLegend}>
          {followed} / {checkedIn} check-in days followed · grey = no check-in
        </Text>
      </View>
      )}

      {/* Nutrition targets: active (with source) vs app recommendation —
          the trainer accepts the recommendation by default and overrides
          only when necessary (§5–§9) */}
      {kind === 'diet' && targetsData && (
        <View style={styles.card}>
          <Text style={styles.groupLabel}>Nutrition targets</Text>
          {targetsData.active ? (
            <Text style={[styles.targetActiveLine, NUMS]}>
              {`${Number(targetsData.active.calories).toLocaleString()} kcal/day · `}
              <Text style={{ fontWeight: '800', color: targetsData.active.target_source === 'trainer_override' ? colors.blue : colors.green }}>
                {targetsData.active.target_source === 'trainer_override' ? 'Trainer target' : 'Automatically calculated'}
              </Text>
            </Text>
          ) : (
            <Text style={styles.targetActiveLine}>No nutrition targets set yet.</Text>
          )}

          <View style={styles.recoBlock}>
            <Text style={styles.recoBlockLabel}>Recommended by app</Text>
            {targetsData.profile_complete && targetsData.recommendation ? (
              <Text style={[styles.recoBlockValue, NUMS]}>
                {`${targetsData.recommendation.calories.toLocaleString()} kcal · ${targetsData.recommendation.protein_g}P · ${targetsData.recommendation.carbs_g}C · ${targetsData.recommendation.fat_g}F`}
              </Text>
            ) : (
              <Text style={styles.recoBlockValue}>Client profile incomplete — no recommendation.</Text>
            )}
          </View>

          {targetsData.recommendation_drift && (
            <View style={[styles.alertRow, styles.alertMedium]}>
              <Ionicons name="information-circle" size={13} color={colors.orange} />
              <Text style={styles.alertText}>
                Client profile changed — the new recommendation differs from the current target.
              </Text>
            </View>
          )}
          {targetsData.active?.override_note ? (
            <Text style={styles.overrideNote}>“{targetsData.active.override_note}”</Text>
          ) : null}

          {overrideOpen ? (
            <View style={{ marginTop: 10 }}>
              <View style={styles.overrideRow}>
                {[
                  ['cal', 'Cal'],
                  ['pro', 'P (g)'],
                  ['car', 'C (g)'],
                  ['fat', 'F (g)'],
                ].map(([k, label]) => (
                  <View key={k} style={styles.overrideCell}>
                    <Text style={styles.overrideLabel}>{label}</Text>
                    <TextInput
                      style={[styles.overrideInput, NUMS]}
                      keyboardType="numeric"
                      value={overrideForm[k]}
                      onChangeText={(v) => setOverrideForm((f) => ({ ...f, [k]: v.replace(/[^0-9.]/g, '') }))}
                      placeholder="—"
                      placeholderTextColor={colors.textDim}
                    />
                  </View>
                ))}
              </View>
              <TextInput
                style={styles.overrideNoteInput}
                placeholder="Reason (optional) — e.g. Reduced calories for the next 2 weeks"
                placeholderTextColor={colors.textDim}
                value={overrideNote}
                onChangeText={setOverrideNote}
                multiline
              />
              <TouchableOpacity style={styles.targetBtn} onPress={saveOverride} disabled={targetsBusy}>
                <Text style={styles.targetBtnText}>{targetsBusy ? 'Saving…' : 'Save Custom Targets'}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.targetSecondaryBtn} onPress={() => setOverrideOpen(false)}>
                <Text style={styles.targetSecondaryText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.targetActionsRow}>
              <TouchableOpacity
                style={[styles.targetBtn, { flex: 1 }]}
                onPress={useRecommendation}
                disabled={targetsBusy || !targetsData.profile_complete}
              >
                <Text style={styles.targetBtnText}>Use App Recommendation</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.targetSecondaryBtn}
                onPress={() => {
                  // prefill from the active target or the recommendation
                  const src = targetsData.active || targetsData.recommendation;
                  setOverrideForm({
                    cal: src?.calories != null ? String(src.calories) : '',
                    pro: src?.protein_g != null ? String(src.protein_g) : '',
                    car: src?.carbs_g != null ? String(src.carbs_g) : '',
                    fat: src?.fat_g != null ? String(src.fat_g) : '',
                  });
                  setOverrideOpen(true);
                }}
              >
                <Text style={styles.targetSecondaryText}>Set Custom Targets</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      )}

      {/* trainer note — lightweight, one-way, client-visible */}
      {kind === 'diet' && (
        <View style={styles.card}>
          <Text style={styles.groupLabel}>Trainer note</Text>
          <TextInput
            style={styles.noteInput}
            placeholder="e.g. Try adding the afternoon snack from your plan tomorrow."
            placeholderTextColor={colors.textDim}
            value={note}
            onChangeText={setNote}
            multiline
          />
          <TouchableOpacity style={styles.noteSendBtn} onPress={sendNote} disabled={noteBusy || !note.trim()}>
            <Ionicons name="paper-plane-outline" size={13} color={note.trim() ? colors.primary : colors.textDim} />
            <Text style={[styles.noteSendText, { color: note.trim() ? colors.primary : colors.textDim }]}>
              {noteBusy ? 'Sending…' : 'Send note to client'}
            </Text>
          </TouchableOpacity>
          {notes.length > 0 && (
            <View style={{ marginTop: 8 }}>
              {notes.slice(0, 5).map((n) => (
                <View key={n.id} style={styles.noteHistoryRow}>
                  <Text style={styles.noteHistoryText} numberOfLines={2}>“{n.note}”</Text>
                  <Text style={styles.noteHistoryMeta}>
                    {new Date(n.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    {n.read_at ? ' · read' : ''}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      {/* trainer day detail — read-only food diary for one date */}
      <Modal visible={!!dayDetail} transparent animationType="slide" onRequestClose={() => setDayDetail(null)}>
        <View style={styles.dayWrap}>
          <View style={styles.daySheet}>
            <View style={styles.dayHeaderRow}>
              <Text style={styles.dayTitle}>
                {clientName || 'Client'} ·{' '}
                {dayDetail ? new Date(`${dayDetail.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : ''}
              </Text>
              <TouchableOpacity hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} onPress={() => setDayDetail(null)}>
                <Ionicons name="close" size={20} color={colors.text} />
              </TouchableOpacity>
            </View>
            {dayDetail && (
              <ScrollView style={{ flex: 1 }}>
                {dayDetail.entries.length === 0 ? (
                  <Text style={styles.dayEmpty}>No food logged this day.</Text>
                ) : (
                  dayDetail.entries.map((e) => (
                    <View key={e.id} style={styles.dayEntryRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.dayEntryName}>{e.name}</Text>
                        <Text style={[styles.dayEntryMeta, NUMS]}>
                          {[
                            String(e.meal_type || 'Anytime').toUpperCase(),
                            e.calories != null ? `${Math.round(e.calories)} kcal` : null,
                            e.protein_g != null ? `${Math.round(e.protein_g)}P` : null,
                            e.quantity && e.quantity !== 1 ? `${e.quantity}x` : null,
                            e.source === 'planned' ? 'As planned' : e.source === 'swapped' ? 'Swapped' : e.source === 'extra' ? 'Added' : 'Logged manually',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </Text>
                      </View>
                    </View>
                  ))
                )}
                <Text style={styles.dayReadonly}>Read-only — the client owns this diary.</Text>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      <TouchableOpacity style={styles.archiveBtn} onPress={confirmArchive} disabled={busy}>
        <Ionicons name="archive-outline" size={16} color={colors.red} />
        <Text style={styles.archiveText}>Archive Plan</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    name: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.4 },
    sub: { color: colors.textDim, marginTop: 4, fontSize: 13 },
    notes: { color: colors.textDim, marginTop: 8, marginBottom: 8, fontSize: 13, fontStyle: 'italic' },

    allergenBanner: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      borderWidth: 1.5, borderColor: colors.red, borderRadius: 12,
      paddingHorizontal: 12, paddingVertical: 10, marginTop: 12, marginBottom: 4,
    },
    allergenBannerText: { color: colors.red, fontSize: 13, fontWeight: '700', flex: 1 },
    ctxCard: {
      backgroundColor: colors.cardLight, borderRadius: 12,
      borderWidth: 1, borderColor: colors.border,
      paddingHorizontal: 12, paddingVertical: 10, marginTop: 12,
    },
    ctxHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    ctxTitle: { color: colors.text, fontWeight: '800', fontSize: 13 },
    ctxBody: { marginTop: 8, gap: 4 },
    ctxLine: { color: colors.text, fontSize: 12, lineHeight: 17 },
    ctxLabel: { color: colors.textDim, fontWeight: '700' },

    groupLabel: {
      color: colors.textDim, fontSize: 12, fontWeight: '800',
      letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10, marginTop: 8,
    },
    card: {
      backgroundColor: colors.card, borderRadius: 14, padding: 12, marginBottom: 8,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    idxBadge: {
      width: 26, height: 26, borderRadius: 8, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    idxText: { color: colors.primary, fontWeight: '800', fontSize: 12 },
    itemTitle: { color: colors.text, fontWeight: '700', fontSize: 15, flex: 1 },
    doseChip: {
      backgroundColor: colors.cardLight, borderRadius: 8,
      paddingHorizontal: 8, paddingVertical: 4,
    },
    doseText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
    itemDesc: { color: colors.textDim, fontSize: 13, marginTop: 6 },
    mealTypeLabel: { color: colors.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 6 },
    nestedItem: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 8, paddingTop: 8 },
    clientNote: { color: colors.yellow, fontSize: 11, fontStyle: 'italic', marginTop: 3 },
    swapRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 4 },
    swapText: { color: colors.text, fontSize: 12, flex: 1 },

    stripRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
    stripCell: {
      width: 28, height: 28, borderRadius: 8, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    stripYes: { backgroundColor: colors.green },
    stripNo: { backgroundColor: colors.red, opacity: 0.75 },
    stripText: { color: '#fff', fontSize: 10, fontWeight: '700' },
    stripLegend: { color: colors.textDim, fontSize: 11, marginTop: 10 },

    // monitoring
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 10 },
    statusText: { fontSize: 15, fontWeight: '800' },
    weekGrid: { flexDirection: 'row', gap: 6 },
    weekCell: { flex: 1, backgroundColor: colors.cardLight, borderRadius: 10, padding: 8 },
    weekVal: { color: colors.text, fontSize: 12, fontWeight: '800' },
    weekLabel: { color: colors.textDim, fontSize: 9, marginTop: 2 },
    alertsWrap: { marginTop: 10, gap: 5 },
    alertRow: {
      flexDirection: 'row', alignItems: 'center', gap: 7,
      borderRadius: 9, paddingHorizontal: 10, paddingVertical: 7,
      borderWidth: 1, borderColor: colors.border,
    },
    alertHigh: { borderColor: colors.red, backgroundColor: colors.card },
    alertMedium: { borderColor: colors.orange },
    alertText: { color: colors.text, fontSize: 12, flex: 1 },
    outcomeStrip: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
    outcomeCell: { alignItems: 'center', gap: 4, flex: 1 },
    outcomeDow: { color: colors.textDim, fontSize: 10, fontWeight: '700' },
    outcomeDot: {
      width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center',
    },
    outcomeDotText: { color: '#fff', fontSize: 12, fontWeight: '800' },
    outcomeLegend: { color: colors.textDim, fontSize: 11, marginTop: 8 },
    targetActiveLine: { color: colors.text, fontSize: 13, marginBottom: 8 },
    recoBlock: {
      backgroundColor: colors.cardLight, borderRadius: 10, padding: 10,
    },
    recoBlockLabel: {
      color: colors.textDim, fontSize: 10, fontWeight: '800',
      textTransform: 'uppercase', letterSpacing: 0.5,
    },
    recoBlockValue: { color: colors.text, fontSize: 13, fontWeight: '700', marginTop: 3 },
    overrideNote: { color: colors.textDim, fontSize: 12, fontStyle: 'italic', marginTop: 8 },
    overrideRow: { flexDirection: 'row', gap: 8 },
    overrideCell: { flex: 1 },
    overrideLabel: { color: colors.textDim, fontSize: 10, marginBottom: 3, textAlign: 'center' },
    overrideInput: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 8,
      paddingHorizontal: 8, paddingVertical: 8, textAlign: 'center', fontSize: 14,
    },
    overrideNoteInput: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 10,
      paddingHorizontal: 11, paddingVertical: 9, minHeight: 48, fontSize: 12,
      marginTop: 8, textAlignVertical: 'top',
    },
    targetActionsRow: { flexDirection: 'row', gap: 8, marginTop: 12, alignItems: 'center' },
    targetBtn: {
      backgroundColor: colors.primary, borderRadius: 11, paddingVertical: 11,
      alignItems: 'center', paddingHorizontal: 12,
    },
    targetBtnText: { color: '#fff', fontWeight: '800', fontSize: 12 },
    targetSecondaryBtn: {
      borderWidth: 1.2, borderColor: colors.border, borderRadius: 11,
      paddingVertical: 11, paddingHorizontal: 12, alignItems: 'center',
    },
    targetSecondaryText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },
    noteInput: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 10,
      paddingHorizontal: 12, paddingVertical: 10, minHeight: 56, fontSize: 13,
      textAlignVertical: 'top',
    },
    noteSendBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      paddingVertical: 10, marginTop: 4,
    },
    noteSendText: { fontWeight: '700', fontSize: 13 },
    noteHistoryRow: {
      borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 7, gap: 2,
    },
    noteHistoryText: { color: colors.text, fontSize: 12, fontStyle: 'italic' },
    noteHistoryMeta: { color: colors.textDim, fontSize: 10 },
    dayWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    daySheet: {
      backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
      padding: 18, height: '70%',
    },
    dayHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    dayTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
    dayEmpty: { color: colors.textDim, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
    dayEntryRow: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.card, borderRadius: 11, padding: 11, marginBottom: 5,
    },
    dayEntryName: { color: colors.text, fontSize: 14, fontWeight: '700' },
    dayEntryMeta: { color: colors.textDim, fontSize: 11, marginTop: 1 },
    dayReadonly: { color: colors.textDim, fontSize: 11, textAlign: 'center', paddingVertical: 14, fontStyle: 'italic' },

    archiveBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      marginTop: 32, paddingVertical: 12, borderRadius: 12, borderWidth: 1,
      borderColor: colors.red, opacity: 0.85,
    },
    archiveText: { color: colors.red, fontWeight: '700', fontSize: 14 },
  });
