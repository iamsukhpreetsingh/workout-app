import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { getBodyWeightHistory, logBodyMetric, BODY_METRIC_TYPES, getTodayBodyMetric, getAllBodyMetricsForDate } from '../services/bodyService';
import { getSettings } from '../services/settingsService';
import { syncPendingMeasurements } from '../lib/syncService';
import LineChart from '../components/LineChart';
import { useColors } from '../theme';
import LoadError from '../shared/components/LoadError';
import { kgToLb, lbToKg } from '../shared/utils/units';
import { PROGRESS_PHOTOS } from '../shared/constants/routes';

export default function BodyScreen({ navigation }) {
  const colors = useColors();
  const [segment, setSegment] = useState('measurements');
  const [weight, setWeight] = useState('');
  const [metricType, setMetricType] = useState('weight');
  const [measurements, setMeasurements] = useState({});
  const [chartData, setChartData] = useState([]);
  const [settings, setSettings] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [lastWeightPrompt, setLastWeightPrompt] = useState(null);
  const [measureDate, setMeasureDate] = useState(new Date());

  const styles = {
    container: { flex: 1, backgroundColor: colors.bg },
    heading: { color: colors.text, fontSize: 28, fontWeight: '800', marginBottom: 16 },
    weightPrompt: {
      backgroundColor: colors.primary,
      padding: 14,
      borderRadius: 12,
      marginBottom: 16,
    },
    weightPromptText: { color: '#fff', fontWeight: '700', textAlign: 'center' },
    segmentRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
    segmentBtn: { flex: 1, padding: 12, borderRadius: 10, backgroundColor: colors.card, alignItems: 'center' },
    segmentBtnOn: { backgroundColor: colors.primary },
    segmentText: { color: colors.textDim, fontWeight: '600' },
    segmentTextOn: { color: '#fff' },
    card: { backgroundColor: colors.card, borderRadius: 12, padding: 16, marginBottom: 12 },
    cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 12 },
    inputRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    input: {
      flex: 1,
      backgroundColor: colors.cardLight,
      color: colors.text,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 18,
    },
    unit: { color: colors.textDim, fontSize: 16 },
    logBtn: { backgroundColor: colors.green, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 8 },
    logBtnText: { color: '#fff', fontWeight: '700' },
    typeScroll: { marginBottom: 12 },
    typeChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 20, backgroundColor: colors.cardLight, marginRight: 8 },
    typeChipOn: { backgroundColor: colors.blue },
    typeChipText: { color: colors.textDim, fontSize: 13 },
    typeChipTextOn: { color: '#fff' },
    chartWrap: { marginTop: 16 },
    dateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginBottom: 12, gap: 8 },
    dateBtn: { padding: 8 },
    dateBtnText: { color: colors.primary, fontSize: 16 },
    dateLabel: { color: colors.text, fontSize: 14, fontWeight: '600', minWidth: 120, textAlign: 'center' },
    todayBtn: { backgroundColor: colors.cardLight, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 },
    todayBtnText: { color: colors.primary, fontSize: 12, fontWeight: '600' },
    launcherCard: { backgroundColor: colors.card, borderRadius: 12, padding: 20, marginBottom: 12, alignItems: 'center' },
    launcherTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: 8 },
    launcherSub: { color: colors.textDim, fontSize: 12, marginTop: 4, textAlign: 'center' },
  };

  const loadData = useCallback(async () => {
    try {
      const s = await getSettings();
      setSettings(s);
      setWeight(String(s.unit === 'lb' ? Math.round(kgToLb(s.bar_weight)) : s.bar_weight));

      const history = await getBodyWeightHistory();
      const unit = s.unit || 'kg';
      setChartData(history.map(h => ({
        x: new Date(h.date).getTime(),
        y: unit === 'lb' ? kgToLb(h.value) : h.value,
      })));

      const today = await getTodayBodyMetric('weight');
      setLastWeightPrompt(today ? null : new Date().toDateString());
      setLoadError(false);
    } catch (e) {
      console.warn('[BodyScreen] load failed:', e?.message || e);
      setLoadError(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      loadData();
      return () => { mounted = false; };
    }, [loadData, retryTick])
  );

  const handleLogWeight = async () => {
    const val = parseFloat(weight);
    if (isNaN(val) || val <= 0) {
      Alert.alert('Invalid', 'Please enter a valid weight');
      return;
    }
    const unit = settings?.unit || 'kg';
    const dbValue = unit === 'lb' ? lbToKg(val) : val;
    const today = new Date().toISOString().split('T')[0];
    await logBodyMetric(today, 'weight', dbValue, unit);
    syncPendingMeasurements(); // background, non-blocking
    setLastWeightPrompt(new Date().toDateString());
    loadData();
    Alert.alert('Saved', `Logged ${val} ${unit}`);
  };

  const handleLogMeasurement = async () => {
    const val = parseFloat(measurements[metricType] || '0');
    if (isNaN(val) || val <= 0) {
      Alert.alert('Invalid', 'Please enter a valid measurement');
      return;
    }
    const unit = settings?.length_unit || 'cm';
    const dateStr = measureDate.toISOString().split('T')[0];
    await logBodyMetric(dateStr, metricType, val, unit);
    loadData();
    Alert.alert('Saved', `Logged ${val} ${unit} for ${measureDate.toLocaleDateString()}`);
  };

  const unit = settings?.unit || 'kg';
  const chartUnit = unit;

  if (loadError && !settings) {
    return <LoadError onRetry={() => setRetryTick((t) => t + 1)} />;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

      {lastWeightPrompt && (
        <TouchableOpacity style={styles.weightPrompt} onPress={handleLogWeight}>
          <Ionicons name="scale-outline" size={16} color="#fff" /><Text style={styles.weightPromptText}> Log today's weight</Text>
        </TouchableOpacity>
      )}

      <View style={styles.segmentRow}>
        <TouchableOpacity
          style={[styles.segmentBtn, segment === 'measurements' && styles.segmentBtnOn]}
          onPress={() => setSegment('measurements')}
        >
          <Text style={[styles.segmentText, segment === 'measurements' && styles.segmentTextOn]}>Measurements</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.segmentBtn, segment === 'photos' && styles.segmentBtnOn]}
          onPress={() => setSegment('photos')}
        >
          <Text style={[styles.segmentText, segment === 'photos' && styles.segmentTextOn]}>Photos</Text>
        </TouchableOpacity>
      </View>

      {segment === 'measurements' && (
        <>
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Body Weight</Text>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={weight}
                onChangeText={setWeight}
                placeholder="0"
                placeholderTextColor={colors.textDim}
              />
              <Text style={styles.unit}>{unit}</Text>
              <TouchableOpacity style={styles.logBtn} onPress={handleLogWeight}>
                <Text style={styles.logBtnText}>Log</Text>
              </TouchableOpacity>
            </View>
            {chartData.length > 1 && (
              <View style={styles.chartWrap}>
                <LineChart data={chartData} height={140} yLabel={chartUnit} />
              </View>
            )}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Other Measurements</Text>
            <View style={styles.dateRow}>
              <TouchableOpacity style={styles.dateBtn} onPress={() => setMeasureDate(d => { const nd = new Date(d); nd.setDate(nd.getDate() - 1); return nd; })}>
                <Text style={styles.dateBtnText}>◀</Text>
              </TouchableOpacity>
              <Text style={styles.dateLabel}>{measureDate.toLocaleDateString()}</Text>
              <TouchableOpacity style={styles.dateBtn} onPress={() => setMeasureDate(d => { const nd = new Date(d); nd.setDate(nd.getDate() + 1); return nd; })}>
                <Text style={styles.dateBtnText}>▶</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.todayBtn} onPress={() => setMeasureDate(new Date())}>
                <Text style={styles.todayBtnText}>Today</Text>
              </TouchableOpacity>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.typeScroll}>
              {BODY_METRIC_TYPES.filter(m => m.type !== 'weight').map(m => (
                <TouchableOpacity
                  key={m.type}
                  style={[styles.typeChip, metricType === m.type && styles.typeChipOn]}
                  onPress={() => setMetricType(m.type)}
                >
                  <Text style={[styles.typeChipText, metricType === m.type && styles.typeChipTextOn]}>
                    {m.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
            <View style={styles.inputRow}>
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={measurements[metricType] || ''}
                onChangeText={(v) => setMeasurements({ ...measurements, [metricType]: v })}
                placeholder="0"
                placeholderTextColor={colors.textDim}
              />
              <Text style={styles.unit}>{settings?.length_unit || 'cm'}</Text>
              <TouchableOpacity style={styles.logBtn} onPress={handleLogMeasurement}>
                <Text style={styles.logBtnText}>Log</Text>
              </TouchableOpacity>
            </View>
          </View>
        </>
      )}

      {segment === 'photos' && (
        <TouchableOpacity
          style={styles.launcherCard}
          onPress={() => navigation.navigate(PROGRESS_PHOTOS)}
          activeOpacity={0.8}
        >
          <Ionicons name="images-outline" size={30} color={colors.primary} />
          <Text style={styles.launcherTitle}>Progress Photos</Text>
          <Text style={styles.launcherSub}>
            Track your transformation over time — add, compare and share photos by date.
          </Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}