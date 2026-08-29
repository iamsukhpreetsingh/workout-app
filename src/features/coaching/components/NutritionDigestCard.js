import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, TextInput, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../lib/api';
import { useColors } from '../../../theme';

const NUMS = { fontVariant: ['tabular-nums'] };

// Trend-based trainer digest for a client's nutrition (Phase 7): weekly
// average vs target, plain-language trend lines, logging consistency, and
// the two real coaching levers — Adjust Target and View Log. Deliberately
// NO meal-by-meal compliance percentage anywhere.
export default function NutritionDigestCard({ clientId, clientName }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [digest, setDigest] = useState(null);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [logRows, setLogRows] = useState(null);
  const [form, setForm] = useState({ calories: '', protein_g: '', carbs_g: '', fat_g: '', note: '' });
  const [busy, setBusy] = useState(false);

  const load = () =>
    api(`/trainer/clients/${clientId}/nutrition-digest?days=7`)
      .then((d) => {
        setDigest(d);
        if (d?.target) {
          setForm((f) => ({
            ...f,
            calories: String(d.target.calories ?? ''),
            protein_g: String(d.target.protein_g ?? ''),
            carbs_g: String(d.target.carbs_g ?? ''),
            fat_g: String(d.target.fat_g ?? ''),
          }));
        }
      })
      .catch(() => {});

  useEffect(() => { load(); }, [clientId]);

  const openLog = async () => {
    setLogOpen((v) => !v);
    if (!logOpen && logRows == null) {
      try {
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
        setLogRows(await api(`/trainer/clients/${clientId}/food-diary?from=${from}&to=${to}`));
      } catch {
        setLogRows([]);
      }
    }
  };

  const saveTarget = async () => {
    if (busy) return;
    const calories = Number(form.calories);
    if (!calories || calories < 1000 || calories > 6000) return; // silent guard
    setBusy(true);
    try {
      await api(`/trainer/clients/${clientId}/nutrition-targets/override`, {
        method: 'POST',
        body: {
          calories,
          protein_g: Number(form.protein_g) || 0,
          carbs_g: Number(form.carbs_g) || 0,
          fat_g: Number(form.fat_g) || 0,
          note: form.note.trim() || null,
        },
      });
      setAdjustOpen(false);
      setForm((f) => ({ ...f, note: '' }));
      await load();
    } catch {}
    setBusy(false);
  };

  if (!digest) return null;
  const s = digest.summary;
  const t = digest.target;

  return (
    <View style={styles.card}>
      <Text style={styles.title}>{clientName || 'Client'}'s Nutrition</Text>

      {t ? (
        <>
          <Text style={[styles.avgLine, NUMS]}>
            This week: {s.avgCalories != null ? s.avgCalories.toLocaleString() : '—'} avg /{' '}
            {Number(t.calories).toLocaleString()} target
          </Text>
          {s.calorieSummary ? (
            <View style={styles.statusRow}>
              <Ionicons
                name={s.withinTolerance ? 'checkmark-circle' : 'trending-down'}
                size={15}
                color={s.withinTolerance ? colors.green : colors.orange}
              />
              <Text style={[styles.statusText, { color: s.withinTolerance ? colors.green : colors.orange }]}>
                {s.calorieSummary.charAt(0).toUpperCase() + s.calorieSummary.slice(1)}
              </Text>
            </View>
          ) : null}
          <Text style={[styles.metaLine, NUMS]}>
            Logged {s.loggedDays} of {s.totalDays} days this week
            {t.target_mode === 'weekly_average' ? ' · weekly-average mode' : ''}
          </Text>
          {s.notLoggedDow.length > 0 && (
            <Text style={styles.gapNote}>Not logged: {s.notLoggedDow.join(', ')}</Text>
          )}
        </>
      ) : (
        <Text style={styles.metaLine}>
          No nutrition targets set
          {digest.profile_complete ? '' : ' — client profile incomplete, no recommendation available'}.
        </Text>
      )}

      {s?.notes?.map((n, i) => (
        <Text key={i} style={styles.trendNote}>• {n} — consider a check-in</Text>
      ))}
      {digest.recommendation_drift && (
        <Text style={styles.trendNote}>• Client profile changed — the app's new recommendation differs from the current target.</Text>
      )}

      <View style={styles.actionsRow}>
        <TouchableOpacity style={styles.actionBtn} onPress={() => setAdjustOpen((v) => !v)}>
          <Text style={styles.actionText}>Adjust Target</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={openLog}>
          <Text style={styles.actionText}>{logOpen ? 'Hide Log' : 'View Log'}</Text>
        </TouchableOpacity>
      </View>

      {adjustOpen && (
        <View style={styles.adjustBox}>
          <View style={styles.grid}>
            {[['calories', 'Cal'], ['protein_g', 'P (g)'], ['carbs_g', 'C (g)'], ['fat_g', 'F (g)']].map(([k, label]) => (
              <View key={k} style={styles.cell}>
                <Text style={styles.label}>{label}</Text>
                <TextInput
                  style={[styles.input, NUMS]}
                  keyboardType="numeric"
                  value={form[k]}
                  onChangeText={(v) => setForm((f) => ({ ...f, [k]: v.replace(/[^0-9.]/g, '') }))}
                />
              </View>
            ))}
          </View>
          <TextInput
            style={styles.noteInput}
            placeholder="Reason (optional) — e.g. Reduced calories for the next 2 weeks"
            placeholderTextColor={colors.textDim}
            value={form.note}
            onChangeText={(v) => setForm((f) => ({ ...f, note: v }))}
            multiline
          />
          <TouchableOpacity style={styles.saveBtn} onPress={saveTarget} disabled={busy}>
            <Text style={styles.saveText}>{busy ? 'Saving…' : 'Save Trainer Targets'}</Text>
          </TouchableOpacity>
        </View>
      )}

      {logOpen && (
        <ScrollView style={styles.logBox} nestedScrollEnabled>
          {logRows == null ? (
            <Text style={styles.metaLine}>Loading…</Text>
          ) : logRows.length === 0 ? (
            <Text style={styles.metaLine}>No food logged in the last 14 days.</Text>
          ) : (
            logRows.map((e) => (
              <View key={e.id} style={styles.logRow}>
                <Text style={styles.logName}>{e.name}</Text>
                <Text style={[styles.logMeta, NUMS]}>
                  {String(e.log_date).slice(5)} · {e.meal_type} ·{' '}
                  {e.calories != null ? `${Math.round(e.calories)} cal` : '—'}
                  {e.quantity && Number(e.quantity) !== 1 ? ` · ${e.quantity} ${e.serving_unit || ''}` : ''}
                </Text>
              </View>
            ))
          )}
          <Text style={styles.readonlyNote}>Read-only — the client owns this diary.</Text>
        </ScrollView>
      )}
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.card, borderRadius: 14, padding: 14, marginBottom: 12,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    title: { color: colors.text, fontSize: 15, fontWeight: '800' },
    avgLine: { color: colors.text, fontSize: 15, fontWeight: '800', marginTop: 6 },
    statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
    statusText: { fontSize: 13, fontWeight: '800' },
    metaLine: { color: colors.textDim, fontSize: 12, marginTop: 4 },
    gapNote: { color: colors.orange, fontSize: 12, fontWeight: '700', marginTop: 3 },
    trendNote: { color: colors.textDim, fontSize: 12, marginTop: 5, lineHeight: 17 },
    actionsRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
    actionBtn: {
      flex: 1, alignItems: 'center', paddingVertical: 10,
      borderRadius: 11, borderWidth: 1.2, borderColor: colors.primary,
    },
    actionText: { color: colors.primary, fontWeight: '800', fontSize: 12 },
    adjustBox: { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 },
    grid: { flexDirection: 'row', gap: 8, marginBottom: 8 },
    cell: { flex: 1 },
    label: { color: colors.textDim, fontSize: 10, marginBottom: 3, textAlign: 'center' },
    input: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 8,
      paddingHorizontal: 6, paddingVertical: 8, textAlign: 'center', fontSize: 13,
    },
    noteInput: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 10,
      paddingHorizontal: 11, paddingVertical: 9, minHeight: 44, fontSize: 12,
      marginBottom: 8, textAlignVertical: 'top',
    },
    saveBtn: { backgroundColor: colors.primary, borderRadius: 11, padding: 12, alignItems: 'center' },
    saveText: { color: '#fff', fontWeight: '800', fontSize: 13 },
    logBox: { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 8, maxHeight: 260 },
    logRow: { paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
    logName: { color: colors.text, fontSize: 13, fontWeight: '700' },
    logMeta: { color: colors.textDim, fontSize: 11, marginTop: 1 },
    readonlyNote: { color: colors.textDim, fontSize: 10, fontStyle: 'italic', textAlign: 'center', paddingVertical: 8 },
  });
