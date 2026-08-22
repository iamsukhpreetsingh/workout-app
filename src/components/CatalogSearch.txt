import React from 'react';
import { View, TextInput, ScrollView, TouchableOpacity, StyleSheet, Text } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';

const DEFAULT_RECIPE_TAGS = ['Vegetarian', 'Vegan', 'Non-Veg', 'High-Protein', 'Low-Carb', 'Dairy-Free', 'Gluten-Free'];
const DEFAULT_WORKOUT_TAGS = ['Push', 'Pull', 'Legs', 'Full Body', 'Upper Body', 'Lower Body', 'Cardio', 'Strength', 'Beginner', 'Hypertrophy', 'Conditioning'];

// Shared catalog search: text query + single-select tag filter chips.
// Used by the Recipes tab, Workouts tab, and diet builder's Add-Item picker.
// Accepts optional customTags prop to use instead of default tags.
// Accepts optional onManageTags prop to show pencil icon for managing tags.
export default function CatalogSearch({ 
  query, 
  onQuery, 
  tag, 
  onTag, 
  tagsFromItems = [], 
  placeholder = 'Search…', 
  favOnly = false, 
  onFavOnly,
  customTags = null,
  onManageTags,
}) {
  const colors = useColors();
  const styles = makeStyles(colors);
  
  // Use custom tags if provided, otherwise use default tags based on placeholder
  let presetTags = customTags;
  if (!presetTags) {
    // Auto-detect category based on placeholder text
    const lowerPlaceholder = placeholder.toLowerCase();
    if (lowerPlaceholder.includes('workout') || lowerPlaceholder.includes('exercise')) {
      presetTags = DEFAULT_WORKOUT_TAGS;
    } else {
      presetTags = DEFAULT_RECIPE_TAGS;
    }
  }
  
  // Combine preset tags with tags from items, remove duplicates
  const allTags = [...new Set([...presetTags, ...tagsFromItems])];

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
      <View style={styles.chipsRow}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, paddingBottom: 2 }}>
          <TouchableOpacity
            style={[styles.chip, !tag && styles.chipOn]}
            onPress={() => onTag(null)}
          >
            <Text style={[styles.chipText, !tag && { color: '#fff' }]}>All</Text>
          </TouchableOpacity>
          {onFavOnly && (
            <TouchableOpacity
              style={[styles.chip, favOnly && styles.chipFavOn]}
              onPress={() => onFavOnly(!favOnly)}
            >
              <Ionicons name="star" size={11} color={favOnly ? '#fff' : colors.yellow} />
              <Text style={[styles.chipText, favOnly && { color: '#fff' }]}>Favorites</Text>
            </TouchableOpacity>
          )}
          {allTags.map((t) => (
            <TouchableOpacity
              key={t}
              style={[styles.chip, tag === t && styles.chipOn]}
              onPress={() => onTag(tag === t ? null : t)}
            >
              <Text style={[styles.chipText, tag === t && { color: '#fff' }]}>{t}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
        {onManageTags && (
          <TouchableOpacity
            onPress={onManageTags}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={styles.manageIcon}
          >
            <Ionicons name="pencil" size={14} color={colors.textDim} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    searchWrap: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.cardLight, borderRadius: 10,
      paddingHorizontal: 12, paddingVertical: 9, marginBottom: 8,
    },
    search: { flex: 1, color: colors.text, fontSize: 14, padding: 0 },
    chipsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    manageIcon: {
      padding: 4,
    },
    chip: {
      backgroundColor: colors.cardLight, borderRadius: 14,
      paddingHorizontal: 11, paddingVertical: 5,
      flexDirection: 'row', alignItems: 'center', gap: 4,
    },
    chipOn: { backgroundColor: colors.primary },
    chipFavOn: { backgroundColor: colors.yellow },
    chipText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
  });