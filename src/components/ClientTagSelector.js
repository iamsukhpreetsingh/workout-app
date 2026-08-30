// import React, { useState, useEffect, useCallback } from 'react';
// import {
//   View,
//   Text,
//   ScrollView,
//   TouchableOpacity,
//   StyleSheet,
//   TextInput,
//   ActivityIndicator,
// } from 'react-native';
// import { Ionicons } from '@expo/vector-icons';
// import { useColors } from '../theme';
// import { api } from '../lib/api';

// const MAX_TAGS = 5;

// export default function ClientTagSelector({ value = [], onChange, type = 'workout', editable = true }) {
//   const colors = useColors();
//   const styles = makeStyles(colors);
//   const [presetTags, setPresetTags] = useState([]);
//   const [loading, setLoading] = useState(true);
//   const [customTag, setCustomTag] = useState('');

//   const loadTags = useCallback(async () => {
//     setLoading(true);
//     try {
//       const endpoint = type === 'workout' ? '/trainer/tags/workout' : '/trainer/tags/recipe';
//       const tags = await api(endpoint);
//       setPresetTags(tags?.map(t => t.name) || []);
//     } catch (e) {
//       setPresetTags([]);
//     } finally {
//       setLoading(false);
//     }
//   }, [type]);

//   useEffect(() => {
//     loadTags();
//   }, [loadTags]);

//   const selectedTags = Array.isArray(value) ? value : [];

//   const isSelected = (tag) => selectedTags.includes(tag);

//   const toggleTag = (tag) => {
//     if (!editable) return;
//     if (isSelected(tag)) {
//       onChange(selectedTags.filter(t => t !== tag));
//     } else {
//       if (selectedTags.length < MAX_TAGS) {
//         onChange([...selectedTags, tag]);
//       }
//     }
//   };

//   const addCustomTag = () => {
//     if (!customTag.trim() || !editable) return;
//     const tag = customTag.trim();
//     if (!selectedTags.includes(tag) && selectedTags.length < MAX_TAGS) {
//       onChange([...selectedTags, tag]);
//     }
//     setCustomTag('');
//   };

//   const removeTag = (tag) => {
//     if (!editable) return;
//     onChange(selectedTags.filter(t => t !== tag));
//   };

//   const canAddMore = selectedTags.length < MAX_TAGS;

//   if (loading) {
//     return (
//       <View style={styles.loadingWrap}>
//         <ActivityIndicator size="small" color={colors.primary} />
//       </View>
//     );
//   }

//   return (
//     <View style={styles.container}>
//       <View style={styles.header}>
//         <Text style={styles.label}>Tags</Text>
//         <Text style={[styles.counter, !canAddMore && styles.counterFull]}>
//           {selectedTags.length}/{MAX_TAGS}
//         </Text>
//       </View>

//       {selectedTags.length > 0 && (
//         <View style={styles.selectedRow}>
//           {selectedTags.map((tag) => (
//             <TouchableOpacity
//               key={tag}
//               style={[styles.selectedTag, !editable && styles.selectedTagReadOnly]}
//               onPress={() => editable && removeTag(tag)}
//               disabled={!editable}
//             >
//               <Text style={styles.selectedTagText}>{tag}</Text>
//               {editable && (
//                 <Ionicons name="close-circle" size={14} color={colors.primary} />
//               )}
//             </TouchableOpacity>
//           ))}
//         </View>
//       )}

//       {editable && (
//         <>
//           <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.presetScroll}>
//             <View style={styles.presetRow}>
//               {presetTags.map((tag) => (
//                 <TouchableOpacity
//                   key={tag}
//                   style={[styles.presetTag, isSelected(tag) && styles.presetTagOn]}
//                   onPress={() => toggleTag(tag)}
//                 >
//                   <Text style={[styles.presetTagText, isSelected(tag) && styles.presetTagTextOn]}>
//                     {tag}
//                   </Text>
//                 </TouchableOpacity>
//               ))}
//             </View>
//           </ScrollView>

//           {canAddMore && (
//             <View style={styles.customRow}>
//               <TextInput
//                 style={styles.customInput}
//                 placeholder="Custom tag..."
//                 placeholderTextColor={colors.textDim}
//                 value={customTag}
//                 onChangeText={setCustomTag}
//                 onSubmitEditing={addCustomTag}
//                 returnKeyType="done"
//               />
//               <TouchableOpacity
//                 style={[styles.addBtn, !customTag.trim() && styles.addBtnDisabled]}
//                 onPress={addCustomTag}
//                 disabled={!customTag.trim()}
//               >
//                 <Ionicons name="add" size={18} color="#fff" />
//               </TouchableOpacity>
//             </View>
//           )}
//         </>
//       )}

