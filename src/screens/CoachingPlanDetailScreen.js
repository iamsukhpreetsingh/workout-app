import React, { useCallback, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Alert, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../lib/api';
import { useColors } from '../theme';

// Trainer view of a diet/supplement plan: item list + adherence strip
// (last 28 days, neutral for no check-in) + archive action.
export default function CoachingPlanDetailScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { planId, kind, clientId, clientName } = route.params || {};
  const seg = kind === 'diet' ? 'diet-plans' : 'supplement-plans';
  const [plan, setPlan] = useState(null);
  const [checkins, setCheckins] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, cis] = await Promise.all([
        api(`/trainer/clients/${clientId}/${seg}/${planId}`),
        api(`/trainer/clients/${clientId}/${seg}/${planId}/checkins`).catch(() => []),
      ]);
      setPlan(p);
      setCheckins(cis);
      navigation.setOptions({ title: p.name || 'Plan' });
    } catch (e) {
      Alert.alert('Could not load plan', e.message || 'Please try again.', [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    }
  }, [clientId, seg, planId, navigation]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const confirmArchive = () =>
    Alert.alert(
      'Archive plan',
      `"${plan.name}" will be removed from ${clientName || 'your client'}'s active plans.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await api(`/trainer/clients/${clientId}/${seg}/${planId}`, {
                method: 'PATCH',
                body: { status: 'archived' },
              });
              navigation.goBack();
            } catch (e) {
              Alert.alert('Could not archive', e.message || 'Please try again.');
            } finally {
              setBusy(false);
            }
          },
        },
      ]
    );

  if (!plan) {
    return (
      <View style={[styles.container, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const doneCol = kind === 'diet' ? 'followed' : 'taken';
  const byDay = new Map(checkins.map((c) => [c.date.slice(0, 10), c[doneCol]]));
  const days = Array.from({ length: 28 }, (_, i) => {
    const d = new Date(Date.now() - (27 - i) * 86400000);
    const key = d.toISOString().slice(0, 10);
    return { key, day: d.getDate(), state: byDay.has(key) ? (byDay.get(key) ? 'yes' : 'no') : 'none' };
  });
  const followed = days.filter((d) => d.state === 'yes').length;
  const checkedIn = days.filter((d) => d.state !== 'none').length;

  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      <Text style={styles.name}>{plan.name}</Text>
      <Text style={styles.sub}>
        {kind === 'diet' ? 'Diet' : 'Supplement'} plan for {clientName || 'client'} ·{' '}
        {new Date(plan.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
      </Text>
      {plan.notes ? <Text style={styles.notes}>{plan.notes}</Text> : null}

      {/* Diet renders the nested day → meal → item chart; supplements flat */}
      {kind === 'diet'
        ? (plan.days || []).map((d, di) => (
            <View key={d.id || di}>
              <Text style={[styles.groupLabel, { marginTop: di === 0 ? 8 : 16 }]}>{d.day_label}</Text>
              {(d.meals || []).map((m, mi) => (
                <View key={m.id || mi} style={styles.card}>
                  <Text style={styles.mealTypeLabel}>{String(m.meal_type).toUpperCase()}</Text>
                  {m.slot_note ? <Text style={styles.itemDesc}>{m.slot_note}</Text> : null}
                  {(m.items || []).map((it, ii) => (
                    <View key={it.id || ii} style={styles.nestedItem}>
                      <Text style={styles.itemTitle} numberOfLines={1}>
                        {it.name}
                        {(it.quantity_multiplier || 1) !== 1 ? ` · ${it.quantity_multiplier}x` : ''}
                      </Text>
                      <Text style={styles.itemDesc}>
                        {it.calories != null ? `${it.calories} cal` : ''}
                        {it.protein_g != null ? ` · ${Math.round(it.protein_g)}P` : ''}
                        {it.carbs_g != null ? ` ${Math.round(it.carbs_g)}C` : ''}
                        {it.fat_g != null ? ` ${Math.round(it.fat_g)}F` : ''}
                      </Text>
                      {it.client_note ? (
                        <Text style={styles.clientNote}>Note: {it.client_note}</Text>
                      ) : null}
                    </View>
                  ))}
                </View>
              ))}
            </View>
          ))
        : (plan.items || []).map((item, i) => (
            <View key={item.id || i} style={styles.card}>
              <View style={styles.rowHeader}>
                <View style={styles.idxBadge}>
                  <Text style={styles.idxText}>{i + 1}</Text>
                </View>
                <Text style={styles.itemTitle}>{item.supplement_name}</Text>
                {item.dosage ? (
                  <View style={styles.doseChip}>
                    <Text style={styles.doseText}>{item.dosage}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={styles.itemDesc}>
                {[item.timing, item.notes].filter(Boolean).join(' · ')}
              </Text>
            </View>
          ))}

      {/* adherence strip — neutral for days with no check-in */}
      <Text style={styles.groupLabel}>Adherence — last 4 weeks</Text>
      <View style={styles.card}>
        <View style={styles.stripRow}>
          {days.map((d) => (
            <View
              key={d.key}
              style={[
                styles.stripCell,
                d.state === 'yes' && styles.stripYes,
                d.state === 'no' && styles.stripNo,
              ]}
            >
              <Text style={[styles.stripText, d.state === 'none' && { color: colors.textDim }]}>{d.day}</Text>
            </View>
          ))}
        </View>
        <Text style={styles.stripLegend}>
          {followed} / {checkedIn} check-in days followed · grey = no check-in
        </Text>
      </View>

      <TouchableOpacity style={styles.archiveBtn} onPress={confirmArchive} disabled={busy}>
        <Ionicons name="archive-outline" size={16} color={colors.red} />
        <Text style={styles.archiveText}>Archive Plan</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    name: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.4 },
    sub: { color: colors.textDim, marginTop: 4, fontSize: 13 },
    notes: { color: colors.textDim, marginTop: 8, marginBottom: 8, fontSize: 13, fontStyle: 'italic' },

    groupLabel: {
      color: colors.textDim, fontSize: 12, fontWeight: '800',
      letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10, marginTop: 8,
    },
    card: {
      backgroundColor: colors.card, borderRadius: 14, padding: 12, marginBottom: 8,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    idxBadge: {
      width: 26, height: 26, borderRadius: 8, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    idxText: { color: colors.primary, fontWeight: '800', fontSize: 12 },
    itemTitle: { color: colors.text, fontWeight: '700', fontSize: 15, flex: 1 },
    doseChip: {
      backgroundColor: colors.cardLight, borderRadius: 8,
      paddingHorizontal: 8, paddingVertical: 4,
    },
    doseText: { color: colors.textDim, fontSize: 11, fontWeight: '600' },
    itemDesc: { color: colors.textDim, fontSize: 13, marginTop: 6 },
    mealTypeLabel: { color: colors.textDim, fontSize: 11, fontWeight: '800', letterSpacing: 1, marginBottom: 6 },
    nestedItem: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 8, paddingTop: 8 },
    clientNote: { color: colors.yellow, fontSize: 11, fontStyle: 'italic', marginTop: 3 },

    stripRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
    stripCell: {
      width: 28, height: 28, borderRadius: 8, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    stripYes: { backgroundColor: colors.green },
    stripNo: { backgroundColor: colors.red, opacity: 0.75 },
    stripText: { color: '#fff', fontSize: 10, fontWeight: '700' },
    stripLegend: { color: colors.textDim, fontSize: 11, marginTop: 10 },

    archiveBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      marginTop: 32, paddingVertical: 12, borderRadius: 12, borderWidth: 1,
      borderColor: colors.red, opacity: 0.85,
    },
    archiveText: { color: colors.red, fontWeight: '700', fontSize: 14 },
  });
