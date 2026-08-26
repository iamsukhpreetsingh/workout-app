import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import LoadError from '../shared/components/LoadError';
import { getExerciseProgress, getPersonalRecords, getExerciseHistory, getRecentSets } from '../db/queries';
import { getPRSetIdsForExercise } from '../db/pr';
import LineChart from '../components/LineChart';
import { useColors } from '../theme';
import { fmtDate } from '../shared/utils/format';
import { avgRpe, rpeInsight } from '../lib/stats';

export default function ExerciseProgressScreen({ route, navigation }) {
  React.useLayoutEffect(() => {
    navigation.setOptions({ title: route.params?.name || 'Exercise' });
  }, [navigation, route.params?.name]);
  const colors = useColors();
  const { exerciseId, name } = route.params;
  const [progress, setProgress] = useState([]);
  const [prs, setPrs] = useState(null);
  const [history, setHistory] = useState([]);
  const [insight, setInsight] = useState(null);
  const [prSetIds, setPrSetIds] = useState(new Set());
  const [loadError, setLoadError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  const styles = {
    container: { flex: 1, backgroundColor: colors.bg },
    heading: { color: colors.text, fontSize: 24, fontWeight: '800', marginBottom: 14 },
    statsRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
    statBox: { flex: 1, backgroundColor: colors.card, borderRadius: 12, padding: 14, alignItems: 'center' },
    statVal: { color: colors.primary, fontSize: 18, fontWeight: '800' },
    statLabel: { color: colors.textDim, fontSize: 11, marginTop: 2, textAlign: 'center' },
    section: { color: colors.text, fontSize: 17, fontWeight: '700', marginBottom: 8, marginTop: 8 },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 10, marginBottom: 14 },
    insight: { color: colors.green, fontSize: 13, marginBottom: 10 },
    histCard: { backgroundColor: colors.card, borderRadius: 12, padding: 14, marginBottom: 8 },
    histDate: { color: colors.textDim, fontSize: 12, marginBottom: 6 },
    setLine: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    setTagRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
    setTag: {
      color: colors.text,
      backgroundColor: colors.cardLight,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 4,
      fontSize: 12,
    },
    setTagPR: { borderWidth: 1, borderColor: '#FFD700' },
    prBadgeSmall: { fontSize: 10 },
  };

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      async function load() {
        try {
          const [prog, prData, hist, prsData] = await Promise.all([
            getExerciseProgress(exerciseId),
            getPersonalRecords(exerciseId),
            getExerciseHistory(exerciseId, 30),
            getPRSetIdsForExercise(exerciseId),
          ]);
          if (mounted) {
            setProgress(prog);
            setPrs(prData);
            setHistory(hist);
            setPrSetIds(prsData);
          }
          const rows = await getRecentSets(exerciseId, 10);
          if (mounted) {
            setInsight(rpeInsight(rows.slice().reverse()));
            setLoadError(false);
          }
        } catch (e) {
          console.warn('[ExerciseProgressScreen] load failed:', e?.message || e);
          if (mounted) setLoadError(true);
        }
      }
      load();
      return () => { mounted = false; };
    }, [exerciseId, retryTick])
  );

  const e1rmData = progress.map((p) => ({ x: p.start_time, y: p.best_e1rm }));
  const volumeData = progress.map((p) => ({ x: p.start_time, y: p.volume }));
  const rpeRows = progress.filter((p) => p.avg_rpe != null);
  const rpeData = rpeRows.map((p) => ({ x: p.start_time, y: p.avg_rpe }));

  // Group history rows by session for the "last performances" list
  const bySession = [];
  let current = null;
  for (const row of history) {
    if (!current || current.session_id !== row.session_id) {
      current = { session_id: row.session_id, name: row.session_name, date: row.start_time, sets: [] };
      bySession.push(current);
    }
    current.sets.push({ weight: row.weight, reps: row.reps, isPR: prSetIds.has(row.set_id) });
  }

  if (loadError && progress.length === 0) {
    return <LoadError onRetry={() => setRetryTick((t) => t + 1)} />;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

      {prs && (
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={styles.statVal}>{Math.round(prs.bestE1rm)}</Text>
            <Text style={styles.statLabel}>Best e1RM (kg)</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statVal}>{prs.maxWeight}</Text>
            <Text style={styles.statLabel}>Max Weight (kg)</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statVal}>{Math.round(prs.totalVolume)}</Text>
            <Text style={styles.statLabel}>Total Volume (kg)</Text>
          </View>
        </View>
      )}

      <Text style={styles.section}>Estimated 1RM</Text>
      <View style={styles.card}>
        <LineChart data={e1rmData} yLabel="kg" />
      </View>

      <Text style={styles.section}>Volume per Session</Text>
      <View style={styles.card}>
        <LineChart data={volumeData} color={colors.blue} yLabel="kg" />
      </View>

      {rpeData.length >= 2 && (
        <>
          <Text style={styles.section}>RPE Trend (avg per session)</Text>
          <View style={styles.card}>
            <LineChart data={rpeData} color={colors.green} yLabel="RPE" />
          </View>
        </>
      )}
      {insight && (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
          <Ionicons name="bulb-outline" size={14} color={colors.green} />
          <Text style={[styles.insight, { marginLeft: 6, flex: 1 }]}>{insight}</Text>
        </View>
      )}

      <Text style={styles.section}>History</Text>
      {bySession.map((s) => (
        <View key={s.session_id} style={styles.histCard}>
          <Text style={styles.histDate}>{fmtDate(s.date)}</Text>
          <View style={styles.setLine}>
            {s.sets.map((set, i) => (
              <View key={i} style={styles.setTagRow}>
                {set.isPR && <Ionicons name="trophy" size={11} color={colors.yellow} />}
                <Text style={[styles.setTag, set.isPR && styles.setTagPR]}>
                  {set.weight}kg × {set.reps}
                </Text>
              </View>
            ))}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}
