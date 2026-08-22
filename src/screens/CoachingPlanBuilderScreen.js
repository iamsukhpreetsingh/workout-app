import React, { useState } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, Alert, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../lib/api';
import { useColors } from '../theme';
import ClientTagSelector from '../components/ClientTagSelector';
import { createSupplementPlan, updateSupplementPlan, getSupplementPlan, isLocalSupplementPlanId } from '../db/supplementPlans';

// Generic builder for diet and supplement plans — same form pattern as the
// routine builder, configured per kind.
const KIND_CONFIG = {
  diet: {
    endpoint: 'diet-plans',
    itemLabel: 'Meal',
    addLabel: 'Add Meal',
    fields: [
      { key: 'meal_label', placeholder: 'Meal (e.g. Breakfast)', flex: 1 },
      { key: 'description', placeholder: 'Foods, portions, macro targets', multiline: true },
    ],
    toApiItem: (item, i) => ({ meal_label: item.meal_label, description: item.description, order_index: i }),
    validate: (item) => item.meal_label && item.description,
    validateMsg: 'Each meal needs a label and description',
  },
  supplement: {
    endpoint: 'supplement-plans',
    itemLabel: 'Supplement',
    addLabel: 'Add Supplement',
    fields: [
      { key: 'supplement_name', placeholder: 'Supplement (e.g. Creatine)', flex: 1 },
      { key: 'dosage', placeholder: 'Dosage (e.g. 5g)', width: 110 },
      { key: 'timing', placeholder: 'Timing (e.g. Post-workout)', width: 150 },
      { key: 'notes', placeholder: 'Notes (optional)', multiline: true },
    ],
    toApiItem: (item, i) => ({
      supplement_name: item.supplement_name,
      dosage: item.dosage || null,
      timing: item.timing || null,
      notes: item.notes || null,
      order_index: i,
    }),
    validate: (item) => item.supplement_name,
    validateMsg: 'Each supplement needs a name',
  },
};

