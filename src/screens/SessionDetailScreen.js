import React, { useCallback, useState, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, StyleSheet, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import LoadError from '../shared/components/LoadError';
import { getSession, deleteSession, updateSetType, updateSessionName } from '../db/queries';
import { getPRSetIdsForSession } from '../db/pr';
import { shareSessionAsRoutine } from '../lib/share';
import ExerciseDetailSheet from '../components/ExerciseDetailSheet';
import { useColors } from '../theme';
import { useHeaderActions } from '../components/HeaderActions';
import { fmtDate } from '../shared/utils/format';
import { formatDuration, groupLabels } from '../store/WorkoutContext';

import { TYPE_TAG, TYPE_COLOR, nextSetType } from '../shared/constants/setTypes';

const NUMS = { fontVariant: ['tabular-nums'] };

export default function SessionDetailScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [session, setSession] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const [prSetIds, setPrSetIds] = useState(new Set());
  const [editingName, setEditingName] = useState(false);
  const [editedName, setEditedName] = useState('');
  const [detailEx, setDetailEx] = useState(null);
  // §9: retroactive set-type editing IS a supported feature, but it must be
  // EXPLICIT — a single accidental tap on a historical set previously mutated
  // the completed workout (and triggered PR recompute + re-sync). View mode
  // is read-only; the header 'Edit' toggle enters the intentional workflow.
  const [editingSets, setEditingSets] = useState(false);
  const inputRef = useRef(null);

  // Share the performed workout structure (no notes/RPE/timestamps)
  // contextual actions (Edit/Share) ride BESIDE the persistent bell+settings
  const headerExtra = session ? (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <TouchableOpacity
        onPress={() => setEditingSets((v) => !v)}
        style={{ paddingHorizontal: 10 }}
        hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
      >
        <Text style={{ color: editingSets ? colors.primary : colors.text, fontWeight: '800', fontSize: 14 }}>
          {editingSets ? 'Done' : 'Edit'}
        </Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={() => shareSessionAsRoutine(session)} style={{ paddingHorizontal: 8 }}>
        <Ionicons name="share-social-outline" size={21} color={colors.text} />
      </TouchableOpacity>
    </View>
  ) : null;
  useHeaderActions(navigation, [session, colors, editingSets], headerExtra);

  const reload = useCallback(() => {
    let mounted = true;
    async function load() {
      try {
        const s = await getSession(route.params.sessionId);
        if (!mounted) return;
        setSession(s);
        if (s) {
          const prs = await getPRSetIdsForSession(s.id);
          if (mounted) setPrSetIds(prs);
        }
        if (mounted) setLoadError(false);
      } catch (e) {
        console.warn('[SessionDetailScreen] load failed:', e?.message || e);
        if (mounted) setLoadError(true);
      }
    }
    load();
    return () => { mounted = false; };
  }, [route.params.sessionId, retryTick]);

  useFocusEffect(reload);

  if (loadError && !session) {
    return <LoadError onRetry={() => setRetryTick((t) => t + 1)} />;
  }

  if (!session) {
    return (
      <View style={styles.container}>
        <Text style={styles.dim}>Loading…</Text>
      </View>
    );
  }

  const totalVolume = session.exercises.reduce(
    (n, ex) =>
      n + ex.sets.filter((s) => s.set_type !== 'warmup').reduce((m, s) => m + s.weight * s.reps, 0),
    0
  );
  const totalSets = session.exercises.reduce(
    (n, ex) => n + ex.sets.filter((s) => s.set_type !== 'warmup').length,
    0
  );

  const cycleType = (set) => {
    if (!editingSets) return; // read-only in view mode — never mutate from a stray tap
    updateSetType(set.id, nextSetType(set.set_type)).then(reload);
  };

  // Confirm-before-destructive — unchanged behavior
  const confirmDelete = () =>
    Alert.alert('Delete workout', 'This session will be permanently deleted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          await deleteSession(session.id);
          navigation.goBack();
        },
      },
    ]);

  const labels = groupLabels(session.exercises.map((e) => ({ groupId: e.group_id })));

  const startEditName = () => {
    setEditedName(session.name);
    setEditingName(true);
    setTimeout(() => inputRef.current?.focus(), 100);
  };

  const cancelEditName = () => {
    setEditingName(false);
    setEditedName('');
    inputRef.current?.blur();
  };

  const confirmEditName = async () => {
    const trimmed = editedName.trim();
    if (!trimmed) return;
    if (trimmed === session.name) {
      setEditingName(false);
      setEditedName('');
      return;
    }
    await updateSessionName(session.id, trimmed);
    setSession({ ...session, name: trimmed });
    setEditingName(false);
    setEditedName('');
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      {/* explicit historical-edit indicator (§9): entering edit mode must be
          obvious — a completed workout is an immutable snapshot otherwise */}
      {editingSets && (
        <View style={styles.editBanner}>
          <Ionicons name="create-outline" size={13} color={colors.orange} />
          <Text style={styles.editBannerText}>
            Editing a completed workout — tapping a set cycles its type and recalculates
            volume & PRs. Changes sync to your trainer.
          </Text>
        </View>
      )}
      {/* Identity: display-weight name, muted date/time */}
      <View style={styles.nameRow}>
        {editingName ? (
          <>
            <TextInput
              ref={inputRef}
              style={styles.nameInput}
              value={editedName}
              onChangeText={setEditedName}
              onSubmitEditing={confirmEditName}
              returnKeyType="done"
              selectTextOnFocus
            />
            <TouchableOpacity
              onPress={confirmEditName}
              disabled={!editedName.trim()}
              style={[styles.iconBtn, !editedName.trim() && styles.iconBtnDisabled]}
            >
              <Ionicons name="checkmark" size={20} color={editedName.trim() ? colors.primary : colors.textDim} />
            </TouchableOpacity>
            <TouchableOpacity onPress={cancelEditName} style={styles.iconBtn}>
              <Ionicons name="close" size={20} color={colors.textDim} />
            </TouchableOpacity>
          </>
        ) : (
          <>
            <Text style={styles.name}>{session.name}</Text>
            <TouchableOpacity onPress={startEditName} style={styles.iconBtn}>
              <Ionicons name="pencil" size={16} color={colors.textDim} />
            </TouchableOpacity>
          </>
        )}
      </View>
      {!!session.source_assigned_plan_id && (
        <View style={styles.trainerBadge}>
          <Ionicons name="fitness" size={12} color={colors.blue} />
          <Text style={styles.trainerBadgeText}>From your trainer</Text>
        </View>
      )}
      <Text style={styles.sub}>
        {fmtDate(session.start_time)}
        {session.duration_sec ? ` · ${formatDuration(session.duration_sec)}` : ''}
      </Text>

      {/* Stats: volume leads, exercises + sets supporting */}
      <View style={styles.statHero}>
        <Text style={[styles.statHeroVal, NUMS]}>{Math.round(totalVolume).toLocaleString()}</Text>
        <Text style={styles.statHeroLabel}>volume</Text>
      </View>
      <View style={styles.statsRow}>
        <View style={styles.statBox}>
          <Text style={[styles.statVal, NUMS]}>{session.exercises.length}</Text>
          <Text style={styles.statLabel}>Exercises</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statVal, NUMS]}>{totalSets}</Text>
          <Text style={styles.statLabel}>Working Sets</Text>
        </View>
      </View>

      {/* Set tables */}
      {session.exercises.map((ex, i) => (
        <View
          key={ex.session_exercise_id}
          style={[styles.card, ex.group_id && styles.groupedCard]}
        >
          {ex.group_id && session.exercises[i - 1]?.group_id !== ex.group_id && (
            <Text style={styles.groupLabel}>Superset {labels[ex.group_id]}</Text>
          )}
          {/* <Text style={styles.exName}>{ex.name}</Text>
          {ex.notes ? <Text style={styles.exNote}>{ex.notes}</Text> : null} */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <Text style={styles.exName}>{ex.name}</Text>
            <TouchableOpacity
              // onPress={() => setDetailEx(ex)}
              onPress={() => setDetailEx({ ...ex, id: ex.exercise_id })}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="information-circle-outline" size={18} color={colors.primary} />
            </TouchableOpacity>
          </View>
          {ex.original_exercise_name ? (
            <Text style={styles.swappedLabel}>
              swapped from {ex.original_exercise_name}
            </Text>
          ) : null}
          {ex.notes ? <Text style={styles.exNote}>{ex.notes}</Text> : null}
          {ex.trainer_note ? (
            <View style={styles.trainerNoteRow}>
              <Ionicons name="people" size={11} color={colors.blue} />
              <Text style={styles.exNote}>Shared with trainer: {ex.trainer_note}</Text>
            </View>
          ) : null}
          <View style={styles.setHeader}>
            <Text style={styles.setHeaderLabel}>TYPE</Text>
            <Text style={styles.setHeaderLabel}>KG</Text>
            <Text style={styles.setHeaderLabel}>REPS</Text>
            <Text style={styles.setHeaderLabel}>RPE</Text>
            <Text style={styles.setHeaderLabel} />
          </View>
          {ex.sets.map((s) => (
            <TouchableOpacity
              key={s.id}
              style={[styles.setRow, s.set_type === 'warmup' && styles.warmupRow]}
              onPress={editingSets ? cycleType.bind(null, s) : undefined}
              disabled={!editingSets}
              activeOpacity={editingSets ? 0.6 : 1}
            >
              {/* set-type left-edge tag keeps columns as straight lines */}
              <View style={styles.typeCell}>
                <View
                  style={[
                    styles.typeTag,
                    { backgroundColor: colors[TYPE_COLOR[s.set_type] || 'textDim'] },
                  ]}
                />
                <Text style={[styles.setType, s.set_type === 'warmup' && styles.warmupText]}>
                  {TYPE_TAG[s.set_type] || 'W'}
                </Text>
              </View>
              <Text style={[styles.setCell, NUMS, s.set_type === 'warmup' && styles.warmupText]}>
                {s.weight}
              </Text>
              <Text style={[styles.setCell, NUMS, s.set_type === 'warmup' && styles.warmupText]}>
                {s.reps}
              </Text>
              <Text style={[styles.setCell, NUMS, s.set_type === 'warmup' && styles.warmupText]}>
                {s.rpe != null ? s.rpe : '—'}
              </Text>
              {/* PR trophy trails the row so number columns stay scannable */}
              <View style={styles.prSlot}>
                {prSetIds.has(s.id) && <Ionicons name="trophy" size={12} color={colors.yellow} />}
              </View>
            </TouchableOpacity>
          ))}
        </View>
      ))}

      <Text style={styles.hint}>Tap any set row to change its type. Stats update instantly.</Text>

      {session.notes ? (
        <View style={styles.card}>
          <Text style={styles.notesLabel}>NOTES</Text>
          <Text style={styles.notesText}>{session.notes}</Text>
        </View>
      ) : null}

      {/* Destructive action: quiet, outlined, well separated from the data */}
      <TouchableOpacity style={styles.deleteBtn} onPress={confirmDelete}>
        <Ionicons name="trash-outline" size={16} color={colors.red} />
        <Text style={styles.deleteText}>Delete Workout</Text>
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
    editBanner: {
      flexDirection: 'row', alignItems: 'center', gap: 7,
      borderWidth: 1.2, borderColor: colors.orange, borderRadius: 11,
      paddingHorizontal: 11, paddingVertical: 9, marginBottom: 10,
    },
    editBannerText: { color: colors.orange, fontSize: 11, fontWeight: '600', flex: 1, lineHeight: 15 },
    dim: { color: colors.textDim, padding: 16 },

    nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    name: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.4, flex: 1 },
    nameInput: {
      flex: 1,
      color: colors.text,
      fontSize: 22,
      fontWeight: '700',
      paddingVertical: 4,
      paddingHorizontal: 8,
      backgroundColor: colors.card,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.primary,
    },
    iconBtn: { padding: 6 },
    iconBtnDisabled: { opacity: 0.4 },
    sub: { color: colors.textDim, marginTop: 4, marginBottom: 18, fontSize: 13 },
    trainerBadge: {
      flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
      backgroundColor: colors.cardLight, borderLeftWidth: 3, borderLeftColor: colors.blue,
      borderRadius: 8, borderTopLeftRadius: 4, borderBottomLeftRadius: 4,
      paddingHorizontal: 8, paddingVertical: 4, marginTop: 8,
    },
    trainerBadgeText: { color: colors.blue, fontSize: 12, fontWeight: '700' },

    // Volume is the hero stat
    statHero: { alignItems: 'center', marginBottom: 4 },
    statHeroVal: { color: colors.primary, fontSize: 38, fontWeight: '800', letterSpacing: -1 },
    statHeroLabel: {
      color: colors.textDim,
      fontSize: 11,
      fontWeight: '800',
      letterSpacing: 1.2,
      textTransform: 'uppercase',
    },
    statsRow: { flexDirection: 'row', gap: 10, marginBottom: 22 },
    statBox: { flex: 1, backgroundColor: colors.card, borderRadius: 14, padding: 12, alignItems: 'center' },
    statVal: { color: colors.text, fontSize: 18, fontWeight: '800' },
    statLabel: { color: colors.textDim, fontSize: 11, marginTop: 2 },

    card: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 14,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12,
      shadowRadius: 8,
      elevation: 2,
    },
    groupedCard: { borderLeftWidth: 3, borderLeftColor: colors.blue },
    groupLabel: { color: colors.blue, fontWeight: '700', fontSize: 12, marginBottom: 6 },

    exName: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: 2 },
    swappedLabel: { color: colors.textDim, fontSize: 11, fontStyle: 'italic', marginTop: -2 },
    exNote: { color: colors.textDim, fontSize: 12, fontStyle: 'italic', marginBottom: 8 },
    trainerNoteRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 8 },

    setHeader: { flexDirection: 'row', marginTop: 8, marginBottom: 2 },
    setHeaderLabel: { color: colors.textDim, fontSize: 10, fontWeight: '700', flex: 1, textAlign: 'center', letterSpacing: 0.5 },

    setRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 5 },
    warmupRow: { opacity: 0.55 },
    warmupText: { color: colors.textDim },
    typeCell: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
    typeTag: { width: 3, height: 12, borderRadius: 1.5 },
    setType: { color: colors.textDim, fontSize: 11, fontWeight: '700' },
    setCell: { color: colors.text, flex: 1, textAlign: 'center', fontSize: 14, fontWeight: '600' },
    prSlot: { width: 16, alignItems: 'center' },

    hint: { color: colors.textDim, fontSize: 11, opacity: 0.75, marginTop: 2 },
    notesLabel: {
      color: colors.textDim,
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 1.2,
      marginBottom: 4,
    },
    notesText: { color: colors.text, fontSize: 13 },

    // Destructive: text+icon, outlined, separated by a wide margin
    deleteBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 44,
      paddingVertical: 12,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.red,
      opacity: 0.85,
    },
    deleteText: { color: colors.red, fontWeight: '700', fontSize: 14 },
  });
