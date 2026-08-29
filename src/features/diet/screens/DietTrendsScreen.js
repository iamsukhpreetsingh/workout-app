import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useColors } from '../../../theme';
import { api } from '../../../lib/api';
import { todayLocalISO } from '../../../lib/checkinDates';
import { listEntriesBetween } from '../../../db/diary';
import { buildTrendSummary } from '../domain/nutritionCore';
import LineChart from '../../../components/LineChart';

const NUMS = { fontVariant: ['tabular-nums'] };
const shiftDateStr = (date, days) => {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

// Trend-based progress (Phase 6): a rolling line over logged days, average
// vs target, and plain-language trend lines. NO pass/fail, NO adherence %.
// Not-logged days are excluded from averages entirely and shown as explicit
// gaps — never as zeros.
export default function DietTrendsScreen() {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [window, setWindow] = useState(7); // 7 or 30 days
  const [days, setDays] = useState([]);
  const [target, setTarget] = useState(null);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      (async () => {
        setLoading(true);
        try {
          const today = todayLocalISO();
          const from = shiftDateStr(today, -(window - 1));
          const entries = await listEntriesBetween(from, today);
          const byDate = new Map();
          for (const e of entries) {
            const cur = byDate.get(e.log_date) || { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
            cur.calories += Number(e.calories) || 0;
            cur.protein_g += Number(e.protein_g) || 0;
            cur.carbs_g += Number(e.carbs_g) || 0;
            cur.fat_g += Number(e.fat_g) || 0;
            byDate.set(e.log_date, cur);
          }
          const rows = [];
          for (let i = window - 1; i >= 0; i--) {
            const d = new Date(`${today}T12:00:00`);
            d.setDate(d.getDate() - i);
            const date = d.toISOString().slice(0, 10);
            const t = byDate.get(date);
            rows.push({
              date,
              dow: d.toLocaleDateString('en-US', { weekday: 'short' }),
              isLogged: !!t,
              calories: t ? Math.round(t.calories) : 0,
              protein_g: t ? Math.round(t.protein_g) : 0,
              carbs_g: t ? Math.round(t.carbs_g) : 0,
              fat_g: t ? Math.round(t.fat_g) : 0,
            });
          }
          if (mounted) setDays(rows);
        } catch {}
        try {
          const t = await api('/client/nutrition-targets');
          if (mounted) setTarget(t?.active || null);
        } catch {}
        if (mounted) setLoading(false);
      })();
      return () => { mounted = false; };
    }, [window])
  );

  const summary = buildTrendSummary(days, target ? {
    calories: Number(target.calories) || null,
    protein_g: Number(target.protein_g) || null,
    carbs_g: Number(target.carbs_g) || null,
    fat_g: Number(target.fat_g) || null,
  } : {}, target?.tolerance_pct ?? 10);

  // LineChart expects numeric x (timestamps) — logged days only
  const chartData = days
    .filter((d) => d.isLogged)
    .map((d) => ({ x: new Date(`${d.date}T12:00:00`).getTime(), y: d.calories }));

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
      <View style={styles.windowRow}>
        {[7, 30].map((w) => (
          <TouchableOpacity key={w} style={[styles.windowBtn, window === w && styles.windowBtnOn]} onPress={() => setWindow(w)}>
            <Text style={[styles.windowText, window === w && { color: '#fff' }]}>{w} days</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading ? (
        <ActivityIndicator color={colors.primary} style={{ marginTop: 30 }} />
      ) : (
        <>
          <View style={styles.card}>
            {target?.calories ? (
              <>
                <Text style={[styles.avgLine, NUMS]}>
                  Avg: {summary.avgCalories != null ? summary.avgCalories.toLocaleString() : '—'} cal/day
                </Text>
                <Text style={[styles.targetLine, NUMS]}>
                  Target: {Number(target.calories).toLocaleString()} cal/day
                  {summary.calorieSummary ? ` — ${summary.calorieSummary}` : ''}
                </Text>
              </>
            ) : (
              <Text style={[styles.avgLine, NUMS]}>
                Avg: {summary.avgCalories != null ? `${summary.avgCalories.toLocaleString()} cal/day` : 'no food logged yet'}
              </Text>
            )}
            <Text style={[styles.macroLine, NUMS]}>
              P {summary.avgProtein ?? '—'}g · C {summary.avgCarbs ?? '—'}g · F {summary.avgFat ?? '—'}g per day
            </Text>
            {summary.notLoggedDow.length > 0 && (
              <Text style={styles.gapNote}>Not logged: {summary.notLoggedDow.join(', ')}</Text>
            )}
          </View>

          {summary.notes.map((n, i) => (
            <View key={i} style={[styles.card, styles.noteCard]}>
              <Ionicons name="information-circle-outline" size={14} color={colors.blue} />
              <Text style={styles.noteText}>{n}</Text>
            </View>
          ))}

          {summary.loggedDays > 0 && (
            <View style={styles.card}>
              <Text style={styles.chartLabel}>Calories per day</Text>
              <LineChart data={chartData} color={colors.primary} />
            </View>
          )}

          {target && (
            <Text style={styles.disclaimer}>
              {target.target_mode === 'weekly_average'
                ? 'Weekly-average mode: your rolling average is compared against the target, so individual days can flex.'
                : ''}
              {target.target_source === 'trainer_override' ? ' Targets set by your trainer.' : ''}
              {' '}Estimates only — not medical advice.
            </Text>
          )}
        </>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    windowRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
    windowBtn: {
      flex: 1, alignItems: 'center', paddingVertical: 9,
      borderRadius: 11, backgroundColor: colors.cardLight,
    },
    windowBtnOn: { backgroundColor: colors.primary },
    windowText: { color: colors.textDim, fontWeight: '800', fontSize: 12 },
    card: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14, marginBottom: 10,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    avgLine: { color: colors.text, fontSize: 20, fontWeight: '800' },
    targetLine: { color: colors.textDim, fontSize: 13, marginTop: 3 },
    macroLine: { color: colors.textDim, fontSize: 12, marginTop: 4 },
    gapNote: { color: colors.orange, fontSize: 12, marginTop: 6, fontWeight: '700' },
    noteCard: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
    noteText: { color: colors.text, fontSize: 13, flex: 1 },
    chartLabel: { color: colors.textDim, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 },
    disclaimer: { color: colors.textDim, fontSize: 11, fontStyle: 'italic', textAlign: 'center', marginTop: 6, lineHeight: 16 },
  });
