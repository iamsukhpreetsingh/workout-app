// import React, { useState, useEffect } from 'react';
// import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, Switch } from 'react-native';
// import { Ionicons } from '@expo/vector-icons';
// import { useColors } from '../theme';
// import { getSyncSettings, setSyncMode, syncPending, getSyncStatus, pullFromCloud, initConnectivityListener, getConnectivityState } from '../lib/sync';

// export default function SyncSettingsScreen({ navigation }) {
//   const colors = useColors();
//   const styles = makeStyles(colors);
//   const [settings, setSettings] = useState({ sync_mode: 'auto', last_synced_at: null });
//   const [syncState, setSyncState] = useState({ status: 'synced', pending_count: 0, isConnected: true });
//   const [isSyncing, setIsSyncing] = useState(false);

//   const loadData = async () => {
//     const [s, state] = await Promise.all([getSyncSettings(), getSyncStatus()]);
//     setSettings(s);
//     setSyncState(state);
//   };

//   useEffect(() => {
//     loadData();
//   }, []);



//   const handlePull = async () => {
//     try {
//       const result = await pullFromCloud();
//       if (result.skipped) {
//         Alert.alert('Pull Skipped', result.reason === 'local_only' ? 'Sync is in Local Only mode' : 'No internet connection');
//       } else {
//         Alert.alert('Pull Complete', `Downloaded ${result.downloaded} items from cloud`);
//       }
//     } catch (e) {
//       Alert.alert('Pull Failed', e.message);
//     }
//     loadData();
//   };

//   const formatLastSync = (timestamp) => {
//     if (!timestamp) return 'Never';
//     const date = new Date(timestamp);
//     return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
//   };

//   const getStatusIcon = () => {
//     if (!syncState.isConnected) return 'cloud-offline-outline';
//     if (syncState.status === 'syncing') return 'sync-outline';
//     if (syncState.status === 'pending' || syncState.status === 'offline-pending') return 'cloud-upload-outline';
//     return 'cloud-done-outline';
//   };

//   const getStatusText = () => {
//     if (!syncState.isConnected) return 'Offline';
//     if (syncState.status === 'syncing') return 'Syncing...';
//     if (syncState.status === 'pending') return `${syncState.pending_count} pending`;
//     if (syncState.status === 'offline-pending') return `Offline · ${syncState.pending_count} pending`;
//     return 'Synced';
//   };

//   return (
//     <ScrollView style={styles.container}>
//       <View style={styles.section}>
//         <Text style={styles.sectionTitle}>Sync Mode</Text>
        
//         <TouchableOpacity 
//           style={[styles.option, settings.sync_mode === 'auto' && styles.optionSelected]}
//           onPress={() => handleModeChange('auto')}
//         >
//           <View style={styles.optionContent}>
//             <Ionicons name="sync" size={22} color={settings.sync_mode === 'auto' ? colors.primary : colors.text} />
//             <View style={styles.optionText}>
//               <Text style={styles.optionTitle}>Automatic Sync</Text>
//               <Text style={styles.optionDesc}>Automatically sync your data whenever an internet connection is available.</Text>
//             </View>
//           </View>
//           {settings.sync_mode === 'auto' && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
//         </TouchableOpacity>

//         <TouchableOpacity 
//           style={[styles.option, settings.sync_mode === 'manual' && styles.optionSelected]}
//           onPress={() => handleModeChange('manual')}
//         >
//           <View style={styles.optionContent}>
//             <Ionicons name="hand-right-outline" size={22} color={settings.sync_mode === 'manual' ? colors.primary : colors.text} />
//             <View style={styles.optionText}>
//               <Text style={styles.optionTitle}>Manual Sync</Text>
//               <Text style={styles.optionDesc}>Keep changes on this device and sync them to the cloud only when you choose.</Text>
//             </View>
//           </View>
//           {settings.sync_mode === 'manual' && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
//         </TouchableOpacity>

