import React from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { fmtClock } from '../utils/workoutMath';

/**
 * Presentational top bar of the active-workout screen: close/pause/restart/
 * finish controls plus the live timer and session stats row.
 *
 * @param {{name:string}} workout
 * @param {boolean} paused
 * @param {number} elapsed seconds
 */
export default function WorkoutTopBar({
  workout,
  paused,
  elapsed,
  doneSets,
  totalVolume,
  styles,
  colors,
  onNameChange,
  onClose,
  onTogglePause,
  onRestart,
  onFinish,
}) {
  return (
    <View style={styles.topBar}>
      <View style={styles.topBarRow}>
        <TouchableOpacity style={styles.topIcon} onPress={onClose}>
          <Ionicons name="chevron-down" size={24} color={colors.textDim} />
        </TouchableOpacity>
        <TextInput
          style={styles.nameInput}
          value={workout.name}
          onChangeText={onNameChange}
        />
        <TouchableOpacity style={styles.topIcon} onPress={onTogglePause}>
          <Ionicons
            name={paused ? 'play' : 'pause'}
            size={22}
            color={paused ? colors.green : colors.text}
          />
        </TouchableOpacity>
        <TouchableOpacity style={styles.topIcon} onPress={onRestart}>
          <Ionicons name="refresh" size={20} color={colors.textDim} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.topIcon} onPress={onFinish}>
          <Ionicons name="checkmark-circle" size={24} color={colors.primary} />
        </TouchableOpacity>
      </View>
      <View style={styles.statsRow}>
        <Text style={[styles.timer, paused && { color: colors.textDim }]}>
          {paused ? 'PAUSED · ' : ''}{fmtClock(elapsed)}
        </Text>
        <Text style={styles.miniStat}>
          {workout.exercises.length} exercises · {doneSets} sets done · {Math.round(totalVolume)} vol
        </Text>
      </View>
    </View>
  );
}
