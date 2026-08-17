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
  Image,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../lib/api';
import { useColors } from '../theme';
import DishForm from '../components/DishForm';
import CatalogSearch from '../components/CatalogSearch';
import TagEditorModal from '../components/TagEditorModal';

const NUMS = { fontVariant: ['tabular-nums'] };

// Trainer-wide dish library. Deleting a dish never affects plans that
// already used it (plan items are snapshots) — only future selection.
export default function MealCatalogScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [items, setItems] = useState(null); // null = loading
  const [recipeTags, setRecipeTags] = useState([]);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState(null);
  const [favOnly, setFavOnly] = useState(false);
  const [editing, setEditing] = useState(null); // null | {} | item
  const [showTagEditor, setShowTagEditor] = useState(false);

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
      const [itemsData, tagsData] = await Promise.all([
        api('/trainer/meal-catalog'),
        api('/trainer/tags/recipe'),
      ]);
      setItems(itemsData);
      setRecipeTags(tagsData || []);
    } catch (e) {
      setItems([]);
    }
  }, []);

  const refreshTags = useCallback(async () => {
    try {
      const tagsData = await api('/trainer/tags/recipe');
      setRecipeTags(tagsData || []);
    } catch (e) {
      // silently fail on refresh
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
    const matchesFav = !favOnly || i.is_favorite;
    return matchesText && matchesTag && matchesFav;
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

  // quick favorite toggle straight from the list — no form round-trip
  const toggleFavorite = async (item) => {
    try {
      await api(`/trainer/meal-catalog/${item.id}`, {
        method: 'PATCH',
        body: { ...item, is_favorite: !item.is_favorite },
      });
      setItems((prev) => prev.map((d) => (d.id === item.id ? { ...d, is_favorite: !d.is_favorite } : d)));
    } catch (e) {
      Alert.alert('Could not update', e.message || 'Please try again.');
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
          tagsFromItems={items?.flatMap((i) => i.tags || []) || []}
          customTags={recipeTags.map(t => t.name)}
          favOnly={favOnly}
          onFavOnly={setFavOnly}
          placeholder="Search recipes…"
          onManageTags={() => setShowTagEditor(true)}
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
          <TouchableOpacity
            style={styles.card}
            activeOpacity={0.8}
            onPress={() => setEditing(item)}
            onLongPress={() =>
              // duplicate as starting point for variations of a base recipe
              setEditing({ ...item, id: undefined, name: `${item.name} (Copy)`, is_favorite: false })
            }
          >
            {item.photo_path ? (
              <Image source={{ uri: item.photo_path }} style={styles.thumb} />
            ) : (
              <View style={[styles.thumb, styles.thumbFallback]}>
                <Ionicons name="restaurant-outline" size={16} color={colors.textDim} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.is_favorite && <Ionicons name="star" size={12} color={colors.yellow} />}
              </View>
              <Text style={[styles.macro, NUMS]}>
                {item.calories != null ? `${item.calories} cal` : '— cal'}
                {item.protein_g != null ? ` · ${Math.round(item.protein_g)}P` : ''}
                {item.carbs_g != null ? ` ${Math.round(item.carbs_g)}C` : ''}
                {item.fat_g != null ? ` ${Math.round(item.fat_g)}F` : ''}
              </Text>
              {(item.allergens || []).length > 0 && (
                <View style={styles.allergenBadge}>
                  <Ionicons name="warning" size={10} color={colors.red} />
                  <Text style={styles.allergenText}>Contains: {item.allergens.join(', ')}</Text>
                </View>
              )}
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
            <TouchableOpacity onPress={() => toggleFavorite(item)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons
                name={item.is_favorite ? 'star' : 'star-outline'}
                size={18}
                color={item.is_favorite ? colors.yellow : colors.textDim}
              />
            </TouchableOpacity>
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

      <TagEditorModal
        visible={showTagEditor}
        type="recipe"
        onClose={() => {
          setShowTagEditor(false);
          refreshTags();
        }}
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
    thumb: {
      width: 46, height: 46, borderRadius: 10, backgroundColor: colors.cardLight,
    },
    thumbFallback: { alignItems: 'center', justifyContent: 'center' },
    allergenBadge: {
      flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5,
      alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.red,
      borderRadius: 7, paddingHorizontal: 6, paddingVertical: 2,
      backgroundColor: colors.card,
    },
    allergenText: { color: colors.red, fontSize: 10, fontWeight: '700' },

    emptyWrap: { alignItems: 'center', padding: 32 },
    emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '800', marginTop: 12 },
    emptySub: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 6, marginBottom: 18 },
    emptyBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12,
      paddingHorizontal: 18, paddingVertical: 11,
    },
    emptyBtnText: { color: colors.primary, fontWeight: '700' },

  });
