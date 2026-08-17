import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useColors } from '../theme';
import { fetchTags, createTag, updateTag, deleteTag, checkTagInUse } from '../lib/tagsApi';

function TagSection({ title, tags, onEdit, onDelete, onAdd, loading }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [newTagName, setNewTagName] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  const handleAdd = async () => {
    if (!newTagName.trim()) return;
    setIsAdding(true);
    try {
      await createTag(newTagName.trim(), title === 'Workout Tags' ? 'workout' : 'recipe');
      setNewTagName('');
      onAdd();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to create tag');
    } finally {
      setIsAdding(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      
      <View style={styles.addRow}>
        <TextInput
          style={styles.addInput}
          placeholder="Add new tag..."
          placeholderTextColor={colors.textDim}
          value={newTagName}
          onChangeText={setNewTagName}
          onSubmitEditing={handleAdd}
        />
        <TouchableOpacity
          style={styles.addBtn}
          onPress={handleAdd}
          disabled={!newTagName.trim() || isAdding}
        >
          {isAdding ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons name="add" size={20} color="#fff" />
          )}
        </TouchableOpacity>
      </View>

      <View style={styles.tagGrid}>
        {tags.map((tag) => (
          <View key={tag.id} style={styles.tagItem}>
            <View style={[styles.tagBadge, tag.is_default && styles.tagDefault]}>
              <Text style={styles.tagText}>{tag.name}</Text>
            </View>
            {!tag.is_default && (
              <View style={styles.tagActions}>
                <TouchableOpacity
                  onPress={() => onEdit(tag)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="pencil" size={14} color={colors.textDim} />
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={() => onDelete(tag)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <Ionicons name="trash-outline" size={14} color={colors.red} />
                </TouchableOpacity>
              </View>
            )}
            {tag.is_default && (
              <Text style={styles.defaultLabel}>Default</Text>
            )}
          </View>
        ))}
        {tags.length === 0 && (
          <Text style={styles.emptyText}>No tags yet</Text>
        )}
      </View>
    </View>
  );
}

export default function TagManagerScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [workoutTags, setWorkoutTags] = useState([]);
  const [recipeTags, setRecipeTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingTag, setEditingTag] = useState(null);
  const [editName, setEditName] = useState('');

  const loadTags = useCallback(async () => {
    try {
      const data = await fetchTags();
      setWorkoutTags(data.workout || []);
      setRecipeTags(data.recipe || []);
    } catch (e) {
      Alert.alert('Error', 'Failed to load tags');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadTags();
    }, [loadTags])
  );

  const handleEdit = (tag) => {
    setEditingTag(tag);
    setEditName(tag.name);
  };

  const handleSaveEdit = async () => {
    if (!editName.trim() || !editingTag) return;
    try {
      await updateTag(editingTag.id, editName.trim());
      setEditingTag(null);
      setEditName('');
      loadTags();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to update tag');
    }
  };

  const handleDelete = async (tag) => {
    try {
      const inUse = await checkTagInUse(tag.id);
      if (inUse) {
        Alert.alert(
          'Cannot Delete',
          'This tag is currently in use by some items. Please remove it from all items first before deleting.',
          [{ text: 'OK' }]
        );
        return;
      }

      Alert.alert(
        'Delete Tag',
        `Are you sure you want to delete "${tag.name}"?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: async () => {
              try {
                await deleteTag(tag.id);
                loadTags();
              } catch (e) {
                Alert.alert('Error', e.message || 'Failed to delete tag');
              }
            },
          },
        ]
      );
    } catch (e) {
      Alert.alert('Error', 'Failed to check tag usage');
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, styles.centered]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.description}>
        Manage your custom tags for workouts and recipes. Default tags can be renamed but not deleted.
      </Text>

      <TagSection
        title="Workout Tags"
        tags={workoutTags}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onAdd={loadTags}
        loading={loading}
      />

      <TagSection
        title="Recipe Tags"
        tags={recipeTags}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onAdd={loadTags}
        loading={loading}
      />

      {/* Edit Modal */}
      {editingTag && (
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Edit Tag</Text>
            <TextInput
              style={styles.modalInput}
              value={editName}
              onChangeText={setEditName}
              placeholder="Tag name"
              placeholderTextColor={colors.textDim}
              autoFocus
            />
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={styles.modalCancel}
                onPress={() => {
                  setEditingTag(null);
                  setEditName('');
                }}
              >
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.modalSave}
                onPress={handleSaveEdit}
              >
                <Text style={styles.modalSaveText}>Save</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centered: { justifyContent: 'center', alignItems: 'center' },
    content: { padding: 20 },
    description: { color: colors.textDim, fontSize: 13, marginBottom: 20, lineHeight: 18 },
    section: { marginBottom: 24 },
    sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '700', marginBottom: 12 },
    addRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
    addInput: {
      flex: 1,
      backgroundColor: colors.cardLight,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: colors.text,
      fontSize: 14,
    },
    addBtn: {
      backgroundColor: colors.primary,
      borderRadius: 10,
      width: 44,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tagGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    tagItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    tagBadge: {
      backgroundColor: colors.cardLight,
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    tagDefault: { backgroundColor: colors.blue + '20' },
    tagText: { color: colors.text, fontSize: 13, fontWeight: '500' },
    tagActions: { flexDirection: 'row', gap: 8 },
    defaultLabel: { color: colors.blue, fontSize: 10, fontWeight: '600' },
    emptyText: { color: colors.textDim, fontSize: 13, fontStyle: 'italic' },
    modalOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    modalContent: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 20,
      width: '80%',
    },
    modalTitle: { color: colors.text, fontSize: 18, fontWeight: '700', marginBottom: 16 },
    modalInput: {
      backgroundColor: colors.cardLight,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: colors.text,
      fontSize: 14,
      marginBottom: 16,
    },
    modalActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 12 },
    modalCancel: { paddingVertical: 8, paddingHorizontal: 16 },
    modalCancelText: { color: colors.textDim, fontSize: 14 },
    modalSave: { backgroundColor: colors.primary, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 16 },
    modalSaveText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  });