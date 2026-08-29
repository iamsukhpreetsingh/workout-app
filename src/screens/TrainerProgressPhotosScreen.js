import React, { useCallback, useEffect, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
  Image, ActivityIndicator, Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../lib/api';
import { useColors } from '../theme';
import { fetchDisplayUri, getTokenForImages, formatDateLong, formatDateShort } from '../lib/progressPhotos';
import CompareView from '../components/CompareView';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Trainer's read-only view of ONE client's TRAINER_SHARED progress photos.
// The server returns only shared photos (personal ones never leave the DB);
// images stream through the same authorized endpoint the client uses —
// the trainer's JWT passes getPhotoForViewer's association+visibility
// checks. Full comparison parity with the client's own view: reuses the
// SAME CompareView (Side-by-Side / Slider / Overlay).
export default function TrainerProgressPhotosScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { clientId, clientName } = route.params || {};
  const [photos, setPhotos] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null); // currently displayed photo row
  const [displayUri, setDisplayUri] = useState(null);
  const [uris, setUris] = useState({});
  const [compare, setCompare] = useState(null);
  const [compareFirst, setCompareFirst] = useState(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const rows = await api(`/trainer/clients/${clientId}/progress-photos`);
      setPhotos(rows || []);
      setSelected((rows || [])[0] || null);
      const out = {};
      for (const p of (rows || []).slice(0, 40)) {
        out[p.id] = await fetchDisplayUri(p, getTokenForImages);
      }
      setUris(out);
    } catch (e) {
      setError(e?.message || 'Could not load photos');
    }
  }, [clientId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useEffect(() => {
    if (selected) {
      setDisplayUri(uris[selected.id] || null);
    } else {
      setDisplayUri(null);
    }
  }, [selected, uris]);

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: `${clientName || 'Client'} · Progress Photos` });
  }, [navigation, clientName]);

  const startCompare = (photo) => {
    if (!compareFirst) {
      setCompareFirst(photo);
      return;
    }
    if (compareFirst.id === photo.id || compareFirst.photo_date === photo.photo_date) {
      Alert.alert('Compare', 'Please select photos from two different dates.');
      setCompareFirst(null);
      return;
    }
    setCompare({ a: compareFirst, b: photo });
    setCompareFirst(null);
  };

  if (error) {
    return (
      <View style={[styles.container, styles.center]}>
        <Ionicons name="cloud-offline-outline" size={36} color={colors.textDim} />
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={load}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (photos === null) {
    return (
      <View style={[styles.container, styles.center]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* thumbnail strip — tap to view, long-press to pick for comparison */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip}>
        {photos.length === 0 && (
          <Text style={styles.stripEmpty}>No shared progress photos yet</Text>
        )}
        {photos.map((p) => (
          <TouchableOpacity
            key={p.id}
            style={[styles.stripThumb, selected?.id === p.id && styles.stripThumbOn,
                    compareFirst?.id === p.id && styles.stripThumbCompare]}
            onPress={() => setSelected(p)}
            onLongPress={() => startCompare(p)}
          >
            {uris[p.id] ? (
              <Image source={{ uri: uris[p.id] }} style={styles.stripImg} />
            ) : (
              <View style={[styles.stripImg, { backgroundColor: colors.cardLight, alignItems: 'center', justifyContent: 'center' }]}>
                <Ionicons name="image-outline" size={18} color={colors.textDim} />
              </View>
            )}
            <Text style={styles.stripDate}>{formatDateShort(p.photo_date)}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {compareFirst && (
        <Text style={styles.compareHint}>
          Comparing: {formatDateShort(compareFirst.photo_date)} selected — long-press a second photo
        </Text>
      )}

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
        {displayUri ? (
          <View>
            <Image source={{ uri: displayUri }} style={styles.photo} resizeMode="contain" />
            <Text style={styles.photoDate}>{formatDateLong(selected.photo_date)}</Text>
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() => {
                  if (photos.length < 2) {
                    Alert.alert('Compare', 'Only one shared photo — nothing to compare yet.');
                    return;
                  }
                  setCompareFirst(selected);
                  Alert.alert('Compare', 'Now long-press a second photo from the strip above.');
                }}
              >
                <Ionicons name="swap-horizontal" size={16} color={colors.primary} />
                <Text style={styles.actionText}>Compare with Another Date</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : photos.length > 0 ? (
          <ActivityIndicator color={colors.primary} style={{ marginTop: 40 }} />
        ) : (
          <View style={styles.emptyWrap}>
            <Ionicons name="camera-outline" size={44} color={colors.textDim} />
            <Text style={styles.emptyText}>
              {clientName || 'This client'} hasn't shared any progress photos yet.{'\n'}
              Photos they mark "Share with Trainer" appear here.
            </Text>
          </View>
        )}
      </ScrollView>

      {compare?.a && compare?.b && (
        <CompareView a={compare.a} b={compare.b} onClose={() => setCompare(null)} />
      )}
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    center: { alignItems: 'center', justifyContent: 'center', padding: 32 },
    errorText: { color: colors.textDim, fontSize: 13, marginTop: 12, textAlign: 'center' },
    retryBtn: {
      backgroundColor: colors.primary, borderRadius: 12, paddingHorizontal: 32,
      paddingVertical: 12, marginTop: 20,
    },
    retryText: { color: '#fff', fontWeight: '800' },
    strip: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.border },
    stripEmpty: { color: colors.textDim, fontSize: 12, paddingHorizontal: 20, paddingVertical: 14 },
    stripThumb: {
      width: 68, marginHorizontal: 4, padding: 4, borderRadius: 10,
      alignItems: 'center',
    },
    stripThumbOn: { backgroundColor: colors.cardLight },
    stripThumbCompare: { borderWidth: 2, borderColor: colors.blue },
    stripImg: { width: 60, height: 60, borderRadius: 8, backgroundColor: colors.cardLight },
    stripDate: { color: colors.textDim, fontSize: 9, marginTop: 3 },
    compareHint: {
      color: colors.blue, fontSize: 12, fontWeight: '700',
      paddingHorizontal: 20, paddingVertical: 6,
    },
    photo: { width: SCREEN_WIDTH - 40, height: SCREEN_WIDTH - 40, borderRadius: 14, backgroundColor: colors.card },
    photoDate: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: 10, textAlign: 'center' },
    actionRow: { marginTop: 14 },
    actionBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
      backgroundColor: colors.card, borderRadius: 10, paddingVertical: 12,
    },
    actionText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
    emptyWrap: { alignItems: 'center', paddingVertical: 60, paddingHorizontal: 20 },
    emptyText: { color: colors.textDim, fontSize: 14, marginTop: 14, textAlign: 'center', lineHeight: 20 },
  });