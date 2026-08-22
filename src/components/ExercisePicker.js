import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  FlatList,
  Text,
  TextInput,
  // TouchableOpacity,
  // Pressable,
  TouchableOpacity,
  Pressable,
  Alert,
} from 'react-native';
import { listExercises, createExercise, getExerciseHistory, getExerciseBest } from '../db/queries';
import { MUSCLE_GROUPS } from '../seed/exercises';
import { useColors } from '../theme';
import MuscleIcon from './MuscleIcon';

// Modal to pick an exercise. Shows last performance ("previous: 60kg x 8")
// and allows creating custom exercises. onPick(exercise) is called on selection.
export default function ExercisePicker({ visible, onClose, onPick }) {
  const colors = useColors();
  const [exercises, setExercises] = useState([]);
  const [query, setQuery] = useState('');
  const [group, setGroup] = useState('All');
  const [newName, setNewName] = useState('');
  const [newGroup, setNewGroup] = useState(MUSCLE_GROUPS[0]);
  const [showAdd, setShowAdd] = useState(false);

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
      backgroundColor: colors.card,
      borderRadius: 10,
      padding: 14,
      marginBottom: 8,
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
    }
  }, [visible]);

  const filtered = exercises.filter((e) => {
    const matchesGroup = group === 'All' || e.muscle_group === group;
    const matchesQuery = e.name.toLowerCase().includes(query.toLowerCase());
    return matchesGroup && matchesQuery;
  });

  const pick = async (exercise) => {
    const history = await getExerciseHistory(exercise.id, 3);
    const best = await getExerciseBest(exercise.id);
    onPick(exercise, history, best);
    onClose();
  };

  // const addCustom = async () => {
  //   if (!newName.trim()) return;
  //   const id = await createExercise(newName, newGroup);
  //   setExercises(await listExercises());
  //   setNewName('');
  //   setShowAdd(false);
  // };

    const addCustom = async () => {
    if (!newName.trim()) return;
    try {
      const id = await createExercise(newName, newGroup);
      setExercises(await listExercises());
      setNewName('');
      setShowAdd(false);
    } catch (e) {
      Alert.alert('Could not add exercise', e.message || 'Please try again.');
    }
  };

  return (
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
            <TouchableOpacity style={styles.row} onPress={() => pick(item)}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <MuscleIcon group={item.muscle_group} size={24} color={colors.primary} />
                <View style={{ marginLeft: 12, flex: 1 }}>
                  <Text style={styles.rowName}>{item.name}</Text>
                  <Text style={styles.rowGroup}>{item.muscle_group}</Text>
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      </View>
    </Modal>
  );
}
