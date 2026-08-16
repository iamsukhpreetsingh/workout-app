import React, { useState } from 'react';
import { Modal, View, Text, TouchableOpacity, TextInput } from 'react-native';;
import { useColors } from '../theme';

const PRESETS = [30, 60, 90, 120, 180];

// Edit an exercise's rest time.
export default function RestEditorModal({ visible, exerciseName, initial, onClose, onSave }) {
  const colors = useColors();
  const [custom, setCustom] = useState('');

  const styles = {
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 },
    sheet: { backgroundColor: colors.card, borderRadius: 16, padding: 20 },
    title: { color: colors.text, fontSize: 18, fontWeight: '800' },
    sub: { color: colors.textDim, fontSize: 13, marginTop: 2, marginBottom: 14 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    chip: { backgroundColor: colors.cardLight, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 10 },
    chipActive: { backgroundColor: colors.primary },
    chipText: { color: colors.text, fontWeight: '600' },
    chipTextActive: { color: '#fff' },
    customRow: { flexDirection: 'row', gap: 8, marginTop: 14 },
    input: {
      flex: 1,
      backgroundColor: colors.cardLight,
      color: colors.text,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    customBtn: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 18, justifyContent: 'center' },
    customBtnText: { color: '#fff', fontWeight: '700' },
  };

  if (!visible) return null;
  const save = (secs) => {
    onSave(Math.max(5, Math.min(1800, Math.round(secs))));
    onClose();
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Rest time</Text>
          <Text style={styles.sub} numberOfLines={1}>{exerciseName}</Text>
          <View style={styles.chips}>
            {PRESETS.map((p) => (
              <TouchableOpacity
                key={p}
                style={[styles.chip, initial === p && styles.chipActive]}
                onPress={() => save(p)}
              >
                <Text style={[styles.chipText, initial === p && styles.chipTextActive]}>{p}s</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.customRow}>
            <TextInput
              style={styles.input}
              keyboardType="numeric"
              placeholder="Custom seconds"
              placeholderTextColor={colors.textDim}
              value={custom}
              onChangeText={setCustom}
            />
            <TouchableOpacity
              style={styles.customBtn}
              onPress={() => custom && save(parseInt(custom, 10))}
            >
              <Text style={styles.customBtnText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