//       {!editable && selectedTags.length === 0 && (
//         <Text style={styles.noTags}>No tags</Text>
//       )}
//     </View>
//   );
// }

// const makeStyles = (colors) =>
//   StyleSheet.create({
//     container: {
//       marginVertical: 8,
//     },
//     loadingWrap: {
//       padding: 16,
//       alignItems: 'center',
//     },
//     header: {
//       flexDirection: 'row',
//       justifyContent: 'space-between',
//       alignItems: 'center',
//       marginBottom: 8,
//     },
//     label: {
//       color: colors.text,
//       fontSize: 14,
//       fontWeight: '600',
//     },
//     counter: {
//       color: colors.textDim,
//       fontSize: 12,
//     },
//     counterFull: {
//       color: colors.red,
//     },
//     selectedRow: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       gap: 6,
//       marginBottom: 10,
//     },
//     selectedTag: {
//       flexDirection: 'row',
//       alignItems: 'center',
//       gap: 4,
//       backgroundColor: colors.primary + '20',
//       borderRadius: 12,
//       paddingHorizontal: 10,
//       paddingVertical: 5,
//     },
//     selectedTagReadOnly: {
//       backgroundColor: colors.blue + '20',
//     },
//     selectedTagText: {
//       color: colors.primary,
//       fontSize: 12,
//       fontWeight: '600',
//     },
//     presetScroll: {
//       marginBottom: 8,
//     },
//     presetRow: {
//       flexDirection: 'row',
//       flexWrap: 'wrap',
//       gap: 6,
//     },
//     presetTag: {
//       backgroundColor: colors.cardLight,
//       borderRadius: 12,
//       paddingHorizontal: 12,
//       paddingVertical: 6,
//     },
//     presetTagOn: {
//       backgroundColor: colors.primary,
//     },
//     presetTagText: {
//       color: colors.textDim,
//       fontSize: 12,
//       fontWeight: '500',
//     },
//     presetTagTextOn: {
//       color: '#fff',
//     },
//     customRow: {
//       flexDirection: 'row',
//       gap: 8,
//     },
//     customInput: {
//       flex: 1,
//       backgroundColor: colors.cardLight,
//       borderRadius: 10,
//       paddingHorizontal: 12,
//       paddingVertical: 8,
//       color: colors.text,
//       fontSize: 14,
//     },
//     addBtn: {
//       backgroundColor: colors.primary,
//       borderRadius: 10,
//       width: 40,
//       alignItems: 'center',
//       justifyContent: 'center',
//     },
//     addBtnDisabled: {
//       backgroundColor: colors.textDim,
//       opacity: 0.5,
//     },
//     noTags: {
//       color: colors.textDim,
//       fontSize: 12,
//       fontStyle: 'italic',
//     },
//   });




import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import { api } from '../lib/api';
import { useAuth } from '../store/AuthContext';

const MAX_TAGS = 5;

