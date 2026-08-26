import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../../theme';

/**
 * Full-area fallback shown when a screen's initial data load fails.
 * Renders centered icon + message + optional Retry button.
 *
 * @param {{message?: string, onRetry?: () => void}} props
 */
export default function LoadError({ message = "Couldn't load your data.", onRetry }) {
  const colors = useColors();
  return (
    <View style={styles.wrap}>
      <Ionicons name="cloud-offline-outline" size={36} color={colors.textDim} />
      <Text style={[styles.msg, { color: colors.text }]}>{message}</Text>
      {!!onRetry && (
        <TouchableOpacity
          onPress={onRetry}
          style={[styles.btn, { borderColor: colors.primary }]}
          activeOpacity={0.7}
        >
          <Text style={[styles.btnText, { color: colors.primary }]}>Retry</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 28,
  },
  msg: {
    fontSize: 14,
    marginTop: 12,
    textAlign: 'center',
  },
  btn: {
    marginTop: 18,
    borderWidth: 1.5,
    borderRadius: 10,
    paddingHorizontal: 22,
    paddingVertical: 9,
  },
  btnText: {
    fontWeight: '700',
    fontSize: 14,
  },
});
