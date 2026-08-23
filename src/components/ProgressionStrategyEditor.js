import React, { useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';
import { listFormulas } from '../progressionFormulas';

// Shared formula picker + dynamic parameter form (Systems 4 & 5). The param
// form is generated from each formula's REAL paramSchema — numbers become
// numeric inputs (min/max enforced on blur), booleans become chips. Used by
// both the client's own settings and the trainer's per-client override —
// the only difference is who saves it.
//
// Props: value {formula_key, params} | onValueChange(next) | busy
export default function ProgressionStrategyEditor({ value, onValueChange, busy }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const formulas = listFormulas();

  const selected = useMemo(
    () => formulas.find((f) => f.key === value?.formula_key) || null,
    [value?.formula_key]
  );

  const setParam = (key, v) => {
    const next = { ...(value?.params || {}) };
    if (v === null) delete next[key];
    else next[key] = v;
    onValueChange({ formula_key: value?.formula_key, params: next });
  };

  // enforce min/max when the user leaves a numeric field
  const clampOnBlur = (p, raw) => {
    const n = parseFloat(raw);
    if (Number.isNaN(n)) return setParam(p.key, null); // back to default
    let v = n;
    if (p.min != null) v = Math.max(p.min, v);
    if (p.max != null) v = Math.min(p.max, v);
    setParam(p.key, v);
  };

  return (
    <View>
      <Text style={styles.sectionLabel}>FORMULA</Text>
      {formulas.map((f) => {
        const on = value?.formula_key === f.key;
        return (
          <TouchableOpacity
            key={f.key}
            style={[styles.formulaCard, on && styles.formulaCardOn]}
            onPress={() => onValueChange({ formula_key: f.key, params: {} })}
            disabled={busy}
            activeOpacity={0.7}
          >
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text style={[styles.formulaName, on && { color: colors.primary }]}>{f.displayName}</Text>
                {f.requiresTrainingMax && (
                  <Ionicons name="information-circle-outline" size={13} color={colors.yellow} />
                )}
              </View>
              <Text style={styles.formulaDesc}>{f.description}</Text>
            </View>
            {on && <Ionicons name="checkmark-circle" size={20} color={colors.primary} />}
          </TouchableOpacity>
        );
      })}

      {selected && (
        <View>
          <Text style={styles.sectionLabel}>PARAMETERS</Text>
          {(selected.paramSchema || []).map((p) => {
            const current = value?.params?.[p.key];
            const shown = current != null ? String(current) : '';
            return (
              <View key={p.key} style={styles.paramRow}>
                {p.type === 'boolean' ? (
                  <TouchableOpacity
                    style={styles.boolRow}
                    onPress={() => setParam(p.key, current === undefined || current === null ? !p.default : !current)}
                    disabled={busy}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.paramLabel}>{p.label}</Text>
                      <Text style={styles.paramHint}>
                        Default: {p.default ? 'On' : 'Off'}
                      </Text>
                    </View>
                    <View style={[styles.boolChip, current !== undefined && current !== null && styles.boolChipOn]}>
                      <Text style={[styles.boolChipText, current !== undefined && current !== null && { color: '#fff' }]}>
                        {(current !== undefined && current !== null ? current : p.default) ? 'ON' : 'OFF'}
                      </Text>
                    </View>
                  </TouchableOpacity>
                ) : (
                  <View style={styles.paramRowInner}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.paramLabel}>{p.label}</Text>
                      <Text style={styles.paramHint}>
                        Default {p.default}
                        {p.min != null || p.max != null ? ` · range ${p.min ?? '–'} to ${p.max ?? '–'}` : ''}
                      </Text>
                    </View>
                    <TextInput
                      style={styles.paramInput}
                      keyboardType="numeric"
                      value={shown}
                      placeholder={String(p.default)}
                      placeholderTextColor={colors.textDim}
                      onChangeText={(raw) => {
                        const next = { ...(value?.params || {}) };
                        if (raw === '') delete next[p.key];
                        else next[p.key] = parseFloat(raw) || 0;
                        onValueChange({ formula_key: value?.formula_key, params: next });
                      }}
                      onEndEditing={() => clampOnBlur(p, shown)}
                      editable={!busy}
                    />
                  </View>
                )}
              </View>
            );
          })}
          <Text style={styles.paramFootnote}>
            Leave a value empty to use its default.
          </Text>
        </View>
      )}

      {busy && <ActivityIndicator color={colors.primary} style={{ marginTop: 12 }} />}
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    sectionLabel: {
      color: colors.textDim, fontSize: 11, fontWeight: '800',
      letterSpacing: 1, textTransform: 'uppercase', marginTop: 14, marginBottom: 8,
    },
    formulaCard: {
      backgroundColor: colors.card, borderRadius: 12, padding: 12,
      marginBottom: 8, borderWidth: 1.5, borderColor: 'transparent',
    },
    formulaCardOn: { borderColor: colors.primary },
    formulaName: { color: colors.text, fontSize: 14, fontWeight: '700' },
    formulaDesc: { color: colors.textDim, fontSize: 11, marginTop: 3, lineHeight: 15 },
    paramRow: { backgroundColor: colors.card, borderRadius: 10, padding: 10, marginBottom: 8 },
    paramRowInner: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    paramLabel: { color: colors.text, fontSize: 13, fontWeight: '600' },
    paramHint: { color: colors.textDim, fontSize: 11, marginTop: 2 },
    paramInput: {
      backgroundColor: colors.cardLight, color: colors.text,
      borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8,
      width: 90, textAlign: 'center', fontSize: 14,
    },
    boolRow: { flexDirection: 'row', alignItems: 'center' },
    boolChip: {
      backgroundColor: colors.cardLight, borderRadius: 8,
      paddingHorizontal: 14, paddingVertical: 7,
    },
    boolChipOn: { backgroundColor: colors.primary },
    boolChipText: { color: colors.textDim, fontWeight: '800', fontSize: 11 },
    paramFootnote: { color: colors.textDim, fontSize: 10, fontStyle: 'italic' },
  });