import React from 'react';
import { View, Text, TouchableOpacity, Modal, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Presentational mid-session swap sheet: configured alternatives first
 * (one tap), then an ad-hoc picker entry point. Visibility is driven by
 * `swapEx` being non-null.
 */
export default function SwapSheet({
  swapEx,
  styles,
  colors,
  onClose,
  onSelectAlternative,
  onAdHocPicker,
}) {
  return (
    <Modal
      visible={!!swapEx}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.swapOverlay} onPress={onClose}>
        <View style={styles.swapSheet}>
          <Text style={styles.swapTitle}>Swap {swapEx?.name}</Text>
          <View style={styles.swapDivider} />
          {(swapEx?.alternatives || []).map((name) => (
            <TouchableOpacity
              key={name}
              style={styles.swapOption}
              onPress={() => onSelectAlternative(name)}
            >
              <Ionicons name="swap-horizontal" size={16} color={colors.primary} />
              <Text style={styles.swapOptionText}>{name}</Text>
            </TouchableOpacity>
          ))}
          <View style={styles.swapDivider} />
          <TouchableOpacity style={styles.swapOption} onPress={onAdHocPicker}>
            <Ionicons name="search" size={16} color={colors.blue} />
            <Text style={[styles.swapOptionText, styles.swapAdHocText]}>
              Choose a different exercise →
            </Text>
          </TouchableOpacity>
        </View>
      </Pressable>
    </Modal>
  );
}
