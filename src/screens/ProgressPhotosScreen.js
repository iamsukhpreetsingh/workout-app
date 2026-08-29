import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
  Modal, Image, Dimensions, ActivityIndicator, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from '@react-navigation/native';
import { useColors } from '../theme';
import { addProgressPhoto, deleteProgressPhoto, setPhotoVisibility } from '../db/photos';
import {
  VISIBILITY, compressForUpload, todayLocal, shiftDate, isFutureDate,
  formatDateLong, formatDateShort, getPhotoForDate, getAllPhotos,
  fetchDisplayUri, getTokenForImages, getTrainerAssociation,
} from '../lib/progressPhotos';
import CompareView from '../components/CompareView';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// The date-based Progress Photos experience (spec §2–8, §13–17, §28).
// Defaults to today; navigates past dates; upload flow = pick → preview →
// privacy → save (compressed); replace/delete; compare launcher; and the
// manage-sharing gallery for the +1 re-share flow.
export default function ProgressPhotosScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [date, setDate] = useState(todayLocal());
  const [photo, setPhoto] = useState(null);
  const [displayUri, setDisplayUri] = useState(null);
  const [loading, setLoading] = useState(true);
  const [trainer, setTrainer] = useState({ hasTrainer: false, trainerName: null });
  const [compare, setCompare] = useState(null);
  const [manageOpen, setManageOpen] = useState(false);

  // upload-flow state (kept flat — simplest reliable shape)
  const [uploadState, setUploadState] = useState(null); // {uri, visibility}
  const [uploadBusy, setUploadBusy] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const p = await getPhotoForDate(date);
    setPhoto(p);
    if (p) {
      setDisplayUri(await fetchDisplayUri(p, getTokenForImages));
    } else {
      setDisplayUri(null);
    }
    setLoading(false);
  }, [date]);

  useFocusEffect(useCallback(() => { reload(); }, [reload]));
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => {
    getTrainerAssociation().then(setTrainer);
  }, []);

  const pickImage = async (source) => {
    try {
      let result;
      if (source === 'camera') {
        const cam = await ImagePicker.requestCameraPermissionsAsync();
        if (!cam.granted) {
          Alert.alert('Permission needed', 'Please allow camera access to take a photo');
          return;
        }
        result = await ImagePicker.launchCameraAsync({ allowsEditing: true, quality: 0.9 });
      } else {
        if (Platform.OS !== 'android' || Platform.Version < 34) {
          const lib = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!lib.granted) {
            Alert.alert('Permission needed', 'Please allow access to your photos');
            return;
          }
        }
        result = await ImagePicker.launchImageLibraryAsync({ allowsEditing: true, quality: 0.9 });
      }
      if (!result.canceled && result.assets?.[0]?.uri) {
        setUploadState({ uri: result.assets[0].uri, visibility: VISIBILITY.PERSONAL });
      }
    } catch (e) {
      Alert.alert('Could not open ' + source, e?.message || 'Please try again.');
    }
  };

  const confirmUpload = async () => {
    if (!uploadState || uploadBusy) return;
    setUploadBusy(true);
    try {
      const compressed = await compressForUpload(uploadState.uri);
      await addProgressPhoto(date, compressed, 'front', uploadState.visibility);
      setUploadState(null);
      reload();
    } catch (e) {
      Alert.alert('Could not save', e?.message || 'Please try again.');
    } finally {
      setUploadBusy(false);
    }
  };

  const confirmDelete = () =>
    Alert.alert('Delete Progress Photo?', 'This photo will be permanently removed.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => { await deleteProgressPhoto(photo.id); reload(); },
      },
    ]);

  const confirmReplace = () =>
    Alert.alert('Replace this progress photo?', '', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Continue', onPress: () => pickImage('library') },
    ]);

  const toggleShare = async () => {
    if (!photo) return;
    if (photo.visibility === VISIBILITY.PERSONAL && !trainer.hasTrainer) {
      Alert.alert(
        'No trainer associated',
        'No trainer is currently associated with your account. Photos stay personal.'
      );
      return;
    }
    const next = photo.visibility === VISIBILITY.PERSONAL
      ? VISIBILITY.TRAINER_SHARED
      : VISIBILITY.PERSONAL;
    await setPhotoVisibility(photo.id, next);
    reload();
  };

  const openCompare = async (preset) => {
    const photos = await getAllPhotos();
    if (photos.length < 2) {
      Alert.alert('Compare', 'You need at least two photos to compare.');
      return;
    }
    if (preset === 'today') {
      const todayPhoto = photos.find((p) => p.date === todayLocal());
      if (!todayPhoto) {
        Alert.alert(
          'Compare with Today',
          "Today's progress photo is not available. Add today's photo to compare."
        );
        return;
      }
      const other = photos.find((p) => p.date === photo?.date) || photos.find((p) => p.date !== todayLocal());
      if (!other || other.date === todayPhoto.date) {
        Alert.alert('Compare', 'Please select photos from two different dates.');
        return;
      }
      setCompare({ a: other, b: todayPhoto });
      return;
    }
    setCompare({ picker: true, photos });
  };

  const future = isFutureDate(date);
  const canGoNext = date < todayLocal();

  return (
    <View style={styles.container}>
      <View style={styles.dateNav}>
        <TouchableOpacity style={styles.navBtn} onPress={() => setDate(shiftDate(date, -1))}>
          <Ionicons name="chevron-back" size={22} color={colors.text} />
        </TouchableOpacity>
        <Text style={styles.dateText}>{formatDateLong(date)}</Text>
        <TouchableOpacity
          style={[styles.navBtn, !canGoNext && { opacity: 0.3 }]}
          disabled={!canGoNext}
          onPress={() => setDate(shiftDate(date, 1))}
        >
          <Ionicons name="chevron-forward" size={22} color={colors.text} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
        {loading ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 60 }} />
        ) : displayUri ? (
          <View>
            <Image source={{ uri: displayUri }} style={styles.photo} resizeMode="contain" />
            <View style={styles.visibilityRow}>
              <Ionicons
                name={photo.visibility === VISIBILITY.TRAINER_SHARED ? 'eye' : 'eye-off'}
                size={14}
                color={photo.visibility === VISIBILITY.TRAINER_SHARED ? colors.blue : colors.textDim}
              />
              <Text style={styles.visibilityText}>
                {photo.visibility === VISIBILITY.TRAINER_SHARED
                  ? `Shared with Trainer${trainer.trainerName ? ` (${trainer.trainerName})` : ''}`
                  : 'Personal'}
              </Text>
              <TouchableOpacity style={styles.visibilityToggle} onPress={toggleShare}>
                <Text style={styles.visibilityToggleText}>
                  {photo.visibility === VISIBILITY.TRAINER_SHARED ? 'Make Personal' : 'Share with Trainer'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.actionBtn} onPress={() => openCompare('today')}>
                <Ionicons name="swap-horizontal" size={16} color={colors.primary} />
                <Text style={styles.actionText}>Compare with Today</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.actionBtn} onPress={confirmReplace}>
                <Ionicons name="refresh" size={16} color={colors.primary} />
                <Text style={styles.actionText}>Replace</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.actionBtn, styles.dangerBtn]} onPress={confirmDelete}>
                <Ionicons name="trash-outline" size={16} color={colors.red} />
                <Text style={styles.dangerText}>Delete</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View style={styles.emptyWrap}>
            <Ionicons name="camera-outline" size={44} color={colors.textDim} />
            <Text style={styles.emptyTitle}>
              {future ? 'Future dates have no photos' : 'No progress photo for this date.'}
            </Text>
            {!future && (
              <TouchableOpacity style={styles.addBtn} onPress={() => pickImage('library')}>
                <Ionicons name="add" size={18} color="#fff" />
                <Text style={styles.addBtnText}>Add Progress Photo</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <TouchableOpacity style={styles.secondaryBtn} onPress={() => setManageOpen(true)}>
          <Ionicons name="images-outline" size={16} color={colors.primary} />
          <Text style={styles.secondaryBtnText}>All Photos & Sharing</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.secondaryBtn, { marginTop: 10 }]} onPress={() => openCompare('picker')}>
          <Ionicons name="swap-horizontal" size={16} color={colors.primary} />
          <Text style={styles.secondaryBtnText}>Compare Two Dates</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* upload flow: preview + privacy + confirm */}
      <Modal visible={!!uploadState} transparent animationType="slide">
        <View style={styles.uploadWrap}>
          {uploadState && (
            <View style={styles.uploadCard}>
              <Text style={styles.uploadTitle}>Preview — {formatDateShort(date)}</Text>
              <Image source={{ uri: uploadState.uri }} style={styles.previewImg} resizeMode="contain" />
              <Text style={styles.visibilityLabel}>VISIBILITY</Text>
              <TouchableOpacity
                style={[styles.visOption, uploadState.visibility === VISIBILITY.PERSONAL && styles.visOptionOn]}
                onPress={() => setUploadState({ ...uploadState, visibility: VISIBILITY.PERSONAL })}
              >
                <Ionicons name="eye-off" size={14} color={colors.text} />
                <Text style={styles.visOptionText}>Keep Personal</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.visOption, uploadState.visibility === VISIBILITY.TRAINER_SHARED && styles.visOptionOn]}
                onPress={() => {
                  if (!trainer.hasTrainer) {
                    Alert.alert(
                      'No trainer associated',
                      'No trainer is currently associated with your account. Photos stay personal.'
                    );
                    return;
                  }
                  setUploadState({ ...uploadState, visibility: VISIBILITY.TRAINER_SHARED });
                }}
              >
                <Ionicons name="eye" size={14} color={colors.blue} />
                <Text style={styles.visOptionText}>
                  Share with Trainer{trainer.trainerName ? ` (${trainer.trainerName})` : ''}
                </Text>
              </TouchableOpacity>
              {!trainer.hasTrainer && (
                <Text style={styles.noTrainerNote}>
                  No trainer is currently associated with your account.
                </Text>
              )}
              <View style={styles.uploadActions}>
                <TouchableOpacity style={styles.cancelBtn} onPress={() => setUploadState(null)}>
                  <Text style={styles.cancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.saveBtn} onPress={confirmUpload} disabled={uploadBusy}>
                  <Text style={styles.saveBtnText}>{uploadBusy ? 'Saving…' : 'Save Photo'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </Modal>

      {compare?.picker && (
        <ComparePicker
          photos={compare.photos}
          onClose={() => setCompare(null)}
          onPicked={(a, b) => {
            if (a.date === b.date) {
              Alert.alert('Compare', 'Please select photos from two different dates.');
              return;
            }
            setCompare({ a, b });
          }}
        />
      )}

      {compare?.a && compare?.b && (
        <CompareView a={compare.a} b={compare.b} onClose={() => setCompare(null)} />
      )}

      <ManageSharingModal
        visible={manageOpen}
        onClose={() => { setManageOpen(false); reload(); }}
        trainer={trainer}
      />
    </View>
  );
}

