// import React, { useCallback, useState } from 'react';
// import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
// import { Ionicons } from '@expo/vector-icons';
// import { useFocusEffect } from '@react-navigation/native';
// import { api } from '../lib/api';
// import CatalogSearch from '../components/CatalogSearch';
// import DishForm from '../components/DishForm';
// import { useColors } from '../theme';

// const NUMS = { fontVariant: ['tabular-nums'] };

// // "My Dishes" — the user's personal dish catalog. Distinguished from the
// // trainer/system catalog: separate screen, separate ownership, and the
// // dishes only ever belong to this user.
// export default function MyDishesScreen({ navigation }) {
//   const colors = useColors();
//   const styles = makeStyles(colors);
//   const [dishes, setDishes] = useState(null);
//   const [query, setQuery] = useState('');
//   const [tagFilter, setTagFilter] = useState(null);
//   const [editing, setEditing] = useState(null);

//   React.useLayoutEffect(() => {
//     navigation.setOptions({
//       headerRight: () => (
//         <TouchableOpacity onPress={() => setEditing({})} style={{ padding: 8 }}>
//           <Ionicons name="add" size={22} color={colors.primary} />
//         </TouchableOpacity>
//       ),
//     });
//   }, [navigation, colors]);

//   const load = useCallback(async () => {
//     try {
//       setDishes(await api('/client/my-dishes'));
//     } catch {
//       setDishes([]);
//     }
//   }, []);

//   useFocusEffect(useCallback(() => { load(); }, [load]));

//   const save = async (item) => {
//     try {
//       if (item.id) {
//         await api(`/client/my-dishes/${item.id}`, { method: 'PATCH', body: item });
//       } else {
//         await api('/client/my-dishes', { method: 'POST', body: item });
//       }
//       setEditing(null);
//       load();
//     } catch (e) {
//       Alert.alert('Could not save dish', e.message || 'Please try again.');
//     }
//   };

//   const confirmDelete = (item) =>
//     Alert.alert(
//       'Delete dish',
//       `"${item.name}" will be removed from My Dishes. Meal plans already using it keep their copied data.`,
//       [
//         { text: 'Cancel', style: 'cancel' },
//         {
//           text: 'Delete',
//           style: 'destructive',
//           onPress: async () => {
//             try {
//               await api(`/client/my-dishes/${item.id}`, { method: 'DELETE' });
//               setEditing(null);
//               load();
//             } catch (e) {
//               Alert.alert('Could not delete', e.message || 'Please try again.');
//             }
//           },
//         },
//       ]
//     );

//   if (dishes === null) {
//     return (
//       <View style={[styles.container, { justifyContent: 'center' }]}>
//         <ActivityIndicator color={colors.primary} />
//       </View>
//     );
//   }

//   const filtered = dishes.filter((d) => {
//     const q = query.trim().toLowerCase();
//     const matchesText = !q || d.name.toLowerCase().includes(q) || (d.tags || []).some((t) => t.toLowerCase().includes(q));
//     const matchesTag = !tagFilter || (d.tags || []).includes(tagFilter);
//     return matchesText && matchesTag;
//   });

//   return (
//     <View style={styles.container}>
//       <View style={{ paddingHorizontal: 20 }}>
//         <CatalogSearch
//           query={query}
//           onQuery={setQuery}
//           tag={tagFilter}
//           onTag={setTagFilter}
//           tagsFromItems={dishes.flatMap((d) => d.tags || [])}
//         />
//       </View>

//       <FlatList
//         data={filtered}
//         keyExtractor={(d) => String(d.id)}
//         contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
//         ListEmptyComponent={
//           <View style={styles.emptyWrap}>
//             <Ionicons name="restaurant-outline" size={36} color={colors.textDim} />
//             <Text style={styles.emptyTitle}>No dishes yet</Text>
//             <Text style={styles.emptySub}>
//               Save the meals you eat often — they become one-tap building blocks for your own diet plans.
//             </Text>
//             <TouchableOpacity style={styles.emptyBtn} onPress={() => setEditing({})}>
//               <Ionicons name="add" size={17} color={colors.primary} />
//               <Text style={styles.emptyBtnText}>New Dish</Text>
//             </TouchableOpacity>
//           </View>
//         }
//         renderItem={({ item }) => (
//           <TouchableOpacity style={styles.card} activeOpacity={0.8} onPress={() => setEditing(item)}>
//             <View style={styles.dishTag}>
//               <Ionicons name="person-outline" size={13} color={colors.primary} />
//             </View>
//             <View style={{ flex: 1 }}>
//               <Text style={styles.name} numberOfLines={1}>
//                 {item.name}
//               </Text>
//               <Text style={[styles.macro, NUMS]}>
//                 {item.calories != null ? `${item.calories} cal` : '— cal'}
//                 {item.protein_g != null ? ` · ${Math.round(item.protein_g)}P` : ''}
//                 {item.carbs_g != null ? ` ${Math.round(item.carbs_g)}C` : ''}
//                 {item.fat_g != null ? ` ${Math.round(item.fat_g)}F` : ''}
//               </Text>
//               {(item.tags || []).length > 0 && (
//                 <View style={styles.tagRow}>
//                   {item.tags.slice(0, 3).map((t) => (
//                     <View key={t} style={styles.tag}>
//                       <Text style={styles.tagText}>{t}</Text>
//                     </View>
//                   ))}
//                 </View>
//               )}
//             </View>
//             <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
//           </TouchableOpacity>
//         )}
//       />