//         <TouchableOpacity 
//           style={[styles.option, settings.sync_mode === 'local' && styles.optionSelected]}
//           onPress={() => handleModeChange('local')}
//         >
//           <View style={styles.optionContent}>
//             <Ionicons name="phone-portrait-outline" size={22} color={settings.sync_mode === 'local' ? colors.primary : colors.text} />
//             <View style={styles.optionText}>
//               <Text style={styles.optionTitle}>Local Only</Text>
//               <Text style={styles.optionDesc}>Keep your data on this device and do not automatically sync it to the cloud.</Text>
//             </View>
//           </View>
//           {settings.sync_mode === 'local' && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
//         </TouchableOpacity>
//       </View>

//       <View style={styles.section}>
//         <Text style={styles.sectionTitle}>Sync Status</Text>
//         <View style={styles.statusCard}>
//           <View style={styles.statusRow}>
//             <Ionicons name={getStatusIcon()} size={20} color={syncState.isConnected ? colors.primary : colors.textDim} />
//             <Text style={styles.statusText}>{getStatusText()}</Text>
//           </View>
//           <Text style={styles.lastSync}>Last synced: {formatLastSync(settings.last_synced_at)}</Text>
//           {syncState.pending_count > 0 && (
//             <Text style={styles.pending}>Pending changes: {syncState.pending_count}</Text>
//           )}
//         </View>

//         <View style={styles.buttonRow}>
//           <TouchableOpacity 
//             style={[styles.button, styles.buttonPrimary, isSyncing && styles.buttonDisabled]} 
//             onPress={handleSyncNow}
//             disabled={isSyncing}
//           >
//             <Ionicons name="cloud-upload-outline" size={18} color="#fff" />
//             <Text style={styles.buttonText}>{isSyncing ? 'Syncing...' : 'Sync Now'}</Text>
//           </TouchableOpacity>

//           <TouchableOpacity 
//             style={[styles.button, styles.buttonSecondary]} 
//             onPress={handlePull}
//           >
//             <Ionicons name="cloud-download-outline" size={18} color={colors.primary} />
//             <Text style={[styles.buttonText, styles.buttonTextSecondary]}>Pull from Cloud</Text>
//           </TouchableOpacity>
//         </View>
//       </View>

//       <View style={styles.section}>
//         <Text style={styles.sectionTitle}>Data Warning</Text>
//         <View style={styles.warningCard}>
//           <Ionicons name="warning-outline" size={20} color={colors.yellow} />
//           <Text style={styles.warningText}>
//             Your data is stored locally on this device. If you uninstall the app, clear app storage, or reset your device before syncing, your data may be permanently lost.
//           </Text>
//         </View>
//       </View>
//     </ScrollView>
//   );
// }

//   });





import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import { getSyncSettings } from '../lib/sync';
// import { processQueue, getEngineStatus } from '../lib/syncEngine';
import { processQueue, getEngineStatus, getFailedItems } from '../lib/syncEngine';
import { getLocalOnlyReminderState, markLocalOnlyReminderShown, hasUnsyncedBackupData } from '../lib/localOnly';


// Human-readable names for each syncable entity, used in the failed list
const ENTITY_LABELS = {
  session: 'Workout session',
  workout_plan: 'Workout routine',
  custom_exercise: 'Custom exercise',
  measurement: 'Body measurement',
  recipe: 'Dish (My Dishes)',
  diet_plan: 'Diet plan',
  diet_checkin: 'Diet check-in',
  diet_swap: 'Diet dish swap',
  supplement_plan: 'Supplement plan',
  supplement_checkin: 'Supplement check-in',
  personal_record: 'Personal record',
  progress_photo: 'Progress photo',
};


const MODES = [
  { key: 'auto', icon: 'sync', title: 'Automatic Sync', desc: 'Syncs whenever you\'re online — foreground, reconnect, and every 10 minutes.' },
  { key: 'manual', icon: 'hand-right-outline', title: 'Manual Sync', desc: 'Keeps changes on this device and syncs only when you tap Sync Now.' },
  { key: 'local', icon: 'phone-portrait-outline', title: 'Local Only', desc: 'Never sends your data to the cloud from this device.' },
];

