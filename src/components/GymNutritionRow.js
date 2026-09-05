// GymNutritionRow — the compact "Gym Recommended →" strip on the Diet home
// screen (Phase 12; Phase 13 switched it to the UNIFIED /gym/my/content
// surface, one call for workouts AND nutrition). Deliberately minimal: one
// row, one modal, no redesign of the existing Diet experience. Shows nothing
// for standalone users. Assigned rows are window-aware server-side and carry
// starts_on/ends_on/notes, which this modal renders for the member.
//
// M2: each item now OPENS the full gym nutrition detail (log to a meal /
// save to My Dishes there), and content entries are normalized through
// gymContent.normalizeNutritionEntries() — gym-authored data can carry
// structured {text, type} lines, which crash React Native if rendered
// directly as <Text> children ("Objects are not valid as a React child").
// The pre-load placeholder row is gone too: the strip renders only once
// the fetch resolves, so standalone users never see a flash of a fake row.
import React, { useState } from 'react';
import { View, Text, Modal, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useColors } from '../theme';
import { fetchMyGymContent } from '../lib/gymApi';
import { normalizeNutritionEntries, GYM_NUTRITION_KIND_LABELS } from '../lib/gymContent';
import { GYM_NUTRITION_DETAIL } from '../shared/constants/routes';

export default function GymNutritionRow() {
  const colors = useColors();
  const navigation = useNavigation();
  const [perGym, setPerGym] = useState(null); // null = not loaded / nothing
  const [open, setOpen] = useState(false);

  const load = () => {
    fetchMyGymContent()
      .then((rows) => {
        if (!Array.isArray(rows)) return setPerGym([]);
        const meaningful = rows.filter(
          (g) => (g.nutrition?.recommended?.length || 0) + (g.nutrition?.assigned?.length || 0) > 0
        );
        setPerGym(meaningful);
      })
      .catch(() => setPerGym([]));
  };

  // resolve once on mount — no tappable placeholder for standalone users
  React.useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const styles = makeStyles(colors);

  if (perGym === null) return null; // still resolving
  if (perGym.length === 0) return null; // standalone user / nothing available

  const total = perGym.reduce(
    (n, g) => n + (g.nutrition?.recommended?.length || 0) + (g.nutrition?.assigned?.length || 0), 0
  );
  const gymLabel = perGym.length === 1 ? perGym[0].gym_name : `${perGym.length} gyms`;

  return (
    <>
      <TouchableOpacity onPress={() => { load(); setOpen(true); }} style={styles.row}>
        <Ionicons name="restaurant-outline" size={15} color={colors.primary} />
        <Text style={styles.rowText}>Gym Recommended</Text>
        <Text style={styles.count}>{total} · {gymLabel}</Text>
        <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
      </TouchableOpacity>

      <Modal visible={open} animationType="slide" transparent onRequestClose={() => setOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.sheet, { backgroundColor: colors.card }]}>
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: colors.text }]}>Gym nutrition</Text>
              <TouchableOpacity onPress={() => setOpen(false)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                <Ionicons name="close" size={20} color={colors.textDim} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 420 }}>
              {perGym.map((g) => (
                <View key={g.gym_id} style={{ marginBottom: 12 }}>
                  <Text style={[styles.gymName, { color: colors.textDim }]}>{g.gym_name}</Text>
                  {[...(g.nutrition?.assigned || []).map((n) => ({ n, tag: 'Assigned' })),
                    ...(g.nutrition?.recommended || []).map((n) => ({ n, tag: 'Recommended' }))].map(({ n, tag }) => (
                    // M2: tap opens the full detail — logging to a meal /
                    // saving to My Dishes happens there, on the existing
                    // diet infrastructure
                    <TouchableOpacity
                      key={`${tag}-${n.id}`}
                      style={[styles.item, { borderColor: colors.border }]}
                      onPress={() => {
                        setOpen(false);
                        navigation.navigate(GYM_NUTRITION_DETAIL, {
                          item: n,
                          gymName: g.gym_name,
                          tag,
                        });
                      }}
                      accessibilityRole="button"
                      accessibilityLabel={`Open ${n.title}`}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.itemTitle, { color: colors.text }]}>{n.title}</Text>
                        <Text style={[styles.itemMeta, { color: colors.textDim }]}>
                          {GYM_NUTRITION_KIND_LABELS[n.kind] || n.kind}
                          {n.targets?.calories ? ` · ${n.targets.calories} kcal` : ''}
                          {n.version ? ` · v${n.version}` : ''}
                        </Text>
                        {tag === 'Assigned' && (n.starts_on || n.ends_on) ? (
                          <Text style={[styles.itemMeta, { color: colors.textDim }]}>
                            {n.starts_on ? `From ${String(n.starts_on).slice(0, 10)}` : ''}
                            {n.starts_on && n.ends_on ? ' · ' : ''}
                            {n.ends_on ? `Until ${String(n.ends_on).slice(0, 10)}` : ''}
                          </Text>
                        ) : null}
                        {n.notes ? (
                          <Text style={[styles.entry, { color: colors.textDim }]}>"{n.notes}"</Text>
                        ) : null}
                        {normalizeNutritionEntries(n.content).slice(0, 3).map((e, i) => (
                          <Text key={`${i}-${e.text.slice(0, 20)}`} style={[styles.entry, { color: colors.textDim }]}>· {e.text}</Text>
                        ))}
                      </View>
                      <Text style={[styles.tag, { color: tag === 'Assigned' ? colors.primary : colors.textDim }]}>
                        {tag}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 12,
    borderRadius: 12,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  rowText: { flex: 1, fontSize: 13, fontWeight: '700', color: colors.text },
  count: { fontSize: 11, color: colors.textDim },
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 18, borderTopRightRadius: 18,
    padding: 16, maxHeight: '80%',
  },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sheetTitle: { fontSize: 17, fontWeight: '800' },
  gymName: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4, marginBottom: 6 },
  item: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#00000022',
  },
  itemTitle: { fontSize: 14, fontWeight: '700' },
  itemMeta: { fontSize: 11, marginTop: 1 },
  entry: { fontSize: 11, marginTop: 1 },
  tag: { fontSize: 10, fontWeight: '800', marginLeft: 8 },
});
