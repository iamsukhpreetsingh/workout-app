import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import ExercisePicker from './ExercisePicker';
import { useColors } from '../theme';

export const MAX_ALTERNATIVES = 3;

// Shared alternatives editor for ALL FOUR builder contexts (self-made
// Routine builder, trainer Template builder, Assign "Build New", Assign
// "Edit"). One component — never four near-duplicate copies.
//
// Props:
//   primaryName   — the exercise this entry is for
//   alternatives  — array of strings (alternative exercise names)
//   onChange      — (nextNames: string[]) => void
//   excludeNames  — extra names to disable in the picker (e.g. other
//                   exercises already on the plan), optional
// Entirely optional per entry: with zero alternatives only the collapsed
// "+ Add Alternative" affordance shows; nothing is required.
export default function AlternativesEditor({
  primaryName,
  alternatives = [],
  onChange,
  excludeNames = [],
}) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const atCap = alternatives.length >= MAX_ALTERNATIVES;

  const addAlternative = (exercise) => {
    // duplicate guard mirrors the server-side rule (belt and suspenders —
    // the picker already excludes used names)
    const dup = [primaryName, ...alternatives].some(
      (n) => String(n).trim().toLowerCase() === String(exercise.name).trim().toLowerCase()
    );
    if (dup || atCap) return;
    onChange([...alternatives, exercise.name]);
  };

  return (
    <View style={styles.wrap}>
      <TouchableOpacity style={styles.headerBtn} onPress={() => setExpanded((v) => !v)}>
        <Ionicons name="swap-horizontal" size={13} color={colors.blue} />
        <Text style={[styles.headerText, atCap && styles.headerTextCap]}>
          {atCap
            ? `${alternatives.length} alternative${alternatives.length === 1 ? '' : 's'}`
            : alternatives.length > 0
              ? 'Alternatives'
              : 'Add Alternative'}
        </Text>
        <Text style={styles.count}>{alternatives.length}/{MAX_ALTERNATIVES}</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textDim} />
      </TouchableOpacity>

      {expanded && (
        <View style={styles.list}>
          {alternatives.map((name, i) => (
            <View key={`${name}-${i}`} style={styles.row}>
              <Ionicons name="arrow-forward" size={12} color={colors.textDim} />
              <Text style={styles.rowName} numberOfLines={1}>{name}</Text>
              <TouchableOpacity
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => onChange(alternatives.filter((_, j) => j !== i))}
              >
                <Ionicons name="close" size={15} color={colors.textDim} />
              </TouchableOpacity>
            </View>
          ))}
          {alternatives.length > 0 && (
            <TouchableOpacity
              style={[styles.addRow, atCap && styles.addRowDisabled]}
              disabled={atCap}
              onPress={() => setPickerVisible(true)}
            >
              <Ionicons name="add" size={14} color={atCap ? colors.textDim : colors.primary} />
              <Text style={[styles.addText, atCap && styles.addTextDisabled]}>
                {atCap ? `Up to ${MAX_ALTERNATIVES} alternatives per exercise` : 'Add Alternative'}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      )}
      {!expanded && !atCap && (
        <TouchableOpacity style={styles.inlineAdd} onPress={() => setPickerVisible(true)}>
          <Ionicons name="add" size={14} color={colors.primary} />
          <Text style={styles.addText}>Add Alternative</Text>
        </TouchableOpacity>
      )}

      {/* SAME picker as the primary "+ Add Exercise" action — no second UI.
          The current primary + already-added alternatives are excluded. */}
      <ExercisePicker
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onPick={addAlternative}
        excludeNames={[primaryName, ...alternatives, ...excludeNames]}
      />
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    wrap: { marginTop: 8 },
    headerBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.cardLight,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 7,
      alignSelf: 'flex-start',
    },
    headerText: { color: colors.blue, fontWeight: '600', fontSize: 12 },
    headerTextCap: { color: colors.textDim },
    count: { color: colors.textDim, fontSize: 11, fontVariant: ['tabular-nums'] },
    list: { marginTop: 6, gap: 4 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.cardLight,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    rowName: { color: colors.text, fontSize: 13, flex: 1 },
    inlineAdd: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      alignSelf: 'flex-start',
      paddingLeft: 2,
      paddingTop: 4,
    },
    addRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderStyle: 'dashed',
      paddingHorizontal: 10,
      paddingVertical: 7,
      alignSelf: 'flex-start',
    },
    addRowDisabled: { opacity: 0.55 },
    addText: { color: colors.primary, fontWeight: '600', fontSize: 12 },
    addTextDisabled: { color: colors.textDim },
  });
