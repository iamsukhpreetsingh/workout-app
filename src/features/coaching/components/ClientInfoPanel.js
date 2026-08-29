import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../lib/api';
import { useColors } from '../../../theme';

// Compact expandable Client Information panel (collapsed by default) —
// surfaces what the app already collects about the client: profile basics,
// activity, goals, nutrition target (+ its source), dietary pattern and
// allergens (visually distinct — safety information). Read-only; no new
// data models, everything comes from the existing intake-profile and
// nutrition-targets endpoints.
export default function ClientInfoPanel({ clientId }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [open, setOpen] = useState(false); // §11: collapsed by default
  const [profile, setProfile] = useState(null);
  const [targets, setTargets] = useState(null);

  useEffect(() => {
    let mounted = true;
    api(`/trainer/clients/${clientId}/intake-profile`)
      .then((p) => mounted && setProfile(p || null))
      .catch(() => {});
    api(`/trainer/clients/${clientId}/nutrition-targets`)
      .then((t) => mounted && setTargets(t?.active || null))
      .catch(() => {});
    return () => { mounted = false; };
  }, [clientId]);

  const hasProfile = profile && (profile.completed_at || profile.age != null || profile.weight_kg != null);
  const ACTIVITY_LABELS = {
    sedentary: 'Sedentary', light: 'Lightly Active', moderate: 'Moderately Active',
    very: 'Very Active', extreme: 'Extremely Active',
  };
  const GOAL_LABELS = {
    weight_loss: 'Lose Weight', weight_maintenance: 'Maintain Weight',
    muscle_gain: 'Gain Muscle', recomposition: 'Recomposition', general_fitness: 'General Fitness',
  };

  const rows = [];
  const add = (label, value) => {
    if (value != null && value !== '') rows.push({ label, value: String(value) });
  };
  if (hasProfile) {
    add('Age', profile.age);
    add('Gender', profile.gender && profile.gender[0].toUpperCase() + profile.gender.slice(1));
    add('Height', profile.height_cm != null ? `${profile.height_cm} cm` : null);
    add('Weight', profile.weight_kg != null ? `${profile.weight_kg} kg` : null);
    add('Target weight', profile.target_weight_kg != null ? `${profile.target_weight_kg} kg` : null);
    add('Activity', profile.activity_level && ACTIVITY_LABELS[profile.activity_level]);
    add('Goal', profile.primary_goal && GOAL_LABELS[profile.primary_goal]);
    add('Dietary pattern', profile.dietary_pattern);
  }

  return (
    <View style={styles.card}>
      <TouchableOpacity style={styles.head} onPress={() => setOpen((v) => !v)} activeOpacity={0.7}>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={13} color={colors.textDim} />
        <Text style={styles.title}>Client Information</Text>
      </TouchableOpacity>
      {open && (
        <View style={styles.body}>
          {rows.map((r) => (
            <View key={r.label} style={styles.row}>
              <Text style={styles.label}>{r.label}</Text>
              <Text style={styles.value}>{r.value}</Text>
            </View>
          ))}

          {/* nutrition target — active values + SOURCE (§9/§22) */}
          {targets ? (
            <View style={styles.targetBox}>
              <Text style={styles.subTitle}>Nutrition Target</Text>
              <Text style={styles.targetLine}>
                {Number(targets.calories).toLocaleString()} kcal · P {targets.protein_g}g · C {targets.carbs_g}g · F {targets.fat_g}g
              </Text>
              <Text style={styles.targetSource}>
                {targets.target_source === 'trainer_override'
                  ? 'Source: trainer assigned'
                  : targets.target_source === 'self'
                  ? 'Source: set by client'
                  : 'Source: automatically calculated'}
              </Text>
            </View>
          ) : (
            <Text style={styles.dim}>No nutrition target set.</Text>
          )}

          {/* allergens — visually distinct (§10) */}
          {(profile?.allergens || []).length > 0 && (
            <View style={styles.allergenBox}>
              {profile.allergens.map((a) => (
                <View key={a} style={styles.allergenChip}>
                  <Ionicons name="warning" size={10} color={colors.red} />
                  <Text style={styles.allergenText}>{a}</Text>
                </View>
              ))}
            </View>
          )}

          {(profile?.food_preferences || []).length > 0 && (
            <View style={styles.row}>
              <Text style={styles.label}>Food preferences</Text>
              <Text style={styles.value}>{profile.food_preferences.join(', ')}</Text>
            </View>
          )}
          {(profile?.foods_avoided || []).length > 0 && (
            <View style={styles.row}>
              <Text style={styles.label}>Foods avoided</Text>
              <Text style={styles.value}>{profile.foods_avoided.join(', ')}</Text>
            </View>
          )}
          {(profile?.goals || []).length > 0 && (
            <View style={styles.row}>
              <Text style={styles.label}>Training goals</Text>
              <Text style={styles.value}>{profile.goals.join(', ')}</Text>
            </View>
          )}
          {profile?.injuries ? (
            <View style={styles.row}>
              <Text style={styles.label}>Injuries</Text>
              <Text style={styles.value}>{profile.injuries}</Text>
            </View>
          ) : null}
          {profile?.medical_conditions ? (
            <View style={styles.row}>
              <Text style={styles.label}>Medical</Text>
              <Text style={styles.value}>{profile.medical_conditions}</Text>
            </View>
          ) : null}
          {!hasProfile && <Text style={styles.dim}>Client hasn't completed their nutrition profile yet.</Text>}
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.cardLight, borderRadius: 12,
      borderWidth: 1, borderColor: colors.border,
      paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12,
    },
    head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    title: { color: colors.text, fontWeight: '800', fontSize: 13, flex: 1 },
    body: { marginTop: 8, gap: 4 },
    row: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
    label: { color: colors.textDim, fontSize: 12 },
    value: { color: colors.text, fontSize: 12, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
    targetBox: {
      backgroundColor: colors.card, borderRadius: 10, padding: 10, marginTop: 4,
    },
    subTitle: { color: colors.textDim, fontSize: 10, fontWeight: '800', textTransform: 'uppercase', letterSpacing: 0.5 },
    targetLine: { color: colors.text, fontSize: 13, fontWeight: '700', marginTop: 3 },
    targetSource: { color: colors.textDim, fontSize: 11, marginTop: 2, fontStyle: 'italic' },
    allergenBox: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
    allergenChip: {
      flexDirection: 'row', alignItems: 'center', gap: 4,
      borderWidth: 1, borderColor: colors.red, borderRadius: 7,
      paddingHorizontal: 7, paddingVertical: 3,
    },
    allergenText: { color: colors.red, fontSize: 11, fontWeight: '700' },
    dim: { color: colors.textDim, fontSize: 12, fontStyle: 'italic' },
  });
