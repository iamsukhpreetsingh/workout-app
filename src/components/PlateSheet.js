import React from 'react';
import { Modal, View, Text } from 'react-native';
import { useColors } from '../theme';
import { plateBreakdown } from '../lib/plates';

// Bottom sheet showing the per-side plate breakdown for a target weight.
export default function PlateSheet({ visible, weight, unit, barWeight, plates, onClose }) {
  const colors = useColors();

  const styles = {
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: colors.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 22, paddingBottom: 34 },
    title: { color: colors.text, fontSize: 18, fontWeight: '800', marginBottom: 10 },
    dim: { color: colors.textDim, marginBottom: 8 },
    warn: { color: '#ffb340', marginTop: 8 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    plate: { backgroundColor: colors.cardLight, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 8 },
    plateText: { color: colors.text, fontWeight: '700' },
  };

  if (!visible) return null;
  const w = parseFloat(weight);
  const result = plateBreakdown(w, barWeight, plates);
  const fmt = (n) => (Number.isInteger(n) ? String(n) : String(n));

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.backdrop} onTouchEnd={onClose}>
        <View style={styles.sheet} onTouchEnd={(e) => e.stopPropagation()}>
          <Text style={styles.title}>
            {isNaN(w) ? 'Plates' : `${w} ${unit} breakdown`}
          </Text>
          {result.error && <Text style={styles.dim}>Enter a weight first.</Text>}
          {result.belowBar && (
            <Text style={styles.warn}>Below bar weight ({barWeight} {unit}) — no plates needed.</Text>
          )}
          {result.perSide?.length > 0 && (
            <>
              <Text style={styles.dim}>
                Bar: {barWeight} {unit} · per side:
              </Text>
              <View style={styles.row}>
                {result.perSide.map((p) => (
                  <View key={p.size} style={styles.plate}>
                    <Text style={styles.plateText}>
                      {p.count} × {fmt(p.size)}
                    </Text>
                  </View>
                ))}
              </View>
              {!result.exact && (
                <Text style={styles.warn}>
                  +{result.leftover} {unit} per side short — no smaller plates available.
                </Text>
              )}
            </>
          )}
          {!result.belowBar && result.perSide?.length === 0 && !result.error && (
            <Text style={styles.dim}>Empty bar.</Text>
          )}
        </View>
      </View>
    </Modal>
  );
}
