import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, FlatList, Alert, Image, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { useColors } from '../theme';
import { api } from '../lib/api';

const PRESET_ALLERGENS = ['nuts', 'dairy', 'gluten', 'shellfish', 'eggs', 'soy'];
const MEAL_SLOTS = ['Breakfast', 'Lunch', 'Dinner', 'Snack', 'Pre-Workout', 'Post-Workout'];
const DIFFICULTIES = ['easy', 'medium', 'hard'];
const NUMS = { fontVariant: ['tabular-nums'] };

const initForm = (d) => ({
  name: d.name || '',
  description: d.description || '',
  serving_size: d.serving_size || '',
  photo_path: d.photo_path || null,
  calories: d.calories != null ? String(d.calories) : '',
  protein_g: d.protein_g != null ? String(d.protein_g) : '',
  carbs_g: d.carbs_g != null ? String(d.carbs_g) : '',
  fat_g: d.fat_g != null ? String(d.fat_g) : '',
  recipe_url: d.recipe_url || '',
  prep_notes: d.prep_notes || '',
  tags: Array.isArray(d.tags) ? d.tags : [],
  ingredients: Array.isArray(d.ingredients) ? [...d.ingredients] : [''],
  allergens: Array.isArray(d.allergens) ? d.allergens : [],
  prep_time_minutes: d.prep_time_minutes != null ? String(d.prep_time_minutes) : '',
  cook_time_minutes: d.cook_time_minutes != null ? String(d.cook_time_minutes) : '',
  difficulty: d.difficulty || null,
  suggested_meal_types: Array.isArray(d.suggested_meal_types) ? d.suggested_meal_types : [],
  is_favorite: !!d.is_favorite,
  alternate_servings: Array.isArray(d.alternate_servings) ? d.alternate_servings.map((a) => ({
    label: a.label || '',
    calories: a.calories != null ? String(a.calories) : '',
    protein_g: a.protein_g != null ? String(a.protein_g) : '',
    carbs_g: a.carbs_g != null ? String(a.carbs_g) : '',
    fat_g: a.fat_g != null ? String(a.fat_g) : '',
  })) : [],
});

const num = (v) => (v === '' || v == null ? null : Number(v));

const buildPayload = (form) => ({
  ...form,
  ingredients: (form.ingredients || []).map((i) => i.trim()).filter(Boolean),
  calories: num(form.calories),
  protein_g: num(form.protein_g),
  carbs_g: num(form.carbs_g),
  fat_g: num(form.fat_g),
  prep_time_minutes: num(form.prep_time_minutes),
  cook_time_minutes: num(form.cook_time_minutes),
  alternate_servings: (form.alternate_servings || [])
    .filter((a) => a.label.trim())
    .map((a) => ({
      label: a.label.trim(),
      calories: num(a.calories),
      protein_g: num(a.protein_g),
      carbs_g: num(a.carbs_g),
      fat_g: num(a.fat_g),
    })),
});

// Advisory only — catches data-entry slips, never blocks save
function calorieMismatch(form) {
  const cal = num(form.calories);
  const p = num(form.protein_g), c = num(form.carbs_g), f = num(form.fat_g);
  if (cal == null || (p == null && c == null && f == null)) return null;
  const expected = (p || 0) * 4 + (c || 0) * 4 + (f || 0) * 9;
  if (expected <= 0) return null;
  if (Math.abs(cal - expected) / expected > 0.2) return Math.round(expected); // >20% off
  return null;
}

