import React from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import MealItemAlternativesEditor from '../../../components/MealItemAlternativesEditor';
import { macroLine } from '../utils/dietPlanUtils';

const NUMS = { fontVariant: ['tabular-nums'] };

/**
 * Presentational day card in the diet plan builder: collapsible header with
 * rename/remove, meal slots with items (multiplier stepper, macros,
 * alternatives editor, client note) and the add-meal chip row.
 * All mutations are owned by the container via callbacks.
 */
export default function DietDayCard({
  day,
  isCollapsed,
  styles,
  colors,
  clientName,
  self,
  catalog,
  refreshCatalog,
  clientProfile,
  onToggleCollapse,
  onRename,
  onRemove,
  onAddMealSlot,
  onOpenPicker,
  onAdjustMultiplier,
  onRemoveItem,
  onSetItemNote,
  onSetItemAlternatives,
}) {
  const d = day;
  return (
      <View key={d.key} style={styles.dayCard}>
        <View style={styles.dayHeader}>
          <TouchableOpacity style={{ flexDirection: 'row', alignItems: 'center', flex: 1, gap: 6 }} onPress={() => onToggleCollapse(d.key)}>
            <Ionicons name={isCollapsed ? 'chevron-forward' : 'chevron-down'} size={15} color={colors.textDim} />
            <TextInput
              style={styles.dayLabel}
              value={d.day_label}
              onChangeText={(v) => onRename(d.key, v)}
            />
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onRemove(d.key)} style={{ padding: 4 }}>
            <Ionicons name="close" size={16} color={colors.red} />
          </TouchableOpacity>
        </View>

        {!isCollapsed && (
          <View>
            {d.meals.map((m) => (
              <View key={m.key} style={styles.mealSlot}>
                <Text style={styles.mealType}>{String(m.meal_type).toUpperCase()}</Text>
                <TouchableOpacity
                  style={styles.addItemMini}
                  onPress={() => onOpenPicker(m.key, m.meal_type)}
                >
                  <Ionicons name="add" size={13} color={colors.primary} />
                  <Text style={styles.addItemMiniText}>Item</Text>
                </TouchableOpacity>
                {m.items.map((i) => (
                  <View key={i.key} style={styles.itemCard}>
                    <View style={styles.itemHeader}>
                      <Text style={styles.itemName} numberOfLines={1}>
                        {i.name}
                        {i.catalog_item_id ? ' ★' : ''}
                      </Text>
                      <View style={styles.multStepper}>
                        <TouchableOpacity onPress={() => onAdjustMultiplier(m.key, i.key, -0.5)}>
                          <Ionicons name="remove" size={13} color={colors.text} />
                        </TouchableOpacity>
                        <Text style={[styles.multText, NUMS]}>{i.quantity_multiplier || 1}x</Text>
                        <TouchableOpacity onPress={() => onAdjustMultiplier(m.key, i.key, 0.5)}>
                          <Ionicons name="add" size={13} color={colors.text} />
                        </TouchableOpacity>
                      </View>
                      <TouchableOpacity onPress={() => onRemoveItem(m.key, i.key)} style={{ padding: 3 }}>
                        <Ionicons name="close" size={14} color={colors.textDim} />
                      </TouchableOpacity>
                    </View>
                    <Text style={[styles.itemMacro, NUMS]}>{macroLine(i)}</Text>
                    {/* configured dish alternatives — same component in
                        BOTH builder contexts (self-authored + assign) */}
                    <MealItemAlternativesEditor
                      primaryName={i.name}
                      alternatives={i.alternatives || []}
                      onChange={(next) => onSetItemAlternatives(m.key, i.key, next)}
                      excludeNames={m.items
                        .filter((x) => x.key !== i.key)
                        .map((x) => x.name)}
                      self={self}
                      catalog={catalog}
                      refreshCatalog={refreshCatalog}
                      clientProfile={clientProfile}
                      clientName={clientName}
                    />
                    <TextInput
                      style={styles.itemNote}
                      value={i.client_note}
                      onChangeText={(v) => onSetItemNote(m.key, i.key, v)}
                      placeholder={`Note for ${clientName || 'client'} on this item (optional)`}
                      placeholderTextColor={colors.textDim}
                    />
                  </View>
                ))}
              </View>
            ))}
            <MealSlotChips onPick={(type) => onAddMealSlot(type)} styles={styles} colors={colors} />
          </View>
        )}
      </View>
  );
}

/** Chip row for adding a meal slot of a given type */
function MealSlotChips({ onPick, styles, colors }) {
  const MEAL_TYPES = ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Pre-Workout', 'Post-Workout'];
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {MEAL_TYPES.map((t) => (
        <TouchableOpacity key={t} style={styles.mealChip} onPress={() => onPick(t)}>
          <Ionicons name="add" size={11} color={colors.primary} />
          <Text style={styles.mealChipText}>{t}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}
