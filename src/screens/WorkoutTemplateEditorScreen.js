import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../lib/api';
import ExercisePicker from '../components/ExercisePicker';
import RestEditorModal from '../components/RestEditorModal';
import { groupLabels } from '../store/WorkoutContext';
import { useColors } from '../theme';

const NUMS = { fontVariant: ['tabular-nums'] };
const PRESET_TAGS = ['push', 'pull', 'legs', 'full body', 'beginner', 'hypertrophy', 'strength', 'conditioning'];

let uid = 0;
const nid = () => `t${Date.now()}_${++uid}`;

// Template editor — the same builder UI as the Assign Workout flow, saving
// to the trainer's reusable template library instead of a client assignment.
export default function WorkoutTemplateEditorScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { templateId } = route.params || {};

  const [loading, setLoading] = useState(!!templateId);
  const [id, setId] = useState(templateId || null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [tags, setTags] = useState([]);
  const [exercises, setExercises] = useState([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [restEditIdx, setRestEditIdx] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  React.useLayoutEffect(() => {
    navigation.setOptions({
      title: id ? 'Edit Template' : 'New Template',
      headerRight: () =>
        id ? (
          <TouchableOpacity
            onPress={confirmDelete}
            style={{ padding: 8 }}
          >
            <Ionicons name="trash-outline" size={20} color={colors.red} />
          </TouchableOpacity>
        ) : null,
    });
  }, [navigation, id, colors]);

  React.useEffect(() => {
    if (!templateId) return;
    api(`/trainer/workout-templates/${templateId}`)
      .then((tpl) => {
        setId(tpl.id);
        setName(tpl.name);
        setNotes(tpl.notes || '');
        setTags(tpl.tags || []);
        setExercises(
          (tpl.exercises || []).map((ex) => ({
            id: ex.id,
            name: ex.exercise_name,
            muscle_group: '',
            targetSets: ex.target_sets,
            restSeconds: ex.rest_seconds || 90,
            groupId: ex.group_id || null,
          }))
        );
      })
      .catch((e) => {
        Alert.alert('Could not load template', e.message || 'Please try again.', [
          { text: 'OK', onPress: () => navigation.goBack() },
        ]);
      })
      .finally(() => setLoading(false));
  }, [templateId]);

  const confirmDelete = () =>
    Alert.alert(
      'Delete template',
      'This template will be removed from your library. Workouts already assigned from it are unaffected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await api(`/trainer/workout-templates/${id}`, { method: 'DELETE' });
              navigation.goBack();
            } catch (e) {
              Alert.alert('Could not delete', e.message || 'Please try again.');
            }
          },
        },
      ]
    );

  const toggleSelect = (i) =>
    setSelected((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]));

  const linkSelected = () => {
    if (selected.length < 2) {
      Alert.alert('Superset', 'Select at least 2 exercises to link.');
      return;
    }
    const groupId = nid();
    setExercises((prev) => prev.map((e, i) => (selected.includes(i) ? { ...e, groupId } : e)));
    setSelected([]);
    setSelectMode(false);
  };

  const toApi = () => ({
    name: name.trim(),
    notes: notes.trim() || null,
    tags,
    exercises: exercises.map((e, i) => ({
      exercise_name: e.name,
      target_sets: e.targetSets,
      target_reps: null,
      target_weight_note: null,
      order_index: i,
      rest_seconds: e.restSeconds,
      notes: null,
      group_id: e.groupId || null,
    })),
  });

  const save = async () => {
    if (busy) return;
    if (!name.trim()) return Alert.alert('Name required', 'Give this template a name.');
    if (!exercises.length) return Alert.alert('No exercises', 'Add at least one exercise.');
    setBusy(true);
    try {
      if (id) {
        await api(`/trainer/workout-templates/${id}`, { method: 'PATCH', body: toApi() });
      } else {
        await api('/trainer/workout-templates', { method: 'POST', body: toApi() });
      }
      navigation.goBack();
    } catch (e) {
      Alert.alert('Could not save template', e.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const toggleTag = (t) =>
    setTags((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const labels = groupLabels(exercises);
  const canSuperset = exercises.length >= 2;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      <TextInput
        style={styles.input}
        placeholder="Template name (e.g. Push Day A)"
        placeholderTextColor={colors.textDim}
        value={name}
        onChangeText={setName}
      />
      <TextInput
        style={[styles.input, { minHeight: 56 }]}
        placeholder="Notes (optional)"
        placeholderTextColor={colors.textDim}
        value={notes}
        onChangeText={setNotes}
        multiline
      />

      <View style={styles.tagRow}>
        {PRESET_TAGS.map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tagChip, tags.includes(t) && styles.tagChipOn]}
            onPress={() => toggleTag(t)}
          >
            <Text style={[styles.tagText, tags.includes(t) && { color: '#fff' }]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {canSuperset && (
        <View style={styles.selectBar}>
          {selectMode ? (
            <>
              <TouchableOpacity style={styles.selectCancel} onPress={() => { setSelectMode(false); setSelected([]); }}>
                <Text style={styles.selectCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.selectConfirm, selected.length < 2 && { opacity: 0.45 }]}
                onPress={linkSelected}
              >
                <Ionicons name="link" size={15} color="#fff" />
                <Text style={styles.selectConfirmText}>Link ({selected.length})</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              style={styles.supersetChip}
              onPress={() => { setSelectMode(true); setSelected([]); }}
            >
              <Ionicons name="link" size={15} color={colors.blue} />
              <Text style={styles.supersetChipText}>Link as Superset</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {selectMode && <Text style={styles.selectHint}>Tap 2 or more exercises, then Link.</Text>}

      {exercises.map((ex, idx) => {
        const firstInGroup = ex.groupId && exercises[idx - 1]?.groupId !== ex.groupId;
        return (
          <View
            key={ex.id || idx}
            style={[
              styles.exRow,
              ex.groupId && styles.groupedRow,
              selectMode && selected.includes(idx) && styles.selectedRow,
            ]}
          >
            {firstInGroup && <Text style={styles.groupLabel}>Superset {labels[ex.groupId]}</Text>}
            <View style={styles.exMain}>
              {selectMode ? (
                <TouchableOpacity style={styles.selectCheck} onPress={() => toggleSelect(idx)}>
                  <Ionicons
                    name={selected.includes(idx) ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={colors.primary}
                  />
                  <Text style={styles.exName}>{ex.name}</Text>
                </TouchableOpacity>
              ) : (
                <View style={styles.idxBadge}>
                  <Text style={[styles.idxText, NUMS]}>{idx + 1}</Text>
                </View>
              )}
              {!selectMode && (
                <View style={{ flex: 1 }}>
                  <Text style={styles.exName}>{ex.name}</Text>
                </View>
              )}
            </View>
            {!selectMode && (
              <View style={styles.controls}>
                <TouchableOpacity
                  style={styles.stepper}
                  onPress={() =>
                    setExercises((prev) =>
                      prev.map((e, i) => (i === idx ? { ...e, targetSets: Math.max(1, e.targetSets - 1) } : e))
                    )
                  }
                >
                  <Ionicons name="remove" size={16} color={colors.text} />
                </TouchableOpacity>
                <Text style={[styles.setCount, NUMS]}>{ex.targetSets}</Text>
                <TouchableOpacity
                  style={styles.stepper}
                  onPress={() =>
                    setExercises((prev) =>
                      prev.map((e, i) => (i === idx ? { ...e, targetSets: Math.min(10, e.targetSets + 1) } : e))
                    )
                  }
                >
                  <Ionicons name="add" size={16} color={colors.text} />
                </TouchableOpacity>
                <Text style={styles.setsUnit}>sets</Text>
                <TouchableOpacity style={styles.restBtn} onPress={() => setRestEditIdx(idx)}>
                  <Ionicons name="time-outline" size={13} color={colors.textDim} />
                  <Text style={[styles.restText, NUMS]}>{ex.restSeconds}s</Text>
                </TouchableOpacity>
                {ex.groupId && (
                  <TouchableOpacity
                    style={styles.unlinkBtn}
                    onPress={() =>
                      setExercises((prev) => prev.map((e, i) => (i === idx ? { ...e, groupId: null } : e)))
                    }
                  >
                    <Ionicons name="unlink" size={15} color={colors.textDim} />
                  </TouchableOpacity>
                )}
                <TouchableOpacity
                  style={styles.removeBtn}
                  onPress={() => setExercises((prev) => prev.filter((_, i) => i !== idx))}
                >
                  <Ionicons name="close" size={16} color={colors.textDim} />
                </TouchableOpacity>
              </View>
            )}
          </View>
        );
      })}

      <TouchableOpacity style={styles.addBtn} onPress={() => setPickerVisible(true)}>
        <Ionicons name="add" size={18} color={colors.primary} />
        <Text style={styles.addBtnText}>Add Exercise</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={busy}>
        <Text style={styles.saveBtnText}>{busy ? 'Saving…' : 'Save Changes'}</Text>
      </TouchableOpacity>

      <ExercisePicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onPick={(exercise) =>
          setExercises((prev) =>
            prev.some((e) => e.id === exercise.id)
              ? prev
              : [...prev, { ...exercise, targetSets: 3, restSeconds: 90, groupId: null }]
          )
        }
      />

      <RestEditorModal
        visible={restEditIdx !== null}
        exerciseName={exercises[restEditIdx]?.name}
        initial={exercises[restEditIdx]?.restSeconds}
        onClose={() => setRestEditIdx(null)}
        onSave={(seconds) =>
          setExercises((prev) =>
            prev.map((e, i) => (i === restEditIdx ? { ...e, restSeconds: seconds } : e))
          )
        }
      />
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    input: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 12,
      paddingHorizontal: 14, paddingVertical: 13, marginBottom: 10, fontSize: 15,
      borderWidth: 1.5, borderColor: 'transparent',
    },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
    tagChip: {
      backgroundColor: colors.cardLight, borderRadius: 12,
      paddingHorizontal: 11, paddingVertical: 6,
    },
    tagChipOn: { backgroundColor: colors.primary },
    tagText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },

    selectBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginVertical: 8 },
    supersetChip: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: colors.cardLight, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8,
    },
    supersetChipText: { color: colors.blue, fontWeight: '700', fontSize: 13 },
    selectCancel: { padding: 8 },
    selectCancelText: { color: colors.textDim, fontWeight: '700', fontSize: 14 },
    selectConfirm: {
      flexDirection: 'row', alignItems: 'center', gap: 6,
      backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8,
    },
    selectConfirmText: { color: '#fff', fontWeight: '700', fontSize: 13 },
    selectHint: { color: colors.textDim, fontSize: 11, marginBottom: 8 },

    exRow: {
      backgroundColor: colors.card, borderRadius: 14, padding: 12, marginBottom: 8,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    groupedRow: {
      backgroundColor: colors.cardLight, borderLeftWidth: 3, borderLeftColor: colors.blue,
      borderTopLeftRadius: 4, borderBottomLeftRadius: 4,
    },
    selectedRow: { borderWidth: 2, borderColor: colors.primary },
    groupLabel: { color: colors.blue, fontWeight: '700', fontSize: 12, marginBottom: 6 },
    exMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    idxBadge: {
      width: 28, height: 28, borderRadius: 9, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    idxText: { color: colors.primary, fontWeight: '800', fontSize: 13 },
    exName: { color: colors.text, fontWeight: '700', fontSize: 15 },
    selectCheck: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },

    controls: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
    stepper: {
      backgroundColor: colors.cardLight, width: 34, height: 34, borderRadius: 10,
      alignItems: 'center', justifyContent: 'center',
    },
    setCount: { color: colors.text, width: 22, textAlign: 'center', fontWeight: '800', fontSize: 15 },
    setsUnit: { color: colors.textDim, fontSize: 11 },
    restBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.cardLight,
      borderRadius: 10, paddingHorizontal: 10, paddingVertical: 7,
    },
    restText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
    unlinkBtn: { padding: 8, width: 32 },
    removeBtn: { padding: 8 },

    addBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      borderRadius: 14, borderWidth: 1.5, borderColor: colors.primary,
      paddingVertical: 14, marginTop: 8, marginBottom: 16,
    },
    addBtnText: { color: colors.primary, fontWeight: '700', fontSize: 15 },
    saveBtn: {
      backgroundColor: colors.primary, borderRadius: 14, padding: 16, alignItems: 'center',
      shadowColor: colors.primary, shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.35, shadowRadius: 12, elevation: 5,
    },
    saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  });