// Add/Edit dish form (modal). Only the name is required — every other
// field (incl. all migration-018 additions) is optional so a minimal dish
// saves exactly as fast as before.
function DishForm({ visible, dish, onClose, onSave, onUseOnce, onDelete }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [form, setForm] = useState(() => initForm(dish));
  const [customTag, setCustomTag] = useState('');
  const [customAllergen, setCustomAllergen] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [recipeTags, setRecipeTags] = useState([]);

  // Load recipe tags from API
  useEffect(() => {
    api('/trainer/tags/recipe')
      .then((tags) => setRecipeTags(tags?.map(t => t.name) || []))
      .catch(() => setRecipeTags([]));
  }, []);

  React.useEffect(() => {
    if (visible) {
      setForm(initForm(dish));
      setCustomTag('');
      setCustomAllergen('');
      setShowMore(false);
    }
  }, [visible, dish?.id]);

  if (!visible) return null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleIn = (key, t) =>
    setForm((f) => ({
      ...f,
      [key]: (f[key] || []).includes(t) ? f[key].filter((x) => x !== t) : [...(f[key] || []), t],
    }));

  const pickPhoto = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled) return;
    setPhotoBusy(true);
    try {
      // upload the bytes — a relative local path is useless to the client's
      // device, so catalog photos live on the server (URL stored in DB)
      const b64 = await FileSystem.readAsStringAsync(result.assets[0].uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const up = await api('/uploads/dish-photo', { method: 'POST', body: { image_base64: b64 } });
      set('photo_path', up.url);
    } catch (e) {
      Alert.alert('Photo upload failed', e.message || 'Please try again.');
    }
    setPhotoBusy(false);
  };

  const setAlt = (i, k, v) =>
    setForm((f) => {
      const alt = [...(f.alternate_servings || [])];
      alt[i] = { ...alt[i], [k]: v };
      return { ...f, alternate_servings: alt };
    });

  const validate = () => {
    if (!form.name.trim()) {
      Alert.alert('Name required', 'Give this dish a name.');
      return false;
    }
    return true;
  };

  const submit = () => {
    if (!validate()) return;
    onSave({ id: dish.id, ...buildPayload(form) });
  };

  const mismatch = calorieMismatch(form);

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.formWrap}>
        <View style={styles.formHeader}>
          <TouchableOpacity onPress={onClose}>
            <Ionicons name="chevron-back" size={24} color={colors.textDim} />
          </TouchableOpacity>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={styles.formTitle}>{dish.id ? 'Edit Dish' : 'New Dish'}</Text>
            <TouchableOpacity onPress={() => set('is_favorite', !form.is_favorite)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name={form.is_favorite ? 'star' : 'star-outline'} size={20} color={form.is_favorite ? colors.yellow : colors.textDim} />
            </TouchableOpacity>
          </View>
          {onDelete ? (
            <TouchableOpacity onPress={() => onDelete(dish)} style={{ padding: 4 }}>
              <Ionicons name="trash-outline" size={20} color={colors.red} />
            </TouchableOpacity>
          ) : (
            <View style={{ width: 24 }} />
          )}
        </View>

        <FlatList
          data={[0]}
          keyExtractor={() => 'form'}
          keyboardShouldPersistTaps="handled"
          renderItem={() => (
            <View style={{ paddingHorizontal: 16, paddingBottom: 30 }}>
              {/* photo */}
              <TouchableOpacity style={styles.photoBox} onPress={pickPhoto} disabled={photoBusy}>
                {photoBusy ? (
                  <ActivityIndicator color={colors.primary} />
                ) : form.photo_path ? (
                  <Image source={{ uri: form.photo_path }} style={styles.photoImg} />
                ) : (
                  <View style={styles.photoPlaceholder}>
                    <Ionicons name="camera-outline" size={22} color={colors.textDim} />
                    <Text style={styles.photoText}>Add Photo</Text>
                  </View>
                )}
                {form.photo_path != null && !photoBusy && (
                  <TouchableOpacity
                    style={styles.photoRemove}
                    onPress={() => set('photo_path', null)}
                  >
                    <Ionicons name="close-circle" size={20} color={colors.red} />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>

              <Text style={styles.fieldLabel}>Dish name</Text>
              <TextInput style={styles.field} value={form.name} onChangeText={(v) => set('name', v)} placeholder="e.g. Grilled Chicken Bowl" placeholderTextColor={colors.textDim} />
              <Text style={styles.fieldLabel}>Short description (optional)</Text>
              <TextInput style={styles.field} value={form.description} onChangeText={(v) => set('description', v)} placeholder="High-protein breakfast bowl" placeholderTextColor={colors.textDim} />
              <Text style={styles.fieldLabel}>Serving size</Text>
              <TextInput style={styles.field} value={form.serving_size} onChangeText={(v) => set('serving_size', v)} placeholder="1 bowl (~300g)" placeholderTextColor={colors.textDim} />

              {/* ingredients — scannable "what", distinct from prep notes' "how" */}
              <Text style={styles.fieldLabel}>Ingredients (optional)</Text>
              {(form.ingredients || []).map((ing, i) => (
                <View key={i} style={styles.lineRow}>
                  <TextInput
                    style={[styles.field, { flex: 1 }]}
                    value={ing}
                    onChangeText={(v) =>
                      setForm((f) => {
                        const arr = [...f.ingredients];
                        arr[i] = v;
                        return { ...f, ingredients: arr };
                      })
                    }
                    placeholder={i === 0 ? '2 eggs' : ''}
                    placeholderTextColor={colors.textDim}
                  />
                  <TouchableOpacity
                    style={styles.lineRemove}
                    onPress={() =>
                      setForm((f) => ({ ...f, ingredients: f.ingredients.filter((_, j) => j !== i) }))
                    }
                  >
                    <Ionicons name="close" size={16} color={colors.red} />
                  </TouchableOpacity>
                </View>
              ))}
              {(form.ingredients || []).length === 0 || (form.ingredients || []).every((x) => x.trim() !== '') ? (
                <TouchableOpacity
                  style={styles.addRow}
                  onPress={() => setForm((f) => ({ ...f, ingredients: [...(f.ingredients || []), ''] }))}
                >
                  <Ionicons name="add" size={15} color={colors.primary} />
                  <Text style={styles.addText}>Add Ingredient</Text>
                </TouchableOpacity>
              ) : null}

              {/* macros — 2x2 grid, all four visible without scrolling */}
              <View style={styles.macroGrid}>
                {[
                  ['calories', 'Calories'],
                  ['protein_g', 'Protein (g)'],
                  ['carbs_g', 'Carbs (g)'],
                  ['fat_g', 'Fat (g)'],
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
              {mismatch != null && (
                <View style={styles.mismatchRow}>
                  <Ionicons name="information-circle-outline" size={14} color={colors.yellow} />
                  <Text style={styles.mismatchText}>
                    Doesn't quite match your macros — expected ~{mismatch} cal
                  </Text>
                </View>
              )}

              {/* allergens — safety-relevant, visually separate from tags */}
              <View style={styles.allergenSection}>
                <View style={styles.allergenHeader}>
                  <Ionicons name="warning-outline" size={13} color={colors.red} />
                  <Text style={styles.allergenTitle}>Contains (allergens)</Text>
                </View>
                <View style={styles.tagPickRow}>
                  {PRESET_ALLERGENS.map((t) => (
                    <TouchableOpacity
                      key={t}
                      style={[styles.tag, styles.allergenTag, (form.allergens || []).includes(t) && styles.allergenTagOn]}
                      onPress={() => toggleIn('allergens', t)}
                    >
                      <Text style={[styles.tagText, (form.allergens || []).includes(t) && { color: '#fff' }]}>{t}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput
                    style={[styles.field, { flex: 1 }]}
                    value={customAllergen}
                    onChangeText={setCustomAllergen}
                    placeholder="Other allergen"
                    placeholderTextColor={colors.textDim}
                  />
                  <TouchableOpacity
                    style={styles.addTagBtn}
                    onPress={() => {
                      const t = customAllergen.trim().toLowerCase();
                      if (t && !(form.allergens || []).includes(t)) toggleIn('allergens', t);
                      setCustomAllergen('');
                    }}
                  >
                    <Ionicons name="add" size={16} color={colors.red} />
                  </TouchableOpacity>
                </View>
              </View>

              {/* "Best for" slots — informational, powers picker smart-filter */}
              <Text style={styles.fieldLabel}>Best for (optional)</Text>
              <View style={styles.tagPickRow}>
                {MEAL_SLOTS.map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.tag, (form.suggested_meal_types || []).includes(t) && styles.tagOn]}
                    onPress={() => toggleIn('suggested_meal_types', t)}
                  >
                    <Text style={[styles.tagText, (form.suggested_meal_types || []).includes(t) && { color: '#fff' }]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.fieldLabel}>Recipe link (optional)</Text>
              <TextInput style={styles.field} value={form.recipe_url} onChangeText={(v) => set('recipe_url', v)} placeholder="https://…" placeholderTextColor={colors.textDim} autoCapitalize="none" />
              <Text style={styles.fieldLabel}>Prep notes (optional)</Text>
              <TextInput style={[styles.field, { minHeight: 52 }]} value={form.prep_notes} onChangeText={(v) => set('prep_notes', v)} placeholder="soak oats overnight" placeholderTextColor={colors.textDim} multiline />

              {/* low-frequency extras collapsed by default to keep the basic
                  create-dish flow short */}
              <TouchableOpacity style={styles.moreToggle} onPress={() => setShowMore((s) => !s)}>
                <Ionicons name={showMore ? 'chevron-up' : 'chevron-down'} size={14} color={colors.textDim} />
                <Text style={styles.moreText}>{showMore ? 'Fewer details' : 'More details (time, difficulty, alt servings)'}</Text>
              </TouchableOpacity>
              {showMore && (
                <View>
                  <View style={styles.timeRow}>
                    <View style={styles.timeCell}>
                      <Text style={styles.macroLabel}>Prep (min)</Text>
                      <TextInput style={[styles.field, styles.macroInput, NUMS]} keyboardType="numeric" value={form.prep_time_minutes} onChangeText={(v) => set('prep_time_minutes', v)} placeholder="—" placeholderTextColor={colors.textDim} />
                    </View>
                    <View style={styles.timeCell}>
                      <Text style={styles.macroLabel}>Cook (min)</Text>
                      <TextInput style={[styles.field, styles.macroInput, NUMS]} keyboardType="numeric" value={form.cook_time_minutes} onChangeText={(v) => set('cook_time_minutes', v)} placeholder="—" placeholderTextColor={colors.textDim} />
                    </View>
                  </View>
                  <Text style={styles.fieldLabel}>Difficulty</Text>
                  <View style={styles.tagPickRow}>
                    {DIFFICULTIES.map((d) => (
                      <TouchableOpacity
                        key={d}
                        style={[styles.tag, form.difficulty === d && styles.tagOn]}
                        onPress={() => set('difficulty', form.difficulty === d ? null : d)}
                      >
                        <Text style={[styles.tagText, form.difficulty === d && { color: '#fff' }]}>
                          {d[0].toUpperCase() + d.slice(1)}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>

                  <Text style={styles.fieldLabel}>Alternate servings (optional)</Text>
                  {(form.alternate_servings || []).map((a, i) => (
                    <View key={i} style={styles.altBox}>
                      <View style={styles.lineRow}>
                        <TextInput
                          style={[styles.field, { flex: 1 }]}
                          value={a.label}
                          onChangeText={(v) => setAlt(i, 'label', v)}
                          placeholder="e.g. 100g"
                          placeholderTextColor={colors.textDim}
                        />
                        <TouchableOpacity
                          style={styles.lineRemove}
                          onPress={() =>
                            setForm((f) => ({
                              ...f,
                              alternate_servings: f.alternate_servings.filter((_, j) => j !== i),
                            }))
                          }
                        >
                          <Ionicons name="close" size={16} color={colors.red} />
                        </TouchableOpacity>
                      </View>
                      <View style={styles.altMacroRow}>
                        {[
                          ['calories', 'Cal'],
                          ['protein_g', 'P'],
                          ['carbs_g', 'C'],
                          ['fat_g', 'F'],
                        ].map(([k, label]) => (
                          <TextInput
                            key={k}
                            style={[styles.field, styles.altMacroInput, NUMS]}
                            keyboardType="numeric"
                            value={a[k]}
                            onChangeText={(v) => setAlt(i, k, v)}
                            placeholder={label}
                            placeholderTextColor={colors.textDim}
                          />
                        ))}
                      </View>
                    </View>
                  ))}
                  <TouchableOpacity
                    style={styles.addRow}
                    onPress={() =>
                      setForm((f) => ({
                        ...f,
                        alternate_servings: [
                          ...(f.alternate_servings || []),
                          { label: '', calories: '', protein_g: '', carbs_g: '', fat_g: '' },
                        ],
                      }))
                    }
                  >
                    <Ionicons name="add" size={15} color={colors.primary} />
                    <Text style={styles.addText}>Add Alternate Serving</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* tags stay last — preference categories, not safety */}
              <Text style={styles.fieldLabel}>Tags</Text>
              <View style={styles.tagPickRow}>
                {recipeTags.map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.tag, (form.tags || []).includes(t) && styles.tagOn]}
                    onPress={() => toggleIn('tags', t)}
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
                    if (t && !(form.tags || []).includes(t)) toggleIn('tags', t);
                    setCustomTag('');
                  }}
                >
                  <Ionicons name="add" size={16} color={colors.primary} />
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={styles.saveDishBtn} onPress={submit}>
                <Text style={styles.saveDishText}>Save Dish</Text>
              </TouchableOpacity>
              {onUseOnce && (
                <TouchableOpacity
                  style={styles.useOnceBtn}
                  onPress={() => {
                    if (!validate()) return;
                    onUseOnce({ ...buildPayload(form), id: undefined });
                  }}
                >
                  <Text style={styles.useOnceText}>Use Once — Don't Save</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        />
      </View>
    </Modal>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
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

    photoBox: {
      alignSelf: 'center', marginTop: 10, width: 110, height: 110,
      borderRadius: 14, overflow: 'hidden',
      backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    photoImg: { width: '100%', height: '100%' },
    photoPlaceholder: { alignItems: 'center', justifyContent: 'center', gap: 4 },
    photoText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
    photoRemove: { position: 'absolute', top: 4, right: 4 },

    lineRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
    lineRemove: {
      width: 34, height: 34, borderRadius: 10, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    addRow: {
      flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start',
      paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10,
      borderWidth: 1, borderColor: colors.border, marginBottom: 4,
    },
    addText: { color: colors.primary, fontWeight: '700', fontSize: 12 },

    macroGrid: {
      flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12,
      justifyContent: 'space-between',
    },
    macroCell: { width: '48%' },
    macroLabel: { color: colors.textDim, fontSize: 11, marginBottom: 4, textAlign: 'center' },
    macroInput: { textAlign: 'center' },
    mismatchRow: {
      flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8,
      backgroundColor: colors.cardLight, borderRadius: 8,
      paddingHorizontal: 10, paddingVertical: 7,
    },
    mismatchText: { color: colors.yellow, fontSize: 12, fontWeight: '600', flex: 1 },

    allergenSection: {
      marginTop: 14, borderWidth: 1, borderColor: colors.border, borderRadius: 12,
      padding: 12, backgroundColor: colors.card,
    },
    allergenHeader: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 8 },
    allergenTitle: { color: colors.red, fontSize: 11, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
    allergenTag: { borderWidth: 1, borderColor: colors.border },
    allergenTagOn: { backgroundColor: colors.red, borderColor: colors.red },

    tagPickRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
    tag: {
      backgroundColor: colors.cardLight, borderRadius: 8,
      paddingHorizontal: 8, paddingVertical: 3,
    },
    tagOn: { backgroundColor: colors.primary },
    tagText: { color: colors.textDim, fontSize: 10, fontWeight: '600' },
    addTagBtn: {
      backgroundColor: colors.cardLight, borderRadius: 10,
      paddingHorizontal: 12, justifyContent: 'center',
    },

    moreToggle: {
      flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 16,
      alignSelf: 'center', paddingVertical: 8, paddingHorizontal: 12,
      borderRadius: 10, backgroundColor: colors.cardLight,
    },
    moreText: { color: colors.textDim, fontSize: 12, fontWeight: '600' },

    timeRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
    timeCell: { flex: 1 },

    altBox: {
      borderWidth: 1, borderColor: colors.border, borderRadius: 12,
      padding: 10, marginBottom: 8, backgroundColor: colors.card,
    },
    altMacroRow: { flexDirection: 'row', gap: 8 },

    saveDishBtn: {
      backgroundColor: colors.primary, borderRadius: 12, padding: 15,
      alignItems: 'center', marginTop: 20,
    },
    saveDishText: { color: '#fff', fontWeight: '800', fontSize: 15 },
    useOnceBtn: {
      alignItems: 'center', padding: 12, marginTop: 6,
      borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    },
    useOnceText: { color: colors.textDim, fontWeight: '700', fontSize: 13 },
  });

export default DishForm;