//       <DishForm
//         visible={!!editing}
//         dish={editing || {}}
//         onClose={() => setEditing(null)}
//         onSave={save}
//         onDelete={editing?.id ? confirmDelete : null}
//       />
//     </View>
//   );
// }


// const makeStyles = (colors) =>
//   StyleSheet.create({
//     container: { flex: 1, backgroundColor: colors.bg },
//     emptyWrap: { alignItems: 'center', padding: 32 },
//     emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '800', marginTop: 12 },
//     emptySub: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 6, marginBottom: 18 },
//     emptyBtn: {
//       flexDirection: 'row', alignItems: 'center', gap: 8,
//       borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12,
//       paddingHorizontal: 18, paddingVertical: 11,
//     },
//     emptyBtnText: { color: colors.primary, fontWeight: '700' },
//     card: {
//       flexDirection: 'row', alignItems: 'center', gap: 12,
//       backgroundColor: colors.card, borderRadius: 14, padding: 14, marginBottom: 8,
//       shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
//       shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
//     },
//     dishTag: {
//       width: 38, height: 38, borderRadius: 12, backgroundColor: colors.cardLight,
//       alignItems: 'center', justifyContent: 'center',
//     },
//     name: { color: colors.text, fontSize: 15, fontWeight: '700' },
//     macro: { color: colors.textDim, fontSize: 12, marginTop: 2 },
//     tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
//     tag: { backgroundColor: colors.cardLight, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
//     tagText: { color: colors.textDim, fontSize: 10, fontWeight: '600' },
//   });



import React, { useCallback, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { listRecipes, createRecipe, updateRecipe, deleteRecipe } from '../db/recipes';
import CatalogSearch from '../components/CatalogSearch';
import DishForm from '../components/DishForm';
import { useColors } from '../theme';

const NUMS = { fontVariant: ['tabular-nums'] };

// "My Dishes" — the user's personal dish catalog, now LOCAL-FIRST: reads
// and writes go to local SQLite (works fully offline), and the sync engine
// backs every change up to /user/backup/recipes. The old server-first
// /client/my-dishes calls are gone.
export default function MyDishesScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [dishes, setDishes] = useState(null);
  const [query, setQuery] = useState('');
  const [tagFilter, setTagFilter] = useState(null);
  const [editing, setEditing] = useState(null);

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
      setDishes(await listRecipes());
    } catch {
      setDishes([]);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const save = async (item) => {
    try {
      const localId = item.local_id || item.id; // id is an alias of local_id
      if (localId) {
        await updateRecipe(String(localId), item);
      } else {
        await createRecipe(item);
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
      `"${item.name}" will be removed from My Dishes. Meal plans already using it keep their copied data.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteRecipe(String(item.local_id || item.id));
              setEditing(null);
              load();
            } catch (e) {
              Alert.alert('Could not delete', e.message || 'Please try again.');
            }
          },
        },
      ]
    );

  if (dishes === null) {
    return (
      <View style={[styles.container, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const filtered = dishes.filter((d) => {
    const q = query.trim().toLowerCase();
    const matchesText = !q || d.name.toLowerCase().includes(q) || (d.tags || []).some((t) => t.toLowerCase().includes(q));
    const matchesTag = !tagFilter || (d.tags || []).includes(tagFilter);
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
          tagsFromItems={dishes.flatMap((d) => d.tags || [])}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(d) => String(d.local_id || d.id)}
        contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <Ionicons name="restaurant-outline" size={36} color={colors.textDim} />
            <Text style={styles.emptyTitle}>No dishes yet</Text>
            <Text style={styles.emptySub}>
              Save the meals you eat often — they become one-tap building blocks for your own diet plans.
            </Text>
            <TouchableOpacity style={styles.emptyBtn} onPress={() => setEditing({})}>
              <Ionicons name="add" size={17} color={colors.primary} />
              <Text style={styles.emptyBtnText}>New Dish</Text>
            </TouchableOpacity>
          </View>
        }
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.card} activeOpacity={0.8} onPress={() => setEditing(item)}>
            <View style={styles.dishTag}>
              <Ionicons name="person-outline" size={13} color={colors.primary} />
            </View>
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
        onDelete={editing?.local_id ? confirmDelete : null}
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
    dishTag: {
      width: 38, height: 38, borderRadius: 12, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    name: { color: colors.text, fontSize: 15, fontWeight: '700' },
    macro: { color: colors.textDim, fontSize: 12, marginTop: 2 },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 },
    tag: { backgroundColor: colors.cardLight, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
    tagText: { color: colors.textDim, fontSize: 10, fontWeight: '600' },
  });