import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import AlternativesEditor from '../../../components/AlternativesEditor';

const NUMS = { fontVariant: ['tabular-nums'] };

/**
 * Presentational row for one exercise inside the routine editor.
 * Pure UI: receives the exercise data + callbacks; all state mutations
 * (steppers, unlink, remove, alternatives) are owned by the container.
 *
 * @param {{
 *   ex: object,               // { id, name, muscle_group, targetSets, restSeconds, groupId, alternatives }
 *   idx: number,
 *   firstInGroup: boolean,
 *   groupLabel?: string|null,
 *   selectMode: boolean,
 *   selected: boolean,
 *   excludeNames: string[],   // names offered as alternatives must skip
 *   styles: object,
 *   colors: object,
 *   onToggleSelect: (idx: number) => void,
 *   onShowDetail: (ex: object) => void,
 *   onAdjustSets: (idx: number, delta: number) => void,
 *   onRestEdit: (idx: number) => void,
 *   onUnlink: (idx: number) => void,
 *   onRemove: (idx: number) => void,
 *   onAlternativesChange: (idx: number, alternatives: string[]) => void,
 * }} props
 */
export default function ExerciseEditRow({
  ex,
  idx,
  firstInGroup,
  groupLabel,
  selectMode,
  selected,
  excludeNames,
  styles,
  colors,
  onToggleSelect,
  onShowDetail,
  onAdjustSets,
  onRestEdit,
  onUnlink,
  onRemove,
  onAlternativesChange,
}) {
  return (
    <View
      style={[
        styles.exRow,
        ex.groupId && styles.groupedRow,
        selectMode && selected && styles.selectedRow,
      ]}
    >
      {firstInGroup && <Text style={styles.groupLabel}>{groupLabel}</Text>}
      <View style={styles.exMain}>
        {selectMode ? (
          <TouchableOpacity style={styles.selectCheck} onPress={() => onToggleSelect(idx)}>
            <Ionicons
              name={selected ? 'checkbox' : 'square-outline'}
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
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={styles.exName}>{ex.name}</Text>
              <TouchableOpacity
                onPress={() => onShowDetail(ex)}
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
          <TouchableOpacity style={styles.stepper} onPress={() => onAdjustSets(idx, -1)}>
            <Ionicons name="remove" size={16} color={colors.text} />
          </TouchableOpacity>
          <Text style={[styles.setCount, NUMS]}>{ex.targetSets}</Text>
          <TouchableOpacity style={styles.stepper} onPress={() => onAdjustSets(idx, +1)}>
            <Ionicons name="add" size={16} color={colors.text} />
          </TouchableOpacity>
          <Text style={styles.setsUnit}>sets</Text>
          <TouchableOpacity style={styles.restBtn} onPress={() => onRestEdit(idx)}>
            <Ionicons name="time-outline" size={13} color={colors.textDim} />
            <Text style={[styles.restText, NUMS]}>{ex.restSeconds}s</Text>
          </TouchableOpacity>
          {ex.groupId && (
            <TouchableOpacity style={styles.unlinkBtn} onPress={() => onUnlink(idx)}>
              <Ionicons name="unlink" size={15} color={colors.textDim} />
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.removeBtn} onPress={() => onRemove(idx)}>
            <Ionicons name="close" size={16} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      )}
      {!selectMode && (
        <AlternativesEditor
          primaryName={ex.name}
          alternatives={ex.alternatives || []}
          excludeNames={excludeNames}
          onChange={(alternatives) => onAlternativesChange(idx, alternatives)}
        />
      )}
    </View>
  );
}