export default function CoachingPlanBuilderScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { kind, clientId, clientName, self, editPlanId } = route.params || {};
  if (!KIND_CONFIG[kind]) {
    throw new Error(`Unknown plan kind: ${kind}`);
  }
  const cfg = KIND_CONFIG[kind];

  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState([]); // [{...fieldValues}]
  const [busy, setBusy] = useState(false);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(!!editPlanId);

  React.useLayoutEffect(() => {
    const prefix = kind === 'diet' ? 'Diet' : 'Supplement';
    navigation.setOptions({
      title: editPlanId
        ? `Edit ${prefix} Plan`
        : self
        ? `New ${prefix} Plan`
        : `${prefix} Plan → ${clientName || 'Client'}`,
    });
  }, [navigation, kind, clientName, self, editPlanId]);

  React.useEffect(() => {
    if (!editPlanId) return;
    // const endpoint = kind === 'supplement' ? 'supplement-plans' : 'diet-plans';
    // api(`/client/${endpoint}/${editPlanId}`)
        const loadPromise =
      kind === 'supplement' && isLocalSupplementPlanId(editPlanId)
        ? getSupplementPlan(editPlanId)
        : api(`/client/${kind === 'supplement' ? 'supplement-plans' : 'diet-plans'}/${editPlanId}`);
    loadPromise
      .then((pl) => {
        setName(pl.name || '');
        setNotes(pl.notes || '');
        setTags(pl.tags || []);
        if (kind === 'supplement' && pl.items) {
          setItems(pl.items.map((it) => ({
            supplement_name: it.supplement_name,
            dosage: it.dosage || '',
            timing: it.timing || '',
            notes: it.notes || '',
          })));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [editPlanId, kind]);

  const addItem = () => setItems((prev) => [...prev, {}]);
  const updateItem = (i, key, value) =>
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, [key]: value } : it)));
  const removeItem = (i) => setItems((prev) => prev.filter((_, idx) => idx !== i));

  const save = async () => {
    if (busy) return;
    if (!name.trim()) return Alert.alert('Name required', 'Give this plan a name.');
    if (!items.length) return Alert.alert('No items', `Add at least one ${cfg.itemLabel.toLowerCase()}.`);
    for (const item of items) {
      if (!cfg.validate(item)) return Alert.alert('Incomplete', cfg.validateMsg);
    }
    setBusy(true);
    try {
      const body = { name: name.trim(), notes: notes.trim() || null, items: items.map(cfg.toApiItem) };
      if (self) {
        body.tags = tags;
      }
      
      // if (editPlanId) {
      //   // Edit mode - supplements only for now (diet uses DietPlanBuilder)
      //   if (kind === 'supplement') {
      //     await api(`/client/${cfg.endpoint}/${editPlanId}`, { method: 'PATCH', body });
      //   }
      // } else if (self) {
      //   await api(`/client/${cfg.endpoint}`, { method: 'POST', body });
      // } else {
        if (editPlanId) {
        // Edit mode - supplements only for now (diet uses DietPlanBuilder)
        if (kind === 'supplement') {
          if (isLocalSupplementPlanId(editPlanId)) {
            await updateSupplementPlan(editPlanId, body); // local-first edit
          } else {
            await api(`/client/${cfg.endpoint}/${editPlanId}`, { method: 'PATCH', body }); // legacy
          }
        }
      } else if (self) {
        await createSupplementPlan(body); // local-first create — works offline
      } else {
        await api(`/trainer/clients/${clientId}/${cfg.endpoint}`, { method: 'POST', body });
      }
      navigation.goBack(); // list refreshes on focus
    } catch (e) {
      Alert.alert('Could not save', e.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      <TextInput
        style={styles.input}
        placeholder="Plan name"
        placeholderTextColor={colors.textDim}
        value={name}
        onChangeText={setName}
      />
      <TextInput
        style={[styles.input, styles.notesInput]}
        placeholder="Notes (optional)"
        placeholderTextColor={colors.textDim}
        value={notes}
        onChangeText={setNotes}
        multiline
      />

      {self && (
        <ClientTagSelector
          value={tags}
          onChange={setTags}
          type={kind === 'diet' ? 'recipe' : 'workout'}
        />
      )}

      {items.map((item, i) => (
        <View key={i} style={styles.itemCard}>
          <View style={styles.itemHeader}>
            <View style={styles.idxBadge}>
              <Text style={styles.idxText}>{i + 1}</Text>
            </View>
            <Text style={styles.itemLabel}>{cfg.itemLabel}</Text>
            <TouchableOpacity style={styles.removeBtn} onPress={() => removeItem(i)}>
              <Ionicons name="close" size={16} color={colors.textDim} />
            </TouchableOpacity>
          </View>
          {cfg.fields.map((f) =>
            f.multiline ? (
              <TextInput
                key={f.key}
                style={[styles.input, styles.itemInput, { minHeight: 56 }]}
                placeholder={f.placeholder}
                placeholderTextColor={colors.textDim}
                value={item[f.key] || ''}
                onChangeText={(v) => updateItem(i, f.key, v)}
                multiline
              />
            ) : (
              <TextInput
                key={f.key}
                style={[styles.input, styles.itemInput, f.width ? { width: f.width, flex: 0 } : null]}
                placeholder={f.placeholder}
                placeholderTextColor={colors.textDim}
                value={item[f.key] || ''}
                onChangeText={(v) => updateItem(i, f.key, v)}
              />
            )
          )}
        </View>
      ))}

      <TouchableOpacity style={styles.addBtn} onPress={addItem}>
        <Ionicons name="add" size={18} color={colors.primary} />
        <Text style={styles.addBtnText}>{cfg.addLabel}</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={busy || loading}>
        <Text style={styles.saveBtnText}>
          {busy
            ? 'Saving…'
            : editPlanId
            ? 'Save Changes'
            : self
            ? `Save ${kind === 'diet' ? 'Diet' : 'Supplement'} Plan`
            : `Assign ${kind === 'diet' ? 'Diet' : 'Supplement'} Plan`}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    input: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 12,
      paddingHorizontal: 14, paddingVertical: 13, marginBottom: 10, fontSize: 15,
      borderWidth: 1.5, borderColor: 'transparent',
    },
    notesInput: { minHeight: 64, paddingTop: 12 },
    itemCard: {
      backgroundColor: colors.card, borderRadius: 14, padding: 12, marginBottom: 10,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    itemHeader: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 },
    idxBadge: {
      width: 26, height: 26, borderRadius: 8, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    idxText: { color: colors.primary, fontWeight: '800', fontSize: 12 },
    itemLabel: { color: colors.text, fontWeight: '700', flex: 1 },
    removeBtn: { padding: 6 },
    itemInput: { marginBottom: 8, backgroundColor: colors.cardLight },
    addBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      borderRadius: 14, borderWidth: 1.5, borderColor: colors.primary,
      paddingVertical: 14, marginTop: 4, marginBottom: 16,
    },
    addBtnText: { color: colors.primary, fontWeight: '700', fontSize: 15 },
    saveBtn: {
      backgroundColor: colors.primary, borderRadius: 14, padding: 16, alignItems: 'center',
      shadowColor: colors.primary, shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.35, shadowRadius: 12, elevation: 5,
    },
    saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  });
