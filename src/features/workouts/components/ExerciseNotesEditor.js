import React from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Presentational inline per-exercise notes editor (personal + trainer-share
 * fields). Draft values are owned by the container; nothing persists until
 * the tick is tapped.
 *
 * @param {{personal: string, trainer: string}} noteDraft
 * @param {boolean} dirty whether either field differs from saved values
 */
export default function ExerciseNotesEditor({
  noteDraft,
  dirty,
  justSaved,
  styles,
  colors,
  onChangePersonal,
  onChangeTrainer,
  onSave,
}) {
  return (
    <View style={styles.exNotesWrap}>
      <View style={styles.exNotesHeaderRow}>
        <Ionicons name="lock-closed" size={11} color={colors.textDim} />
        <Text style={styles.exNotesLabel}>Personal Notes</Text>
        {justSaved ? (
          <View style={styles.exNotesSavedRow}>
            <Ionicons name="checkmark-circle" size={13} color={colors.green} />
            <Text style={styles.exNotesSavedText}>Saved</Text>
          </View>
        ) : null}
        <TouchableOpacity
          style={[styles.exNotesTickBtn, !dirty && styles.exNotesTickBtnOff]}
          disabled={!dirty}
          onPress={onSave}
          accessibilityLabel="Save notes"
        >
          <Ionicons
            name="checkmark-circle"
            size={24}
            color={dirty ? colors.green : colors.textDim}
          />
        </TouchableOpacity>
      </View>
      <TextInput
        style={styles.exNotesInput}
        placeholder="Private note for you (e.g. remember to increase weight next session)"
        placeholderTextColor={colors.textDim}
        value={noteDraft.personal}
        onChangeText={onChangePersonal}
        multiline
      />
      <View style={styles.exNotesHeaderRow}>
        <Ionicons name="people" size={11} color={colors.textDim} />
        <Text style={styles.exNotesLabel}>Share with Trainer</Text>
      </View>
      <TextInput
        style={[styles.exNotesInput, styles.exNotesInputTrainer]}
        placeholder="Visible to your trainer (e.g. knees felt slightly uncomfortable on the last set)"
        placeholderTextColor={colors.textDim}
        value={noteDraft.trainer}
        onChangeText={onChangeTrainer}
        multiline
      />
    </View>
  );
}
