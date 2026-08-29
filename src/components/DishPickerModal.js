import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet,
  Modal, FlatList, ActivityIndicator, Image, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../lib/api';
import { useColors } from '../theme';
import CatalogSearch from './CatalogSearch';
import DishForm from './DishForm';
import { listRecipes, createRecipe, getRecipe } from '../db/recipes';
import { splitAllergens, getAllergenConflicts } from '../lib/allergens';

const NUMS = { fontVariant: ['tabular-nums'] };

// THE one "Add Item" search modal for dishes — From Catalog / Custom Item
// tabs, favorites/tags filtering, allergen badges, nested quick-create
// DishForm. Used by BOTH builder contexts (self-authored plan builder via
// My Dishes, trainer assign builder via the trainer Meal Catalog) AND the
// Phase-3 swap fallback ("Choose a different dish"). Never build a second
// picker.
//
// Props:
//   visible / onClose
//   title            — sheet heading ("Add to Breakfast", "Swap Oatmeal…")
//   self             — true → personal recipe catalog ("My Dishes");
//                      false → trainer Meal Catalog
//   catalog          — dish array (owner-appropriate; parent loads it)
//   refreshCatalog   — async () => fresh dish array (re-run on every open)
//   slotHint         — meal-type string; dishes tagged for it rank first
//   excludeNames     — names hidden from results (primary dish + already-
//                      added alternatives for the alternatives picker)
//   clientProfile    — intake profile; null skips all allergen warnings
//   clientName       — display name for warning copy
//   onPickCatalog(c) — snapshot attach of one catalog dish (after any
//                      allergen soft-confirm)
//   onPickCustom(it) — free-typed/custom item submit
export default function DishPickerModal({
  visible,
  onClose,
  title,
  self,
  catalog,
  refreshCatalog,
  slotHint = '',
  excludeNames = [],
  clientProfile = null,
  clientName = '',
  onPickCatalog,
  onPickCustom,
}) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [mode, setMode] = useState('catalog');
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState(null);
  const [favOnly, setFavOnly] = useState(false);
  const [quickCreate, setQuickCreate] = useState(false);
  const [customForm, setCustomForm] = useState({ form: {}, saveToCatalog: false });

  // fresh state per open — stale queries/filters never leak between uses
  useEffect(() => {
    if (visible) {
      setMode('catalog');
      setQuery('');
      setTag(null);
      setFavOnly(false);
      setQuickCreate(false);
      setCustomForm({ form: {}, saveToCatalog: false });
      if (refreshCatalog) refreshCatalog().catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const excludedLower = new Set(excludeNames.map((n) => String(n).trim().toLowerCase()));

  const slotWord = String(slotHint || '').toLowerCase().replace('-', '');
  const rankFor = (c) =>
    (c.suggested_meal_types || []).some(
      (t) => t.toLowerCase().replace('-', '').replace(' ', '') === slotWord
    )
      ? 0
      : 1;

  const filtered = (catalog || [])
    .filter((c) => !excludedLower.has(String(c.name).trim().toLowerCase()))
    .filter((c) => {
      const q = query.trim().toLowerCase();
      const matchesText = !q || c.name.toLowerCase().includes(q) || (c.tags || []).some((t) => t.toLowerCase().includes(q));
      const matchesTag = !tag || (c.tags || []).includes(tag);
      const matchesFav = !favOnly || c.is_favorite;
      return matchesText && matchesTag && matchesFav;
    })
    .slice()
    .sort((a, b) => rankFor(a) - rankFor(b));

  // one tap → snapshot attach → close. Allergen conflicts trigger a soft
  // confirm first — never a hard block (trainer's clinical judgment wins).
  const attachCatalogItem = (c) => {
    const conflicts = clientProfile
      ? getAllergenConflicts(clientProfile.allergens, c.allergens)
      : [];

    const doAttach = () => {
      onPickCatalog?.(c);
      onClose();
    };

    if (conflicts.length) {
      Alert.alert(
        'Allergen warning',
        `This recipe contains ${conflicts.join(', ')}, which ${
          clientName || 'the client'
        } has listed as an allergen. Add anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Add Anyway', style: 'destructive', onPress: doAttach },
        ],
        { cancelable: true }
      );
      return; // Cancel keeps the picker open so another dish can be chosen
    }

    doAttach();
  };

  const submitCustom = () => {
    const f = customForm.form;
    if (!f.name?.trim()) {
      Alert.alert('Name required', 'Give this item a name.');
      return;
    }
    onPickCustom?.({
      name: f.name.trim(),
      calories: f.calories === '' ? null : Number(f.calories),
      protein_g: f.protein_g === '' ? null : Number(f.protein_g),
      carbs_g: f.carbs_g === '' ? null : Number(f.carbs_g),
      fat_g: f.fat_g === '' ? null : Number(f.fat_g),
      serving_size: f.serving_size || null,
      recipe_url: f.recipe_url || null,
      saveToCatalog: customForm.saveToCatalog,
    });
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => { if (!quickCreate) onClose(); }}>
      <View style={styles.pickWrap}>
        <View style={styles.pickSheet}>
          <Text style={styles.pickTitle}>{title}</Text>
          <View style={styles.pickTabs}>
            {[
              { key: 'catalog', label: self ? 'My Dishes' : 'From Catalog' },
              { key: 'custom', label: 'Custom Item' },
            ].map((t) => {
              const on = mode === t.key;
              return (
                <TouchableOpacity
                  key={t.key}
                  style={[styles.pickTab, on && styles.pickTabOn]}
                  onPress={() => setMode(t.key)}
                >
                  <Text style={[styles.pickTabText, on && { color: '#fff' }]}>{t.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {mode === 'catalog' ? (
            <View style={{ flex: 1 }}>
              <CatalogSearch
                query={query}
                onQuery={setQuery}
                tag={tag}
                onTag={setTag}
                favOnly={favOnly}
                onFavOnly={setFavOnly}
              />
              {catalog === null ? (
                <ActivityIndicator color={colors.primary} size="small" style={{ marginTop: 20 }} />
              ) : filtered.length === 0 ? (
                <View style={styles.pickEmpty}>
                  <Text style={styles.pickEmptyText}>
                    {(catalog || []).length === 0
                      ? self
                        ? 'No saved dishes yet — create one below'
                        : 'Your catalog is empty'
                      : 'No dishes found'}
                  </Text>
                  <TouchableOpacity style={styles.pickQuickBtn} onPress={() => setQuickCreate(true)}>
                    <Ionicons name="add" size={15} color={colors.primary} />
                    <Text style={styles.pickQuickText}>Add New Dish</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <FlatList
                  data={filtered}
                  keyExtractor={(c) => String(c.id)}
                  contentContainerStyle={{ paddingBottom: 10 }}
                  renderItem={({ item: c }) => (
                    <TouchableOpacity
                      style={styles.pickRow}
                      // one tap attaches the snapshot and closes
                      onPress={() => attachCatalogItem(c)}
                    >
                      {c.photo_path ? (
                        <Image source={{ uri: c.photo_path }} style={styles.pickThumb} />
                      ) : (
                        <View style={[styles.pickThumb, { backgroundColor: colors.cardLight, alignItems: 'center', justifyContent: 'center' }]}>
                          <Ionicons name="restaurant-outline" size={14} color={colors.textDim} />
                        </View>
                      )}
                      <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                          {c.is_favorite && <Ionicons name="star" size={11} color={colors.yellow} />}
                          <Text style={styles.pickName} numberOfLines={1}>
                            {c.name}
                          </Text>
                        </View>
                        <Text style={[styles.pickMacro, NUMS]}>
                          {c.calories != null ? `${c.calories} cal` : ''}
                          {c.protein_g != null ? ` · ${Math.round(c.protein_g)}P` : ''}
                          {c.carbs_g != null ? ` ${Math.round(c.carbs_g)}C` : ''}
                          {c.fat_g != null ? ` ${Math.round(c.fat_g)}F` : ''}
                        </Text>
                        {(() => {
                          const { conflicts, others } = clientProfile
                            ? splitAllergens(clientProfile.allergens, c.allergens)
                            : { conflicts: [], others: c.allergens || [] };
                          return (
                            <>
                              {conflicts.length > 0 && (
                                <View style={styles.pickAllergen}>
                                  <Ionicons name="warning" size={10} color={colors.red} />
                                  <Text style={styles.pickAllergenText}>
                                    Contains: {conflicts.join(', ')} — client allergy
                                  </Text>
                                </View>
                              )}
                              {others.length > 0 && (
                                <View style={styles.pickAllergen}>
                                  <Ionicons name="warning" size={10} color={colors.red} />
                                  <Text style={styles.pickAllergenText}>Contains: {others.join(', ')}</Text>
                                </View>
                              )}
                            </>
                          );
                        })()}
                      </View>
                      <Ionicons name="add-circle-outline" size={20} color={colors.primary} />
                    </TouchableOpacity>
                  )}
                />
              )}
            </View>
          ) : (
            <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled">
              <TextInput
                style={styles.sheetField}
                placeholder="Item name"
                placeholderTextColor={colors.textDim}
                value={customForm.form.name || ''}
                onChangeText={(v) => setCustomForm((c) => ({ ...c, form: { ...c.form, name: v } }))}
              />
              <View style={styles.macroRow}>
                {[
                  ['calories', 'Cal'],
                  ['protein_g', 'P'],
                  ['carbs_g', 'C'],
                  ['fat_g', 'F'],
                ].map(([k, label]) => (
                  <View key={k} style={styles.macroCell}>
                    <Text style={styles.macroLabel}>{label}</Text>
                    <TextInput
                      style={[styles.sheetField, styles.macroInput, NUMS]}
                      keyboardType="numeric"
                      value={customForm.form[k] || ''}
                      onChangeText={(v) => setCustomForm((c) => ({ ...c, form: { ...c.form, [k]: v } }))}
                      placeholder="—"
                      placeholderTextColor={colors.textDim}
                    />
                  </View>
                ))}
              </View>
              <TextInput
                style={styles.sheetField}
                placeholder="Serving size (optional)"
                placeholderTextColor={colors.textDim}
                value={customForm.form.serving_size || ''}
                onChangeText={(v) => setCustomForm((c) => ({ ...c, form: { ...c.form, serving_size: v } }))}
              />
              <TextInput
                style={styles.sheetField}
                placeholder="Recipe link (optional)"
                placeholderTextColor={colors.textDim}
                autoCapitalize="none"
                value={customForm.form.recipe_url || ''}
                onChangeText={(v) => setCustomForm((c) => ({ ...c, form: { ...c.form, recipe_url: v } }))}
              />
              <TouchableOpacity
                style={styles.checkRow}
                onPress={() => setCustomForm((c) => ({ ...c, saveToCatalog: !c.saveToCatalog }))}
              >
                <Ionicons
                  name={customForm.saveToCatalog ? 'checkbox' : 'square-outline'}
                  size={18}
                  color={colors.primary}
                />
                <Text style={styles.checkText}>
                  {self ? 'Save to My Dishes too' : 'Save to my catalog too'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.pickAttachBtn} onPress={submitCustom}>
                <Text style={styles.pickAttachText}>Add Item</Text>
              </TouchableOpacity>
            </ScrollView>
          )}

          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>

        {/* empty-catalog escape hatch: create a dish without leaving the
            picker; lands back in the catalog tab, ready to attach */}
        <DishForm
          visible={quickCreate}
          dish={{}}
          self={self}
          onClose={() => setQuickCreate(false)}
          onSave={async (item) => {
            // Save to My Dishes / trainer catalog, then attach
            try {
              const created = self
                ? await getRecipe(await createRecipe(item))
                : await api('/trainer/meal-catalog', { method: 'POST', body: item });
              onPickCatalog?.(created);
              onClose();
            } catch (e) {
              Alert.alert('Could not save dish', e.message || 'Please try again.');
            }
            setQuickCreate(false);
          }}
          onUseOnce={(item) => {
            // add to this plan only — never saved to the catalog
            onPickCustom?.({
              name: item.name,
              calories: item.calories ?? null,
              protein_g: item.protein_g ?? null,
              carbs_g: item.carbs_g ?? null,
              fat_g: item.fat_g ?? null,
              serving_size: item.serving_size || null,
              recipe_url: item.recipe_url || null,
              saveToCatalog: false,
            });
            setQuickCreate(false);
            onClose();
          }}
          onDelete={null}
        />
      </View>
    </Modal>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    macroRow: { flexDirection: 'row', gap: 8 },
    macroCell: { flex: 1 },
    macroLabel: { color: colors.textDim, fontSize: 11, marginBottom: 4, textAlign: 'center' },
    macroInput: { textAlign: 'center', paddingVertical: 9 },

    pickWrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    // fixed height (not maxHeight) so the flex:1 content area has real
    // bounds — auto-height + flex children collapsed the dish list to zero
    pickSheet: {
      backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
      padding: 18, height: '82%',
    },
    pickTitle: { color: colors.text, fontSize: 17, fontWeight: '800', marginBottom: 10 },
    pickTabs: { flexDirection: 'row', backgroundColor: colors.cardLight, borderRadius: 12, padding: 3, marginBottom: 10 },
    pickTab: { flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 8 },
    pickTabOn: { backgroundColor: colors.primary },
    pickTabText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },
    pickThumb: { width: 40, height: 40, borderRadius: 9, marginRight: 2 },
    pickAllergen: {
      flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4,
      alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.red,
      borderRadius: 6, paddingHorizontal: 5, paddingVertical: 2,
    },
    pickAllergenText: { color: colors.red, fontSize: 10, fontWeight: '700' },
    pickRow: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 6,
      shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.1, shadowRadius: 6, elevation: 2,
    },
    pickName: { color: colors.text, fontSize: 14, fontWeight: '700' },
    pickMacro: { color: colors.textDim, fontSize: 11, marginTop: 2 },
    pickEmpty: { alignItems: 'center', paddingVertical: 28 },
    pickEmptyText: { color: colors.textDim, fontSize: 13, marginBottom: 12 },
    pickQuickBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 7,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12,
      paddingHorizontal: 16, paddingVertical: 10,
    },
    pickQuickText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
    pickAttachBtn: { backgroundColor: colors.primary, borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 6 },
    pickAttachText: { color: '#fff', fontWeight: '800' },
    sheetField: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 9, marginBottom: 8, fontSize: 14,
    },
    checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginVertical: 8 },
    checkText: { color: colors.text, fontSize: 13 },
    cancelBtn: { alignItems: 'center', padding: 10, marginTop: 4 },
    cancelText: { color: colors.textDim, fontWeight: '700' },
  });
