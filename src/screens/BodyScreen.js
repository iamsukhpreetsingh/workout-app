import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Alert,
  Platform,
  Modal,
  Image,
  Dimensions,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { getBodyWeightHistory, logBodyMetric, BODY_METRIC_TYPES, getTodayBodyMetric, getAllBodyMetricsForDate } from '../db/body';
import { addProgressPhoto, getProgressPhotos, deleteProgressPhoto, getPhotoFilePath } from '../db/photos';
import { getSettings } from '../db/settings';
import { syncPendingMeasurements } from '../lib/syncService';
import LineChart from '../components/LineChart';
import { useColors } from '../theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

export default function BodyScreen({ navigation }) {
  const colors = useColors();
  const [segment, setSegment] = useState('measurements');
  const [weight, setWeight] = useState('');
  const [metricType, setMetricType] = useState('weight');
  const [measurements, setMeasurements] = useState({});
  const [chartData, setChartData] = useState([]);
  const [photos, setPhotos] = useState([]);
  const [settings, setSettings] = useState(null);
  const [lastWeightPrompt, setLastWeightPrompt] = useState(null);
  const [viewPhoto, setViewPhoto] = useState(null);
  const [compareMode, setCompareMode] = useState(false);
  const [selectedPhotos, setSelectedPhotos] = useState([]);
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
    addPhotoBtn: { backgroundColor: colors.primary, padding: 16, borderRadius: 12, alignItems: 'center', marginBottom: 16 },
    addPhotoText: { color: '#fff', fontWeight: '700' },
    empty: { color: colors.textDim, textAlign: 'center', marginTop: 40 },
    photoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    photoThumb: { width: '31%', aspectRatio: 1, backgroundColor: colors.card, borderRadius: 8, justifyContent: 'center', alignItems: 'center' },
    photoDate: { color: colors.textDim, fontSize: 10, position: 'absolute', bottom: 4 },
    photoIcon: { fontSize: 28 },
    hint: { color: colors.textDim, fontSize: 12, marginTop: 12, textAlign: 'center' },
    photoActions: { flexDirection: 'row', gap: 8, marginBottom: 16 },
    compareBtn: { flex: 1, backgroundColor: colors.card, padding: 16, borderRadius: 12, alignItems: 'center' },
    compareBtnOn: { backgroundColor: colors.blue },
    compareBtnText: { color: colors.text, fontWeight: '700' },
    compareBtnTextOn: { color: '#fff' },
    photoThumbSelected: { borderWidth: 2, borderColor: colors.blue },
    selectBadge: { position: 'absolute', top: 4, right: 4, backgroundColor: colors.blue, width: 20, height: 20, borderRadius: 10, justifyContent: 'center', alignItems: 'center' },
    selectBadgeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
    modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' },
    modalClose: { position: 'absolute', top: 50, right: 20, zIndex: 10, padding: 10 },
    modalCloseText: { color: '#fff', fontSize: 24 },
    modalScroll: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
    fullImage: { width: SCREEN_WIDTH - 40, height: SCREEN_WIDTH - 40 },
    modalCaption: { color: '#fff', marginTop: 16, fontSize: 14 },
    compareContainer: { flex: 1, flexDirection: 'row', gap: 8, padding: 20, paddingTop: 60 },
    comparePanel: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    compareImage: { width: '100%', height: '80%' },
    compareLabel: { color: '#fff', marginTop: 8, fontSize: 12 },
  };

  const loadData = useCallback(async () => {
    const s = await getSettings();
    setSettings(s);
    setWeight(String(s.unit === 'lb' ? Math.round(s.bar_weight * 2.205) : s.bar_weight));

    const history = await getBodyWeightHistory();
    const unit = s.unit || 'kg';
    setChartData(history.map(h => ({
      x: new Date(h.date).getTime(),
      y: unit === 'lb' ? h.value * 2.205 : h.value,
    })));

    const today = await getTodayBodyMetric('weight');
    setLastWeightPrompt(today ? null : new Date().toDateString());

    const p = await getProgressPhotos();
    setPhotos(p);
  }, []);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      loadData();
      return () => { mounted = false; };
    }, [loadData])
  );

  const handleLogWeight = async () => {
    const val = parseFloat(weight);
    if (isNaN(val) || val <= 0) {
      Alert.alert('Invalid', 'Please enter a valid weight');
      return;
    }
    const unit = settings?.unit || 'kg';
    const dbValue = unit === 'lb' ? val / 2.205 : val;
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

  const handleAddPhoto = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!status.granted) {
      Alert.alert('Permission needed', 'Please allow access to your photos');
      return;
    }

    Alert.alert('Add Photo', 'Choose source', [
      {
        text: 'Camera',
        onPress: async () => {
          const result = await ImagePicker.launchCameraAsync({
            allowsEditing: true,
            quality: 0.8,
          });
          if (!result.canceled) {
            const today = new Date().toISOString().split('T')[0];
            await addProgressPhoto(today, result.assets[0].uri, 'front');
            loadData();
          }
        },
      },
      {
        text: 'Library',
        onPress: async () => {
          const result = await ImagePicker.launchImageLibraryAsync({
            allowsEditing: true,
            quality: 0.8,
          });
          if (!result.canceled) {
            const today = new Date().toISOString().split('T')[0];
            await addProgressPhoto(today, result.assets[0].uri, 'front');
            loadData();
          }
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const handleDeletePhoto = (id) => {
    Alert.alert('Delete Photo', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => {
        await deleteProgressPhoto(id);
        loadData();
      }},
    ]);
  };

  const unit = settings?.unit || 'kg';
  const chartUnit = unit;

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
        <>
          <View style={styles.photoActions}>
            <TouchableOpacity style={styles.addPhotoBtn} onPress={handleAddPhoto}>
              <Text style={styles.addPhotoText}>+ Add Photo</Text>
            </TouchableOpacity>
            {photos.length >= 2 && (
              <TouchableOpacity
                style={[styles.compareBtn, compareMode && styles.compareBtnOn]}
                onPress={() => {
                  if (compareMode && selectedPhotos.length === 2) {
                    setViewPhoto({ type: 'compare', photos: selectedPhotos });
                  }
                  setCompareMode(!compareMode);
                  setSelectedPhotos([]);
                }}
              >
                <Text style={[styles.compareBtnText, compareMode && styles.compareBtnTextOn]}>
                  {compareMode ? `Select 2 (${selectedPhotos.length})` : 'Compare'}
                </Text>
              </TouchableOpacity>
            )}
          </View>

          {photos.length === 0 ? (
            <Text style={styles.empty}>No photos yet. Add your first progress photo!</Text>
          ) : (
            <View style={styles.photoGrid}>
              {photos.slice(0, 12).map((photo) => {
                const isSelected = selectedPhotos.some(p => p.id === photo.id);
                return (
                  <TouchableOpacity
                    key={photo.id}
                    style={[styles.photoThumb, isSelected && styles.photoThumbSelected]}
                    onPress={() => {
                      if (compareMode) {
                        setSelectedPhotos(prev => {
                          if (prev.some(p => p.id === photo.id)) {
                            return prev.filter(p => p.id !== photo.id);
                          }
                          if (prev.length >= 2) return [prev[1], photo];
                          return [...prev, photo];
                        });
                      } else {
                        setViewPhoto({ type: 'single', photo });
                      }
                    }}
                    onLongPress={() => handleDeletePhoto(photo.id)}
                  >
                    {isSelected && <View style={styles.selectBadge}><Ionicons name="checkmark" size={12} color="#fff" /></View>}
                    <Text style={styles.photoDate}>
                      {new Date(photo.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </Text>
                    <Ionicons name="image-outline" size={28} color={colors.textDim} />
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
          <Text style={styles.hint}>
            {compareMode ? 'Tap 2 photos to compare' : 'Long press a photo to delete'}
          </Text>
        </>
      )}

      <Modal visible={!!viewPhoto} animationType="fade" transparent>
        <View style={styles.modalBg}>
          <TouchableOpacity style={styles.modalClose} onPress={() => setViewPhoto(null)}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          {viewPhoto?.type === 'single' && (
            <ScrollView contentContainerStyle={styles.modalScroll}>
              <Image
                source={{ uri: `file://${PHOTOS_DIR}${viewPhoto.photo.file_path}` }}
                style={styles.fullImage}
                resizeMode="contain"
              />
              <Text style={styles.modalCaption}>
                {new Date(viewPhoto.photo.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}
                {viewPhoto.photo.angle ? ` · ${viewPhoto.photo.angle}` : ''}
              </Text>
            </ScrollView>
          )}
          {viewPhoto?.type === 'compare' && (
            <View style={styles.compareContainer}>
              <View style={styles.comparePanel}>
                <Image
                  source={{ uri: `file://${PHOTOS_DIR}${viewPhoto.photos[0].file_path}` }}
                  style={styles.compareImage}
                  resizeMode="contain"
                />
                <Text style={styles.compareLabel}>
                  {new Date(viewPhoto.photos[0].date).toLocaleDateString()}
                </Text>
              </View>
              <View style={styles.comparePanel}>
                <Image
                  source={{ uri: `file://${PHOTOS_DIR}${viewPhoto.photos[1].file_path}` }}
                  style={styles.compareImage}
                  resizeMode="contain"
                />
                <Text style={styles.compareLabel}>
                  {new Date(viewPhoto.photos[1].date).toLocaleDateString()}
                </Text>
              </View>
            </View>
          )}
        </View>
      </Modal>
    </ScrollView>
  );
}

const PHOTOS_DIR = `${FileSystem?.documentDirectory || ''}progress_photos/`;