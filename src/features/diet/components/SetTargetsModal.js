import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../lib/api';
import { useColors } from '../../../theme';

const NUMS = { fontVariant: ['tabular-nums'] };

// Targets overlay (Phase 5) — client side. Shows the active target + its
// source, the app's calculated recommendation (when the profile supports
// one), and lets the user set their own targets (source 'self') with a
// daily or rolling weekly-average mode. No target is a completely valid
// state: pure counting, no goals.
export default function SetTargetsModal({ visible, onClose, target, onSaved }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [rec, setRec] = useState(null); // app recommendation
  const [mode, setMode] = useState('daily');
  const [form, setForm] = useState({ calories: '', protein_g: '', carbs_g: '', fat_g: '', tolerance_pct: '10' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setMode(target?.target_mode === 'weekly_average' ? 'weekly_average' : 'daily');
    setForm({
      calories: target?.calories != null ? String(target.calories) : '',
      protein_g: target?.protein_g != null ? String(target.protein_g) : '',
      carbs_g: target?.carbs_g != null ? String(target.carbs_g) : '',
      fat_g: target?.fat_g != null ? String(target.fat_g) : '',
      tolerance_pct: String(target?.tolerance_pct ?? 10),
    });
    api('/client/nutrition-targets')
      .then((t) => setRec(t?.recommendation || null))
      .catch(() => setRec(null));
  }, [visible, target]);

  const save = async (override) => {
    if (busy) return;
    const f = override
      ? {
          calories: String(override.calories), protein_g: String(override.protein_g),
          carbs_g: String(override.carbs_g), fat_g: String(override.fat_g),
          tolerance_pct: form.tolerance_pct,
        }
      : form;
    const calories = Number(f.calories);
    if (!calories || calories < 1000 || calories > 6000) {
      return Alert.alert('Invalid calories', 'Enter a calorie target between 1000 and 6000, or remove your target by leaving it unset.');
    }
    const macros = [f.protein_g, f.carbs_g, f.fat_g].map((v) => Number(v));
    if (macros.some((v) => !isFinite(v) || v < 0 || v > 1000)) {
      return Alert.alert('Invalid macros', 'Protein, carbs and fat must be between 0 and 1000 g.');
    }
    setBusy(true);
    try {
      await api('/client/nutrition-targets/self', {
        method: 'POST',
        body: {
          calories,
          protein_g: macros[0], carbs_g: macros[1], fat_g: macros[2],
          tolerance_pct: Number(f.tolerance_pct) || 10,
          target_mode: mode,
        },
      });
      onSaved?.({
        calories, protein_g: macros[0], carbs_g: macros[1], fat_g: macros[2],
        target_source: 'self', set_by: 'self', target_mode: mode,
        tolerance_pct: Number(f.tolerance_pct) || 10,
      });
      onClose();
    } catch (e) {
      Alert.alert('Could not save targets', e.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.wrap}>
        <View style={styles.sheet}>
          <Text style={styles.title}>Nutrition Targets</Text>

          {target ? (
            <Text style={styles.sourceLine}>
              Current: {Number(target.calories).toLocaleString()} kcal/day ·{' '}
              {target.target_source === 'trainer_override'
                ? 'set by your trainer'
                : target.target_source === 'self'
                ? 'set by you'
                : 'automatically calculated'}
            </Text>
          ) : (
            <Text style={styles.sourceLine}>No target set — plain calorie counting.</Text>
          )}

          {rec && (
            <TouchableOpacity style={styles.recoCard} onPress={() => save(rec)}>
              <Ionicons name="calculator-outline" size={14} color={colors.primary} />
              <Text style={styles.recoText} numberOfLines={1}>
                Calculated from your profile: {rec.calories.toLocaleString()} kcal · {rec.protein_g}P · {rec.carbs_g}C · {rec.fat_g}F — tap to use
              </Text>
            </TouchableOpacity>
          )}

          <View style={styles.modeRow}>
            {[
              { key: 'daily', label: 'Daily target' },
              { key: 'weekly_average', label: 'Weekly average' },
            ].map((m) => (
              <TouchableOpacity key={m.key} style={[styles.modeBtn, mode === m.key && styles.modeBtnOn]} onPress={() => setMode(m.key)}>
                <Text style={[styles.modeText, mode === m.key && { color: '#fff' }]}>{m.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.modeHint}>
            {mode === 'daily'
              ? 'Each day is compared against the target.'
              : 'Your rolling 7-day average is compared against the target — flexible days balance out.'}
          </Text>

          <View style={styles.grid}>
            {[['calories', 'Calories'], ['protein_g', 'Protein (g)'], ['carbs_g', 'Carbs (g)'], ['fat_g', 'Fat (g)'], ['tolerance_pct', 'Tolerance (%)']].map(([k, label]) => (
              <View key={k} style={styles.cell}>
                <Text style={styles.label}>{label}</Text>
                <TextInput
                  style={[styles.input, NUMS]}
                  keyboardType="numeric"
                  value={form[k]}
                  onChangeText={(v) => setForm((f) => ({ ...f, [k]: v.replace(/[^0-9.]/g, '') }))}
                  placeholder="—"
                  placeholderTextColor={colors.textDim}
                />
              </View>
            ))}
          </View>

          <TouchableOpacity style={styles.primaryBtn} onPress={() => save()} disabled={busy}>
            <Text style={styles.primaryBtnText}>{busy ? 'Saving…' : 'Save Targets'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    wrap: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18 },
    title: { color: colors.text, fontSize: 17, fontWeight: '800', marginBottom: 6 },
    sourceLine: { color: colors.textDim, fontSize: 12, marginBottom: 10 },
    recoCard: {
      flexDirection: 'row', alignItems: 'center', gap: 8,
      backgroundColor: colors.cardLight, borderRadius: 10, padding: 10, marginBottom: 12,
    },
    recoText: { color: colors.text, fontSize: 11, flex: 1 },
    modeRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
    modeBtn: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, backgroundColor: colors.cardLight },
    modeBtnOn: { backgroundColor: colors.primary },
    modeText: { color: colors.textDim, fontWeight: '800', fontSize: 12 },
    modeHint: { color: colors.textDim, fontSize: 11, marginBottom: 12, lineHeight: 15 },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
    cell: { width: '31%' },
    label: { color: colors.textDim, fontSize: 10, marginBottom: 3 },
    input: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 8,
      paddingHorizontal: 8, paddingVertical: 8, textAlign: 'center', fontSize: 14,
    },
    primaryBtn: { backgroundColor: colors.primary, borderRadius: 12, padding: 13, alignItems: 'center', marginTop: 4 },
    primaryBtnText: { color: '#fff', fontWeight: '800' },
    cancelBtn: { alignItems: 'center', padding: 10 },
    cancelText: { color: colors.textDim, fontWeight: '700' },
  });
