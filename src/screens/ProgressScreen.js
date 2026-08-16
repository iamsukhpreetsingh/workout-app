import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { getProgressOverview, getExerciseProgressList } from '../db/queries';
import { getBodyWeightHistory } from '../db/body';
import { calculateStreak, getCalendarData } from '../lib/streaks';
import { getVolumeWarnings } from '../lib/volumeWarnings';
import { getSettings } from '../db/settings';
import LineChart from '../components/LineChart';
import CalendarHeatmap from '../components/CalendarHeatmap';
import { useColors } from '../theme';

export default function ProgressScreen({ navigation }) {
  const colors = useColors();
  const [segment, setSegment] = useState('strength');
  const [overview, setOverview] = useState([]);
  const [exercises, setExercises] = useState([]);
  const [bodyData, setBodyData] = useState([]);
  const [streak, setStreak] = useState({ current: 0, longest: 0 });
  const [calendarData, setCalendarData] = useState({});
  const [settings, setSettings] = useState(null);
  const [warnings, setWarnings] = useState([]);

  const styles = {
    container: { flex: 1 },
    heading: { fontSize: 28, fontWeight: '800', marginBottom: 16 },
    segmentRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
    segmentBtn: { flex: 1, padding: 12, borderRadius: 10, alignItems: 'center' },
    segmentText: { fontWeight: '600' },
    warningCard: { borderRadius: 12, padding: 12, marginBottom: 12, borderLeftWidth: 3, borderLeftColor: '#FF9500' },
    warningText: { fontSize: 13, fontWeight: '600', marginBottom: 2 },
    empty: {},
    statsRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
    statBox: { flex: 1, borderRadius: 12, padding: 14, alignItems: 'center' },
    statVal: { fontSize: 20, fontWeight: '800' },
    statLabel: { fontSize: 11, marginTop: 2, textAlign: 'center' },
    streakRow: { flexDirection: 'row', gap: 10, marginBottom: 16 },
    streakBox: { flex: 1, borderRadius: 12, padding: 14, alignItems: 'center' },
    streakVal: { fontSize: 18, fontWeight: '700' },
    streakLabel: { fontSize: 11, marginTop: 2 },
    section: { fontSize: 17, fontWeight: '700', marginBottom: 8, marginTop: 8 },
    hint: { fontSize: 12, marginBottom: 10 },
    card: { borderRadius: 12, padding: 10, marginBottom: 14 },
    exRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, padding: 14, marginBottom: 8 },
    exName: { fontWeight: '600' },
    exSub: { fontSize: 12, marginTop: 2 },
    chev: { fontSize: 20 },
  };

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      async function load() {
        const [overviewData, exercisesData, history, streakData, calendar, s, w] = await Promise.all([
          getProgressOverview(),
          getExerciseProgressList(),
          getBodyWeightHistory(),
          calculateStreak(1),
          getCalendarData(6),
          getSettings(),
          getVolumeWarnings(),
        ]);
        if (!mounted) return;
        setOverview(overviewData);
        setExercises(exercisesData);
        setBodyData(history);
        setStreak(streakData);
        setCalendarData(calendar);
        setSettings(s);
        setWarnings(w);
      }
      load();
      return () => { mounted = false; };
    }, [])
  );

  const completed = overview.filter((s) => s.end_time);
  const volumeData = completed.map((s) => ({ x: s.start_time, y: s.volume }));
  const setsData = completed.map((s) => ({ x: s.start_time, y: s.set_count }));
  const thisWeek = completed.filter(
    (s) => Date.now() - s.start_time < 7 * 86400 * 1000
  );
  const weekVolume = thisWeek.reduce((n, s) => n + s.volume, 0);
  const totalWorkouts = completed.length;

  const unit = settings?.weight_unit || 'kg';
  const weightData = bodyData.map(h => ({
    x: new Date(h.date).getTime(),
    y: unit === 'lb' ? h.value * 2.205 : h.value,
  }));

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.bg }]} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

      <View style={styles.segmentRow}>
        <TouchableOpacity
          style={[styles.segmentBtn, { backgroundColor: colors.card }, segment === 'strength' && { backgroundColor: colors.primary }]}
          onPress={() => setSegment('strength')}
        >
          <Text style={[styles.segmentText, { color: colors.textDim }, segment === 'strength' && { color: '#fff' }]}>Strength</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.segmentBtn, { backgroundColor: colors.card }, segment === 'body' && { backgroundColor: colors.primary }]}
          onPress={() => {
            setSegment('body');
            navigation.navigate('Body');
          }}
        >
          <Text style={[styles.segmentText, { color: colors.textDim }, segment === 'body' && { color: '#fff' }]}>Body</Text>
        </TouchableOpacity>
      </View>

      {warnings.length > 0 && (
        <View style={[styles.warningCard, { backgroundColor: colors.card }]}>
          {warnings.map((w, i) => (
            <Text key={i} style={[styles.warningText, { color: w.type === 'drop' ? colors.orange : colors.blue }]}>
              {w.muscle_group}: volume {w.type === 'drop' ? 'down' : 'up'} {Math.abs(w.pctChange)}% this week
            </Text>
          ))}
        </View>
      )}

      {totalWorkouts === 0 ? (
        <Text style={[styles.empty, { color: colors.textDim }]}>
          Complete your first workout to start seeing progress here.
        </Text>
      ) : (
        <>
          <View style={styles.statsRow}>
            <View style={[styles.statBox, { backgroundColor: colors.card }]}>
              <Text style={[styles.statVal, { color: colors.primary }]}>{totalWorkouts}</Text>
              <Text style={[styles.statLabel, { color: colors.textDim }]}>Total Workouts</Text>
            </View>
            <View style={[styles.statBox, { backgroundColor: colors.card }]}>
              <Text style={[styles.statVal, { color: colors.primary }]}>{thisWeek.length}</Text>
              <Text style={[styles.statLabel, { color: colors.textDim }]}>This Week</Text>
            </View>
            <View style={[styles.statBox, { backgroundColor: colors.card }]}>
              <Text style={[styles.statVal, { color: colors.primary }]}>{Math.round(weekVolume)}</Text>
              <Text style={[styles.statLabel, { color: colors.textDim }]}>Weekly Volume</Text>
            </View>
          </View>

          <View style={styles.streakRow}>
            <View style={[styles.streakBox, { backgroundColor: colors.card }]}>
              <Text style={[styles.streakVal, { color: colors.text }]}><Ionicons name="flame" size={16} color={colors.orange} /> {streak.current}</Text>
              <Text style={[styles.streakLabel, { color: colors.textDim }]}>Day Streak</Text>
            </View>
            <View style={[styles.streakBox, { backgroundColor: colors.card }]}>
              <Text style={[styles.streakVal, { color: colors.text }]}><Ionicons name="trophy-outline" size={15} color={colors.yellow} /> {streak.longest}</Text>
              <Text style={[styles.streakLabel, { color: colors.textDim }]}>Longest</Text>
            </View>
          </View>

          <Text style={[styles.section, { color: colors.text }]}>Consistency</Text>
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            <CalendarHeatmap data={calendarData} months={6} />
          </View>

          <Text style={[styles.section, { color: colors.text }]}>Volume per Workout ({unit})</Text>
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            <LineChart data={volumeData} yLabel={unit} />
          </View>

          <Text style={[styles.section, { color: colors.text }]}>Sets per Workout</Text>
          <View style={[styles.card, { backgroundColor: colors.card }]}>
            <LineChart data={setsData} color={colors.blue} yLabel="sets" />
          </View>

          {weightData.length > 1 && (
            <>
              <Text style={[styles.section, { color: colors.text }]}>Body Weight ({unit})</Text>
              <View style={[styles.card, { backgroundColor: colors.card }]}>
                <LineChart data={weightData} color={colors.green} yLabel={unit} />
              </View>
            </>
          )}

          <Text style={[styles.section, { color: colors.text }]}>By Exercise</Text>
          <Text style={[styles.hint, { color: colors.textDim }]}>
            Estimated 1RM uses the Epley formula: weight × (1 + reps/30).
          </Text>
          {exercises.map((ex) => (
            <TouchableOpacity
              key={ex.id}
              style={[styles.exRow, { backgroundColor: colors.card }]}
              onPress={() => navigation.navigate('ExerciseProgress', { exerciseId: ex.id, name: ex.name })}
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.exName, { color: colors.text }]}>{ex.name}</Text>
                <Text style={[styles.exSub, { color: colors.textDim }]}>
                  {ex.session_count} sessions · best {ex.best_weight} {unit}
                </Text>
              </View>
              <Text style={[styles.chev, { color: colors.textDim }]}>›</Text>
            </TouchableOpacity>
          ))}
        </>
      )}
    </ScrollView>
  );
}