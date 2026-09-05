// Gym Nutrition — the full program list behind the member home's
// "Gym Recommended → View Nutrition" entry point (Mobile M5).
//
// Same split as GymWorkoutsScreen: the dashboard shows counts, this screen
// shows the list. Rows open the existing GYM_NUTRITION_DETAIL screen, so
// log-to-meal / save-to-My-Dishes behavior is untouched.
//
// Data: GET /gym/my/content sliced to the ACTIVE gym. Nutrition content is
// normalized through normalizeNutritionEntries() at the detail boundary
// (the {text,type} crash guard) — this list only renders titles + the
// server-provided kind/targets meta, so it never touches raw entries.
import React, { useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useColors, spacing } from '../theme';
import LoadError from '../shared/components/LoadError';
import useAsyncData from '../shared/hooks/useAsyncData';
import { useGym } from '../store/GymContext';
import { fetchMyGymContent } from '../lib/gymApi';
import { GYM_NUTRITION_KIND_LABELS } from '../lib/gymContent';
import { GYM_NUTRITION_DETAIL } from '../shared/constants/routes';

export default function GymNutritionScreen() {
  const colors = useColors();
  const navigation = useNavigation();
  const gym = useGym();
  const content = useAsyncData(() => fetchMyGymContent(), []);

  useFocusEffect(
    useCallback(() => {
      content.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
  );

  const styles = makeStyles(colors);

  const sections = useMemo(() => {
    const rows = Array.isArray(content.data) ? content.data : [];
    const mine = rows.find((g) => g && g.gym_id === (gym.gym || {}).gym_id) || null;
    return {
      assigned: mine?.nutrition?.assigned || [],
      recommended: mine?.nutrition?.recommended || [],
    };
  }, [content.data, gym.gym]);

  if (gym.loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (gym.error) {
    return <LoadError message="Couldn't load your gym." onRetry={gym.reload} />;
  }
  if (!gym.hasGym || !gym.gym) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Ionicons name="restaurant-outline" size={40} color={colors.textDim} />
        <Text style={styles.emptyTitle}>You&apos;re not connected to a gym yet.</Text>
      </View>
    );
  }

  const openItem = (n, tag) =>
    navigation.navigate(GYM_NUTRITION_DETAIL, {
      item: n,
      gymName: gym.gym.gym_name,
      tag,
    });

  const renderSection = (label, rows, tag) => (
    <View style={styles.card}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{label}</Text>
        <Text style={styles.sectionCount}>{rows.length}</Text>
      </View>
      {rows.length === 0 ? (
        <Text style={styles.emptyHint}>
          {label === 'Assigned'
            ? 'Meal plans your gym assigns to you will appear here.'
            : 'Recipes and diet guides your gym recommends will appear here.'}
        </Text>
      ) : (
        rows.map((n, i) => (
          <TouchableOpacity
            key={`${tag}-${n.id}`}
            style={[styles.row, i === rows.length - 1 && { borderBottomWidth: 0 }]}
            onPress={() => openItem(n, tag)}
            accessibilityRole="button"
            accessibilityLabel={`Open gym nutrition ${n.title}`}
          >
            <Ionicons name="restaurant-outline" size={16} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowText} numberOfLines={1}>{n.title}</Text>
              <Text style={styles.rowHint} numberOfLines={1}>
                {[
                  GYM_NUTRITION_KIND_LABELS[n.kind] || n.kind,
                  n.targets?.calories != null ? `${n.targets.calories} kcal` : null,
                ].filter(Boolean).join(' · ') || 'Gym nutrition'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
          </TouchableOpacity>
        ))
      )}
    </View>
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
    >
      {content.loading && !content.data ? (
        <View style={styles.card}>
          <SkeletonRows colors={colors} />
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.primary} />
          </View>
        </View>
      ) : content.error && !content.data ? (
        <LoadError message="Couldn't load your gym's nutrition." onRetry={content.reload} />
      ) : (
        <>
          {renderSection('Assigned', sections.assigned, 'Assigned')}
          {renderSection('Recommended', sections.recommended, 'Recommended')}
        </>
      )}
    </ScrollView>
  );
}

// static placeholder bars — same loading language as the workouts list
function SkeletonRows({ colors }) {
  const styles = makeStyles(colors);
  return (
    <View style={{ gap: spacing.sm }}>
      {[54, 40, 46].map((h, i) => (
        <View
          key={i}
          style={[styles.skeletonBar, { backgroundColor: colors.cardLight, height: h }]}
        />
      ))}
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, paddingBottom: spacing.xxl },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: spacing.md, textAlign: 'center' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.lg - 2,
    marginBottom: spacing.md,
  },
  sectionHead: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  sectionTitle: { color: colors.text, fontSize: 13, fontWeight: '800', letterSpacing: 0.3, flex: 1 },
  sectionCount: {
    color: colors.textDim,
    fontSize: 11,
    fontWeight: '700',
    backgroundColor: colors.cardLight,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  emptyHint: { color: colors.textDim, fontSize: 12, lineHeight: 17 },
  skeletonBar: { borderRadius: 10 },
  loadingRow: { alignItems: 'center', paddingTop: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  rowHint: { color: colors.textDim, fontSize: 11, marginTop: 1 },
});
