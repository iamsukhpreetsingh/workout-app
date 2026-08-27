import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, Image,
  Dimensions, PanResponder,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import { fetchDisplayUri, getTokenForImages, formatDateShort } from '../lib/progressPhotos';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Three comparison modes (spec §9–12): Side-by-Side (default), Slider
// (drag to reveal), Overlay (adjustable opacity). Mode persists only for
// the comparison session. Aspect ratios preserved via resizeMode. A
// missing/deleted photo shows "no longer available" and exits safely.
export default function CompareView({ a, b, onClose }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [mode, setMode] = useState('side');
  const [uriA, setUriA] = useState(null);
  const [uriB, setUriB] = useState(null);
  const [loading, setLoading] = useState(true);
  const [slider, setSlider] = useState(0.5);
  const [opacity, setOpacity] = useState(0.5);

  useEffect(() => {
    (async () => {
      const [ua, ub] = await Promise.all([
        fetchDisplayUri(a, getTokenForImages),
        fetchDisplayUri(b, getTokenForImages),
      ]);
      setUriA(ua);
      setUriB(ub);
      setLoading(false);
    })();
  }, [a?.id, b?.id]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => mode === 'slider',
        onMoveShouldSetPanResponder: () => mode === 'slider',
        onPanResponderMove: (e, g) => {
          const frac = Math.min(1, Math.max(0, (g.x0 + g.dx) / SCREEN_WIDTH));
          setSlider(frac);
        },
      }),
    [mode]
  );

  const IMG_H = SCREEN_HEIGHT * 0.5;
  const IMG_W = SCREEN_WIDTH - 24;

  const setOpacityFromX = (x) => {
    setOpacity(Math.min(1, Math.max(0, x / IMG_W)));
  };

  return (
    <Modal visible transparent animationType="fade">
      <View style={styles.wrap}>
        <View style={styles.header}>
          <Text style={styles.title}>Compare Progress</Text>
          <TouchableOpacity onPress={onClose} style={{ padding: 6 }}>
            <Ionicons name="close" size={24} color={colors.text} />
          </TouchableOpacity>
        </View>

        <View style={styles.modeRow}>
          {[
            { key: 'side', label: 'Side by Side' },
            { key: 'slider', label: 'Slider' },
            { key: 'overlay', label: 'Overlay' },
          ].map((m) => (
            <TouchableOpacity
              key={m.key}
              style={[styles.modeBtn, mode === m.key && styles.modeBtnOn]}
              onPress={() => setMode(m.key)}
            >
              <Text style={[styles.modeText, mode === m.key && { color: '#fff' }]}>{m.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? (
          <View style={styles.center}><Text style={styles.dim}>Loading…</Text></View>
        ) : !uriA || !uriB ? (
          <View style={styles.center}>
            <Text style={styles.dim}>This photo is no longer available.</Text>
          </View>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            {mode === 'side' && (
              <View style={styles.sideRow}>
                <View style={styles.sideCell}>
                  <Image source={{ uri: uriA }} style={{ width: '100%', height: IMG_H * 0.7, borderRadius: 10 }} resizeMode="contain" />
                  <Text style={styles.caption}>{formatDateShort(a.date || a.photo_date)} · Earlier</Text>
                </View>
                <View style={styles.sideCell}>
                  <Image source={{ uri: uriB }} style={{ width: '100%', height: IMG_H * 0.7, borderRadius: 10 }} resizeMode="contain" />
                  <Text style={styles.caption}>{formatDateShort(b.date || b.photo_date)} · Current</Text>
                </View>
              </View>
            )}

            {mode === 'slider' && (
              <View style={styles.sliderWrap} {...pan.panHandlers}>
                <Image source={{ uri: uriB }} style={{ width: IMG_W, height: IMG_H, borderRadius: 12 }} resizeMode="cover" />
                <View style={[styles.sliderClip, { width: slider * IMG_W }]}>
                  <Image source={{ uri: uriA }} style={{ width: IMG_W, height: IMG_H }} resizeMode="cover" />
                </View>
                <View style={[styles.sliderHandle, { left: slider * IMG_W - 17 }]}>
                  <Ionicons name="swap-horizontal" size={18} color="#fff" />
                </View>
              </View>
            )}
            {mode === 'slider' && (
              <View style={styles.sliderLabels}>
                <Text style={styles.sliderLabel}>{formatDateShort(a.date || a.photo_date)}</Text>
                <Text style={styles.sliderLabel}>{formatDateShort(b.date || b.photo_date)}</Text>
              </View>
            )}

            {mode === 'overlay' && (
              <View>
                <View style={styles.overlayBox}>
                  <Image source={{ uri: uriB }} style={{ width: IMG_W, height: IMG_H, borderRadius: 12 }} resizeMode="cover" />
                  <Image
                    source={{ uri: uriA }}
                    style={{ width: IMG_W, height: IMG_H, borderRadius: 12, position: 'absolute', opacity }}
                    resizeMode="cover"
                  />
                </View>
                <Text style={styles.opacityLabel}>
                  Earlier photo opacity: {Math.round(opacity * 100)}%
                </Text>
                <TouchableOpacity
                  style={styles.opacityTrack}
                  onPress={(e) => setOpacityFromX(e.nativeEvent.locationX)}
                  activeOpacity={1}
                >
                  <View style={styles.opacityRail}>
                    <View style={[styles.opacityKnob, { left: `${opacity * 100}%` }]} />
                  </View>
                </TouchableOpacity>
                <View style={styles.opacityLabels}>
                  <Text style={styles.opacityLabelsText}>0% — only current</Text>
                  <Text style={styles.opacityLabelsText}>100% — only earlier</Text>
                </View>
              </View>
            )}
          </View>
        )}

        <TouchableOpacity style={styles.doneBtn} onPress={onClose}>
          <Text style={styles.doneText}>Done</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    wrap: { flex: 1, backgroundColor: colors.bg, paddingTop: 50, paddingHorizontal: 12 },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
    title: { color: colors.text, fontSize: 18, fontWeight: '800' },
    modeRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
    modeBtn: {
      flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10,
      backgroundColor: colors.cardLight,
    },
    modeBtnOn: { backgroundColor: colors.primary },
    modeText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    dim: { color: colors.textDim },
    sideRow: { flexDirection: 'row', gap: 8, width: '100%' },
    sideCell: { flex: 1, alignItems: 'center' },
    caption: { color: colors.textDim, fontSize: 12, marginTop: 6 },
    sliderWrap: { position: 'relative', borderRadius: 12, overflow: 'hidden' },
    sliderClip: {
      position: 'absolute', top: 0, left: 0, height: '100%', overflow: 'hidden',
      borderRightWidth: 2, borderRightColor: colors.primary,
    },
    sliderHandle: {
      position: 'absolute', top: '50%', marginTop: -17, width: 34, height: 34,
      borderRadius: 17, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center',
    },
    sliderLabels: {
      flexDirection: 'row', justifyContent: 'space-between',
      alignSelf: 'stretch', paddingHorizontal: 4, marginTop: 8,
    },
    sliderLabel: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
    overlayBox: { position: 'relative' },
    opacityLabel: { color: colors.textDim, fontSize: 12, marginTop: 12, textAlign: 'center' },
    opacityTrack: { height: 36, justifyContent: 'center', marginTop: 4 },
    opacityRail: { height: 6, backgroundColor: colors.cardLight, borderRadius: 3, marginHorizontal: 24, position: 'relative' },
    opacityKnob: {
      position: 'absolute', top: -7, width: 20, height: 20,
      borderRadius: 10, backgroundColor: colors.primary, marginLeft: -10,
    },
    opacityLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
    opacityLabelsText: { color: colors.textDim, fontSize: 10 },
    doneBtn: {
      alignSelf: 'center', backgroundColor: colors.primary, borderRadius: 12,
      paddingHorizontal: 40, paddingVertical: 13, marginBottom: 24, marginTop: 16,
    },
    doneText: { color: '#fff', fontWeight: '800' },
  });