// Data & Sync settings — rebuilt for the unified engine (Phase 5). Shows the
// TRUE pending/failed counts, enforces the five mode-switch behaviors, and
// carries System 7's Local Only warnings (verbatim wording per spec).
export default function SyncSettingsScreen() {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [settings, setSettings] = useState({ sync_mode: 'auto', last_synced_at: null });
  const [status, setStatus] = useState({ pending_count: 0, failed_count: 0, isConnected: true });
  const [isSyncing, setIsSyncing] = useState(false);
  const [failedItems, setFailedItems] = useState([]);
  const [failedExpanded, setFailedExpanded] = useState(false);



  const loadData = useCallback(async () => {
    const [s, st] = await Promise.all([getSyncSettings(), getEngineStatus()]);
  //   setSettings(s);
  //   setStatus(st);
  // }, []);
    setSettings(s);
    setStatus(st);
    setFailedItems(await getFailedItems());
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const handleModeChange = async (mode) => {
    const prev = settings.sync_mode;
    if (mode === prev) return;

    // System 7 #1: the exact confirmation dialog, verbatim
    if (mode === 'local') {
      Alert.alert(
        'Keep your data on this device only?',
        'Your workouts, measurements, and plans will never be backed up to the cloud. If you delete the app, switch phones, or your device is lost or reset, this data will be gone permanently and cannot be recovered. If you have a trainer, they will not be able to see any new activity while this is on.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'I Understand, Turn On Local Only',
            style: 'destructive',
            onPress: async () => { await applyMode(mode, prev); },
          },
        ]
      );
      return;
    }
    await applyMode(mode, prev);
  };

  // The five mode-switch edge cases (System 6). Spec-exact.
  const applyMode = async (mode, prev) => {
    await getSyncSettings(); // ensure row exists
    const { setSyncMode } = await import('../lib/sync');
    await setSyncMode(mode);
    // local→auto: immediately run the accumulated backlog
    if (prev === 'local' && mode === 'auto') {
      setIsSyncing(true);
      processQueue().finally(() => { setIsSyncing(false); loadData(); });
    }
    // local→manual: backlog shows as pending count; NO auto-sync
    // manual→auto: immediately trigger one run
    if (prev === 'manual' && mode === 'auto') {
      setIsSyncing(true);
      processQueue().finally(() => { setIsSyncing(false); loadData(); });
    }
    // auto→manual: nothing to do — in-flight runs finish; future auto
    // triggers suppressed (the engine checks the mode on every trigger)
    // anything→local: same — in-flight finishes, nothing new starts
    loadData();
  };

  const handleSyncNow = async () => {
    setIsSyncing(true);
    try {
      const result = await processQueue({ manual: true });
      if (result.skipped) {
        if (result.reason === 'offline') {
          Alert.alert('Offline', 'No internet connection. Your changes will sync when you\'re back online.');
        } else if (result.reason === 'local_only') {
          Alert.alert('Sync Disabled', 'Sync is set to Local Only. Change your sync mode to enable cloud backup.');
        }
      // } else {
      //   const msg = `Uploaded: ${result.uploaded}`;
      //   Alert.alert('Sync Complete', result.failed > 0
      //     ? `${msg}\nFailed: ${result.failed} (will retry automatically)` : msg);
      // }

            } else {
        const msg = `Uploaded: ${result.uploaded}`;
        if (result.failed > 0) {
          const failedDetail = await getFailedItems();
          const lines = failedDetail.slice(0, 5).map((f) =>
            `• ${ENTITY_LABELS[f.entity_type] || f.entity_type}: ${f.error}`
          );
          const more = failedDetail.length > 5 ? `\n…and ${failedDetail.length - 5} more` : '';
          Alert.alert('Sync Complete',
            `${msg}\nFailed: ${result.failed}\n\n${lines.join('\n')}${more}\n\nThey'll retry automatically — or see details in Sync Status.`);
        } else {
          Alert.alert('Sync Complete', msg);
        }
      }
    } catch (e) {
      Alert.alert('Sync Failed', e.message || 'Please try again.');
    } finally {
      setIsSyncing(false);
      loadData();
    }
  };

  const formatLastSync = (ts) => {
    if (!ts) return 'Never';
    return new Date(ts).toLocaleDateString() + ' ' + new Date(ts).toLocaleTimeString();
  };

  const isLocalOnly = settings.sync_mode === 'local';

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }}>
      {/* System 7 #2: persistent indicator while local_only is active */}
      {isLocalOnly && (
        <View style={styles.localOnlyBanner}>
          <Ionicons name="lock-closed" size={15} color={colors.red} />
          <Text style={styles.localOnlyBannerText}>Local Only — not backed up</Text>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Sync Mode</Text>
        {MODES.map((m) => {
          const on = settings.sync_mode === m.key;
          return (
            <TouchableOpacity
              key={m.key}
              style={[styles.option, on && (m.key === 'local' ? styles.optionSelectedDanger : styles.optionSelected)]}
              onPress={() => handleModeChange(m.key)}
            >
              <View style={styles.optionContent}>
                <Ionicons name={m.icon} size={22} color={on ? (m.key === 'local' ? colors.red : colors.primary) : colors.text} />
                <View style={styles.optionText}>
                  <Text style={[styles.optionTitle, m.key === 'local' && on && { color: colors.red }]}>{m.title}</Text>
                  <Text style={styles.optionDesc}>{m.desc}</Text>
                </View>
              </View>
              {on && <Ionicons name="checkmark-circle" size={22} color={m.key === 'local' ? colors.red : colors.primary} />}
            </TouchableOpacity>
          );
        })}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Sync Status</Text>
        <View style={styles.statusCard}>
          <View style={styles.statusRow}>
            <Ionicons
              name={!status.isConnected ? 'cloud-offline-outline' : status.pending_count > 0 ? 'cloud-upload-outline' : 'cloud-done-outline'}
              size={20}
              color={status.isConnected ? colors.primary : colors.textDim}
            />
            <Text style={styles.statusText}>
              {!status.isConnected
                ? 'Offline'
                : status.pending_count > 0
                ? `${status.pending_count} pending`
                : status.failed_count > 0
                ? 'Synced (with failures)'
                : 'All backed up'}
            </Text>
          </View>
          <Text style={styles.lastSync}>Last synced: {formatLastSync(settings.last_synced_at)}</Text>
          {status.pending_count > 0 && (
            <Text style={styles.pending}>Pending changes: {status.pending_count}</Text>
          )}
          {/* {status.failed_count > 0 && (
            <Text style={styles.failedText}>Failed items: {status.failed_count} — tap Sync Now to retry</Text>
          )} */}

                    {failedItems.length > 0 && (
            <TouchableOpacity
              style={styles.failedHeader}
              onPress={() => setFailedExpanded((v) => !v)}
              activeOpacity={0.7}
            >
              <Ionicons
                name={failedExpanded ? 'chevron-down' : 'chevron-forward'}
                size={14}
                color={colors.red}
              />
              <Text style={styles.failedText}>
                {failedItems.length} item{failedItems.length === 1 ? '' : 's'} failed to sync — tap to{' '}
                {failedExpanded ? 'hide' : 'see which'}
              </Text>
            </TouchableOpacity>
          )}
          {failedItems.length > 0 && failedExpanded && (
            <View style={styles.failedList}>
              {failedItems.map((f, i) => (
                <View key={`${f.entity_type}-${f.entity_id}-${i}`} style={styles.failedRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.failedRowTitle}>
                      {ENTITY_LABELS[f.entity_type] || f.entity_type} {f.operation === 'DELETE' ? '(delete)' : ''}
                    </Text>
                    <Text style={styles.failedRowError} numberOfLines={3}>
                      {f.error}
                    </Text>
                  </View>
                  <View style={styles.failedMeta}>
                    <Text style={styles.failedMetaText}>attempt {f.attempts}</Text>
                    <Text style={styles.failedMetaText}>
                      {f.capped ? 'needs manual retry' : `retry in ~${f.retry_in}`}
                    </Text>
                  </View>
                </View>
              ))}
              <Text style={styles.failedHint}>
                Tap Sync Now to retry now regardless of the schedule.
              </Text>
            </View>
          )}
        </View>

        {/* System 6: manual-sync UI hidden entirely in local_only */}
        {!isLocalOnly && (
          <TouchableOpacity
            style={[styles.button, styles.buttonPrimary, isSyncing && styles.buttonDisabled]}
            onPress={handleSyncNow}
            disabled={isSyncing}
          >
            <Ionicons name="cloud-upload-outline" size={18} color="#fff" />
            <Text style={styles.buttonText}>{isSyncing ? 'Syncing…' : 'Sync Now'}</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Backup Contents</Text>
        <View style={styles.contentsCard}>
          <Text style={styles.contentsText}>
            Your workouts (with notes & RPE), routines, custom exercises, dishes, diet & supplement plans,
            check-ins, body measurements, personal records, and progress photos are backed up and can be
            restored on any device by logging in.
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    localOnlyBanner: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.card, borderWidth: 1.5, borderColor: colors.red,
      borderRadius: 12, padding: 12, margin: 16, marginBottom: 0,
    },
    localOnlyBannerText: { color: colors.red, fontWeight: '800', fontSize: 13, flex: 1 },
    section: { padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
    sectionTitle: { color: colors.textDim, fontSize: 13, fontWeight: '700', marginBottom: 12, letterSpacing: 0.5 },
    option: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      padding: 14, backgroundColor: colors.card, borderRadius: 12, marginBottom: 8,
    },
    optionSelected: { borderWidth: 1, borderColor: colors.primary },
    optionSelectedDanger: { borderWidth: 1.5, borderColor: colors.red },
    optionContent: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 12 },
    optionText: { flex: 1 },
    optionTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
    optionDesc: { color: colors.textDim, fontSize: 12, marginTop: 2 },
    statusCard: { backgroundColor: colors.card, borderRadius: 12, padding: 16, marginBottom: 12 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
    statusText: { color: colors.text, fontSize: 15, fontWeight: '600' },
    lastSync: { color: colors.textDim, fontSize: 13 },
    pending: { color: colors.yellow, fontSize: 13, marginTop: 4 },
    // failedText: { color: colors.red, fontSize: 13, marginTop: 4 },

    failedText: { color: colors.red, fontSize: 13, marginTop: 4, flex: 1 },
    failedHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
    failedList: {
      marginTop: 8, backgroundColor: colors.cardLight, borderRadius: 10, padding: 10,
    },
    failedRow: {
      flexDirection: 'row', gap: 10, paddingVertical: 8,
      borderTopWidth: 1, borderTopColor: colors.border,
    },
    failedRowTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
    failedRowError: { color: colors.textDim, fontSize: 11, marginTop: 2 },
    failedMeta: { alignItems: 'flex-end' },
    failedMetaText: { color: colors.textDim, fontSize: 10 },
    failedHint: { color: colors.textDim, fontSize: 10, fontStyle: 'italic', marginTop: 6 },


    buttonRow: { flexDirection: 'row', gap: 12 },
    button: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 10 },
    buttonPrimary: { backgroundColor: colors.primary },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: '#fff', fontWeight: '600', fontSize: 14 },
    contentsCard: { backgroundColor: colors.card, borderRadius: 12, padding: 14 },
    contentsText: { color: colors.textDim, fontSize: 12, lineHeight: 18 },
  });