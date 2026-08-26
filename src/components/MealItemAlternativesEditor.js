import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import DishPickerModal from './DishPickerModal';

export const MAX_ALTERNATIVES = 3;

// Dish-alternatives editor for a meal item card — ONE shared component for
// BOTH builder contexts (self-authored Diet Plan builder and the trainer's
// Assign Diet Plan flow; both render through DietPlanBuilderScreen). Mirrors
// AlternativesEditor.js (the workout version), adapted to dishes/macros.
//
// Entirely optional per item: zero alternatives renders only the collapsed
// "+ Add Alternative" affordance. Cap of 3 is enforced here AND server-side;
// duplicates of the primary name or sibling alternatives are blocked in the
// picker (excludeNames) and re-checked on attach.
//
// Props:
//   primaryName   — the dish this entry is for
//   alternatives  — [{ name, calories, protein_g, carbs_g, fat_g,
//                     catalog_item_id }] — macro SNAPSHOTS taken on add
//   onChange      — (nextAlternatives) => void
//   excludeNames  — extra names hidden from the picker (other items on plan)
//   self / catalog / refreshCatalog / clientProfile / clientName — passed
//                   straight through to the shared DishPickerModal so this
//                   editor uses the SAME search modal as primary item-adding
export default function MealItemAlternativesEditor({
  primaryName,
  alternatives = [],
  onChange,
  excludeNames = [],
  self,
  catalog,
  refreshCatalog,
  clientProfile = null,
  clientName = '',
}) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const atCap = alternatives.length >= MAX_ALTERNATIVES;

  const addAlternative = (c) => {
    // snapshot macros NOW — later edits to the source catalog dish never
    // retroactively change an already-configured alternative
    const alt = {
      name: c.name,
      calories: c.calories ?? null,
      protein_g: c.protein_g ?? null,
      carbs_g: c.carbs_g ?? null,
      fat_g: c.fat_g ?? null,
      catalog_item_id: c.id ?? null,
    };
    // duplicate guard mirrors the server-side rule (belt and suspenders —
    // the picker already excludes used names)
    const dup = [primaryName, ...alternatives.map((a) => a.name)].some(
      (n) => String(n).trim().toLowerCase() === String(alt.name).trim().toLowerCase()
    );
    if (dup || atCap) return;
    onChange([...alternatives, alt]);
  };

  const altNames = alternatives.map((a) => a.name);

  return (
    <View style={styles.wrap}>
      <TouchableOpacity style={styles.headerBtn} onPress={() => setExpanded((v) => !v)}>
        <Ionicons name="swap-horizontal" size={13} color={colors.blue} />
        <Text style={[styles.headerText, atCap && styles.headerTextCap]}>
          {alternatives.length > 0
            ? `${alternatives.length} alternative${alternatives.length === 1 ? '' : 's'}`
            : 'Add Alternative'}
        </Text>
        <Text style={styles.count}>{alternatives.length}/{MAX_ALTERNATIVES}</Text>
        <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textDim} />
      </TouchableOpacity>

      {expanded && (
        <View style={styles.list}>
          {alternatives.map((alt, i) => (
            <View key={`${alt.name}-${i}`} style={styles.row}>
              <Ionicons name="arrow-forward" size={12} color={colors.textDim} />
              <View style={{ flex: 1 }}>
                <Text style={styles.rowName} numberOfLines={1}>{alt.name}</Text>
                {!!alt.calories && (
                  <Text style={[styles.rowMacro, NUMS]}>{alt.calories} cal</Text>
                )}
              </View>
              <TouchableOpacity
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                onPress={() => onChange(alternatives.filter((_, j) => j !== i))}
              >
                <Ionicons name="close" size={15} color={colors.textDim} />
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity
            style={[styles.addRow, atCap && styles.addRowDisabled]}
            disabled={atCap}
            onPress={() => setPickerVisible(true)}
          >
            <Ionicons name="add" size={14} color={atCap ? colors.textDim : colors.primary} />
            <Text style={[styles.addText, atCap && styles.addTextDisabled]}>
              {atCap ? `Up to ${MAX_ALTERNATIVES} alternatives` : 'Add Alternative'}
            </Text>
          </TouchableOpacity>
        </View>
      )}
      {!expanded && !atCap && (
        <TouchableOpacity style={styles.inlineAdd} onPress={() => setPickerVisible(true)}>
          <Ionicons name="add" size={14} color={colors.primary} />
          <Text style={styles.addText}>Add Alternative</Text>
        </TouchableOpacity>
      )}

      {/* SAME picker as the primary "+ Item" action — no second UI.
          The current primary + already-added alternatives are excluded. */}
      <DishPickerModal
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        title={`Alternative for ${primaryName}`}
        self={self}
        catalog={catalog}
        refreshCatalog={refreshCatalog}
        slotHint=""
        excludeNames={[primaryName, ...altNames, ...excludeNames]}
        clientProfile={clientProfile}
        clientName={clientName}
        onPickCatalog={addAlternative}
        onPickCustom={(item) => addAlternative(item)}
      />
    </View>
  );
}

const NUMS = { fontVariant: ['tabular-nums'] };

const makeStyles = (colors) =>
  StyleSheet.create({
    wrap: { marginTop: 6 },
    headerBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.card,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 7,
      alignSelf: 'flex-start',
    },
    headerText: { color: colors.blue, fontWeight: '600', fontSize: 12 },
    headerTextCap: { color: colors.textDim },
    count: { color: colors.textDim, fontSize: 11, fontVariant: ['tabular-nums'] },
    list: { marginTop: 6, gap: 4 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.card,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    rowName: { color: colors.text, fontSize: 13 },
    rowMacro: { color: colors.textDim, fontSize: 10, marginTop: 1 },
    inlineAdd: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      alignSelf: 'flex-start',
      paddingLeft: 2,
      paddingTop: 4,
    },
    addRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.border,
      borderStyle: 'dashed',
      paddingHorizontal: 10,
      paddingVertical: 7,
      alignSelf: 'flex-start',
    },
    addRowDisabled: { opacity: 0.55 },
    addText: { color: colors.primary, fontWeight: '600', fontSize: 12 },
    addTextDisabled: { color: colors.textDim },
  });
