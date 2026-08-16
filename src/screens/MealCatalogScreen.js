import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Modal,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../lib/api';
import { useColors } from '../theme';
import DishForm from '../components/DishForm';
import CatalogSearch from '../components/CatalogSearch';

const NUMS = { fontVariant: ['tabular-nums'] };

// Trainer-wide dish library. Deleting a dish never affects plans that
// already used it (plan items are snapshots) — only future selection.
export default function MealCatalogScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [items, setItems] = useState(null); // null = loading
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState(null);
  const [editing, setEditing] = useState(null); // null | {} | item

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity onPress={() => setEditing({})} style={{ padding: 8 }}>
          <Ionicons name="add" size={22} color={colors.primary} />
        </TouchableOpacity>
      ),
    });
  }, [navigation, colors]);

  const load = useCallback(async () => {
    try {
      setItems(await api('/trainer/meal-catalog'));
    } catch (e) {
      setItems([]);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const filtered = (items || []).filter((i) => {
    const q = query.trim().toLowerCase();
    const matchesText =
      !q ||
      i.name.toLowerCase().includes(q) ||
      (i.tags || []).some((t) => t.toLowerCase().includes(q));
    const matchesTag = !tagFilter || (i.tags || []).includes(tagFilter);
    return matchesText && matchesTag;
  });

  const save = async (item) => {
    try {
      if (item.id) {
        await api(`/trainer/meal-catalog/${item.id}`, { method: 'PATCH', body: item });
      } else {
        await api('/trainer/meal-catalog', { method: 'POST', body: item });
      }
      setEditing(null);
      load();
    } catch (e) {
      Alert.alert('Could not save dish', e.message || 'Please try again.');
    }
  };

  const confirmDelete = (item) =>
    Alert.alert(
      'Delete dish',
      `"${item.name}" will be removed from your catalog. Plans already using it keep their copied data.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await api(`/trainer/meal-catalog/${item.id}`, { method: 'DELETE' });
              setEditing(null);
              load();
            } catch (e) {
              Alert.alert('Could not delete', e.message || 'Please try again.');
            }
          },
        },
      ]
    );

  if (items === null) {
    return (
      <View style={[styles.container, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={{ paddingHorizontal: 20 }}>
        <CatalogSearch
          query={query}
          onQuery={setQuery}
          tag={tagFilter}
          onTag={setTagFilter}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(i) => String(i.id)}
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Ionicons name="restaurant-outline" size={36} color={colors.textDim} />
            <Text style={styles.emptyTitle}>No dishes yet</Text>
            <Text style={styles.emptySub}>
              Save the meals you prescribe often — they become one-tap building blocks for diet plans.
            </Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={() => setEditing({})}>
              <Ionicons name="add" size={17} color={colors.primary} />
              <Text style={styles.emptyBtnText}>New Dish</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} activeOpacity={0.8} onPress={() => setEditing(item)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={[styles.macro, NUMS]}>
                {item.calories != null ? `${item.calories} cal` : '— cal'}
                {item.protein_g != null ? ` · ${Math.round(item.protein_g)}P` : ''}
                {item.carbs_g != null ? ` ${Math.round(item.carbs_g)}C` : ''}
                {item.fat_g != null ? ` ${Math.round(item.fat_g)}F` : ''}
              </Text>
              {(item.tags || []).length > 0 && (
                <View style={styles.tagRow}>
                  {item.tags.slice(0, 3).map((t) => (
                    <View key={t} style={styles.tag}>
                      <Text style={styles.tagText}>{t}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
          </TouchableOpacity>
        )}
      />

      <DishForm
        visible={!!editing}
        dish={editing || {}}
        onClose={() => setEditing(null)}
        onSave={save}
        onDelete={editing?.id ? confirmDelete : null}
      />
    </View>
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
