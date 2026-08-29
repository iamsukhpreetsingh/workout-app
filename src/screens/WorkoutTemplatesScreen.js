import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../lib/api';
import CatalogSearch from '../components/CatalogSearch';
import TagEditorModal from '../components/TagEditorModal';
import { useColors } from '../theme';
import { WORKOUT_TEMPLATE_EDITOR } from '../shared/constants/routes';

const NUMS = { fontVariant: ['tabular-nums'] };

// Trainer's reusable workout-template library (Workouts tab). Search and
// tag filtering now uses dynamic tags from API.
export default function WorkoutTemplatesScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [templates, setTemplates] = useState(null);
  const [workoutTags, setWorkoutTags] = useState([]);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState(null);
  const [showTagEditor, setShowTagEditor] = useState(false);

  useHeaderActions(navigation, [], (
    <TouchableOpacity
      onPress={() => navigation.navigate(WORKOUT_TEMPLATE_EDITOR, {})}
      style={{ padding: 8 }}
    >
      <Ionicons name="add" size={22} color={colors.primary} />
    </TouchableOpacity>
  ));

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      Promise.all([
        api('/trainer/workout-templates'),
        api('/trainer/tags/workout'),
      ])
        .then(([templatesData, tagsData]) => {
          if (mounted) {
            setTemplates(templatesData);
            setWorkoutTags(tagsData || []);
          }
        })
        .catch(() => { 
          if (mounted) setTemplates([]); 
        });
      return () => { mounted = false; };
    }, [])
  );

  const refreshTags = useCallback(async () => {
    try {
      const tagsData = await api('/trainer/tags/workout');
      setWorkoutTags(tagsData || []);
    } catch (e) {
      // silently fail on refresh
    }
  }, []);

  if (templates === null) {
    return (
      <View style={[styles.container, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const filtered = templates.filter((t) => {
    const q = query.trim().toLowerCase();
    const matchesText = !q || t.name.toLowerCase().includes(q) || (t.tags || []).some((x) => x.toLowerCase().includes(q));
    const matchesTag = !tagFilter || (t.tags || []).includes(tagFilter);
    return matchesText && matchesTag;
  });

  return (
    <View style={styles.container}>
      <View style={{ paddingHorizontal: 20 }}>
        <CatalogSearch
          query={query}
          onQuery={setQuery}
          tag={tagFilter}
          onTag={setTagFilter}
          tagsFromItems={templates?.flatMap((t) => t.tags || []) || []}
          customTags={workoutTags.map(t => t.name)}
          placeholder="Search workouts…"
          onManageTags={() => setShowTagEditor(true)}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(t) => String(t.id)}
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Ionicons name="barbell-outline" size={38} color={colors.textDim} />
            <Text style={styles.emptyTitle}>No templates yet</Text>
            <Text style={styles.emptySub}>
              Save a workout once — assign it to any client in one tap, any time.
            </Text>
            <TouchableOpacity
              style={styles.emptyBtn}
              onPress={() => navigation.navigate(WORKOUT_TEMPLATE_EDITOR, {})}
            >
              <Ionicons name="add" size={17} color={colors.primary} />
              <Text style={styles.emptyBtnText}>New Template</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.card}
            activeOpacity={0.8}
            onPress={() => navigation.navigate(WORKOUT_TEMPLATE_EDITOR, { templateId: item.id })}
          >
            <View style={styles.templateTag}>
              <Ionicons name="copy-outline" size={13} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={[styles.meta, NUMS]}>
                {item.exercise_count} exercises
                {(item.tags || []).length ? ` · ${item.tags.slice(0, 3).join(', ')}` : ''}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
          </TouchableOpacity>
        )}
      />

      <TagEditorModal
        visible={showTagEditor}
        type="workout"
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
    emptyWrap: { alignItems: 'center', padding: 32 },
    emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '800', marginTop: 12 },
    emptySub: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 6, marginBottom: 18 },
    emptyBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12,
      paddingHorizontal: 18, paddingVertical: 11,
    },
    emptyBtnText: { color: colors.primary, fontWeight: '700' },
    card: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.card, borderRadius: 14, padding: 14, marginBottom: 8,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    templateTag: {
      width: 38, height: 38, borderRadius: 12, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    name: { color: colors.text, fontSize: 15, fontWeight: '700' },
    meta: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  });
