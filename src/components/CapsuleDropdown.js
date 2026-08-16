import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Modal, FlatList, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';

// Reusable capsule dropdown — one component for the Strength exercise
// picker, the Measurements body-part picker, and anywhere else needed.
// options: [{ value, label }]
export default function CapsuleDropdown({ value, options, onChange, placeholder = 'Select…', disabled = false }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <View>
      <TouchableOpacity
        style={[styles.capsule, disabled && { opacity: 0.5 }]}
        disabled={disabled || !options.length}
        onPress={() => setOpen(true)}
      >
        <Text style={[styles.capsuleText, !selected && { color: colors.textDim }]} numberOfLines={1}>
          {selected ? selected.label : placeholder}
        </Text>
        <Ionicons name="chevron-down" size={14} color={colors.textDim} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.sheet}>
            <FlatList
              data={options}
              keyExtractor={(o) => String(o.value)}
              style={{ maxHeight: 300 }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.option, item.value === value && styles.optionOn]}
                  onPress={() => {
                    onChange(item.value);
                    setOpen(false);
                  }}
                >
                  <Text style={[styles.optionText, item.value === value && { color: colors.primary, fontWeight: '700' }]}>
                    {item.label}
                  </Text>
                  {item.value === value && <Ionicons name="checkmark" size={16} color={colors.primary} />}
                </TouchableOpacity>
              )}
            />
            <TouchableOpacity style={styles.cancel} onPress={() => setOpen(false)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    capsule: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.cardLight,
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingVertical: 8,
      alignSelf: 'flex-start',
      maxWidth: 260,
    },
    capsuleText: { color: colors.text, fontSize: 13, fontWeight: '600' },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
    sheet: { backgroundColor: colors.card, borderRadius: 16, padding: 12 },
    option: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    optionOn: { backgroundColor: colors.cardLight },
    optionText: { color: colors.text, fontSize: 14 },
    cancel: { alignItems: 'center', padding: 12, marginTop: 4 },
    cancelText: { color: colors.textDim, fontWeight: '700' },
  });
