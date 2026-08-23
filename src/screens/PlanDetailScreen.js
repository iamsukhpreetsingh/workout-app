import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, StyleSheet } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getPlan, deletePlan } from '../db/queries';
import { useWorkout, groupLabels } from '../store/WorkoutContext';
import { Ionicons } from '@expo/vector-icons';
import { shareRoutine } from '../lib/share';
import ExerciseDetailSheet from '../components/ExerciseDetailSheet';
import { useColors, fmtDate } from '../theme';

const NUMS = { fontVariant: ['tabular-nums'] };

export default function PlanDetailScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [plan, setPlan] = useState(null);
  const [detailEx, setDetailEx] = useState(null);
  const { workout, dispatch } = useWorkout();

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      getPlan(route.params.planId).then((p) => { if (mounted) setPlan(p); });
      return () => { mounted = false; };
    }, [route.params.planId])
  );

  // Share action in the routine header (same treatment as Session Detail)
  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row' }}>
          <TouchableOpacity
            onPress={() => navigation.navigate('PlanEditor', { planId: plan?.id })}
            style={{ paddingHorizontal: 8 }}
          >
            <Ionicons name="create-outline" size={21} color={colors.text} />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => plan && shareRoutine(plan)} style={{ paddingHorizontal: 8 }}>
            <Ionicons name="share-social-outline" size={21} color={colors.text} />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, plan, colors]);

  const startWorkout = (p) => {
    if (workout) {
      Alert.alert('Workout in progress', 'Finish or discard your current workout first.', [
        { text: 'OK' },
      ]);
      return;
    }
    dispatch({ type: 'START_WORKOUT', name: p.name, planId: p.id, planExercises: p.exercises });
    // Expands the mini-bar's full logging view (there is no Workout tab)
    navigation.navigate('ActiveWorkout');
  };

  if (!plan) {
    return <View style={styles.container}><Text style={styles.dim}>Loading…</Text></View>;
  }

  // Confirm-before-destructive — unchanged behavior
  const confirmDelete = () =>
    Alert.alert('Delete routine', `"${plan.name}" will be deleted.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deletePlan(plan.id);
          navigation.goBack();
        },
      },
    ]);

  const labels = groupLabels(plan.exercises.map((e) => ({ groupId: e.group_id })));

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      {/* Identity block — same pattern as Session Detail */}
      <Text style={styles.name}>{plan.name}</Text>
      <Text style={styles.sub}>
        {plan.exercises.length} exercises · created {fmtDate(plan.created_at)}
      </Text>
      {plan.notes ? <Text style={styles.notes}>{plan.notes}</Text> : null}

      {/* Numbered exercise list with superset grouping preview */}
      {plan.exercises.map((ex, i) => {
        const firstInGroup =
          ex.group_id && plan.exercises[i - 1]?.group_id !== ex.group_id;
        return (
          <View
            key={ex.id}
            style={[styles.row, ex.group_id && styles.groupedRow, firstInGroup && styles.groupFirst]}
          >
            {firstInGroup && (
              <Text style={styles.groupLabel}>Superset {labels[ex.group_id]}</Text>
            )}
            <View style={styles.rowInner}>
              <View style={[styles.idxBadge, ex.group_id && styles.groupedRowIdx]}>
                <Text style={[styles.idxText, NUMS]}>{i + 1}</Text>
              </View>
              {/* <View style={{ flex: 1 }}>
                <Text style={styles.exName}>{ex.name}</Text>
                <View style={styles.exMetaRow}>
                  <Text style={[styles.exSets, NUMS]}>{ex.target_sets}</Text>
                  <Text style={styles.exSetsUnit}>sets</Text>
                  <Text style={styles.exGroup}>{ex.muscle_group}</Text>
                </View>
              </View>
              <View style={styles.restChip}> */}
                            <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Text style={styles.exName}>{ex.name}</Text>
                  <TouchableOpacity
                    onPress={() => setDetailEx(ex)}
                    hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  >
                    <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
                  </TouchableOpacity>
                </View>
                <View style={styles.exMetaRow}>
                  <Text style={[styles.exSets, NUMS]}>{ex.target_sets}</Text>
                  <Text style={styles.exSetsUnit}>sets</Text>
                  <Text style={styles.exGroup}>{ex.muscle_group}</Text>
                </View>
              </View>
              <View style={styles.restChip}>


                <Ionicons name="time-outline" size={12} color={colors.textDim} />
                <Text style={[styles.restText, NUMS]}>{ex.rest_seconds || 90}s</Text>
              </View>
            </View>
          </View>
        );
      })}

      {/* Primary action: solid ember CTA */}
      <TouchableOpacity style={styles.startBtn} onPress={() => startWorkout(plan)}>
        <Ionicons name="play" size={18} color="#fff" />
        <Text style={styles.startBtnText}>Start Workout</Text>
      </TouchableOpacity>

      {/* Destructive: quiet, outlined, separated — mirrors Session Detail */}
      <TouchableOpacity style={styles.deleteBtn} onPress={confirmDelete}>
        <Ionicons name="trash-outline" size={16} color={colors.red} />
        <Text style={styles.deleteText}>Delete Routine</Text>
      </TouchableOpacity>
    {/* </ScrollView>
  );
} */}
      <ExerciseDetailSheet visible={!!detailEx} exercise={detailEx} onClose={() => setDetailEx(null)} />
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    dim: { color: colors.textDim, padding: 16 },

    name: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.4 },
    sub: { color: colors.textDim, marginTop: 4, fontSize: 13 },
    notes: { color: colors.textDim, marginTop: 8, marginBottom: 8, fontSize: 13, fontStyle: 'italic' },

    row: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 12,
      marginTop: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12,
      shadowRadius: 8,
      elevation: 2,
    },
    // Superset grouping: shared tint + connector (same language as live view)
    groupedRow: {
      backgroundColor: colors.cardLight,
      borderLeftWidth: 3,
      borderLeftColor: colors.blue,
      borderTopLeftRadius: 4,
      borderBottomLeftRadius: 4,
    },
    groupFirst: { marginTop: 12 },
    groupLabel: { color: colors.blue, fontWeight: '700', fontSize: 12, marginBottom: 6 },
    rowInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },

    idxBadge: {
      width: 28,
      height: 28,
      borderRadius: 9,
      backgroundColor: colors.cardLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    groupedRowIdx: { backgroundColor: colors.card },
    idxText: { color: colors.primary, fontWeight: '800', fontSize: 13 },
    exName: { color: colors.text, fontWeight: '700', fontSize: 15 },
    exMetaRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 2 },
    exSets: { color: colors.text, fontSize: 13, fontWeight: '800' },
    exSetsUnit: { color: colors.textDim, fontSize: 11, marginRight: 8 },
    exGroup: { color: colors.textDim, fontSize: 12 },
    restChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: colors.cardLight,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 5,
    },
    restText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },

    startBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.primary,
      borderRadius: 14,
      padding: 16,
      marginTop: 24,
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.35,
      shadowRadius: 12,
      elevation: 5,
    },
    startBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },

    deleteBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 36,
      paddingVertical: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.red,
      opacity: 0.85,
    },
    deleteText: { color: colors.red, fontWeight: '700', fontSize: 14 },
  });
