// GymNutritionRow — the compact "Gym Recommended →" strip on the Diet home
// screen (Phase 12). Deliberately minimal: one row, one modal, no redesign
// of the existing Diet experience. Shows nothing for standalone users.
// Data comes from /gym/my/nutrition (server-resolved: recommended + assigned
// + saved across the user's ACTIVE gym memberships).
import React, { useState } from 'react';
import { View, Text, Modal, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import { api } from '../lib/api';

const KIND_LABELS = {
  RECIPE: 'Recipe',
  MEAL_PLAN: 'Meal plan',
  DIET_RECOMMENDATION: 'Diet guide',
};

export default function GymNutritionRow() {
  const colors = useColors();
  const [perGym, setPerGym] = useState(null); // null = not loaded / nothing
  const [open, setOpen] = useState(false);

  const load = () => {
    api('/gym/my/nutrition')
      .then((rows) => {
        if (!Array.isArray(rows)) return setPerGym([]);
        const meaningful = rows.filter(
          (g) => (g.recommended?.length || 0) + (g.assigned?.length || 0) > 0
        );
        setPerGym(meaningful);
      })
      .catch(() => setPerGym([]));
  };

  const styles = makeStyles(colors);

  if (perGym === null) {
    return (
      <TouchableOpacity onPress={load} style={styles.row}>
        <Ionicons name="restaurant-outline" size={15} color={colors.primary} />
        <Text style={[styles.rowText, { color: colors.textDim }]}>Gym nutrition</Text>
        <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
      </TouchableOpacity>
    );
  }
  if (perGym.length === 0) return null; // standalone user / nothing available

  const total = perGym.reduce(
    (n, g) => n + (g.recommended?.length || 0) + (g.assigned?.length || 0), 0
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
                  {[...(g.assigned || []).map((n) => ({ n, tag: 'Assigned' })),
                    ...(g.recommended || []).map((n) => ({ n, tag: 'Recommended' }))].map(({ n, tag }) => (
                    <View key={`${tag}-${n.id}`} style={[styles.item, { borderColor: colors.border }]}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.itemTitle, { color: colors.text }]}>{n.title}</Text>
                        <Text style={[styles.itemMeta, { color: colors.textDim }]}>
                          {KIND_LABELS[n.kind] || n.kind}
                          {n.targets?.calories ? ` · ${n.targets.calories} kcal` : ''}
                          {n.version ? ` · v${n.version}` : ''}
                        </Text>
                        {(n.content?.entries || []).slice(0, 3).map((e, i) => (
                          <Text key={i} style={[styles.entry, { color: colors.textDim }]}>· {e}</Text>
                        ))}
                      </View>
                      <Text style={[styles.tag, { color: tag === 'Assigned' ? colors.primary : colors.textDim }]}>
                        {tag}
                      </Text>
                    </View>
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
