import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../lib/api';
import CatalogSearch from '../components/CatalogSearch';
import { useColors } from '../theme';
import { ASSIGN_WORKOUT } from '../shared/constants/routes';

const NUMS = { fontVariant: ['tabular-nums'] };

// Two-tab Assign Workout entry: From Saved (template library — one-tap
// assign as-is, or edit a client-side copy) and Build New (from scratch).
export default function AssignWorkoutPickerScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { clientId, clientName } = route.params || {};
  const [tab, setTab] = useState('saved'); // saved | new
  const [templates, setTemplates] = useState(null);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState(null);
  const [toast, setToast] = useState(null);
  const toastOpacity = React.useRef(new Animated.Value(0)).current;

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: `Assign Workout → ${clientName || 'Client'}` });
  }, [navigation, clientName]);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      api('/trainer/workout-templates')
        .then((rows) => { if (mounted) setTemplates(rows); })
        .catch(() => { if (mounted) setTemplates([]); });
      return () => { mounted = false; };
    }, [])
  );

  const showToast = (msg) => {
    setToast(msg);
    Animated.timing(toastOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    setTimeout(() => {
      Animated.timing(toastOpacity, { toValue: 0, duration: 300, useNativeDriver: true }).start(
        () => setToast(null)
      );
    }, 2200);
  };

  const assignAsIs = async (tpl) => {
    try {
      await api(`/trainer/clients/${clientId}/assigned-plans/from-template/${tpl.id}`, {
        method: 'POST',
      });
      showToast(`"${tpl.name}" assigned to ${clientName || 'client'}`);
      setTimeout(() => navigation.goBack(), 1200); // list refreshes on focus
    } catch (e) {
      showToast(e.message || 'Could not assign');
    }
  };

  // Edit: fetch the full template, prefill the from-scratch builder with a
  // client-side copy — the saved template is never touched.
  const editCopy = async (tpl) => {
    try {
      const full = await api(`/trainer/workout-templates/${tpl.id}`);
      navigation.navigate(ASSIGN_WORKOUT, {
        clientId,
        clientName,
        prefill: {
          name: full.name,
          notes: full.notes || '',
          exercises: (full.exercises || []).map((ex) => ({
            name: ex.exercise_name,
            targetSets: ex.target_sets,
            restSeconds: ex.rest_seconds || 90,
            groupId: ex.group_id || null,
          })),
        },
      });
    } catch (e) {
      showToast(e.message || 'Could not load template');
    }
  };

  if (tab === 'new') {
    // Build New delegates immediately to the existing builder
    return (
      <View style={styles.container}>
        <View style={styles.segRow}>
          {[
            { key: 'saved', label: 'From Saved' },
            { key: 'new', label: 'Build New' },
          ].map((t) => (
            <TouchableOpacity
              key={t.key}
              style={[styles.segBtn, tab === t.key && styles.segBtnOn]}
              onPress={() => setTab(t.key)}
            >
              <Text style={[styles.segText, tab === t.key && { color: '#fff' }]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          style={styles.buildCard}
          activeOpacity={0.85}
          onPress={() => navigation.replace(ASSIGN_WORKOUT, { clientId, clientName })}
        >
          <Ionicons name="barbell-outline" size={22} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.buildTitle}>Build from scratch</Text>
            <Text style={styles.buildSub}>Pick exercises, sets, rest and supersets</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
        </TouchableOpacity>
      </View>
    );
  }

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
      <View style={styles.segRow}>
        {[
          { key: 'saved', label: 'From Saved' },
          { key: 'new', label: 'Build New' },
        ].map((t) => (
          <TouchableOpacity
            key={t.key}
            style={[styles.segBtn, tab === t.key && styles.segBtnOn]}
            onPress={() => setTab(t.key)}
          >
            <Text style={[styles.segText, tab === t.key && { color: '#fff' }]}>{t.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={{ paddingHorizontal: 20 }}>
        <CatalogSearch
          query={query}
          onQuery={setQuery}
          tag={tagFilter}
          onTag={setTagFilter}
          tagsFromItems={templates.flatMap((t) => t.tags || [])}
          placeholder="Search your workouts…"
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(t) => String(t.id)}
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Ionicons name="copy-outline" size={36} color={colors.textDim} />
            <Text style={styles.emptyTitle}>
              {templates.length === 0 ? 'No saved templates yet' : 'No templates match'}
            </Text>
            <Text style={styles.emptySub}>
              {templates.length === 0
                ? 'Build one now — you can save it as a reusable template while assigning.'
                : 'Try a different search or tag.'}
            </Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={() => setTab('new')}>
              <Ionicons name="add" size={16} color={colors.primary} />
              <Text style={styles.emptyBtnText}>Build New</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name} numberOfLines={1}>
                {item.name}
              </Text>
              <Text style={[styles.meta, NUMS]}>
                {item.exercise_count} exercises
                {(item.tags || []).length ? ` · ${item.tags.slice(0, 3).join(', ')}` : ''}
              </Text>
            </View>
            <TouchableOpacity style={styles.editBtn} onPress={() => editCopy(item)}>
              <Ionicons name="create-outline" size={14} color={colors.primary} />
              <Text style={styles.editText}>Edit</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.assignBtn} onPress={() => assignAsIs(item)}>
              <Ionicons name="checkmark" size={14} color="#fff" />
              <Text style={styles.assignText}>Assign As-Is</Text>
            </TouchableOpacity>
          </View>
        )}
      />

      {toast && (
        <Animated.View style={[styles.toast, { opacity: toastOpacity }]} pointerEvents="none">
          <Ionicons name="checkmark-circle" size={15} color={colors.green} />
          <Text style={styles.toastText}>{toast}</Text>
        </Animated.View>
      )}
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    segRow: {
      flexDirection: 'row', backgroundColor: colors.cardLight,
      borderRadius: 12, padding: 3, margin: 20, marginBottom: 10,
    },
    segBtn: { flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 8 },
    segBtnOn: { backgroundColor: colors.primary },
    segText: { color: colors.textDim, fontWeight: '700', fontSize: 13 },

    buildCard: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.card, borderRadius: 14, padding: 16, marginHorizontal: 20,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    buildTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
    buildSub: { color: colors.textDim, fontSize: 12, marginTop: 2 },

    card: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.card, borderRadius: 14, padding: 12, marginBottom: 8,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    name: { color: colors.text, fontSize: 14, fontWeight: '700' },
    meta: { color: colors.textDim, fontSize: 11, marginTop: 2 },
    editBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 9,
      paddingHorizontal: 9, paddingVertical: 6,
    },
    editText: { color: colors.primary, fontWeight: '700', fontSize: 11 },
    assignBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      backgroundColor: colors.primary, borderRadius: 9,
      paddingHorizontal: 9, paddingVertical: 7,
    },
    assignText: { color: '#fff', fontWeight: '700', fontSize: 11 },

    emptyWrap: { alignItems: 'center', padding: 28 },
    emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '800', marginTop: 10 },
    emptySub: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 6, marginBottom: 16 },
    emptyBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 7,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12,
      paddingHorizontal: 18, paddingVertical: 11,
    },
    emptyBtnText: { color: colors.primary, fontWeight: '700' },

    toast: {
      position: 'absolute', bottom: 24, left: 20, right: 20,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      backgroundColor: colors.card, borderRadius: 12, padding: 12,
      shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.25, shadowRadius: 8, elevation: 6,
    },
    toastText: { color: colors.text, fontWeight: '700', fontSize: 13 },
  });
