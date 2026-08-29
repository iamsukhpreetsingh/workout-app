import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../lib/api';
import { useColors } from '../../../theme';

const NUMS = { fontVariant: ['tabular-nums'] };
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const DIET_COLORS = {
  green: { colorKey: 'green', symbol: '✓', label: 'Target Hit' },
  yellow: { colorKey: 'yellow', symbol: '!', label: 'Needs Attention' },
  red: { colorKey: 'red', symbol: '×', label: 'Target Missed' },
  not_logged: { colorKey: 'cardLight', symbol: '—', label: 'Not Logged' },
  in_progress: { colorKey: 'blue', symbol: '◐', label: 'In Progress (today)' },
  no_target: { colorKey: 'textDim', symbol: '·', label: 'No target configured' },
};

// GitHub-style consistency maps for the trainer Overview (diet + workout).
// COLOR = NUTRITION OUTCOME, never plan adherence — a day the client hits
// calories AND configured macros with completely different foods is GREEN.
// Grey = not logged ("I don't know"), never red. Today logged shows as
// in-progress, never a premature failure. Workouts: this app has no
// date-scheduled plans, so a day is GREEN (session completed) or GREY
// (rest/no session) — a "missed" state is never fabricated.
//
// Maps are visual exception detectors: tap a day → compact summary panel →
// deep-link into the Diet/Workouts tab for the full detail.
export default function ActivityMapsCard({ clientId, clientName, onFocusDay }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [map, setMap] = useState(null);
  const [sel, setSel] = useState(null); // selected day row

  useEffect(() => {
    let mounted = true;
    api(`/trainer/clients/${clientId}/activity-map?weeks=12`)
      .then((m) => mounted && setMap(m))
      .catch(() => {});
    return () => { mounted = false; };
  }, [clientId]);

  // grid columns: weeks of 7 (Mon-start), oldest → newest, leading pad
  const weeks = useMemo(() => {
    if (!map?.days?.length) return [];
    const cols = [];
    let col = new Array(DOW.length).fill(null);
    for (const day of map.days) {
      const idx = (new Date(`${day.date}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
      col[idx] = day;
      if (idx === 6) { cols.push(col); col = new Array(DOW.length).fill(null); }
    }
    if (col.some(Boolean)) cols.push(col);
    return cols;
  }, [map]);

  const renderGrid = (colorOf, onSelect, selectedDate) => (
    <View style={styles.gridWrap}>
      <View style={styles.dowCol}>
        {DOW.map((d) => (
          <Text key={d} style={styles.dowLabel}>{d[0]}</Text>
        ))}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        {weeks.map((col, ci) => (
          <View key={ci} style={styles.weekCol}>
            {col.map((day, ri) => {
              if (!day) return <View key={ri} style={styles.cell} />;
              const c = colorOf(day);
              const on = selectedDate === day.date;
              return (
                <TouchableOpacity
                  key={ri}
                  style={[styles.cell, { backgroundColor: colors[c.colorKey] || colors.cardLight }, on && styles.cellOn]}
                  onPress={() => onSelect(day)}
                >
                  <Text style={[styles.cellSymbol, { color: c.colorKey === 'cardLight' ? colors.textDim : '#fff' }]}>
                    {c.symbol}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  );

  const dietColorOf = (day) => DIET_COLORS[day.dietColor] || DIET_COLORS.not_logged;
  const workoutColorOf = (day) =>
    day.workoutSessions > 0
      ? { colorKey: 'green', symbol: '✓', label: 'Workout Completed' }
      : { colorKey: 'cardLight', symbol: '—', label: 'Rest / No Session' };

  if (!map) return null; // silently absent when the endpoint/data is unavailable

  const selDiet = sel ? map.days.find((d) => d.date === sel) : null;

  return (
    <View style={styles.card}>
      {/* THIS WEEK summary (§42) — the 5-second read before the maps */}
      <Text style={styles.title}>{clientName || 'Client'} — Consistency</Text>
      <View style={styles.weekRowWrap}>
        <View style={styles.weekStat}>
          <Text style={[styles.weekVal, NUMS]}>{map.week.dietGreen} / {map.week.dietLogged || 0}</Text>
          <Text style={styles.weekLabel}>logged days on target</Text>
        </View>
        <View style={styles.weekStat}>
          <Text style={[styles.weekVal, NUMS]}>{map.week.workoutSessions}</Text>
          <Text style={styles.weekLabel}>workouts this week</Text>
        </View>
        <View style={styles.weekStat}>
          <Text style={[styles.weekVal, NUMS]}>{map.streaks.logging}</Text>
          <Text style={styles.weekLabel}>logging streak</Text>
        </View>
        <View style={styles.weekStat}>
          <Text style={[styles.weekVal, NUMS]}>{map.streaks.target}</Text>
          <Text style={styles.weekLabel}>target streak</Text>
        </View>
      </View>

      {/* attention — exceptions first (§28) */}
      {map.attention.length > 0 && (
        <View style={styles.attentionBox}>
          {map.attention.map((a, i) => (
            <View key={i} style={styles.attentionRow}>
              <Ionicons
                name={a.level === 'red' ? 'warning' : 'information-circle'}
                size={12}
                color={a.level === 'red' ? colors.red : colors.orange}
              />
              <Text style={styles.attentionText}>{a.text}</Text>
            </View>
          ))}
        </View>
      )}

      {/* DIET MAP */}
      <Text style={styles.mapTitle}>DIET — LAST 12 WEEKS</Text>
      {renderGrid(dietColorOf, (day) => setSel(day.date), sel)}
      <View style={styles.legendRow}>
        {['green', 'yellow', 'red', 'not_logged', 'in_progress'].map((k) => (
          <View key={k} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: colors[DIET_COLORS[k].colorKey] || colors.cardLight }]} />
            <Text style={styles.legendText}>{DIET_COLORS[k].label}</Text>
          </View>
        ))}
      </View>

      {/* diet day detail panel */}
      {selDiet && (
        <View style={styles.detailPanel}>
          <Text style={[styles.detailDate, NUMS]}>{selDiet.date} {selDiet.isToday ? '· Today' : ''}</Text>
          <Text style={styles.detailStatus}>
            {dietColorOf(selDiet).symbol} {dietColorOf(selDiet).label}
          </Text>
          {selDiet.dietLogged ? (
            <>
              <Text style={[styles.detailLine, NUMS]}>
                Calories: {selDiet.calories.toLocaleString()}{selDiet.caloriesTarget ? ` / ${Number(selDiet.caloriesTarget).toLocaleString()}` : ''}
              </Text>
              <Text style={[styles.detailLine, NUMS]}>
                Protein: {selDiet.protein_g}{selDiet.proteinTarget ? ` / ${selDiet.proteinTarget}g` : ''} ·{' '}
                Carbs: {selDiet.carbs_g}{selDiet.carbsTarget ? ` / ${selDiet.carbsTarget}g` : ''} ·{' '}
                Fat: {selDiet.fat_g}{selDiet.fatTarget ? ` / ${selDiet.fatTarget}g` : ''}
              </Text>
              {selDiet.planFollowed && selDiet.planFollowed.total > 0 && (
                <Text style={styles.detailDim}>
                  Plan: {selDiet.planFollowed.completed} / {selDiet.planFollowed.total} items used
                  {selDiet.dietColor === 'green' && selDiet.planFollowed.completed < selDiet.planFollowed.total
                    ? ' — reached targets with different foods.' : ''}
                </Text>
              )}
              <TouchableOpacity style={styles.viewBtn} onPress={() => onFocusDay?.(selDiet.date, 'diet')}>
                <Text style={styles.viewBtnText}>View Diet →</Text>
              </TouchableOpacity>
            </>
          ) : (
            <Text style={styles.detailDim}>No food was logged this day.</Text>
          )}
        </View>
      )}

      {/* WORKOUT MAP — sessions are all-or-nothing in this app and plans are
          not date-scheduled: green = trained that day, grey = rest/no data */}
      <Text style={styles.mapTitle}>WORKOUT — LAST 12 WEEKS</Text>
      {renderGrid(workoutColorOf, (day) => setSel(day.date), sel)}
      <View style={styles.legendRow}>
        {[
          { k: 'green', label: 'Workout Completed' },
          { k: 'grey', label: 'Rest / No Session' },
        ].map((l) => (
          <View key={l.k} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: colors[l.colorKey] }]} />
            <Text style={styles.legendText}>{l.label}</Text>
          </View>
        ))}
      </View>

      {sel && (() => {
        const d = map.days.find((x) => x.date === sel);
        if (!d) return null;
        return (
          <View style={styles.detailPanel}>
            <Text style={[styles.detailDate, NUMS]}>{d.date} {d.isToday ? '· Today' : ''}</Text>
            {d.workoutSessions > 0 ? (
              <>
                <Text style={styles.detailStatus}>✓ Workout Completed</Text>
                {d.workoutName ? <Text style={styles.detailLine}>{d.workoutName}</Text> : null}
                <Text style={[styles.detailLine, NUMS]}>
                  {[`${d.workoutSessions} session${d.workoutSessions > 1 ? 's' : ''}`,
                    d.workoutExercises ? `${d.workoutExercises} exercises` : null,
                    d.workoutMinutes ? `${d.workoutMinutes} min` : null,
                    d.workoutVolume ? `${d.workoutVolume.toLocaleString()} kg volume` : null]
                    .filter(Boolean).join(' · ')}
                </Text>
                <TouchableOpacity style={styles.viewBtn} onPress={() => onFocusDay?.(d.date, 'workouts')}>
                  <Text style={styles.viewBtnText}>View Workouts →</Text>
                </TouchableOpacity>
              </>
            ) : (
              <Text style={styles.detailDim}>No workout this day.</Text>
            )}
          </View>
        );
      })()}
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
    title: { color: colors.text, fontSize: 15, fontWeight: '800' },
    weekRowWrap: { flexDirection: 'row', gap: 6, marginTop: 10 },
    weekStat: { flex: 1, backgroundColor: colors.cardLight, borderRadius: 10, padding: 8 },
    weekVal: { color: colors.text, fontSize: 13, fontWeight: '800' },
    weekLabel: { color: colors.textDim, fontSize: 9, marginTop: 2 },
    attentionBox: { marginTop: 10, gap: 4 },
    attentionRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    attentionText: { color: colors.text, fontSize: 12, flex: 1 },
    mapTitle: {
      color: colors.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 1,
      marginTop: 14, marginBottom: 6,
    },
    gridWrap: { flexDirection: 'row', gap: 4 },
    dowCol: { justifyContent: 'space-between', height: 7 * 17 },
    dowLabel: { color: colors.textDim, fontSize: 8, fontWeight: '700', lineHeight: 17 },
    weekCol: { gap: 3 },
    cell: {
      width: 14, height: 14, borderRadius: 3, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    cellOn: { borderWidth: 1.5, borderColor: colors.text },
    cellSymbol: { fontSize: 8, fontWeight: '800' },
    legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
    legendItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    legendDot: { width: 8, height: 8, borderRadius: 2 },
    legendText: { color: colors.textDim, fontSize: 9 },
    detailPanel: {
      marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border,
    },
    detailDate: { color: colors.textDim, fontSize: 11, fontWeight: '700' },
    detailStatus: { color: colors.text, fontSize: 13, fontWeight: '800', marginTop: 2 },
    detailLine: { color: colors.text, fontSize: 12, marginTop: 3 },
    detailDim: { color: colors.textDim, fontSize: 11, marginTop: 4, fontStyle: 'italic' },
    viewBtn: { alignSelf: 'flex-start', marginTop: 8, paddingVertical: 6, paddingHorizontal: 10,
      borderWidth: 1.2, borderColor: colors.primary, borderRadius: 9 },
    viewBtnText: { color: colors.primary, fontWeight: '800', fontSize: 11 },
  });
