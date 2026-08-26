import React from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { fmtVolume } from '../../../shared/utils/format';
import {
  ASSIGNED_PLAN_DETAIL,
  ASSIGN_WORKOUT,
  ASSIGN_WORKOUT_PICKER,
} from '../../../shared/constants/routes';
import { fmtDuration, TYPE_TAG } from '../utils/clientAnalytics';

const NUMS = { fontVariant: ['tabular-nums'] };

/**
 * Client-detail Workouts tab: recent session summaries with a cached
 * per-set drill-down accordion + assigned workout plans + assign action.
 * Drill-down fetch/caching is owned by the container (`toggleExpand` +
 * `detailCache`).
 */
export default function ClientWorkoutsTab({
  styles,
  colors,
  navigation,
  clientId,
  clientName,
  readOnly,
  summaries,
  assignedPlans,
  expanded,
  detailCache,
  toggleExpand,
}) {
  return (
    <View>
          <Text style={styles.groupLabel}>Recent</Text>
          {summaries.length === 0 && (
            <Text style={styles.emptySub}>
              No synced workouts yet — sessions appear here as your client trains.
            </Text>
          )}
          {summaries.map((s) => {
            const isOpen = expanded === s.id;
            const details = detailCache.current[s.id];
            return (
              <View key={s.id} style={styles.card}>
                <TouchableOpacity style={styles.sessRow} onPress={() => toggleExpand(s.id)}>
                  <View style={styles.dateBlock}>
                    <Text style={[styles.dateDay, NUMS]}>{new Date(s.performed_at).getDate()}</Text>
                    <Text style={styles.dateMon}>
                      {new Date(s.performed_at).toLocaleDateString(undefined, { month: 'short' })}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sessName} numberOfLines={1}>
                      {s.name || 'Workout'}
                    </Text>
                    <Text style={[styles.meta, NUMS]}>
                      {s.exercise_count} ex · {s.working_set_count} sets · {fmtVolume(s.total_volume)} vol
                      {s.duration_seconds ? ` · ${fmtDuration(s.duration_seconds)}` : ''}
                    </Text>
                  </View>
                  <Ionicons name={isOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textDim} />
                </TouchableOpacity>

                {isOpen && (
                  <View style={styles.detailWrap}>
                    {!details ? (
                      <ActivityIndicator color={colors.primary} size="small" />
                    ) : details.error ? (
                      <Text style={styles.error}>{details.error}</Text>
                    ) : (
                      details.map((ex) => (
                        <View key={`${ex.exercise_name}-${ex.order_index}`} style={styles.detailEx}>
                          <Text style={styles.detailExName}>{ex.exercise_name}</Text>
                          {ex.original_exercise_name ? (
                            <Text style={styles.detailSwapped}>
                              swapped from {ex.original_exercise_name}
                            </Text>
                          ) : null}
                          {ex.shared_note ? (
                            <View style={styles.sharedNoteRow}>
                              <Ionicons name="chatbubble-ellipses" size={11} color={colors.blue} />
                              <Text style={styles.sharedNoteText}>
                                <Text style={styles.sharedNoteLabel}>Shared note: </Text>
                                {ex.shared_note}
                              </Text>
                            </View>
                          ) : null}
                          {ex.sets.map((set, i) => (
                            <View key={i} style={styles.detailSetRow}>
                              <Text style={[styles.detailCell, NUMS]}>{set.set_number}</Text>
                              <Text style={[styles.detailCell, set.set_type === 'warmup' && styles.warmupText]}>
                                {TYPE_TAG[set.set_type] || 'W'}
                              </Text>
                              <Text style={[styles.detailCell, NUMS, set.set_type === 'warmup' && styles.warmupText]}>
                                {set.weight}
                              </Text>
                              <Text style={[styles.detailCell, NUMS, set.set_type === 'warmup' && styles.warmupText]}>
                                {set.reps}
                              </Text>
                            </View>
                          ))}
                        </View>
                      ))
                    )}
                  </View>
                )}
              </View>
            );
          })}

          <Text style={[styles.groupLabel, { marginTop: 18 }]}>Assigned</Text>
          {assignedPlans.length === 0 && (
            <Text style={styles.emptySub}>Nothing assigned yet — build one below.</Text>
          )}
          {assignedPlans.map((ap) => (
            <View key={ap.id} style={styles.card}>
              <TouchableOpacity
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                activeOpacity={0.8}
                onPress={() => navigation.navigate(ASSIGNED_PLAN_DETAIL, { planId: ap.id, clientId, clientName })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.sessName} numberOfLines={1}>
                    {ap.name}
                  </Text>
                  <Text style={[styles.meta, NUMS]}>
                    {ap.exercise_count} exercises · assigned{' '}
                    {new Date(ap.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.editIconBtn}
                onPress={() => navigation.navigate(ASSIGN_WORKOUT, { clientId, clientName, planId: ap.id })}
              >
                <Ionicons name="create-outline" size={18} color={colors.textDim} />
              </TouchableOpacity>
            </View>
          ))}

          <TouchableOpacity
            style={[styles.assignBtn, readOnly && { opacity: 0.4 }]}
            disabled={readOnly}
            onPress={() => navigation.navigate(ASSIGN_WORKOUT_PICKER, { clientId, clientName })}
          >
            <Ionicons name="add-circle-outline" size={20} color="#fff" />
            <Text style={styles.assignText}>Assign Workout</Text>
          </TouchableOpacity>
        </View>
  );
}
