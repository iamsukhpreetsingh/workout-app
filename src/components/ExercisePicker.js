import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  FlatList,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { listExercises, createExercise, getExerciseHistory, getExerciseBest, getLastSessionSetsByPosition } from '../db/queries';
import { MUSCLE_GROUPS } from '../seed/exercises';
import { useColors } from '../theme';
import MuscleIcon from './MuscleIcon';
import ExerciseDetailSheet from './ExerciseDetailSheet';

// Modal to pick an exercise. Shows last performance ("previous: 60kg x 8")
// and allows creating custom exercises. onPick(exercise) is called on selection.
// Every row also carries an ⓘ button opening the ExerciseDetailSheet
// (multilingual instructions, equipment, steps) as a SIBLING of this Modal.
// `excludeNames`: names already in use (e.g. the primary exercise or an
// existing alternative) are filtered out of the results — duplicate
// prevention at the picker level for the alternatives feature.
export default function ExercisePicker({ visible, onClose, onPick, excludeNames = [] }) {
  const colors = useColors();
  const excludeSet = React.useMemo(
    () => new Set(excludeNames.map((n) => String(n || '').trim().toLowerCase())),
    [excludeNames]
  );
  const [exercises, setExercises] = useState([]);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('All');
  const [newName, setNewName] = useState('');
  const [newGroup, setNewGroup] = useState(MUSCLE_GROUPS[0]);
  const [showAdd, setShowAdd] = useState(false);
  const [detail, setDetail] = useState(null);
  const [newEquipment, setNewEquipment] = useState('');
  const [newInstructions, setNewInstructions] = useState('');

  const styles = {
    container: { flex: 1, backgroundColor: colors.bg, paddingTop: 60, paddingHorizontal: 16 },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
    title: { color: colors.text, fontSize: 18, fontWeight: '700' },
    closeBtn: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    search: {
      backgroundColor: colors.card,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      marginBottom: 10,
    },
    groupChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
    chip: {
      backgroundColor: colors.card,
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    chipActive: { backgroundColor: colors.primary },
    chipText: { color: colors.textDim, fontSize: 12 },
    chipTextActive: { color: '#fff' },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: 10,
      paddingLeft: 14,
      paddingRight: 4,
      paddingVertical: 8,
      marginBottom: 8,
    },
    // selection target — ends BEFORE the info zone so the two never overlap
    rowSelect: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingVertical: 6 },
    // dedicated right-edge info zone, clearly separated from selection
    rowInfoBtn: {
      width: 44,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowName: { color: colors.text, fontSize: 15, fontWeight: '600' },
    rowGroup: { color: colors.textDim, fontSize: 12, marginTop: 2 },
    addRow: { backgroundColor: colors.card, borderRadius: 10, padding: 12, marginBottom: 10 },
    addInput: {
      backgroundColor: colors.cardLight,
      color: colors.text,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginBottom: 8,
    },
    addBtn: { backgroundColor: colors.primary, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
    addBtnText: { color: '#fff', fontWeight: '700' },
  };

  useEffect(() => {
    if (visible) {
      listExercises().then(setExercises);
      setQuery('');
      setGroup('All');
      setShowAdd(false);
      setNewName('');
      setNewEquipment('');
      setNewInstructions('');
    }
  }, [visible]);

  const filtered = exercises.filter((e) => {
    if (excludeSet.has(String(e.name).trim().toLowerCase())) return false;
    const matchesGroup = group === 'All' || e.muscle_group === group;
    const matchesQuery = e.name.toLowerCase().includes(query.toLowerCase());
    return matchesGroup && matchesQuery;
  });

  const pick = async (exercise) => {
    // Per-set positional history: the most recent prior session's sets, in
    // set order — each new set row pre-fills ITS OWN position's last value.
    const history = await getLastSessionSetsByPosition(exercise.id);
    const best = await getExerciseBest(exercise.id);
    onPick(exercise, history, best);
    onClose();
  };

  // Custom exercises carry the optional equipment + instructions fields
  // through createExercise → the sync engine → /user/backup/custom-exercises.
  const addCustom = async () => {
    if (!newName.trim()) return;
    try {
      await createExercise(newName, newGroup, {
        equipment: newEquipment,
        instructions: newInstructions,
      });
      setExercises(await listExercises());
      setNewName('');
      setNewEquipment('');
      setNewInstructions('');
      setShowAdd(false);
    } catch (e) {
      Alert.alert('Could not add exercise', e.message || 'Please try again.');
    }
  };

  // The Fragment (<> … </>) wraps the Modal AND the detail sheet so this
  // component returns exactly one parent element — React's hard rule.
  // The sheet lives OUTSIDE the Modal so it slides over everything and
  // closing it drops the user back into the picker where they left off.
  return (
    <>
      <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
        <View style={styles.container}>
          <View style={styles.header}>
            <TouchableOpacity onPress={onClose}>
              <Text style={styles.closeBtn}>Close</Text>
            </TouchableOpacity>
            <Text style={styles.title}>Select Exercise</Text>
            <TouchableOpacity onPress={() => setShowAdd((v) => !v)}>
              <Text style={styles.closeBtn}>+ New</Text>
            </TouchableOpacity>
          </View>

          {showAdd && (
            <View style={styles.addRow}>
              <TextInput
                style={styles.addInput}
                placeholder="Exercise name"
                placeholderTextColor={colors.textDim}
                value={newName}
                onChangeText={setNewName}
              />
              <View style={styles.groupChips}>
                {MUSCLE_GROUPS.map((g) => (
                  <Pressable
                    key={g}
                    onPress={() => setNewGroup(g)}
                    style={[styles.chip, newGroup === g && styles.chipActive]}
                  >
                    <Text style={[styles.chipText, newGroup === g && styles.chipTextActive]}>
                      {g}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <TextInput
                style={styles.addInput}
                placeholder="Equipment (optional — e.g. barbell)"
                placeholderTextColor={colors.textDim}
                value={newEquipment}
                onChangeText={setNewEquipment}
              />
              <TextInput
                style={[styles.addInput, { minHeight: 60 }]}
                placeholder="Instructions (optional)"
                placeholderTextColor={colors.textDim}
                value={newInstructions}
                onChangeText={setNewInstructions}
                multiline
              />
              <TouchableOpacity style={styles.addBtn} onPress={addCustom}>
                <Text style={styles.addBtnText}>Add exercise</Text>
              </TouchableOpacity>
            </View>
          )}

          <TextInput
            style={styles.search}
            placeholder="Search exercises"
            placeholderTextColor={colors.textDim}
            value={query}
            onChangeText={setQuery}
          />

          <View style={styles.groupChips}>
            {['All', ...MUSCLE_GROUPS].map((g) => (
              <Pressable key={g} onPress={() => setGroup(g)} style={[styles.chip, group === g && styles.chipActive]}>
                <Text style={[styles.chipText, group === g && styles.chipTextActive]}>{g}</Text>
              </Pressable>
            ))}
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(item) => String(item.id)}
            renderItem={({ item }) => (
              // SIBLING touchables, not nested: the selection area ends
              // BEFORE the info zone, so a tap on the row can never land in
              // the ⓘ hit area (the old nested button + 10px hitSlop
              // overlapped the row and stole taps meant to select).
              <View style={styles.row}>
                <TouchableOpacity style={styles.rowSelect} onPress={() => pick(item)}>
                  <MuscleIcon group={item.muscle_group} size={24} color={colors.primary} />
                  <View style={{ marginLeft: 12, flex: 1 }}>
                    <Text style={styles.rowName}>{item.name}</Text>
                    <Text style={styles.rowGroup}>{item.muscle_group}</Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.rowInfoBtn}
                  onPress={() => setDetail(item)}
                  hitSlop={{ top: 6, bottom: 6 }}
                  accessibilityLabel={`About ${item.name}`}
                >
                  <Ionicons name="information-circle-outline" size={22} color={colors.textDim} />
                </TouchableOpacity>
              </View>
            )}
          />
        </View>
      </Modal>

      <ExerciseDetailSheet visible={!!detail} exercise={detail} onClose={() => setDetail(null)} />
    </>
  );
}