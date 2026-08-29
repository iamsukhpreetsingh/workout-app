import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../lib/api';
import { useColors } from '../../../theme';
import { todayLocalISO, isFutureDate } from '../../../lib/checkinDates';

const NUMS = { fontVariant: ['tabular-nums'] };

const shiftDateStr = (date, days) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const fmtDate = (date) =>
  new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const STATUS_META = {
  on_target: { label: 'Target Hit', symbol: '✓', colorKey: 'green' },
  under_target: { label: 'Under Target', symbol: '↓', colorKey: 'orange' },
  over_target: { label: 'Over Target', symbol: '↑', colorKey: 'red' },
  not_logged: { label: 'Not Logged', symbol: '—', colorKey: 'textDim' },
};

const MEAL_LABELS = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks', other: 'Other' };

// Trainer nutrition monitoring (Day / Week / Month): current target vs
// actual consumption, remaining/excess, per-macro status, the client's
// actual food log (READ-ONLY — the trainer can never edit it), period
// averages over LOGGED days only, and the missed-target notification
// toggle for this relationship. No compliance percentages anywhere — the
// dominant indicator is always the nutrition target outcome.
export default function NutritionDigestCard({ clientId, clientName, focusDate }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [mode, setMode] = useState('day');
  const [dayDate, setDayDate] = useState(todayLocalISO());
  const [day, setDay] = useState(null);
  const [history, setHistory] = useState(null);
  const [prefs, setPrefs] = useState(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [form, setForm] = useState({ calories: '', protein_g: '', carbs_g: '', fat_g: '', note: '' });
  const [busy, setBusy] = useState(false);

  const load = () => {
    api(`/trainer/clients/${clientId}/nutrition-day?date=${dayDate}`).then(setDay).catch(() => {});
    if (mode !== 'day') {
      api(`/trainer/clients/${clientId}/nutrition-history?mode=${mode}&date=${dayDate}`)
        .then(setHistory)
        .catch(() => {});
    }
    api(`/trainer/clients/${clientId}/nutrition-notifications`)
      .then(setPrefs)
      .catch(() => setPrefs({ target_miss_notifications: false }));
    // prefill the adjust-target form from whatever target is in view
    api(`/trainer/clients/${clientId}/nutrition-targets`)
      .then((t) => {
        if (t?.active) {
          setForm((f) => ({
            ...f,
            calories: String(t.active.calories ?? ''),
            protein_g: String(t.active.protein_g ?? ''),
            carbs_g: String(t.active.carbs_g ?? ''),
            fat_g: String(t.active.fat_g ?? ''),
          }));
        }
      })
      .catch(() => {});
  };

  useEffect(() => { load(); }, [clientId, mode, dayDate]);

  // deep-link from the Overview activity maps: tapping a map day opens the
  // Diet tab focused on that exact date
  useEffect(() => {
    if (focusDate) setDayDate(focusDate);
  }, [focusDate]);

  const saveTarget = async () => {
    if (busy) return;
    const calories = Number(form.calories);
    if (!calories || calories < 1000 || calories > 6000) return;
    setBusy(true);
    try {
      await api(`/trainer/clients/${clientId}/nutrition-targets/override`, {
        method: 'POST',
        body: {
          calories,
          protein_g: Number(form.protein_g) || 0,
          carbs_g: Number(form.carbs_g) || 0,
          fat_g: Number(form.fat_g) || 0,
          note: form.note.trim() || null,
        },
      });
      setAdjustOpen(false);
      setForm((f) => ({ ...f, note: '' }));
      load();
    } catch {}
    setBusy(false);
  };

  const toggleNotifs = async (v) => {
    setPrefs((p) => ({ ...(p || {}), target_miss_notifications: v })); // optimistic
    try {
      await api(`/trainer/clients/${clientId}/nutrition-notifications`, {
        method: 'PUT',
        body: { target_miss_notifications: v },
      });
    } catch {
      setPrefs((p) => ({ ...(p || {}), target_miss_notifications: !v }));
    }
  };

  const statusMeta = (st) => STATUS_META[st] || STATUS_META.not_logged;

  return (
    <View style={styles.card}>
      {/* header + mode segmented control */}
      <View style={styles.headRow}>
        <Text style={styles.title}>{clientName || 'Client'}'s Nutrition</Text>
        <View style={styles.modeRow}>
          {['day', 'week', 'month'].map((m) => (
            <TouchableOpacity key={m} style={[styles.modeBtn, mode === m && styles.modeBtnOn]} onPress={() => setMode(m)}>
              <Text style={[styles.modeText, mode === m && { color: '#fff' }]}>{m[0].toUpperCase() + m.slice(1)}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* ── DAY view (§21): status → kcal/remaining → macros → food log ── */}
      {mode === 'day' && (
        <>
          <View style={styles.dateNav}>
            <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setDayDate(shiftDateStr(dayDate, -1))}>
              <Ionicons name="chevron-back" size={16} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity hitSlop={{ top: 8, bottom: 8 }} onPress={() => setDayDate(todayLocalISO())}>
              <Text style={styles.dateText}>
                {fmtDate(dayDate)}{dayDate === todayLocalISO() ? ' · Today' : ''}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }} onPress={() => setDayDate(shiftDateStr(dayDate, 1))}>
              <Ionicons name="chevron-forward" size={16} color={colors.text} />
            </TouchableOpacity>
          </View>

          {day && (
            day.is_future ? (
              <View style={styles.dayBody}>
                <Text style={[styles.statusLine, { color: colors.textDim }]}>— Future date</Text>
                {day.target?.calories ? (
                  <Text style={[styles.kcalLine, NUMS]}>Target: {Number(day.target.calories).toLocaleString()} kcal</Text>
                ) : null}
                <Text style={styles.dimNote}>Food logging becomes available on this date.</Text>
              </View>
            ) : (
              <View style={styles.dayBody}>
                {(() => {
                  const meta = statusMeta(day.calorieStatus);
                  const color = colors[meta.colorKey] || colors.textDim;
                  return (
                    <>
                      <Text style={[styles.statusLine, { color }]}>
                        {meta.symbol} {meta.label}
                      </Text>
                      <Text style={[styles.kcalLine, NUMS]}>
                        {day.totals.calories.toLocaleString()}
                        {day.target?.calories ? ` / ${Number(day.target.calories).toLocaleString()} kcal` : ' kcal'}
                      </Text>
                      {day.target?.calories ? (
                        <Text style={[styles.remainingLine, NUMS]}>
                          {day.remaining > 0
                            ? `${day.remaining.toLocaleString()} kcal remaining`
                            : day.over > 0
                            ? `${day.over.toLocaleString()} kcal over`
                            : 'Calorie target reached'}
                        </Text>
                      ) : null}
                      {day.macros && ['protein_g', 'carbs_g', 'fat_g'].map((k) => {
                        const m = day.macros[k];
                        if (!m.target) return null;
                        const on = m.status === 'on_target';
                        const label = k === 'protein_g' ? 'Protein' : k === 'carbs_g' ? 'Carbs' : 'Fat';
                        return (
                          <View key={k} style={styles.macroRow}>
                            <Text style={styles.macroName}>{label}</Text>
                            <Text style={[styles.macroVals, NUMS]}>{m.actual} / {m.target}g</Text>
                            <Text style={[styles.macroState, NUMS, { color: on ? colors.green : colors.textDim }]}>
                              {on ? '✓' : m.over > 0 ? `${m.over}g over` : `${m.remaining}g below`}
                            </Text>
                          </View>
                        );
                      })}
                    </>
                  );
                })()}

                {/* the client's ACTUAL food log — read-only */}
                <Text style={styles.sectionLabel}>FOOD LOG</Text>
                {!day.isLogged ? (
                  <Text style={styles.dimNote}>No food was logged for this day.</Text>
                ) : (
                  day.foodLog.map((g) => (
                    <View key={g.meal_type} style={{ marginBottom: 6 }}>
                      <View style={styles.logMealHead}>
                        <Text style={styles.logMeal}>{MEAL_LABELS[g.meal_type]}</Text>
                        <Text style={[styles.logMealKcal, NUMS]}>{g.kcal} cal</Text>
                      </View>
                      {g.entries.map((e) => (
                        <View key={e.id} style={styles.logRow}>
                          <Text style={styles.logName} numberOfLines={1}>
                            {e.name}
                            {e.quantity && Number(e.quantity) !== 1 ? ` (${e.quantity} ${e.serving_unit || ''})` : ''}
                          </Text>
                          <Text style={[styles.logKcal, NUMS]}>{e.calories != null ? e.calories : '—'}</Text>
                        </View>
                      ))}
                    </View>
                  ))
                )}
                <Text style={styles.readonlyNote}>Read-only — the client owns this diary.</Text>
              </View>
            )
          )}
        </>
      )}

      {/* ── WEEK view (§22): achievement + averages + per-day strip ── */}
      {mode === 'week' && history && (
        <View style={styles.dayBody}>
          <Text style={[styles.kcalLine, NUMS]}>
            Target achievement: {history.days_on_target} / {history.days_logged || 0} logged days
          </Text>
          {history.averages?.calories != null && (
            <Text style={[styles.remainingLine, NUMS]}>
              Avg {history.averages.calories.toLocaleString()}
              {history.averages.calories_target ? ` / ${Number(history.averages.calories_target).toLocaleString()} kcal` : ''} / day
              {' · '}P {history.averages.protein_g ?? '—'}
              {history.averages.protein_target ? ` / ${history.averages.protein_target}g` : ''}
            </Text>
          )}
          <Text style={styles.dimNote}>Based on {history.days_logged} logged days{history.total_days ? ` of ${history.total_days}` : ''}.</Text>
          <View style={{ marginTop: 8 }}>
            {history.days.map((d) => {
              const meta = statusMeta(d.status);
              return (
                <TouchableOpacity key={d.date} style={styles.weekRow} onPress={() => { setDayDate(d.date); setMode('day'); }}>
                  <Text style={[styles.weekDow, { flex: 1 }]}>{d.dow}</Text>
                  <Text style={[styles.weekStatus, { color: colors[meta.colorKey] || colors.textDim }]}>
                    {d.isLogged ? `${meta.symbol} ` : ''}{meta.label}
                  </Text>
                  <Text style={[styles.weekKcal, NUMS]}>
                    {d.isLogged ? `${d.calories.toLocaleString()} kcal` : 'Not logged'}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* ── MONTH view (§23): counts + averages, then the daily list ── */}
      {mode === 'month' && history && (
        <View style={styles.dayBody}>
          <Text style={[styles.kcalLine, NUMS]}>
            {history.days_logged} / {history.total_days} days logged
          </Text>
          <Text style={[styles.remainingLine, NUMS]}>
            {history.days_on_target} / {history.days_logged || 0} logged days on target
            {history.achievement_pct != null ? ` (${history.achievement_pct}%)` : ''}
          </Text>
          {history.averages && (
            <View style={{ marginTop: 8 }}>
              <Text style={styles.sectionLabel}>Average daily nutrition</Text>
              <Text style={[styles.averLine, NUMS]}>
                Calories: {history.averages.calories ?? '—'}{history.averages.calories_target ? ` / ${Number(history.averages.calories_target).toLocaleString()}` : ''}
              </Text>
              <Text style={[styles.averLine, NUMS]}>
                Protein: {history.averages.protein_g ?? '—'}{history.averages.protein_target ? ` / ${history.averages.protein_target}g` : ''}
                {'  ·  '}Carbs: {history.averages.carbs_g ?? '—'}{history.averages.carbs_target ? ` / ${history.averages.carbs_target}g` : ''}
                {'  ·  '}Fat: {history.averages.fat_g ?? '—'}{history.averages.fat_target ? ` / ${history.averages.fat_target}g` : ''}
              </Text>
              <Text style={[styles.dimNote, { marginTop: 4 }]}>
                {history.days_under} under · {history.days_over} over · not-logged days excluded from averages
              </Text>
            </View>
          )}
          <View style={{ marginTop: 10 }}>
            {history.days.filter((d) => d.isLogged).map((d) => {
              const meta = statusMeta(d.status);
              return (
                <TouchableOpacity key={d.date} style={styles.weekRow} onPress={() => { setDayDate(d.date); setMode('day'); }}>
                  <Text style={[styles.weekDow, { flex: 1 }]}>{d.date.slice(5)}</Text>
                  <Text style={[styles.weekStatus, { color: colors[meta.colorKey] || colors.textDim }]}>{meta.symbol}</Text>
                  <Text style={[styles.weekKcal, NUMS]}>{d.calories.toLocaleString()} kcal</Text>
                </TouchableOpacity>
              );
            })}
            {history.days.some((d) => !d.isLogged) && (
              <Text style={styles.dimNote}>Not logged: {history.days.filter((d) => !d.isLogged).map((d) => d.date.slice(5)).join(', ')}</Text>
            )}
          </View>
        </View>
      )}

      {/* notification preference — per relationship, default OFF (§14/§18) */}
      <View style={styles.prefRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.prefTitle}>Missed-target notifications</Text>
          <Text style={styles.prefHint}>Notify me when a completed day is outside this client's target.</Text>
        </View>
        <Switch
          value={prefs?.target_miss_notifications === true}
          onValueChange={toggleNotifs}
          trackColor={{ true: colors.primary, false: colors.cardLight }}
        />
      </View>

      {/* coaching lever: override the targets for this client */}
      <View style={styles.actionsRow}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => setAdjustOpen((v) => !v)}>
          <Text style={styles.actionText}>Adjust Target</Text>
        </TouchableOpacity>
      </View>
      {adjustOpen && (
        <View style={styles.adjustBox}>
          <View style={styles.grid}>
            {[['calories', 'Cal'], ['protein_g', 'P (g)'], ['carbs_g', 'C (g)'], ['fat_g', 'F (g)']].map(([k, label]) => (
              <View key={k} style={styles.cell}>
                <Text style={styles.label}>{label}</Text>
                <TextInput
                  style={[styles.input, NUMS]}
                  keyboardType="numeric"
                  value={form[k]}
                  onChangeText={(v) => setForm((f) => ({ ...f, [k]: v.replace(/[^0-9.]/g, '') }))}
                />
              </View>
            ))}
          </View>
          <TextInput
            style={styles.noteInput}
            placeholder="Reason (optional) — e.g. Reduced calories for the next 2 weeks"
            placeholderTextColor={colors.textDim}
            value={form.note}
            onChangeText={(v) => setForm((f) => ({ ...f, note: v }))}
            multiline
          />
          <TouchableOpacity style={styles.saveBtn} onPress={saveTarget} disabled={busy}>
            <Text style={styles.saveText}>{busy ? 'Saving…' : 'Save Trainer Targets'}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14, marginBottom: 12,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 },
    title: { color: colors.text, fontSize: 15, fontWeight: '800', flex: 1 },
    modeRow: { flexDirection: 'row', backgroundColor: colors.cardLight, borderRadius: 9, padding: 2 },
    modeBtn: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 7 },
    modeBtnOn: { backgroundColor: colors.primary },
    modeText: { color: colors.textDim, fontWeight: '800', fontSize: 11 },
    dateNav: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16,
      backgroundColor: colors.cardLight, borderRadius: 10, paddingVertical: 7,
    },
    dateText: { color: colors.text, fontSize: 12, fontWeight: '800' },
    dayBody: { marginTop: 10 },
    statusLine: { fontSize: 14, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, textAlign: 'center' },
    kcalLine: { color: colors.text, fontSize: 20, fontWeight: '800', textAlign: 'center', marginTop: 4 },
    remainingLine: { color: colors.textDim, fontSize: 12, textAlign: 'center', marginTop: 2 },
    macroRow: { flexDirection: 'row', alignItems: 'center', marginTop: 7, gap: 8 },
    macroName: { color: colors.textDim, fontSize: 12, fontWeight: '700', width: 58 },
    macroVals: { color: colors.text, fontSize: 13, fontWeight: '700', flex: 1, textAlign: 'center' },
    macroState: { color: colors.textDim, fontSize: 11, width: 80, textAlign: 'right' },
    sectionLabel: {
      color: colors.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 1,
      marginTop: 14, marginBottom: 4,
    },
    logMealHead: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 },
    logMeal: { color: colors.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
    logMealKcal: { color: colors.textDim, fontSize: 11, fontWeight: '700' },
    logRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.border },
    logName: { color: colors.text, fontSize: 13, flex: 1, marginRight: 8 },
    logKcal: { color: colors.textDim, fontSize: 12 },
    readonlyNote: { color: colors.textDim, fontSize: 10, fontStyle: 'italic', marginTop: 8, textAlign: 'center' },
    dimNote: { color: colors.textDim, fontSize: 12, marginTop: 4 },
    weekRow: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.border,
    },
    weekDow: { color: colors.text, fontSize: 13, fontWeight: '700' },
    weekStatus: { fontSize: 12, fontWeight: '700', width: 100 },
    weekKcal: { color: colors.textDim, fontSize: 12 },
    averLine: { color: colors.text, fontSize: 13, marginTop: 3 },
    prefRow: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      marginTop: 14, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border,
    },
    prefTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
    prefHint: { color: colors.textDim, fontSize: 11, marginTop: 1 },
    actionsRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
    actionBtn: {
      flex: 1, alignItems: 'center', paddingVertical: 10,
      borderRadius: 11, borderWidth: 1.2, borderColor: colors.primary,
    },
    actionText: { color: colors.primary, fontWeight: '800', fontSize: 12 },
    adjustBox: { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 },
    grid: { flexDirection: 'row', gap: 8, marginBottom: 8 },
    cell: { flex: 1 },
    label: { color: colors.textDim, fontSize: 10, marginBottom: 3, textAlign: 'center' },
    input: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 8,
      paddingHorizontal: 6, paddingVertical: 8, textAlign: 'center', fontSize: 13,
    },
    noteInput: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 10,
      paddingHorizontal: 11, paddingVertical: 9, minHeight: 44, fontSize: 12,
      marginBottom: 8, textAlignVertical: 'top',
    },
    saveBtn: { backgroundColor: colors.primary, borderRadius: 11, padding: 12, alignItems: 'center' },
    saveText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  });
