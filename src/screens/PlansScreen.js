import React, { useCallback, useState, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { listPlans } from '../db/queries';
import { getPinnedSet, togglePin } from '../db/pins';
import { useAuth } from '../store/AuthContext';
import { api } from '../lib/api';
import { listLocalDietPlans } from '../db/dietPlans';
import { listLocalSupplementPlans } from '../db/supplementPlans';
import { fetchAndCacheTrainerContent } from '../lib/trainerCache';
import { useColors } from '../theme';
import { useHeaderActions } from '../components/HeaderActions';

const NUMS = { fontVariant: ['tabular-nums'] };

export default function PlansScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [plans, setPlans] = useState([]);
  const [assigned, setAssigned] = useState([]);
  const [tab, setTab] = useState('mine'); // 'mine' | 'trainer'
  const [pinned, setPinned] = useState(new Set());
  const [subTab, setSubTab] = useState('workouts'); // workouts | diet | supplements
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const { user } = useAuth();
  const isClient = user?.role === 'user' || user?.role === 'trainer';

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      listPlans().then((p) => { if (mounted) setPlans(p); });
      getPinnedSet().then((set) => { if (mounted) setPinned(set); });
      return () => { mounted = false; };
    }, [])
  );

  const onTogglePin = async (sourceType, refId) => {
    try {
      await togglePin(sourceType, refId);
      setPinned(await getPinnedSet());
    } catch (e) {
      if (e.capHit) {
        Alert.alert('Pins full', e.message);
      }
    }
  };

  useFocusEffect(
    useCallback(() => {
      if (!isClient) {
        setAssigned([]);
        return;
      }
      let mounted = true;
      api('/client/assigned-plans')
        .then((rows) => { if (mounted) setAssigned(rows); })
        .catch(() => { if (mounted) setAssigned([]); });
      return () => { mounted = false; };
    }, [isClient])
  );

  // Shared settings + profile icons replace the header "+ New" — routine
  // creation now lives inside the My Routines tab only (nothing is created
  // from the From Trainer tab, whose content is trainer-shared).
  useHeaderActions(navigation);

  const showTrainerTab = isClient && tab === 'trainer';
  const isSearching = searchQuery.trim().length > 0;

  useEffect(() => {
    if (!isSearching) {
      setSearchResults(null);
      return;
    }
    const timer = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const q = searchQuery.toLowerCase();
        const allResults = [];
        const localPlans = await listPlans();
        localPlans.forEach((p) => {
          if (p.name.toLowerCase().includes(q) || (p.tags || []).some(t => t.toLowerCase().includes(q))) {
            allResults.push({ type: 'workout', source: 'My Workout', ...p, displayName: p.name, displayTags: p.tags || [] });
          }
        });
        // if (isClient) {
        //   const [dietPlans, suppPlans, trainerWorkouts] = await Promise.all([
        //     api('/client/diet-plans').catch(() => []),
        //     api('/client/supplement-plans').catch(() => []),
        //     api('/client/assigned-plans').catch(() => []),
        //   ]);
        //   dietPlans.forEach((p) => {
        //     const tags = p.display_tags || p.tags || [];
        //     if (p.name.toLowerCase().includes(q) || tags.some(t => t.toLowerCase().includes(q))) {
        //       allResults.push({ type: 'diet', source: p.created_by === 'client' ? 'My Diet' : 'From Trainer · Diet', ...p, displayName: p.name, displayTags: tags });
        //     }
        //   });
        //   suppPlans.forEach((p) => {
        //     const tags = p.tags || [];
        //     if (p.name.toLowerCase().includes(q) || tags.some(t => t.toLowerCase().includes(q))) {
        //       allResults.push({ type: 'supplement', source: p.created_by === 'client' ? 'My Supplement' : 'From Trainer · Supplement', ...p, displayName: p.name, displayTags: tags });
        //     }
        //   });
        //   trainerWorkouts.forEach((p) => {
        //     const tags = p.tags || [];
        //     if (p.name.toLowerCase().includes(q) || tags.some(t => t.toLowerCase().includes(q))) {
        //       allResults.push({ type: 'workout', source: 'From Trainer · Workout', ...p, displayName: p.name, displayTags: tags });
        //     }
        //   });
        // }


                if (isClient) {
          // self-authored diet/supplement plans come from LOCAL tables;
          // trainer-assigned content stays server-fetched
          const [localDiet, localSupp, remoteDiet, remoteSupp, trainerWorkouts] = await Promise.all([
            listLocalDietPlans().catch(() => []),
            listLocalSupplementPlans().catch(() => []),
            api('/client/diet-plans').catch(() => []),
            api('/client/supplement-plans').catch(() => []),
            api('/client/assigned-plans').catch(() => []),
          ]);
          localDiet.forEach((p) => {
            if (p.name.toLowerCase().includes(q) || (p.tags || []).some((t) => t.toLowerCase().includes(q))) {
              allResults.push({ type: 'diet', source: 'My Diet', ...p, displayName: p.name, displayTags: p.tags || [] });
            }
          });
          remoteDiet.filter((p) => p.created_by === 'trainer').forEach((p) => {
            const tags = p.display_tags || p.tags || [];
            if (p.name.toLowerCase().includes(q) || tags.some((t) => t.toLowerCase().includes(q))) {
              allResults.push({ type: 'diet', source: 'From Trainer · Diet', ...p, displayName: p.name, displayTags: tags });
            }
          });
          localSupp.forEach((p) => {
            if (p.name.toLowerCase().includes(q) || (p.tags || []).some((t) => t.toLowerCase().includes(q))) {
              allResults.push({ type: 'supplement', source: 'My Supplement', ...p, displayName: p.name, displayTags: p.tags || [] });
            }
          });
          remoteSupp.filter((p) => p.created_by === 'trainer').forEach((p) => {
            const tags = p.tags || [];
            if (p.name.toLowerCase().includes(q) || tags.some((t) => t.toLowerCase().includes(q))) {
              allResults.push({ type: 'supplement', source: 'From Trainer · Supplement', ...p, displayName: p.name, displayTags: tags });
            }
          });
          trainerWorkouts.forEach((p) => {
            const tags = p.tags || [];
            if (p.name.toLowerCase().includes(q) || tags.some((t) => t.toLowerCase().includes(q))) {
              allResults.push({ type: 'workout', source: 'From Trainer · Workout', ...p, displayName: p.name, displayTags: tags });
            }
          });
        }





        setSearchResults(allResults);
      } catch (e) {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, isClient, isSearching]);

  const handleClearSearch = () => {
    setSearchQuery('');
    setSearchResults(null);
  };

  const renderSearchResult = ({ item }) => {
    const iconMap = { workout: 'barbell-outline', diet: 'nutrition-outline', supplement: 'medkit-outline' };
    const colorMap = { workout: colors.primary, diet: colors.primary, supplement: colors.primary };
    return (
      <TouchableOpacity
        style={styles.card}
        activeOpacity={0.8}
        onPress={() => {
          handleClearSearch();
          if (item.type === 'workout') {
            navigation.navigate(item.source.includes('From Trainer') ? 'ClientAssignedDetail' : 'PlanDetail', { planId: item.id });
          } else {
            navigation.navigate('ClientDietPlanDetail', { planId: item.id, self: !item.source.includes('From Trainer'), plan: { name: item.name, kind: item.type } });
          }
        }}
      >
        <View style={styles.templateTag}>
          <Ionicons name={iconMap[item.type]} size={13} color={item.source.includes('From Trainer') ? colors.blue : colorMap[item.type]} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name} numberOfLines={1}>{item.displayName}</Text>
          <Text style={[styles.meta, NUMS]}>{item.source}</Text>
          {item.displayTags.length > 0 && (
            <View style={styles.tagRow}>
              {item.displayTags.slice(0, 3).map((tag) => (
                <View key={tag} style={[styles.tagChip, item.source.includes('From Trainer') && styles.tagChipTrainer]}>
                  <Text style={[styles.tagChipText, item.source.includes('From Trainer') && styles.tagChipTextTrainer]}>{tag}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
      </TouchableOpacity>
    );
  };

  // Search bar - always visible
  const renderSearchBar = () => (
    <View style={styles.searchRow}>
      <View style={styles.searchInputWrap}>
        <Ionicons name="search" size={16} color={colors.textDim} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search workouts, diets, supplements..."
          placeholderTextColor={colors.textDim}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoFocus={isSearching}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={handleClearSearch}>
            <Ionicons name="close-circle" size={18} color={colors.textDim} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  // Search results view - keeps search bar visible
  if (isSearching) {
    return (
      <View style={styles.container}>
        {renderSearchBar()}
        {searchLoading ? (
          <View style={styles.emptyWrap}><Text style={styles.emptySub}>Searching...</Text></View>
        ) : searchResults && searchResults.length === 0 ? (
          <View style={styles.emptyWrap}>
            <Text style={styles.emptyTitle}>No results</Text>
            <Text style={styles.emptySub}>No workouts, diets, or supplements match "{searchQuery}"</Text>
          </View>
        ) : searchResults ? (
          <FlatList
            data={searchResults}
            keyExtractor={(item, i) => `${item.type}-${item.id}-${i}`}
            renderItem={renderSearchResult}
            contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
          />
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {isClient && (
        <>
          {renderSearchBar()}
          <SegmentedControl styles={styles} colors={colors} tab={tab} setTab={setTab} />
        </>
      )}
      {isClient && subTab === 'supplements' ? (
        <SupplementPlansList styles={styles} colors={colors} navigation={navigation} fromTrainer={showTrainerTab} />
      ) : isClient && subTab === 'diet' ? (
        <DietPlansList styles={styles} colors={colors} navigation={navigation} fromTrainer={showTrainerTab} />
      ) : showTrainerTab ? (
        <AssignedList styles={styles} colors={colors} navigation={navigation} pinned={pinned} onTogglePin={onTogglePin} />
      ) : (
        <MyRoutinesList styles={styles} colors={colors} navigation={navigation} pinned={pinned} onTogglePin={onTogglePin} />
      )}
      {isClient && (
        <View style={styles.subTabDock}>
          {[
            { key: 'workouts', label: 'Workouts', icon: 'barbell-outline' },
            { key: 'diet', label: 'Diet', icon: 'nutrition-outline' },
            { key: 'supplements', label: 'Supps', icon: 'medkit-outline' },
          ].map((t) => {
            const on = subTab === t.key;
            return (
              <TouchableOpacity
                key={t.key}
                style={[styles.subTabBtn, on && styles.subTabBtnOn]}
                onPress={() => setSubTab(t.key)}
              >
                <Ionicons name={t.icon} size={15} color={on ? '#fff' : colors.textDim} />
                <Text style={[styles.subTabText, on && { color: '#fff' }]}>{t.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

// // Client diet plans surface: self-authored (My Routines context) and
// // trainer-assigned (From Trainer context) share this list; the builder
// // and viewer are shared too — only catalog access differs (trainer-only).
// function DietPlansList({ styles, colors, navigation, fromTrainer }) {
//   const [plans, setPlans] = useState([]);

//   useFocusEffect(
//     useCallback(() => {
//       let mounted = true;
//       api('/client/diet-plans')
//         .then((rows) => {
//           if (mounted) setPlans(rows.filter((p) => (fromTrainer ? p.created_by === 'trainer' : p.created_by === 'client')));
//         })
//         .catch(() => { if (mounted) setPlans([]); });
//       return () => { mounted = false; };
//     }, [fromTrainer])
//   );

//   const checkIn = async (plan, followed) => {
//     const today = new Date().toISOString().slice(0, 10);
//     try {
//       await api(`/client/diet-plans/${plan.id}/checkins`, {
//         method: 'POST',
//         body: { date: today, followed },
//       });
//     } catch (e) {
//       Alert.alert('Check-in failed', e.message || 'Please try again.');
//     }
//   };

//   if (plans.length === 0) {
//     return (
//       <View style={{ flex: 1 }}>
//         {!fromTrainer && (
//           <View style={styles.dietSegRow}>
//             <View style={[styles.dietSegBtn, styles.dietSegBtnOn]}>
//               <Text style={[styles.dietSegText, { color: '#fff' }]}>Plans</Text>
//             </View>
//             <TouchableOpacity
//               style={styles.dietSegBtn}
//               onPress={() => navigation.navigate('MyDishes')}
//             >
//               <Text style={styles.dietSegText}>My Dishes ›</Text>
//             </TouchableOpacity>
//           </View>
//         )}
//         <View style={styles.emptyWrap}>
//           <Ionicons name="nutrition-outline" size={38} color={colors.textDim} />
//           <Text style={styles.emptyTitle}>{fromTrainer ? 'Nothing assigned yet' : 'No diet plans yet'}</Text>
//           <Text style={styles.emptySub}>
//             {fromTrainer
//               ? 'Diet plans your trainer assigns will appear here.'
//               : 'Build your own day-by-day nutrition plan.'}
//           </Text>
//           {!fromTrainer && (
//             <TouchableOpacity
//               style={styles.emptyBtn}
//               onPress={() => navigation.navigate('DietPlanBuilder', { self: true })}
//             >
//               <Ionicons name="add" size={17} color={colors.primary} />
//               <Text style={styles.emptyBtnText}>New Diet Plan</Text>
//             </TouchableOpacity>
//           )}
//         </View>
//       </View>
//     );
//   }

//   return (
//     <View style={{ flex: 1 }}>
//       {!fromTrainer && (
//         <View style={styles.dietSegRow}>
//           <View style={[styles.dietSegBtn, styles.dietSegBtnOn]}>
//             <Text style={[styles.dietSegText, { color: '#fff' }]}>Plans</Text>
//           </View>
//           <TouchableOpacity
//             style={styles.dietSegBtn}
//             onPress={() => navigation.navigate('MyDishes')}
//           >
//             <Text style={styles.dietSegText}>My Dishes ›</Text>
//           </TouchableOpacity>
//         </View>
//       )}

//       <FlatList
//         data={plans}
//         keyExtractor={(p) => String(p.id)}
//         contentContainerStyle={{ padding: 20, paddingTop: 6, paddingBottom: 40 }}
//         ListHeaderComponent={
//           !fromTrainer ? (
//             <TouchableOpacity
//               style={styles.newRoutineBtn}
//               onPress={() => navigation.navigate('DietPlanBuilder', { self: true })}
//             >
//               <Ionicons name="add" size={17} color={colors.primary} />
//               <Text style={styles.newRoutineText}>New Diet Plan</Text>
//             </TouchableOpacity>
//           ) : null
//         }
//         renderItem={({ item: plan }) => {
//           const itemCount = (plan.days || []).reduce(
//             (n, d) => n + (d.meals || []).reduce((m, mm) => m + (mm.items || []).length, 0), 0
//           );
//           const planTags = plan.display_tags || plan.tags || [];
//           return (
//             <TouchableOpacity
//               style={styles.card}
//               activeOpacity={0.8}
//               onPress={() => navigation.navigate('ClientDietPlanDetail', { planId: plan.id, self: !fromTrainer, plan: { name: plan.name, trainer_name: plan.trainer_name } })}
//             >
//               <View style={styles.templateTag}>
//                 <Ionicons name="nutrition-outline" size={13} color={fromTrainer ? colors.blue : colors.primary} />
//               </View>
//               <View style={{ flex: 1 }}>
//                 <Text style={styles.name} numberOfLines={1}>
//                   {plan.name}
//                 </Text>
//                 <Text style={[styles.meta, NUMS]}>
//                   {(fromTrainer ? `From ${plan.trainer_name || 'your trainer'} · ` : '') + itemCount + ' items' + (plan.daily_calorie_target ? ` · ${plan.daily_calorie_target} cal/day` : '')}
//                 </Text>
//                 {planTags.length > 0 && (
//                   <View style={styles.tagRow}>
//                     {planTags.slice(0, 3).map((tag) => (
//                       <View key={tag} style={[styles.tagChip, fromTrainer && styles.tagChipTrainer]}>
//                         <Text style={[styles.tagChipText, fromTrainer && styles.tagChipTextTrainer]}>{tag}</Text>
//                       </View>
//                     ))}
//                   </View>
//                 )}
//               </View>
//               <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
//             </TouchableOpacity>
//           );
//         }}
//       />
//     </View>
//   );
// }




// Client diet plans surface: self-authored plans now come from LOCAL SQLite
// (create/edit/delete/check-in all work offline; the sync engine backs
// them up). Trainer-assigned plans stay server-fetched (server-owned).
function DietPlansList({ styles, colors, navigation, fromTrainer }) {
  const [plans, setPlans] = useState([]);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
        if (fromTrainer) {
        fetchAndCacheTrainerContent('trainer:diet-plans', () => api('/client/diet-plans'))
      // if (fromTrainer) {
      //   api('/client/diet-plans')
          .then((rows) => {
            if (mounted) setPlans(rows.filter((p) => p.created_by === 'trainer'));
          })
          .catch(() => { if (mounted) setPlans([]); });
      } else {
        listLocalDietPlans().then((rows) => { if (mounted) setPlans(rows); });
      }
      return () => { mounted = false; };
    }, [fromTrainer])
  );

  if (plans.length === 0) {
    return (
      <View style={{ flex: 1 }}>
        {!fromTrainer && (
          <View style={styles.dietSegRow}>
            <View style={[styles.dietSegBtn, styles.dietSegBtnOn]}>
              <Text style={[styles.dietSegText, { color: '#fff' }]}>Plans</Text>
            </View>
            <TouchableOpacity
              style={styles.dietSegBtn}
              onPress={() => navigation.navigate('MyDishes')}
            >
              <Text style={styles.dietSegText}>My Dishes ›</Text>
            </TouchableOpacity>
          </View>
        )}
        <View style={styles.emptyWrap}>
          <Ionicons name="nutrition-outline" size={38} color={colors.textDim} />
          <Text style={styles.emptyTitle}>{fromTrainer ? 'Nothing assigned yet' : 'No diet plans yet'}</Text>
          <Text style={styles.emptySub}>
            {fromTrainer
              ? 'Diet plans your trainer assigns will appear here.'
              : 'Build your own day-by-day nutrition plan.'}
          </Text>
          {!fromTrainer && (
            <TouchableOpacity
              style={styles.emptyBtn}
              onPress={() => navigation.navigate('DietPlanBuilder', { self: true })}
            >
              <Ionicons name="add" size={17} color={colors.primary} />
              <Text style={styles.emptyBtnText}>New Diet Plan</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {!fromTrainer && (
        <View style={styles.dietSegRow}>
          <View style={[styles.dietSegBtn, styles.dietSegBtnOn]}>
            <Text style={[styles.dietSegText, { color: '#fff' }]}>Plans</Text>
          </View>
          <TouchableOpacity
            style={styles.dietSegBtn}
            onPress={() => navigation.navigate('MyDishes')}
          >
            <Text style={styles.dietSegText}>My Dishes ›</Text>
          </TouchableOpacity>
        </View>
      )}

      <FlatList
        data={plans}
        keyExtractor={(p) => String(p.id)}
        contentContainerStyle={{ padding: 20, paddingTop: 6, paddingBottom: 40 }}
        ListHeaderComponent={
          !fromTrainer ? (
            <TouchableOpacity
              style={styles.newRoutineBtn}
              onPress={() => navigation.navigate('DietPlanBuilder', { self: true })}
            >
              <Ionicons name="add" size={17} color={colors.primary} />
              <Text style={styles.newRoutineText}>New Diet Plan</Text>
            </TouchableOpacity>
          ) : null
        }
        renderItem={({ item: plan }) => {
          const itemCount = (plan.days || []).reduce(
            (n, d) => n + (d.meals || []).reduce((m, mm) => m + (mm.items || []).length, 0), 0
          );
          const planTags = plan.display_tags || plan.tags || [];
          return (
            <TouchableOpacity
              style={styles.card}
              activeOpacity={0.8}
              onPress={() => navigation.navigate('ClientDietPlanDetail', { planId: plan.id, self: !fromTrainer, plan: { name: plan.name, trainer_name: plan.trainer_name } })}
            >
              <View style={styles.templateTag}>
                <Ionicons name="nutrition-outline" size={13} color={fromTrainer ? colors.blue : colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {plan.name}
                </Text>
                <Text style={[styles.meta, NUMS]}>
                  {(fromTrainer ? `From ${plan.trainer_name || 'your trainer'} · ` : '') + itemCount + ' items' + (plan.daily_calorie_target ? ` · ${plan.daily_calorie_target} cal/day` : '')}
                </Text>
                {planTags.length > 0 && (
                  <View style={styles.tagRow}>
                    {planTags.slice(0, 3).map((tag) => (
                      <View key={tag} style={[styles.tagChip, fromTrainer && styles.tagChipTrainer]}>
                        <Text style={[styles.tagChipText, fromTrainer && styles.tagChipTextTrainer]}>{tag}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}


// function SupplementPlansList({ styles, colors, navigation, fromTrainer }) {
//   const [plans, setPlans] = useState([]);

//   useFocusEffect(
//     useCallback(() => {
//       let mounted = true;
//       api('/client/supplement-plans')
//         .then((rows) => {
//           if (mounted) setPlans(rows.filter((p) => (fromTrainer ? p.created_by === 'trainer' : p.created_by === 'client')));
//         })
//         .catch(() => { if (mounted) setPlans([]); });
//       return () => { mounted = false; };
//     }, [fromTrainer])
//   );

//   if (plans.length === 0) {
//     return (
//       <View style={styles.emptyWrap}>
//         <Ionicons name="medkit-outline" size={38} color={colors.textDim} />
//         <Text style={styles.emptyTitle}>{fromTrainer ? 'Nothing assigned yet' : 'No supplement plans yet'}</Text>
//         <Text style={styles.emptySub}>
//           {fromTrainer
//             ? 'Supplement plans your trainer assigns will appear here.'
//             : 'Track your supplements and vitamins.'}
//         </Text>
//         {!fromTrainer && (
//           <TouchableOpacity
//             style={styles.emptyBtn}
//             onPress={() => navigation.navigate('CoachingPlanBuilder', { kind: 'supplement', self: true })}
//           >
//             <Ionicons name="add" size={17} color={colors.primary} />
//             <Text style={styles.emptyBtnText}>New Supplement Plan</Text>
//           </TouchableOpacity>
//         )}
//       </View>
//     );
//   }

//   return (
//     <View style={{ flex: 1 }}>
//       <FlatList
//         data={plans}
//         keyExtractor={(p) => String(p.id)}
//         contentContainerStyle={{ padding: 20, paddingTop: 6, paddingBottom: 40 }}
//         ListHeaderComponent={
//           !fromTrainer ? (
//             <TouchableOpacity
//               style={styles.newRoutineBtn}
//               onPress={() => navigation.navigate('CoachingPlanBuilder', { kind: 'supplement', self: true })}
//             >
//               <Ionicons name="add" size={17} color={colors.primary} />
//               <Text style={styles.newRoutineText}>New Supplement Plan</Text>
//             </TouchableOpacity>
//           ) : null
//         }
//         renderItem={({ item: plan }) => {
//           const itemCount = (plan.items || []).length;
//           const planTags = plan.tags || plan.display_tags || [];
//           return (
//             <TouchableOpacity
//               style={styles.card}
//               activeOpacity={0.8}
//               onPress={() => navigation.navigate('ClientDietPlanDetail', { planId: plan.id, self: !fromTrainer, plan: { name: plan.name, trainer_name: plan.trainer_name, kind: 'supplement' } })}
//             >
//               <View style={styles.templateTag}>
//                 <Ionicons name="medkit-outline" size={13} color={fromTrainer ? colors.blue : colors.primary} />
//               </View>
//               <View style={{ flex: 1 }}>
//                 <Text style={styles.name} numberOfLines={1}>
//                   {plan.name}
//                 </Text>
//                 <Text style={[styles.meta, NUMS]}>
//                   {(fromTrainer ? `From ${plan.trainer_name || 'your trainer'} · ` : '') + itemCount + ' supplements'}
//                 </Text>
//                 {planTags.length > 0 && (
//                   <View style={styles.tagRow}>
//                     {planTags.slice(0, 3).map((tag) => (
//                       <View key={tag} style={[styles.tagChip, fromTrainer && styles.tagChipTrainer]}>
//                         <Text style={[styles.tagChipText, fromTrainer && styles.tagChipTextTrainer]}>{tag}</Text>
//                       </View>
//                     ))}
//                   </View>
//                 )}
//               </View>
//               <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
//             </TouchableOpacity>
//           );
//         }}
//       />
//     </View>
//   );
// }

function SupplementPlansList({ styles, colors, navigation, fromTrainer }) {
  const [plans, setPlans] = useState([]);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      // if (fromTrainer) {
      //   api('/client/supplement-plans')
        if (fromTrainer) {
        fetchAndCacheTrainerContent('trainer:supplement-plans', () => api('/client/supplement-plans'))
          .then((rows) => {
            if (mounted) setPlans(rows.filter((p) => p.created_by === 'trainer'));
          })
          .catch(() => { if (mounted) setPlans([]); });
      } else {
        listLocalSupplementPlans().then((rows) => { if (mounted) setPlans(rows); });
      }
      return () => { mounted = false; };
    }, [fromTrainer])
  );

  if (plans.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Ionicons name="medkit-outline" size={38} color={colors.textDim} />
        <Text style={styles.emptyTitle}>{fromTrainer ? 'Nothing assigned yet' : 'No supplement plans yet'}</Text>
        <Text style={styles.emptySub}>
          {fromTrainer
            ? 'Supplement plans your trainer assigns will appear here.'
            : 'Track your supplements and vitamins.'}
        </Text>
        {!fromTrainer && (
          <TouchableOpacity
            style={styles.emptyBtn}
            onPress={() => navigation.navigate('CoachingPlanBuilder', { kind: 'supplement', self: true })}
          >
            <Ionicons name="add" size={17} color={colors.primary} />
            <Text style={styles.emptyBtnText}>New Supplement Plan</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={plans}
        keyExtractor={(p) => String(p.id)}
        contentContainerStyle={{ padding: 20, paddingTop: 6, paddingBottom: 40 }}
        ListHeaderComponent={
          !fromTrainer ? (
            <TouchableOpacity
              style={styles.newRoutineBtn}
              onPress={() => navigation.navigate('CoachingPlanBuilder', { kind: 'supplement', self: true })}
            >
              <Ionicons name="add" size={17} color={colors.primary} />
              <Text style={styles.newRoutineText}>New Supplement Plan</Text>
            </TouchableOpacity>
          ) : null
        }
        renderItem={({ item: plan }) => {
          const itemCount = (plan.items || []).length;
          const planTags = plan.tags || plan.display_tags || [];
          return (
            <TouchableOpacity
              style={styles.card}
              activeOpacity={0.8}
              onPress={() => navigation.navigate('ClientDietPlanDetail', { planId: plan.id, self: !fromTrainer, plan: { name: plan.name, trainer_name: plan.trainer_name, kind: 'supplement' } })}
            >
              <View style={styles.templateTag}>
                <Ionicons name="medkit-outline" size={13} color={fromTrainer ? colors.blue : colors.primary} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.name} numberOfLines={1}>
                  {plan.name}
                </Text>
                <Text style={[styles.meta, NUMS]}>
                  {(fromTrainer ? `From ${plan.trainer_name || 'your trainer'} · ` : '') + itemCount + ' supplements'}
                </Text>
                {planTags.length > 0 && (
                  <View style={styles.tagRow}>
                    {planTags.slice(0, 3).map((tag) => (
                      <View key={tag} style={[styles.tagChip, fromTrainer && styles.tagChipTrainer]}>
                        <Text style={[styles.tagChipText, fromTrainer && styles.tagChipTextTrainer]}>{tag}</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}


function MyRoutinesList({ styles, colors, navigation, pinned, onTogglePin }) {
  const [plans, setPlans] = useState([]);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      listPlans().then((p) => { if (mounted) setPlans(p); });
      return () => { mounted = false; };
    }, [])
  );

  if (!plans.length) {
    return (
      <View style={styles.emptyWrap}>
        <Ionicons name="list-outline" size={40} color={colors.textDim} />
        <Text style={styles.emptyTitle}>No routines yet</Text>
        <Text style={styles.emptySub}>
          Build a reusable template once — start it in one tap every time.
        </Text>
        <TouchableOpacity style={styles.emptyBtn} onPress={() => navigation.navigate('PlanEditor', {})}>
          <Ionicons name="add" size={18} color={colors.primary} />
          <Text style={styles.emptyBtnText}>Create a Routine</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <FlatList
      ListHeaderComponent={
        <TouchableOpacity style={styles.newRoutineBtn} onPress={() => navigation.navigate('PlanEditor', {})}>
          <Ionicons name="add" size={17} color={colors.primary} />
          <Text style={styles.newRoutineText}>New Routine</Text>
        </TouchableOpacity>
      }
      data={plans}
      keyExtractor={(item) => String(item.id)}
      contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
      renderItem={({ item }) => {
        const planTags = item.tags || [];
        return (
        <TouchableOpacity
          style={styles.card}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('PlanDetail', { planId: item.id })}
        >
          <View style={styles.templateTag}>
            <Ionicons name="copy-outline" size={13} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={[styles.meta, NUMS]}>
              {item.exerciseCount} exercises
              {item.used_count > 0 ? ` · used ${item.used_count}×` : ' · never used'}
            </Text>
            {planTags.length > 0 && (
              <View style={styles.tagRow}>
                {planTags.slice(0, 3).map((tag) => (
                  <View key={tag} style={styles.tagChip}>
                    <Text style={styles.tagChipText}>{tag}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
          <PinButton
            styles={styles}
            colors={colors}
            pinned={pinned.has(`self:${item.id}`)}
            onPress={() => onTogglePin('self', item.id)}
          />
          <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
        </TouchableOpacity>
      );}}
    />
  );
}

function AssignedList({ styles, colors, navigation, pinned, onTogglePin }) {
  const [assigned, setAssigned] = useState([]);
  const { user } = useAuth();

  useFocusEffect(
    useCallback(() => {
      if (user?.role !== 'user' && user?.role !== 'trainer') {
        setAssigned([]);
        return;
      }
      let mounted = true;
      // api('/client/assigned-plans')
        fetchAndCacheTrainerContent('trainer:assigned-workouts', () => api('/client/assigned-plans'))
        .then((rows) => { if (mounted) setAssigned(rows); })
        .catch(() => { if (mounted) setAssigned([]); });
      return () => { mounted = false; };
    }, [user])
  );

  if (!assigned.length) {
    return (
      <View style={styles.emptyWrap}>
        <Ionicons name="fitness-outline" size={40} color={colors.textDim} />
        <Text style={styles.emptyTitle}>Nothing assigned yet</Text>
        <Text style={styles.emptySub}>
          When your trainer assigns a workout, it will show up here ready to start.
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={assigned}
      keyExtractor={(ap) => String(ap.id)}
      contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
      renderItem={({ item: ap }) => {
        const planTags = ap.tags || [];
        return (
        <TouchableOpacity
          style={styles.assignedCard}
          activeOpacity={0.8}
          onPress={() => navigation.navigate('ClientAssignedDetail', { planId: ap.id })}
        >
          <View style={styles.assignedAccent} />
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={1}>
              {ap.name}
            </Text>
            <Text style={[styles.meta, NUMS]}>
              Assigned by {ap.trainer_name || 'your trainer'} ·{' '}
              {ap.exercises?.length ?? 0} exercises
            </Text>
            {planTags.length > 0 && (
              <View style={styles.tagRow}>
                {planTags.slice(0, 3).map((tag) => (
                  <View key={tag} style={[styles.tagChip, styles.tagChipTrainer]}>
                    <Text style={[styles.tagChipText, styles.tagChipTextTrainer]}>{tag}</Text>
                  </View>
                ))}
              </View>
            )}
          </View>
          <PinButton
            styles={styles}
            colors={colors}
            pinned={pinned.has(`trainer_assigned:${ap.id}`)}
            onPress={() => onTogglePin('trainer_assigned', ap.id)}
          />
          <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
        </TouchableOpacity>
      );}}
    />
  );
}

function SegmentedControl({ styles, colors, tab, setTab }) {
  const segs = [
    { key: 'mine', label: 'My Routines' },
    { key: 'trainer', label: 'From Trainer' },
  ];
  return (
    <View style={styles.segRow}>
      {segs.map((seg) => {
        const on = tab === seg.key;
        return (
          <TouchableOpacity
            key={seg.key}
            style={[styles.segBtn, on && styles.segBtnOn]}
            onPress={() => setTab(seg.key)}
          >
            {seg.key === 'trainer' && (
              <Ionicons name="fitness" size={13} color={on ? '#fff' : colors.blue} />
            )}
            <Text style={[styles.segText, on && styles.segTextOn]}>{seg.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function PinButton({ styles, colors, pinned, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.pinBtn} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
      <Ionicons
        name={pinned ? 'star' : 'star-outline'}
        size={18}
        color={pinned ? colors.yellow : colors.textDim}
      />
    </TouchableOpacity>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },

    segRow: {
      flexDirection: 'row',
      marginHorizontal: 20,
      marginTop: 12,
      marginBottom: 6,
      backgroundColor: colors.cardLight,
      borderRadius: 12,
      padding: 3,
    },
    segBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 10,
      paddingVertical: 8,
    },
    segBtnOn: { backgroundColor: colors.primary },
    segText: { color: colors.textDim, fontWeight: '700', fontSize: 13 },
    segTextOn: { color: '#fff' },

    emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
    emptyTitle: { color: colors.text, fontSize: 19, fontWeight: '800', marginTop: 14 },
    emptySub: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 6, marginBottom: 20 },
    emptyBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: colors.primary,
      paddingHorizontal: 20,
      paddingVertical: 12,
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

    assignedCard: {
      flexDirection: 'row', alignItems: 'center', gap: 12,
      backgroundColor: colors.card, borderRadius: 14,
      paddingVertical: 14, paddingRight: 14, paddingLeft: 0, marginBottom: 8,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    assignedAccent: {
      alignSelf: 'stretch', width: 4, borderRadius: 2,
      backgroundColor: colors.blue, opacity: 0.9,
    },

    subTabDock: {
      flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingVertical: 10,
      borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg,
    },
    subTabBtn: {
      flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
      backgroundColor: colors.cardLight, borderRadius: 12, paddingVertical: 10,
    },
    subTabBtnOn: { backgroundColor: colors.primary },
    subTabText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },
    newRoutineBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12,
      paddingVertical: 12, marginBottom: 12,
    },
    newRoutineText: { color: colors.primary, fontWeight: '700', fontSize: 14 },
    dietSegRow: {
      flexDirection: 'row', backgroundColor: colors.cardLight,
      borderRadius: 12, padding: 3, marginHorizontal: 20, marginTop: 10, marginBottom: 4,
    },
    dietSegBtn: { flex: 1, alignItems: 'center', borderRadius: 10, paddingVertical: 8 },
    dietSegBtnOn: { backgroundColor: colors.primary },
    dietSegText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },
    pinBtn: { padding: 6 },
    name: { color: colors.text, fontSize: 15, fontWeight: '700' },
    meta: { color: colors.textDim, fontSize: 12, marginTop: 2 },
    tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 6 },
    tagChip: {
      backgroundColor: colors.cardLight,
      borderRadius: 8,
      paddingHorizontal: 8,
      paddingVertical: 2,
    },
    tagChipTrainer: {
      backgroundColor: colors.blue + '20',
    },
    tagChipText: {
      color: colors.textDim,
      fontSize: 10,
      fontWeight: '600',
    },
    tagChipTextTrainer: {
      color: colors.blue,
    },
    searchRow: {
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 8,
    },
    searchInputWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.cardLight,
      borderRadius: 12,
      paddingHorizontal: 12,
      gap: 8,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 10,
      color: colors.text,
      fontSize: 15,
    },
  });