import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { listSessions } from '../db/queries';
import { useColors } from '../theme';
import { useHeaderActions } from '../components/HeaderActions';
import { formatDuration } from '../store/WorkoutContext';

const NUMS = { fontVariant: ['tabular-nums'] };

function fmtK(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v));
}

function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Quiet relative period labels: Today / Yesterday / This Week / month names
function periodLabel(ts, now = new Date()) {
  const d = new Date(ts);
  const day = localDay(ts);
  if (day === localDay(now.getTime())) return 'Today';
  if (day === localDay(now.getTime() - 86400000)) return 'Yesterday';
  if (ts >= now.getTime() - 6 * 86400000) return 'This Week';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function groupSessions(sessions) {
  const groups = [];
  let current = null;
  let currentLabel = null;
  const now = new Date();
  for (const s of sessions) {
    const label = periodLabel(s.start_time, now);
    if (label !== currentLabel) {
      current = { label, items: [] };
      groups.push(current);
      currentLabel = label;
    }
    current.items.push(s);
  }
  return groups;
}

export default function HistoryScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [sessions, setSessions] = useState([]);

  useHeaderActions(navigation);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      listSessions().then((s) => { if (mounted) setSessions(s); });
      return () => { mounted = false; };
    }, [])
  );

  if (sessions.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Ionicons name="calendar-clear-outline" size={40} color={colors.textDim} />
        <Text style={styles.emptyTitle}>Nothing here yet</Text>
        <Text style={styles.emptySub}>
          Your finished workouts will show up here — go start one.
        </Text>
        <TouchableOpacity style={styles.emptyBtn} onPress={() => navigation.navigate('Home')}>
          <Ionicons name="barbell-outline" size={18} color={colors.primary} />
          <Text style={styles.emptyBtnText}>Start a Workout</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const groups = groupSessions(sessions);

  return (
    <FlatList
      data={groups}
      keyExtractor={(g) => g.label}
      contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
      style={{ backgroundColor: colors.bg }}
      renderItem={({ item: group }) => (
        <View>
          <Text style={styles.groupLabel}>{group.label}</Text>
          {group.items.map((s) => {
            const unnamed = !s.name || s.name.trim().toLowerCase() === 'workout';
            const fromTrainer = !!s.source_assigned_plan_id;
            return (
              <TouchableOpacity
                key={s.id}
                style={[styles.card, fromTrainer && styles.cardTrainer]}
                activeOpacity={0.8}
                onPress={() => navigation.navigate('SessionDetail', { sessionId: s.id })}
              >
                <View style={styles.dateBlock}>
                  <Text style={[styles.dateDay, NUMS]}>{new Date(s.start_time).getDate()}</Text>
                  <Text style={styles.dateMon}>
                    {new Date(s.start_time).toLocaleDateString(undefined, { month: 'short' })}
                  </Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.name, unnamed && styles.nameUnnamed]} numberOfLines={1}>
                    {s.name || 'Workout'}
                  </Text>
                  {fromTrainer ? (
                    <View style={styles.trainerTagRow}>
                      <Ionicons name="fitness" size={11} color={colors.blue} />
                      <Text style={styles.trainerTag}>Trainer</Text>
                    </View>
                  ) : null}
                  <View style={styles.metaRow}>
                    <Text style={[styles.vol, NUMS]}>{fmtK(s.totalVolume || 0)}</Text>
                    <Text style={styles.volUnit}>vol</Text>
                  </View>
                  <Text style={[styles.meta, NUMS]}>
                    {s.exerciseCount} ex · {s.totalSets || 0} sets
                    {s.duration_sec ? ` · ${formatDuration(s.duration_sec)}` : ''}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    />
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    emptyWrap: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 32 },
    emptyTitle: { color: colors.text, fontSize: 19, fontWeight: '800', marginTop: 14 },
    emptySub: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 6, marginBottom: 20 },
    emptyBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: colors.primary,
      paddingHorizontal: 20,
      paddingVertical: 12,
    },
    emptyBtnText: { color: colors.primary, fontWeight: '700' },

    groupLabel: {
      color: colors.textDim,
      fontSize: 12,
      fontWeight: '800',
      letterSpacing: 1.2,
      textTransform: 'uppercase',
      marginBottom: 10,
      marginTop: 18,
    },

    // Same card anatomy as Home's Recent rows — one design system
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 12,
      marginBottom: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12,
      shadowRadius: 8,
      elevation: 2,
    },
    dateBlock: {
      width: 46,
      height: 46,
      borderRadius: 12,
      backgroundColor: colors.cardLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dateDay: { color: colors.text, fontSize: 17, fontWeight: '800', lineHeight: 18 },
    dateMon: { color: colors.textDim, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 },

    cardTrainer: {
      borderLeftWidth: 3,
      borderLeftColor: colors.blue,
      borderTopLeftRadius: 4,
      borderBottomLeftRadius: 4,
      paddingLeft: 12,
    },
    trainerTagRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
    trainerTag: { color: colors.blue, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
    name: { color: colors.text, fontSize: 15, fontWeight: '700' },
    nameUnnamed: { fontWeight: '600', color: colors.textDim, fontStyle: 'italic' },
    metaRow: { flexDirection: 'row', alignItems: 'baseline', gap: 4, marginTop: 3 },
    vol: { color: colors.primary, fontSize: 17, fontWeight: '800' },
    volUnit: { color: colors.textDim, fontSize: 11 },
    meta: { color: colors.textDim, fontSize: 12, marginTop: 1 },
  });
