import React from 'react';
import { View, TextInput, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';

const PRESET_TAGS = ['vegetarian', 'vegan', 'non-veg', 'high-protein', 'low-carb', 'dairy-free', 'gluten-free'];

// Shared catalog search: text query + single-select tag filter chips.
// Used by the Recipes tab and the diet builder's Add-Item picker — one
// implementation, not two.
export default function CatalogSearch({ query, onQuery, tag, onTag, tagsFromItems = [], placeholder = 'Search dishes…' }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const tags = [...new Set([...PRESET_TAGS, ...tagsFromItems])];

  return (
    <View>
      <View style={styles.searchWrap}>
        <Ionicons name="search-outline" size={15} color={colors.textDim} />
        <TextInput
          style={styles.search}
          placeholder={placeholder}
          placeholderTextColor={colors.textDim}
          value={query}
          onChangeText={onQuery}
        />
        {query !== '' && (
          <TouchableOpacity onPress={() => onQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Ionicons name="close-circle" size={15} color={colors.textDim} />
          </TouchableOpacity>
        )}
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingBottom: 2 }}>
        <TouchableOpacity
          style={[styles.chip, !tag && styles.chipOn]}
          onPress={() => onTag(null)}
        >
          <Text style={[styles.chipText, !tag && { color: '#fff' }]}>All</Text>
        </TouchableOpacity>
        {tags.map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.chip, tag === t && styles.chipOn]}
            onPress={() => onTag(tag === t ? null : t)}
          >
            <Text style={[styles.chipText, tag === t && { color: '#fff' }]}>{t}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

import { Text } from 'react-native';

const makeStyles = (colors) =>
  StyleSheet.create({
    searchWrap: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.cardLight, borderRadius: 10,
      paddingHorizontal: 12, paddingVertical: 9, marginBottom: 8,
    },
    search: { flex: 1, color: colors.text, fontSize: 14, padding: 0 },
    chip: {
      backgroundColor: colors.cardLight, borderRadius: 14,
      paddingHorizontal: 11, paddingVertical: 5,
    },
    chipOn: { backgroundColor: colors.primary },
    chipText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
  });
