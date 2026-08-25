import React from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RPE_OPTIONS, TYPE_META, setHasValues } from '../utils/workoutMath';

/**
 * Presentational single set row: type chip, previous performance quick-fill,
 * weight/reps inputs, done toggle (with prev-delta badges), plate/remove
 * actions and the optional RPE chip row for completed sets.
 *
 * PR evaluation on completion is owned by the container via `onToggleDone`.
 *
 * @param {object} set the set state row
 * @param {object} item the parent exercise
 */
export default function SetRow({
  set,
  item,
  rpeEnabled,
  styles,
  colors,
  dispatch,
  onToggleDone,
  onShowPlates,
}) {
  const hasValues = setHasValues(set);
  return (
    <View key={set.key}>
      <View
        style={[
          styles.setRow,
          set.type === 'warmup' && styles.warmupRow,
          set.completed && set.type !== 'warmup' && styles.setRowDone,
        ]}
      >
        <TouchableOpacity
          style={styles.typeChip}
          onPress={() =>
            dispatch({ type: 'TOGGLE_SET_TYPE', exerciseKey: item.key, setKey: set.key })
          }
        >
          <Text style={[styles.typeChipText, set.type === 'warmup' && styles.warmupText]}>
            {TYPE_META[set.type]?.label || 'W'}
          </Text>
        </TouchableOpacity>
        {/* Previous performance as faded placeholder values —
            tap to quick-fill empty fields with last session */}
        <TouchableOpacity
          style={styles.lastCell}
          onPress={() =>
            set.prev && dispatch({ type: 'FILL_FROM_PREV', exerciseKey: item.key, setKey: set.key })
          }
        >
          {set.prev && (set.prev.weight > 0 || set.prev.reps > 0) ? (
            <Text style={styles.lastText}>
              {set.prev.weight}×{set.prev.reps}
            </Text>
          ) : (
            <Text style={styles.lastTextDim}>—</Text>
          )}
        </TouchableOpacity>
        <TextInput
          style={[styles.setInput, set.type === 'warmup' && styles.warmupText]}
          keyboardType="numeric"
          value={set.weight}
          placeholder={set.prev && set.prev.weight > 0 ? String(set.prev.weight) : ''}
          placeholderTextColor={colors.textDim}
          onChangeText={(weight) =>
            dispatch({ type: 'UPDATE_SET', exerciseKey: item.key, setKey: set.key, field: 'weight', value: weight })
          }
        />
        <TextInput
          style={[styles.setInput, set.type === 'warmup' && styles.warmupText]}
          keyboardType="numeric"
          value={set.reps}
          placeholder={set.prev && set.prev.reps > 0 ? String(set.prev.reps) : ''}
          placeholderTextColor={colors.textDim}
          onChangeText={(reps) =>
            dispatch({ type: 'UPDATE_SET', exerciseKey: item.key, setKey: set.key, field: 'reps', value: reps })
          }
        />
        {/* Bidirectional done toggle: un-marking removes the
            set from volume/PRs again */}
        <TouchableOpacity style={styles.doneBtn} onPress={() => onToggleDone(item, set)}>
          <Ionicons
            name={set.completed ? 'checkmark-circle' : 'ellipse-outline'}
            size={20}
            color={set.completed ? colors.green : colors.textDim}
          />
        </TouchableOpacity>
        {set.prev && hasValues && (
          <View style={styles.deltaContainer}>
            {(() => {
              const currW = parseFloat(set.weight) || 0;
              const currR = parseInt(set.reps, 10) || 0;
              const prevW = set.prev.weight || 0;
              const prevR = set.prev.reps || 0;
              const wDiff = currW - prevW;
              const rDiff = currR - prevR;
              if (wDiff === 0 && rDiff === 0) return null;
              return (
                <>
                  {wDiff !== 0 && (
                    <Text style={[styles.deltaText, wDiff > 0 ? styles.deltaUp : styles.deltaDown]}>
                      {wDiff > 0 ? '+' : ''}{Math.round(wDiff)}
                    </Text>
                  )}
                  {rDiff !== 0 && (
                    <Text style={[styles.deltaTextSmall, rDiff > 0 ? styles.deltaUp : styles.deltaDown]}>
                      {rDiff > 0 ? '+' : ''}{rDiff}r
                    </Text>
                  )}
                </>
              );
            })()}
          </View>
        )}
        <View style={styles.setActions}>
          <TouchableOpacity onPress={() => onShowPlates(set.key)}>
            <Ionicons name="grid-outline" size={16} color={colors.blue} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() =>
              item.sets.length > 1
                ? dispatch({ type: 'REMOVE_SET', exerciseKey: item.key, setKey: set.key })
                : dispatch({ type: 'REMOVE_EXERCISE', key: item.key })
            }
          >
            <Ionicons name="close" size={16} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      </View>
      {rpeEnabled && set.completed && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.rpeRow}>
          <Text style={styles.rpeLabel}>RPE</Text>
          {RPE_OPTIONS.map((r) => (
            <TouchableOpacity
              key={r}
              onPress={() =>
                dispatch({
                  type: 'UPDATE_SET',
                  exerciseKey: item.key,
                  setKey: set.key,
                  field: 'rpe',
                  value: set.rpe === r ? null : r,
                })
              }
            >
              <Text style={[styles.rpeChip, set.rpe === r && styles.rpeChipOn]}>{r}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}
    </View>
  );
}
