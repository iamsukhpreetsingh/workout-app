import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, FlatList, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';

const PRESET_TAGS = ['vegetarian', 'vegan', 'non-veg', 'high-protein', 'low-carb', 'dairy-free', 'gluten-free'];
const NUMS = { fontVariant: ['tabular-nums'] };

// Add/Edit dish form (modal) — compact 4-column macro row + tag chips
function DishForm({ visible, dish, onClose, onSave, onDelete }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const initForm = (d) => ({
    name: d.name || '',
    description: d.description || '',
    serving_size: d.serving_size || '',
    calories: d.calories != null ? String(d.calories) : '',
    protein_g: d.protein_g != null ? String(d.protein_g) : '',
    carbs_g: d.carbs_g != null ? String(d.carbs_g) : '',
    fat_g: d.fat_g != null ? String(d.fat_g) : '',
    recipe_url: d.recipe_url || '',
    prep_notes: d.prep_notes || '',
    tags: Array.isArray(d.tags) ? d.tags : [],
  });
  const [form, setForm] = useState(() => initForm(dish));
  const [customTag, setCustomTag] = useState('');

  React.useEffect(() => {
    if (visible) {
      setForm({
        name: dish.name || '',
        description: dish.description || '',
        serving_size: dish.serving_size || '',
        calories: dish.calories != null ? String(dish.calories) : '',
        protein_g: dish.protein_g != null ? String(dish.protein_g) : '',
        carbs_g: dish.carbs_g != null ? String(dish.carbs_g) : '',
        fat_g: dish.fat_g != null ? String(dish.fat_g) : '',
        recipe_url: dish.recipe_url || '',
        prep_notes: dish.prep_notes || '',
        tags: Array.isArray(dish.tags) ? dish.tags : [],
      });
      setCustomTag('');
    }
  }, [visible, dish?.id]);

  if (!visible) return null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleTag = (t) =>
    setForm((f) => ({
      ...f,
      tags: (f.tags || []).includes(t) ? f.tags.filter((x) => x !== t) : [...(f.tags || []), t],
    }));

  const submit = () => {
    if (!form.name.trim()) {
      Alert.alert('Name required', 'Give this dish a name.');
      return;
    }
    onSave({
      id: dish.id, // present when editing — PATCHes in place instead of creating
      ...form,
      calories: form.calories === '' ? null : Number(form.calories),
      protein_g: form.protein_g === '' ? null : Number(form.protein_g),
      carbs_g: form.carbs_g === '' ? null : Number(form.carbs_g),
      fat_g: form.fat_g === '' ? null : Number(form.fat_g),
    });
  };

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.formWrap}>
        <View style={styles.formHeader}>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="chevron-back" size={24} color={colors.textDim} />
          </TouchableOpacity>
          <Text style={styles.formTitle}>{dish.id ? 'Edit Dish' : 'New Dish'}</Text>
          {onDelete ? (
            <TouchableOpacity onPress={() => onDelete(dish)} style={{ padding: 4 }}>
              <Ionicons name="trash-outline" size={20} color={colors.red} />
            </TouchableOpacity>
          ) : (
            <View style={{ width: 24 }} />
          )}
        </View>

        {/* eslint-disable-next-line */}
        <FlatList
          data={[0]}
          keyExtractor={() => 'form'}
          renderItem={() => (
            <View style={{ paddingBottom: 30 }}>
              <Text style={styles.fieldLabel}>Dish name</Text>
              <TextInput style={styles.field} value={form.name} onChangeText={(v) => set('name', v)} placeholder="e.g. Grilled Chicken Bowl" placeholderTextColor={colors.textDim} />
              <Text style={styles.fieldLabel}>Short description (optional)</Text>
              <TextInput style={styles.field} value={form.description} onChangeText={(v) => set('description', v)} placeholder="High-protein breakfast bowl" placeholderTextColor={colors.textDim} />
              <Text style={styles.fieldLabel}>Serving size</Text>
              <TextInput style={styles.field} value={form.serving_size} onChangeText={(v) => set('serving_size', v)} placeholder="1 bowl (~300g)" placeholderTextColor={colors.textDim} />

              <View style={styles.macroRow}>
                {[
                  ['calories', 'Calories'],
                  ['protein_g', 'Protein'],
                  ['carbs_g', 'Carbs'],
                  ['fat_g', 'Fat'],
                ].map(([k, label]) => (
                  <View key={k} style={styles.macroCell}>
                    <Text style={styles.macroLabel}>{label}</Text>
                    <TextInput
                      style={[styles.field, styles.macroInput, NUMS]}
                      keyboardType="numeric"
                      value={form[k]}
                      onChangeText={(v) => set(k, v)}
                      placeholder="—"
                      placeholderTextColor={colors.textDim}
                    />
                  </View>
                ))}
              </View>

              <Text style={styles.fieldLabel}>Recipe link (optional)</Text>
              <TextInput style={styles.field} value={form.recipe_url} onChangeText={(v) => set('recipe_url', v)} placeholder="https://…" placeholderTextColor={colors.textDim} autoCapitalize="none" />
              <Text style={styles.fieldLabel}>Prep notes (optional)</Text>
              <TextInput style={[styles.field, { minHeight: 52 }]} value={form.prep_notes} onChangeText={(v) => set('prep_notes', v)} placeholder="soak oats overnight" placeholderTextColor={colors.textDim} multiline />

              <Text style={styles.fieldLabel}>Tags</Text>
              <View style={styles.tagPickRow}>
                {PRESET_TAGS.map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.tag, (form.tags || []).includes(t) && styles.tagOn]}
                    onPress={() => toggleTag(t)}
                  >
                    <Text style={[styles.tagText, (form.tags || []).includes(t) && { color: '#fff' }]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TextInput
                  style={[styles.field, { flex: 1 }]}
                  value={customTag}
                  onChangeText={setCustomTag}
                  placeholder="Custom tag"
                  placeholderTextColor={colors.textDim}
                />
                <TouchableOpacity
                  style={styles.addTagBtn}
                  onPress={() => {
                    const t = customTag.trim();
                    if (t && !(form.tags || []).includes(t)) toggleTag(t);
                    setCustomTag('');
                  }}
                >
                  <Ionicons name="add" size={16} color={colors.primary} />
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={styles.saveDishBtn} onPress={submit}>
                <Text style={styles.saveDishText}>Save Dish</Text>
              </TouchableOpacity>
            </View>
          )}
        />
      </View>
    </Modal>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    search: {
      margin: 20, marginBottom: 6, backgroundColor: colors.cardLight, color: colors.text,
      borderRadius: 10, paddingHorizontal: 14, paddingVertical: 10,
    },

    card: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.card, borderRadius: 14, padding: 14, marginBottom: 8,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    name: { color: colors.text, fontSize: 15, fontWeight: '700' },
    macro: { color: colors.textDim, fontSize: 12, marginTop: 2 },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
    tag: {
      backgroundColor: colors.cardLight, borderRadius: 8,
      paddingHorizontal: 8, paddingVertical: 3,
    },
    tagOn: { backgroundColor: colors.primary },
    tagText: { color: colors.textDim, fontSize: 10, fontWeight: '600' },

    emptyWrap: { alignItems: 'center', padding: 32 },
    emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '800', marginTop: 12 },
    emptySub: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 6, marginBottom: 18 },
    emptyBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12,
      paddingHorizontal: 18, paddingVertical: 11,
    },
    emptyBtnText: { color: colors.primary, fontWeight: '700' },

    formWrap: { flex: 1, backgroundColor: colors.bg, paddingTop: 12 },
    formHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 16, paddingVertical: 8,
    },
    formTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
    fieldLabel: { color: colors.textDim, fontSize: 11, fontWeight: '700', marginTop: 12, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
    field: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 10,
      paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
    },
    macroRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
    macroCell: { flex: 1 },
    macroLabel: { color: colors.textDim, fontSize: 11, marginBottom: 4, textAlign: 'center' },
    macroInput: { textAlign: 'center' },
    tagPickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
    addTagBtn: {
      backgroundColor: colors.cardLight, borderRadius: 10,
      paddingHorizontal: 12, justifyContent: 'center',
    },
    saveDishBtn: {
      backgroundColor: colors.primary, borderRadius: 12, padding: 15,
      alignItems: 'center', marginTop: 20,
    },
    saveDishText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  });

export default DishForm;
