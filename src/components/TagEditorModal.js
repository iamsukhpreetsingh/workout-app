import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Modal,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import { fetchWorkoutTags, fetchRecipeTags, createTag, updateTag, deleteTag, checkTagInUse } from '../lib/tagsApi';

export default function TagEditorModal({ visible, type, onClose }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newTagName, setNewTagName] = useState('');
  const [isAdding, setIsAdding] = useState(false);
  const [editingTag, setEditingTag] = useState(null);
  const [editName, setEditName] = useState('');

  const loadTags = useCallback(async () => {
    setLoading(true);
    try {
      const data = type === 'workout' ? await fetchWorkoutTags() : await fetchRecipeTags();
      setTags(data || []);
    } catch (e) {
      Alert.alert('Error', 'Failed to load tags');
    } finally {
      setLoading(false);
    }
  }, [type]);

  useEffect(() => {
    if (visible) {
      loadTags();
      setNewTagName('');
      setEditingTag(null);
      setEditName('');
    }
  }, [visible, loadTags]);

  const handleAdd = async () => {
    if (!newTagName.trim()) return;
    setIsAdding(true);
    try {
      await createTag(newTagName.trim(), type);
      setNewTagName('');
      loadTags();
    } catch (e) {
      Alert.alert('Error', e.message || 'Failed to create tag');
    } finally {
      setIsAdding(false);
    }
  };

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

  return (
    <Modal visible={visible} animationType="slide" transparent presentationStyle="overFullScreen">
      <View style={styles.overlay}>
        <View style={styles.container}>
          <View style={styles.header}>
            <Text style={styles.title}>
              {type === 'workout' ? 'Workout' : 'Recipe'} Tags
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
              <Ionicons name="close" size={24} color={colors.text} />
            </TouchableOpacity>
          </View>

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

          {loading ? (
            <ActivityIndicator color={colors.primary} style={{ marginTop: 20 }} />
          ) : (
            <ScrollView style={styles.tagList}>
              {tags.map((tag) => (
                <View key={tag.id} style={styles.tagItem}>
                  <View style={[styles.tagBadge, tag.is_default && styles.tagDefault]}>
                    <Text style={styles.tagText}>{tag.name}</Text>
                    {tag.is_default && <Text style={styles.defaultLabel}>Default</Text>}
                  </View>
                  <View style={styles.tagActions}>
                    <TouchableOpacity
                      onPress={() => handleEdit(tag)}
                      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    >
                      <Ionicons name="pencil" size={14} color={colors.textDim} />
                    </TouchableOpacity>
                    {!tag.is_default && (
                      <TouchableOpacity
                        onPress={() => handleDelete(tag)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <Ionicons name="trash-outline" size={14} color={colors.red} />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              ))}
              {tags.length === 0 && (
                <Text style={styles.emptyText}>No tags yet</Text>
              )}
            </ScrollView>
          )}

          {editingTag && (
            <View style={styles.editModal}>
              <Text style={styles.editTitle}>Edit Tag</Text>
              <TextInput
                style={styles.editInput}
                value={editName}
                onChangeText={setEditName}
                placeholder="Tag name"
                placeholderTextColor={colors.textDim}
                autoFocus
              />
              <View style={styles.editActions}>
                <TouchableOpacity
                  style={styles.editCancel}
                  onPress={() => {
                    setEditingTag(null);
                    setEditName('');
                  }}
                >
                  <Text style={styles.editCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.editSave}
                  onPress={handleSaveEdit}
                >
                  <Text style={styles.editSaveText}>Save</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    overlay: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    container: {
      backgroundColor: colors.bg,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      maxHeight: '80%',
      paddingBottom: 40,
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      padding: 20,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
    },
    title: {
      color: colors.text,
      fontSize: 18,
      fontWeight: '700',
    },
    addRow: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 20,
      paddingTop: 16,
    },
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
    tagList: {
      paddingHorizontal: 20,
      paddingTop: 16,
    },
    tagItem: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 8,
    },
    tagBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.cardLight,
      borderRadius: 14,
      paddingHorizontal: 12,
      paddingVertical: 6,
      gap: 6,
    },
    tagDefault: {
      backgroundColor: colors.blue + '20',
    },
    tagText: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '500',
    },
    defaultLabel: {
      color: colors.blue,
      fontSize: 10,
      fontWeight: '600',
    },
    tagActions: {
      flexDirection: 'row',
      gap: 12,
    },
    emptyText: {
      color: colors.textDim,
      fontSize: 13,
      fontStyle: 'italic',
      textAlign: 'center',
      marginTop: 20,
    },
    editModal: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: colors.card,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 20,
      borderTopWidth: 1,
      borderTopColor: colors.border,
    },
    editTitle: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '700',
      marginBottom: 12,
    },
    editInput: {
      backgroundColor: colors.cardLight,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      color: colors.text,
      fontSize: 14,
      marginBottom: 12,
    },
    editActions: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: 12,
    },
    editCancel: {
      paddingVertical: 8,
      paddingHorizontal: 16,
    },
    editCancelText: {
      color: colors.textDim,
      fontSize: 14,
    },
    editSave: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingVertical: 8,
      paddingHorizontal: 16,
    },
    editSaveText: {
      color: '#fff',
      fontSize: 14,
      fontWeight: '600',
    },
  });