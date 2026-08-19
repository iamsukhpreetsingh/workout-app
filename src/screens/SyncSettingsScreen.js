import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert, Switch } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import { getSyncSettings, setSyncMode, syncPending, getSyncStatus, pullFromCloud, initConnectivityListener, getConnectivityState } from '../lib/sync';

export default function SyncSettingsScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [settings, setSettings] = useState({ sync_mode: 'auto', last_synced_at: null });
  const [syncState, setSyncState] = useState({ status: 'synced', pending_count: 0, isConnected: true });
  const [isSyncing, setIsSyncing] = useState(false);

  const loadData = async () => {
    const [s, state] = await Promise.all([getSyncSettings(), getSyncStatus()]);
    setSettings(s);
    setSyncState(state);
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleModeChange = async (mode) => {
    if (mode === 'local' && settings.sync_mode !== 'local') {
      Alert.alert(
        'Switch to Local Only?',
        'Your data will be stored only on this device and will not automatically sync to the cloud. If you delete the app, clear its storage, or lose/reset your device, locally stored data may be permanently lost.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Switch', onPress: async () => { await setSyncMode(mode); loadData(); }, style: 'destructive' },
        ]
      );
    } else {
      await setSyncMode(mode);
      loadData();
    }
  };

  const handleSyncNow = async () => {
    setIsSyncing(true);
    try {
      const result = await syncPending();
      if (result.skipped) {
        if (result.reason === 'local_only') {
          Alert.alert('Sync Disabled', 'Sync is set to Local Only. Change your sync mode to enable automatic synchronization.');
        } else if (result.reason === 'offline') {
          Alert.alert('Offline', 'No internet connection. Your changes will sync when you\'re back online.');
        }
      } else {
        Alert.alert('Sync Complete', `Uploaded: ${result.uploaded}\nFailed: ${result.failed}\nPending: ${result.pending}`);
      }
    } catch (e) {
      Alert.alert('Sync Failed', e.message);
    } finally {
      setIsSyncing(false);
      loadData();
    }
  };

  const handlePull = async () => {
    try {
      const result = await pullFromCloud();
      if (result.skipped) {
        Alert.alert('Pull Skipped', result.reason === 'local_only' ? 'Sync is in Local Only mode' : 'No internet connection');
      } else {
        Alert.alert('Pull Complete', `Downloaded ${result.downloaded} items from cloud`);
      }
    } catch (e) {
      Alert.alert('Pull Failed', e.message);
    }
    loadData();
  };

  const formatLastSync = (timestamp) => {
    if (!timestamp) return 'Never';
    const date = new Date(timestamp);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const getStatusIcon = () => {
    if (!syncState.isConnected) return 'cloud-offline-outline';
    if (syncState.status === 'syncing') return 'sync-outline';
    if (syncState.status === 'pending' || syncState.status === 'offline-pending') return 'cloud-upload-outline';
    return 'cloud-done-outline';
  };

  const getStatusText = () => {
    if (!syncState.isConnected) return 'Offline';
    if (syncState.status === 'syncing') return 'Syncing...';
    if (syncState.status === 'pending') return `${syncState.pending_count} pending`;
    if (syncState.status === 'offline-pending') return `Offline · ${syncState.pending_count} pending`;
    return 'Synced';
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Sync Mode</Text>
        
        <TouchableOpacity 
          style={[styles.option, settings.sync_mode === 'auto' && styles.optionSelected]}
          onPress={() => handleModeChange('auto')}
        >
          <View style={styles.optionContent}>
            <Ionicons name="sync" size={22} color={settings.sync_mode === 'auto' ? colors.primary : colors.text} />
            <View style={styles.optionText}>
              <Text style={styles.optionTitle}>Automatic Sync</Text>
              <Text style={styles.optionDesc}>Automatically sync your data whenever an internet connection is available.</Text>
            </View>
          </View>
          {settings.sync_mode === 'auto' && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.option, settings.sync_mode === 'manual' && styles.optionSelected]}
          onPress={() => handleModeChange('manual')}
        >
          <View style={styles.optionContent}>
            <Ionicons name="hand-right-outline" size={22} color={settings.sync_mode === 'manual' ? colors.primary : colors.text} />
            <View style={styles.optionText}>
              <Text style={styles.optionTitle}>Manual Sync</Text>
              <Text style={styles.optionDesc}>Keep changes on this device and sync them to the cloud only when you choose.</Text>
            </View>
          </View>
          {settings.sync_mode === 'manual' && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
        </TouchableOpacity>

        <TouchableOpacity 
          style={[styles.option, settings.sync_mode === 'local' && styles.optionSelected]}
          onPress={() => handleModeChange('local')}
        >
          <View style={styles.optionContent}>
            <Ionicons name="phone-portrait-outline" size={22} color={settings.sync_mode === 'local' ? colors.primary : colors.text} />
            <View style={styles.optionText}>
              <Text style={styles.optionTitle}>Local Only</Text>
              <Text style={styles.optionDesc}>Keep your data on this device and do not automatically sync it to the cloud.</Text>
            </View>
          </View>
          {settings.sync_mode === 'local' && <Ionicons name="checkmark-circle" size={22} color={colors.primary} />}
        </TouchableOpacity>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Sync Status</Text>
        <View style={styles.statusCard}>
          <View style={styles.statusRow}>
            <Ionicons name={getStatusIcon()} size={20} color={syncState.isConnected ? colors.primary : colors.textDim} />
            <Text style={styles.statusText}>{getStatusText()}</Text>
          </View>
          <Text style={styles.lastSync}>Last synced: {formatLastSync(settings.last_synced_at)}</Text>
          {syncState.pending_count > 0 && (
            <Text style={styles.pending}>Pending changes: {syncState.pending_count}</Text>
          )}
        </View>

        <View style={styles.buttonRow}>
          <TouchableOpacity 
            style={[styles.button, styles.buttonPrimary, isSyncing && styles.buttonDisabled]} 
            onPress={handleSyncNow}
            disabled={isSyncing}
          >
            <Ionicons name="cloud-upload-outline" size={18} color="#fff" />
            <Text style={styles.buttonText}>{isSyncing ? 'Syncing...' : 'Sync Now'}</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={[styles.button, styles.buttonSecondary]} 
            onPress={handlePull}
          >
            <Ionicons name="cloud-download-outline" size={18} color={colors.primary} />
            <Text style={[styles.buttonText, styles.buttonTextSecondary]}>Pull from Cloud</Text>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Data Warning</Text>
        <View style={styles.warningCard}>
          <Ionicons name="warning-outline" size={20} color={colors.yellow} />
          <Text style={styles.warningText}>
            Your data is stored locally on this device. If you uninstall the app, clear app storage, or reset your device before syncing, your data may be permanently lost.
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    section: { padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border },
    sectionTitle: { color: colors.textDim, fontSize: 13, fontWeight: '700', marginBottom: 12, letterSpacing: 0.5 },
    option: { 
      flexDirection: 'row', 
      alignItems: 'center', 
      justifyContent: 'space-between',
      padding: 14, 
      backgroundColor: colors.card, 
      borderRadius: 12, 
      marginBottom: 8 
    },
    optionSelected: { borderWidth: 1, borderColor: colors.primary },
    optionContent: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: 12 },
    optionText: { flex: 1 },
    optionTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
    optionDesc: { color: colors.textDim, fontSize: 12, marginTop: 2 },
    statusCard: { backgroundColor: colors.card, borderRadius: 12, padding: 16, marginBottom: 12 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
    statusText: { color: colors.text, fontSize: 15, fontWeight: '600' },
    lastSync: { color: colors.textDim, fontSize: 13 },
    pending: { color: colors.yellow, fontSize: 13, marginTop: 4 },
    buttonRow: { flexDirection: 'row', gap: 12 },
    button: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 12, borderRadius: 10 },
    buttonPrimary: { backgroundColor: colors.primary },
    buttonSecondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.primary },
    buttonDisabled: { opacity: 0.6 },
    buttonText: { color: '#fff', fontWeight: '600', fontSize: 14 },
    buttonTextSecondary: { color: colors.primary },
    warningCard: { flexDirection: 'row', gap: 10, backgroundColor: colors.card, borderRadius: 12, padding: 14, alignItems: 'flex-start' },
    warningText: { flex: 1, color: colors.textDim, fontSize: 12, lineHeight: 18 },
  });