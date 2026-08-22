import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, BackHandler } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import { isRestoreNeeded, performRestore } from '../lib/restore';

// Full-screen, NON-DISMISSIBLE restore progress (System 5). The user must
// not enter an app that's about to have data appear underneath them
// mid-use. Hardware back is blocked; the only exits are completion or an
// explicit Retry after failure. Partial data from a failed attempt is
// harmless — retry re-upserts over it.
export default function RestoreScreen({ onFinished }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [phase, setPhase] = useState('checking'); // checking | restoring | error
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  const run = async () => {
    setPhase('checking');
    setError(null);
    setProgress(null);
    try {
      if (!(await isRestoreNeeded())) return onFinished();
      setPhase('restoring');
      await performRestore(setProgress);
      onFinished();
    } catch (e) {
      setError(e.message || 'Restore failed. Check your connection and try again.');
      setPhase('error');
    }
  };

  useEffect(() => {
    run();
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.overlay}>
      {phase === 'checking' && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.title}>Checking for cloud backup…</Text>
        </View>
      )}

      {phase === 'restoring' && (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.title}>Restoring your data</Text>
          {progress && (
            <Text style={styles.step}>
              Step {progress.index} of {progress.total}: {progress.step}
            </Text>
          )}
          {progress?.detail ? <Text style={styles.detail}>{progress.detail}</Text> : null}
          <Text style={styles.hint}>Keep the app open — this only happens once.</Text>
        </View>
      )}

      {phase === 'error' && (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.textDim} />
          <Text style={styles.title}>Restore incomplete</Text>
          <Text style={styles.step}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={run}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    overlay: {
      position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
      backgroundColor: colors.bg, justifyContent: 'center',
    },
    center: { alignItems: 'center', padding: 32 },
    title: { color: colors.text, fontSize: 18, fontWeight: '800', marginTop: 16 },
    step: { color: colors.textDim, fontSize: 14, marginTop: 8, textAlign: 'center' },
    detail: { color: colors.primary, fontSize: 13, fontWeight: '700', marginTop: 6 },
    hint: { color: colors.textDim, fontSize: 12, fontStyle: 'italic', marginTop: 18 },
    retryBtn: {
      backgroundColor: colors.primary, borderRadius: 12, paddingHorizontal: 32,
      paddingVertical: 13, marginTop: 22,
    },
    retryText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  });