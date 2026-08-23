import React, { useEffect, useMemo, useState } from 'react';
import { Modal, View, Text, ScrollView, TouchableOpacity, StyleSheet, TextInput, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import { setExerciseTrainingMax } from '../db/queries';

const LANG_LABELS = {
  en: 'EN', it: 'IT', tr: 'TR', es: 'ES', ru: 'RU',
  zh: '中文', hi: 'हिन्दी', pl: 'PL', ko: '한국어', fr: 'FR',
};

function parseObj(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch { return null; }
}
function parseArr(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; }
}

// Exercise details sheet: multilingual instructions with a language switch
// (English default), equipment/body-part/target metadata, secondary
// muscles, numbered steps, and a media placeholder — swap in real
// image/gif rendering later where marked.
export default function ExerciseDetailSheet({ visible, exercise, onClose }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [lang, setLang] = useState('en');
  const [tm, setTm] = useState('');
  const [tmBusy, setTmBusy] = useState(false);

//   useEffect(() => { if (visible) setLang('en'); }, [visible, exercise?.id]);
  useEffect(() => {
    if (visible) {
      setLang('en');
      setTm(exercise?.training_max != null ? String(exercise.training_max) : '');
    }
  }, [visible, exercise?.id]);

  const instructions = parseObj(exercise?.instructions);
  const steps = parseObj(exercise?.instruction_steps);
  const secondary = parseArr(exercise?.secondary_muscles) || [];

  const available = useMemo(() => {
    const keys = new Set([...Object.keys(instructions || {}), ...Object.keys(steps || {})]);
    if (!keys.size) keys.add('en');
    return [...keys];
  }, [visible, exercise?.id]);

    const saveTm = async () => {
    if (tmBusy || !exercise?.id) return;
    setTmBusy(true);
    try {
      await setExerciseTrainingMax(exercise.id, tm);
    } catch (e) {
      Alert.alert('Could not save', e.message || 'Please try again.');
    } finally {
      setTmBusy(false);
    }
  };


  if (!visible || !exercise) return null;

  const rawText = typeof exercise.instructions === 'string' ? exercise.instructions : null;
  const text = instructions?.[lang] || instructions?.en || rawText || 'No instructions available.';
  const stepList = steps?.[lang] || steps?.en || [];
  const hasLangChoice = available.length > 1;

  const Chip = ({ label }) => (
    <View style={styles.chip}><Text style={styles.chipText}>{label}</Text></View>
  );

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.wrap}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={{ padding: 8 }}>
            <Ionicons name="chevron-back" size={24} color={colors.textDim} />
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>Exercise Details</Text>
          <View style={{ width: 24 }} />
        </View>

        <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}>
          <Text style={styles.name}>{exercise.name}</Text>
          {exercise.is_custom ? <Text style={styles.customTag}>Custom exercise</Text> : null}

          <View style={styles.chipRow}>
            {exercise.muscle_group ? <Chip label={exercise.muscle_group} /> : null}
            {exercise.body_part && exercise.body_part !== exercise.muscle_group ? <Chip label={exercise.body_part} /> : null}
            {exercise.equipment ? <Chip label={exercise.equipment} /> : null}
            {exercise.target ? <Chip label={`Target: ${exercise.target}`} /> : null}
          </View>
          {secondary.length > 0 && (
            <View style={styles.chipRow}>
              {secondary.map((m, i) => <Chip key={`${m}-${i}`} label={m} />)}
            </View>
          )}

          {/* MEDIA PLACEHOLDER — replace the inner block with an Image/GIF
              (source: exercise.gif_url / media assets) when media exists */}
          <View style={styles.mediaBox}>
            <Ionicons name="image-outline" size={34} color={colors.textDim} />
            <Text style={styles.mediaText}>Exercise media coming soon</Text>
          </View>

          {hasLangChoice && (
            <View style={styles.langRow}>
              {available.map((l) => (
                <TouchableOpacity
                  key={l}
                  style={[styles.langChip, lang === l && styles.langChipOn]}
                  onPress={() => setLang(l)}
                >
                  <Text style={[styles.langText, lang === l && { color: '#fff' }]}>
                    {LANG_LABELS[l] || l.toUpperCase()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <Text style={styles.sectionLabel}>Instructions</Text>
          <Text style={styles.body}>{text}</Text>

          {stepList.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>Step by step</Text>
              {stepList.map((s, i) => (
                <View key={i} style={styles.stepRow}>
                  <View style={styles.stepNum}><Text style={styles.stepNumText}>{i + 1}</Text></View>
                  <Text style={styles.stepText}>{s}</Text>
                </View>
              ))}
            </>
          )}

            {/* Training max — input for the Percentage-Based progression formula */}
          {exercise.id ? (
            <View style={styles.tmCard}>
              <Text style={styles.tmLabel}>TRAINING MAX (KG)</Text>
              <Text style={styles.tmHint}>
                Used by the Percentage-Based progression strategy to calculate your working weights.
              </Text>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <TextInput
                  style={styles.tmInput}
                  keyboardType="numeric"
                  value={tm}
                  onChangeText={setTm}
                  placeholder="—"
                  placeholderTextColor={colors.textDim}
                />
                <TouchableOpacity style={styles.tmSave} onPress={saveTm} disabled={tmBusy}>
                  <Text style={styles.tmSaveText}>{tmBusy ? 'Saving…' : 'Save'}</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : null}


          {exercise.attribution ? (
            <Text style={styles.attribution}>{exercise.attribution}</Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    wrap: { flex: 1, backgroundColor: colors.bg, paddingTop: 12 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingVertical: 6 },
    title: { color: colors.text, fontSize: 17, fontWeight: '800' },
    name: { color: colors.text, fontSize: 24, fontWeight: '800', marginTop: 8 },
    customTag: { color: colors.primary, fontSize: 12, fontWeight: '700', marginTop: 4 },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
    chip: { backgroundColor: colors.cardLight, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 4 },
    chipText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
    mediaBox: {
      height: 150, borderRadius: 14, backgroundColor: colors.card, marginTop: 16,
      alignItems: 'center', justifyContent: 'center', gap: 6,
    },
    mediaText: { color: colors.textDim, fontSize: 12, fontStyle: 'italic' },
    langRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 16 },
    langChip: { backgroundColor: colors.cardLight, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 6 },
    langChipOn: { backgroundColor: colors.primary },
    langText: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
    sectionLabel: { color: colors.textDim, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 18, marginBottom: 6 },
    body: { color: colors.text, fontSize: 14, lineHeight: 21 },
    stepRow: { flexDirection: 'row', gap: 10, marginBottom: 8 },
    stepNum: { width: 22, height: 22, borderRadius: 7, backgroundColor: colors.cardLight, alignItems: 'center', justifyContent: 'center' },
    stepNumText: { color: colors.primary, fontSize: 11, fontWeight: '800' },
    stepText: { color: colors.text, fontSize: 13, lineHeight: 19, flex: 1 },
    attribution: { color: colors.textDim, fontSize: 10, fontStyle: 'italic', marginTop: 20 },
        tmCard: {
      backgroundColor: colors.card, borderRadius: 12, padding: 12, marginTop: 20,
    },
    tmLabel: { color: colors.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
    tmHint: { color: colors.textDim, fontSize: 11, marginTop: 4, lineHeight: 15 },
    tmInput: {
      flex: 1, backgroundColor: colors.cardLight, color: colors.text,
      borderRadius: 8, paddingHorizontal: 12, paddingVertical: 9, fontSize: 14,
    },
    tmSave: {
      backgroundColor: colors.primary, borderRadius: 8, paddingHorizontal: 18,
      alignItems: 'center', justifyContent: 'center',
    },
    tmSaveText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  });