// Tag picker for plan editors. Preset tag chips come from the TRAINER tag
// library (/trainer/tags/... — a trainer-only surface), so the preset fetch
// runs ONLY for trainer accounts. Normal users skip the API entirely (no
// 403 error spam) and get the free-text custom-tag input, which works
// fully offline. Selected tags ride along in the plan payload for both
// roles exactly as before.
export default function ClientTagSelector({ value = [], onChange, type = 'workout', editable = true }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { user } = useAuth();
  const isTrainer = user?.role === 'trainer';
  const [presetTags, setPresetTags] = useState([]);
  const [loading, setLoading] = useState(isTrainer); // only trainers fetch
  const [customTag, setCustomTag] = useState('');

  const loadTags = useCallback(async () => {
    if (!isTrainer) return; // trainer-only endpoint — never call as user
    setLoading(true);
    try {
      const endpoint = type === 'workout' ? '/trainer/tags/workout' : '/trainer/tags/recipe';
      const tags = await api(endpoint);
      setPresetTags(tags?.map(t => t.name) || []);
    } catch (e) {
      setPresetTags([]);
    } finally {
      setLoading(false);
    }
  }, [type, isTrainer]);

  useEffect(() => {
    loadTags();
  }, [loadTags]);

  const selectedTags = Array.isArray(value) ? value : [];

  const isSelected = (tag) => selectedTags.includes(tag);

  const toggleTag = (tag) => {
    if (!editable) return;
    if (isSelected(tag)) {
      onChange(selectedTags.filter(t => t !== tag));
    } else {
      if (selectedTags.length < MAX_TAGS) {
        onChange([...selectedTags, tag]);
      }
    }
  };

  const addCustomTag = () => {
    if (!customTag.trim() || !editable) return;
    const tag = customTag.trim();
    if (!selectedTags.includes(tag) && selectedTags.length < MAX_TAGS) {
      onChange([...selectedTags, tag]);
    }
    setCustomTag('');
  };

  const removeTag = (tag) => {
    if (!editable) return;
    onChange(selectedTags.filter(t => t !== tag));
  };

  const canAddMore = selectedTags.length < MAX_TAGS;

  if (loading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator size="small" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.label}>Tags</Text>
        <Text style={[styles.counter, !canAddMore && styles.counterFull]}>
          {selectedTags.length}/{MAX_TAGS}
        </Text>
      </View>

      {selectedTags.length > 0 && (
        <View style={styles.selectedRow}>
          {selectedTags.map((tag) => (
            <TouchableOpacity
              key={tag}
              style={[styles.selectedTag, !editable && styles.selectedTagReadOnly]}
              onPress={() => editable && removeTag(tag)}
              disabled={!editable}
            >
              <Text style={styles.selectedTagText}>{tag}</Text>
              {editable && (
                <Ionicons name="close-circle" size={14} color={colors.primary} />
              )}
            </TouchableOpacity>
          ))}
        </View>
      )}

      {editable && (
        <>
          {/* preset chips — trainer library, trainer accounts only */}
          {isTrainer && presetTags.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.presetScroll}>
              <View style={styles.presetRow}>
                {presetTags.map((tag) => (
                  <TouchableOpacity
                    key={tag}
                    style={[styles.presetTag, isSelected(tag) && styles.presetTagOn]}
                    onPress={() => toggleTag(tag)}
                  >
                    <Text style={[styles.presetTagText, isSelected(tag) && styles.presetTagTextOn]}>
                      {tag}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          )}

          {canAddMore && (
            <View style={styles.customRow}>
              <TextInput
                style={styles.customInput}
                placeholder="Custom tag..."
                placeholderTextColor={colors.textDim}
                value={customTag}
                onChangeText={setCustomTag}
                onSubmitEditing={addCustomTag}
                returnKeyType="done"
              />
              <TouchableOpacity
                style={[styles.addBtn, !customTag.trim() && styles.addBtnDisabled]}
                onPress={addCustomTag}
                disabled={!customTag.trim()}
              >
                <Ionicons name="add" size={18} color="#fff" />
              </TouchableOpacity>
            </View>
          )}
        </>
      )}

      {!editable && selectedTags.length === 0 && (
        <Text style={styles.noTags}>No tags</Text>
      )}
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: {
      marginVertical: 8,
    },
    loadingWrap: {
      padding: 16,
      alignItems: 'center',
    },
    header: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 8,
    },
    label: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '600',
    },
    counter: {
      color: colors.textDim,
      fontSize: 12,
    },
    counterFull: {
      color: colors.red,
    },
    selectedRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginBottom: 10,
    },
    selectedTag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: colors.primary + '20',
      borderRadius: 12,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    selectedTagReadOnly: {
      backgroundColor: colors.blue + '20',
    },
    selectedTagText: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: '600',
    },
    presetScroll: {
      marginBottom: 8,
    },
    presetRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    presetTag: {
      backgroundColor: colors.cardLight,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    presetTagOn: {
      backgroundColor: colors.primary,
    },
    presetTagText: {
      color: colors.textDim,
      fontSize: 12,
      fontWeight: '500',
    },
    presetTagTextOn: {
      color: '#fff',
    },
    customRow: {
      flexDirection: 'row',
      gap: 8,
    },
    customInput: {
      flex: 1,
      backgroundColor: colors.cardLight,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
      color: colors.text,
      fontSize: 14,
    },
    addBtn: {
      backgroundColor: colors.primary,
      borderRadius: 10,
      width: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    addBtnDisabled: {
      backgroundColor: colors.textDim,
      opacity: 0.5,
    },
    noTags: {
      color: colors.textDim,
      fontSize: 12,
      fontStyle: 'italic',
    },
  });