// Two sequential date picks; only dates that HAVE photos appear.
function ComparePicker({ photos, onClose, onPicked }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [first, setFirst] = useState(null);
  const [uris, setUris] = useState({});
  useEffect(() => {
    (async () => {
      const out = {};
      for (const p of photos.slice(0, 30)) {
        out[p.id] = await fetchDisplayUri(p, getTokenForImages);
      }
      setUris(out);
    })();
  }, [photos]);

  return (
    <Modal visible transparent animationType="slide">
      <View style={styles.pickerWrap}>
        <View style={styles.pickerCard}>
          <Text style={styles.pickerTitle}>
            {first ? 'Select Current Photo' : 'Select Earlier Photo'}
          </Text>
          {first && (
            <Text style={styles.pickerHint}>
              First: {formatDateShort(first.date)} — pick a different date
            </Text>
          )}
          <ScrollView>
            {photos.map((p) => (
              <TouchableOpacity
                key={p.id}
                style={[styles.pickerRow, first?.id === p.id && styles.pickerRowDim]}
                disabled={first?.id === p.id}
                onPress={() => (first ? onPicked(first, p) : setFirst(p))}
              >
                {uris[p.id] ? (
                  <Image source={{ uri: uris[p.id] }} style={styles.pickerThumb} />
                ) : (
                  <View style={[styles.pickerThumb, { backgroundColor: colors.cardLight }]} />
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.pickerDate}>{formatDateLong(p.date)}</Text>
                  <Text style={styles.pickerVis}>
                    {p.visibility === VISIBILITY.TRAINER_SHARED ? 'Shared' : 'Personal'}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
              </TouchableOpacity>
            ))}
          </ScrollView>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// Gallery + the +1-rule re-share flow: long-press to multi-select, then
// share the selected photos with the (actively associated) trainer or
// make them personal.
function ManageSharingModal({ visible, onClose, trainer }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [photos, setPhotos] = useState([]);
  const [uris, setUris] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!visible) return;
    const all = await getAllPhotos();
    setPhotos(all);
    setSelected(new Set());
    const out = {};
    for (const p of all.slice(0, 60)) {
      out[p.id] = await fetchDisplayUri(p, getTokenForImages);
    }
    setUris(out);
  }, [visible]);
  useEffect(() => { load(); }, [load]);

  const applyToSelected = async (visibility) => {
    if (busy || !selected.size) return;
    setBusy(true);
    try {
      for (const id of selected) {
        await setPhotoVisibility(String(id), visibility);
      }
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.pickerWrap}>
        <View style={styles.pickerCard}>
          <Text style={styles.pickerTitle}>All Photos & Sharing</Text>
          <Text style={styles.pickerHint}>
            {trainer.hasTrainer
              ? `Long-press to select, then share with ${trainer.trainerName || 'your trainer'}`
              : 'No trainer currently associated — photos stay personal.'}
          </Text>
          <ScrollView>
            {photos.map((p) => {
              const isSel = selected.has(p.id);
              return (
                <TouchableOpacity
                  key={p.id}
                  style={[styles.pickerRow, isSel && styles.pickerRowSel]}
                  onLongPress={() => setSelected((prev) => new Set(prev).add(p.id))}
                  onPress={() => {
                    if (!selected.size) return;
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(p.id)) next.delete(p.id);
                      else next.add(p.id);
                      return next;
                    });
                  }}
                >
                  {uris[p.id] ? (
                    <Image source={{ uri: uris[p.id] }} style={styles.pickerThumb} />
                  ) : (
                    <View style={[styles.pickerThumb, { backgroundColor: colors.cardLight }]} />
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickerDate}>{formatDateLong(p.date)}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Ionicons
                        name={p.visibility === VISIBILITY.TRAINER_SHARED ? 'eye' : 'eye-off'}
                        size={11}
                        color={p.visibility === VISIBILITY.TRAINER_SHARED ? colors.blue : colors.textDim}
                      />
                      <Text style={styles.pickerVis}>
                        {p.visibility === VISIBILITY.TRAINER_SHARED ? 'Shared with Trainer' : 'Personal'}
                      </Text>
                    </View>
                  </View>
                  {isSel && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
          {selected.size > 0 && (
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
              <TouchableOpacity
                style={[styles.actionBtn, { flex: 1 }]}
                disabled={!trainer.hasTrainer || busy}
                onPress={() => applyToSelected(VISIBILITY.TRAINER_SHARED)}
              >
                <Text style={styles.actionText}>Share Selected ({selected.size})</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.actionBtn, { flex: 1 }]}
                disabled={busy}
                onPress={() => applyToSelected(VISIBILITY.PERSONAL)}
              >
                <Text style={styles.actionText}>Make Personal</Text>
              </TouchableOpacity>
            </View>
          )}
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    dateNav: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border,
    },
    navBtn: { padding: 8 },
    dateText: { color: colors.text, fontSize: 17, fontWeight: '800' },
    photo: { width: SCREEN_WIDTH - 40, height: SCREEN_WIDTH - 40, borderRadius: 14, backgroundColor: colors.card },
    visibilityRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12, paddingHorizontal: 4 },
    visibilityText: { color: colors.textDim, fontSize: 13, flex: 1 },
    visibilityToggle: { paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, backgroundColor: colors.cardLight },
    visibilityToggleText: { color: colors.primary, fontSize: 12, fontWeight: '700' },
    actionRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
    actionBtn: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      backgroundColor: colors.card, borderRadius: 10, paddingVertical: 12,
    },
    actionText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
    dangerBtn: { borderWidth: 1, borderColor: colors.red, backgroundColor: 'transparent' },
    dangerText: { color: colors.red, fontWeight: '700', fontSize: 13 },
    emptyWrap: { alignItems: 'center', paddingVertical: 60 },
    emptyTitle: { color: colors.textDim, fontSize: 15, marginTop: 14, marginBottom: 20, textAlign: 'center' },
    addBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.primary, borderRadius: 12, paddingHorizontal: 24, paddingVertical: 13,
    },
    addBtnText: { color: '#fff', fontWeight: '800' },
    secondaryBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      paddingVertical: 13, marginTop: 24, borderRadius: 10, backgroundColor: colors.cardLight,
    },
    secondaryBtnText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
    uploadWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 20 },
    uploadCard: { backgroundColor: colors.bg, borderRadius: 16, padding: 16 },
    uploadTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: 12 },
    previewImg: { width: '100%', height: 300, borderRadius: 10, backgroundColor: colors.cardLight, marginBottom: 12 },
    visibilityLabel: { color: colors.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 1, marginBottom: 8 },
    visOption: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.cardLight, borderRadius: 10, padding: 12, marginBottom: 8,
      borderWidth: 1.5, borderColor: 'transparent',
    },
    visOptionOn: { borderColor: colors.primary },
    visOptionText: { color: colors.text, fontSize: 14, fontWeight: '600' },
    noTrainerNote: { color: colors.textDim, fontSize: 11, fontStyle: 'italic', marginBottom: 8 },
    uploadActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
    cancelBtn: {
      flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10,
      backgroundColor: colors.cardLight,
    },
    cancelText: { color: colors.textDim, fontWeight: '700' },
    saveBtn: {
      flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: 10,
      backgroundColor: colors.primary,
    },
    saveBtnText: { color: '#fff', fontWeight: '800' },
    pickerWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
    pickerCard: {
      backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
      padding: 18, height: '85%',
    },
    pickerTitle: { color: colors.text, fontSize: 17, fontWeight: '800', marginBottom: 4 },
    pickerHint: { color: colors.textDim, fontSize: 12, marginBottom: 12 },
    pickerRow: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.card, borderRadius: 12, padding: 10, marginBottom: 8,
    },
    pickerRowDim: { opacity: 0.4 },
    pickerRowSel: { borderWidth: 2, borderColor: colors.primary },
    pickerThumb: { width: 52, height: 52, borderRadius: 10, backgroundColor: colors.cardLight },
    pickerDate: { color: colors.text, fontSize: 14, fontWeight: '700' },
    pickerVis: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  });