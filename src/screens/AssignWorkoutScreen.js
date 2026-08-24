import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  Alert,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../lib/api';
import ExercisePicker from '../components/ExercisePicker';
import AlternativesEditor from '../components/AlternativesEditor';
import { getExerciseByName } from '../db/queries';
import ExerciseDetailSheet from '../components/ExerciseDetailSheet';
import RestEditorModal from '../components/RestEditorModal';
import { groupLabels } from '../store/WorkoutContext';
import { useColors } from '../theme';

let groupCounter = 0;
const nextGroupId = () => `a${Date.now()}_${++groupCounter}`;

const NUMS = { fontVariant: ['tabular-nums'] };

export default function AssignWorkoutScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { clientId, clientName, planId, prefill } = route.params || {};
  const isEditing = !!planId;
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [nameError, setNameError] = useState(false);
  const [exercises, setExercises] = useState([]);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [restEditIdx, setRestEditIdx] = useState(null);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [alsoSaveTemplate, setAlsoSaveTemplate] = useState(false);
  const [loading, setLoading] = useState(isEditing);

    const [detailEx, setDetailEx] = useState(null);

  // Assigned-plan rows carry only exercise NAMES from the server — resolve
  // the full enriched record (instructions, equipment, languages) from the
  // local library on demand. Falls back to the row itself.
  const showDetail = async (ex) => {
    try {
      const full = await getExerciseByName(ex.name);
      if (full) return setDetailEx(full);
    } catch {}
    setDetailEx(ex);
  };

  useEffect(() => {
    if (isEditing) {
      api(`/trainer/clients/${clientId}/assigned-plans`)
        .then((plans) => {
          const plan = plans.find((p) => p.id === planId);
          if (plan) {
            setName(plan.name);
            setNotes(plan.notes || '');
            setExercises(
              (plan.exercises || []).map((e, i) => ({
                id: `ex_${i}`,
                name: e.exercise_name,
                muscle_group: '',
                targetSets: e.target_sets,
                restSeconds: e.rest_seconds || 90,
                groupId: e.group_id,
                alternatives: (e.alternatives || []).map((a) => a.alternative_exercise_name ?? a),
              }))
            );
          }
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }
  }, [planId, clientId, isEditing]);

  React.useEffect(() => {
    if (!prefill) return;
    setName(prefill.name || '');
    setNotes(prefill.notes || '');
    setExercises(
      (prefill.exercises || []).map((ex, i) => ({
        id: `p${i}`,
        name: ex.name,
        muscle_group: '',
        targetSets: ex.targetSets || 3,
        restSeconds: ex.restSeconds || 90,
        groupId: ex.groupId || null,
        alternatives: ex.alternatives || [],
      }))
    );
  }, [prefill]);

  React.useLayoutEffect(() => {
    navigation.setOptions({
      title: isEditing ? `Edit for ${clientName || 'Client'}` : `Assign to ${clientName || 'Client'}`,
    });
  }, [navigation, clientName, isEditing]);

  const toggleSelect = (i) =>
    setSelected((prev) => (prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]));

  const linkSelected = () => {
    if (selected.length < 2) {
      Alert.alert('Superset', 'Select at least 2 exercises to link.');
      return;
    }
    const groupId = nextGroupId();
    setExercises((prev) => prev.map((e, i) => (selected.includes(i) ? { ...e, groupId } : e)));
    setSelected([]);
    setSelectMode(false);
  };

  const saveWorkout = async () => {
    if (busy) return;
    if (!name.trim()) {
      setNameError(true);
      Alert.alert('Name required', 'Give this workout a name.');
      return;
    }
    if (!exercises.length) {
      Alert.alert('No exercises', 'Add at least one exercise before assigning.');
      return;
    }
    setBusy(true);
    try {
      const exercisesPayload = exercises.map((e, i) => ({
        exercise_name: e.name,
        target_sets: e.targetSets,
        target_reps: null,
        target_weight_note: null,
        order_index: i,
        rest_seconds: e.restSeconds,
        notes: null,
        group_id: e.groupId || null,
        alternatives: (e.alternatives || []).map((a) =>
          typeof a === 'string' ? a : a.alternative_exercise_name ?? a.name
        ),
      }));

      if (isEditing) {
        await api(`/trainer/clients/${clientId}/assigned-plans/${planId}`, {
          method: 'PUT',
          body: {
            name: name.trim(),
            notes: notes.trim() || null,
            exercises: exercisesPayload,
          },
        });
      } else {
        await api(`/trainer/clients/${clientId}/assigned-plans`, {
          method: 'POST',
          body: {
            name: name.trim(),
            notes: notes.trim() || null,
            exercises: exercisesPayload,
          },
        });
      // independent second write: seed the reusable template library
      if (alsoSaveTemplate) {
        await api('/trainer/workout-templates', {
          method: 'POST',
          body: {
            name: name.trim(),
            notes: notes.trim() || null,
            tags: [],
            exercises: exercises.map((e, i) => ({
              exercise_name: e.name,
              target_sets: e.targetSets,
              target_reps: null,
              target_weight_note: null,
              order_index: i,
              rest_seconds: e.restSeconds,
              notes: null,
              group_id: e.groupId || null,
              alternatives: (e.alternatives || []).map((a) =>
                typeof a === 'string' ? a : a.alternative_exercise_name ?? a.name
              ),
            })),
          },
        });
      }
      }
      navigation.navigate('ClientDetail', {
        ...route.params,
        assignedToast: name.trim(),
        refreshKey: Date.now(),
      });
    } catch (e) {
      Alert.alert('Could not save workout', e.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const labels = groupLabels(exercises);
  const canSuperset = exercises.length >= 2;

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ color: colors.textDim }}>Loading...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      <TextInput
        style={[styles.input, nameError && !name.trim() && styles.inputError]}
        placeholder="Workout name (e.g. Hypertrophy A)"
        placeholderTextColor={colors.textDim}
        value={name}
        onChangeText={(t) => { setName(t); setNameError(false); }}
      />
      <TextInput
        style={[styles.input, styles.notesInput]}
        placeholder="Notes for this plan (optional)"
        placeholderTextColor={colors.textDim}
        value={notes}
        onChangeText={setNotes}
        multiline
      />

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
            key={ex.id}
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
              {/* {!selectMode && (
                <View style={{ flex: 1 }}>
                  <Text style={styles.exName}>{ex.name}</Text>
                  <Text style={styles.exGroup}>{ex.muscle_group}</Text>
                </View>
              )} */}

                {!selectMode && (
                <View style={{ flex: 1 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Text style={styles.exName}>{ex.name}</Text>
                    <TouchableOpacity
                      onPress={() => showDetail(ex)}
                      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                    >
                      <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.exGroup}>{ex.muscle_group}</Text>
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
                <TouchableOpacity
                  style={styles.unlinkBtn}
                  onPress={() =>
                    setExercises((prev) => prev.map((e, i) => (i === idx ? { ...e, groupId: null } : e)))
                  }
                >
                  {ex.groupId ? <Ionicons name="unlink" size={15} color={colors.textDim} /> : null}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.removeBtn}
                  onPress={() => setExercises((prev) => prev.filter((_, i) => i !== idx))}
                >
                  <Ionicons name="close" size={16} color={colors.textDim} />
                </TouchableOpacity>
              </View>
            )}
            {!selectMode && (
              <AlternativesEditor
                primaryName={ex.name}
                alternatives={ex.alternatives || []}
                excludeNames={exercises.filter((_, j) => j !== idx).map((e) => e.name)}
                onChange={(alternatives) =>
                  setExercises((prev) =>
                    prev.map((e, i) => (i === idx ? { ...e, alternatives } : e))
                  )
                }
              />
            )}
          </View>
        );
      })}

      <TouchableOpacity style={styles.addBtn} onPress={() => setPickerVisible(true)}>
        <Ionicons name="add" size={18} color={colors.primary} />
        <Text style={styles.addBtnText}>Add Exercise</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.checkRow} onPress={() => setAlsoSaveTemplate((v) => !v)}>
        <Ionicons name={alsoSaveTemplate ? 'checkbox' : 'square-outline'} size={18} color={colors.primary} />
        <Text style={styles.checkText}>Also save this as a reusable template</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.assignBtn} onPress={saveWorkout} disabled={busy}>
        <Text style={styles.assignBtnText}>
          {busy ? (isEditing ? 'Saving…' : 'Assigning…') : isEditing ? 'Save Changes' : 'Assign Workout'}
        </Text>
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


      <ExerciseDetailSheet visible={!!detailEx} exercise={detailEx} onClose={() => setDetailEx(null)} />


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
      backgroundColor: colors.cardLight,
      color: colors.text,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 13,
      marginBottom: 10,
      fontSize: 15,
      borderWidth: 1.5,
      borderColor: 'transparent',
    },
    inputError: { borderColor: colors.red },
    notesInput: { minHeight: 64, paddingTop: 12 },

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
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.12,
      shadowRadius: 8, elevation: 2,
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
    exGroup: { color: colors.textDim, fontSize: 12, marginTop: 2 },
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

    checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
    checkText: { color: colors.text, fontSize: 13 },
    assignBtn: {
      backgroundColor: colors.primary, borderRadius: 14, padding: 16, alignItems: 'center',
      shadowColor: colors.primary, shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.35, shadowRadius: 12, elevation: 5,
    },
    assignBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  });
