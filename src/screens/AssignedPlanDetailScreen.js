import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../lib/api';
import { groupLabels } from '../store/WorkoutContext';
import { useColors } from '../theme';

const NUMS = { fontVariant: ['tabular-nums'] };

// Read-only view of an assigned plan — Routine Detail's layout, since the
// data shape is nearly identical. Archive is the only mutating action.
export default function AssignedPlanDetailScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { planId, clientId, clientName } = route.params || {};
  const [plan, setPlan] = useState(null);
  const [busy, setBusy] = useState(false);

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: plan?.name || 'Assigned Plan' });
  }, [navigation, plan?.name]);

  const load = useCallback(async () => {
    try {
      const p = await api(`/trainer/plans/${planId}`);
      setPlan(p);
    } catch (e) {
      Alert.alert('Could not load plan', e.message || 'Please try again.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    }
  }, [planId, navigation]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const confirmArchive = () =>
    Alert.alert('Archive plan', `"${plan.name}" will be removed from ${clientName || 'your client'}'s active workouts. It stays in the database and can be reviewed later.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Archive',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await api(`/trainer/clients/${clientId}/assigned-plans/${planId}`, {
              method: 'PATCH',
              body: { status: 'archived' },
            });
            navigation.goBack(); // list refreshes on focus
          } catch (e) {
            Alert.alert('Could not archive', e.message || 'Please try again.');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);

  if (!plan) {
    return (
      <View style={[styles.container, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const labels = groupLabels((plan.exercises || []).map((e) => ({ groupId: e.group_id })));

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      <Text style={styles.name}>{plan.name}</Text>
      <Text style={styles.sub}>
        Assigned to {clientName || 'client'} ·{' '}
        {new Date(plan.created_at).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })}
      </Text>
      {plan.notes ? <Text style={styles.notes}>{plan.notes}</Text> : null}

      {(plan.exercises || []).map((ex, i) => {
        const firstInGroup = ex.group_id && plan.exercises[i - 1]?.group_id !== ex.group_id;
        return (
          <View
            key={ex.id}
            style={[styles.row, ex.group_id && styles.groupedRow, firstInGroup && styles.groupFirst]}
          >
            {firstInGroup && <Text style={styles.groupLabel}>Superset {labels[ex.group_id]}</Text>}
            <View style={styles.rowInner}>
              <View style={styles.idxBadge}>
                <Text style={[styles.idxText, NUMS]}>{i + 1}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.exName}>{ex.exercise_name}</Text>
                <View style={styles.exMetaRow}>
                  <Text style={[styles.exSets, NUMS]}>{ex.target_sets}</Text>
                  <Text style={styles.exSetsUnit}>sets{ex.target_reps ? ` · ${ex.target_reps} reps` : ''}</Text>
                  <Text style={styles.exGroup}>{ex.notes || ''}</Text>
                </View>
                {ex.target_weight_note ? (
                  <Text style={styles.exHint}>{ex.target_weight_note}</Text>
                ) : null}
              </View>
              {ex.rest_seconds ? (
                <View style={styles.restChip}>
                  <Ionicons name="time-outline" size={12} color={colors.textDim} />
                  <Text style={[styles.restText, NUMS]}>{ex.rest_seconds}s</Text>
                </View>
              ) : null}
            </View>
          </View>
        );
      })}

      <TouchableOpacity style={styles.archiveBtn} onPress={confirmArchive} disabled={busy}>
        <Ionicons name="archive-outline" size={16} color={colors.red} />
        <Text style={styles.archiveText}>Archive Plan</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    name: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.4 },
    sub: { color: colors.textDim, marginTop: 4, fontSize: 13 },
    notes: { color: colors.textDim, marginTop: 8, marginBottom: 8, fontSize: 13, fontStyle: 'italic' },

    row: {
      backgroundColor: colors.card, borderRadius: 14, padding: 12, marginTop: 8,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.12,
      shadowRadius: 8, elevation: 2,
    },
    groupedRow: {
      backgroundColor: colors.cardLight, borderLeftWidth: 3, borderLeftColor: colors.blue,
      borderTopLeftRadius: 4, borderBottomLeftRadius: 4,
    },
    groupFirst: { marginTop: 12 },
    groupLabel: { color: colors.blue, fontWeight: '700', fontSize: 12, marginBottom: 6 },
    rowInner: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    idxBadge: {
      width: 28, height: 28, borderRadius: 9, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    idxText: { color: colors.primary, fontWeight: '800', fontSize: 13 },
    exName: { color: colors.text, fontWeight: '700', fontSize: 15 },
    exMetaRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 2 },
    exSets: { color: colors.text, fontSize: 13, fontWeight: '800' },
    exSetsUnit: { color: colors.textDim, fontSize: 11, marginRight: 8 },
    exGroup: { color: colors.textDim, fontSize: 12, fontStyle: 'italic' },
    exHint: { color: colors.textDim, fontSize: 11, marginTop: 2 },
    restChip: {
      flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.cardLight,
      borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5,
    },
    restText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },

    archiveBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      marginTop: 36, paddingVertical: 12, borderRadius: 12, borderWidth: 1,
      borderColor: colors.red, opacity: 0.85,
    },
    archiveText: { color: colors.red, fontWeight: '700', fontSize: 14 },
  });
