import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';

// One-time-per-device mode selection for trainer accounts. Two equally
// weighted cards; trainer accent for Trainer View, default accent for User
// View — same color language as the trainer/self-made coding everywhere else.
export default function ViewChoiceScreen({ userName, onChoose }) {
  const colors = useColors();
  const styles = makeStyles(colors);

  const cards = [
    {
      mode: 'trainer',
      icon: 'people',
      label: 'Trainer View',
      sub: 'Manage your clients',
      accent: colors.blue,
    },
    {
      mode: 'user',
      icon: 'barbell',
      label: 'User View',
      sub: 'Log your own workouts',
      accent: colors.primary,
    },
  ];

  return (
    <View style={styles.container}>
      <Text style={styles.welcome}>Welcome, {userName || 'Coach'}</Text>
      <Text style={styles.question}>How do you want to use the app today?</Text>

      <View style={styles.cardWrap}>
        {cards.map((c) => (
          <TouchableOpacity
            key={c.mode}
            style={[styles.card, { borderColor: c.accent }]}
            activeOpacity={0.85}
            onPress={() => onChoose(c.mode)}
          >
            <View style={[styles.iconWrap, { backgroundColor: c.accent }]}>
              <Ionicons name={c.icon} size={26} color="#fff" />
            </View>
            <Text style={styles.cardLabel}>{c.label}</Text>
            <Text style={styles.cardSub}>{c.sub}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center', padding: 28 },
    welcome: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.4 },
    question: { color: colors.textDim, fontSize: 14, marginTop: 8, marginBottom: 32 },
    cardWrap: { alignSelf: 'stretch', gap: 14 },
    card: {
      borderWidth: 2,
      borderRadius: 18,
      padding: 20,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      backgroundColor: colors.card,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.18,
      shadowRadius: 12,
      elevation: 4,
    },
    iconWrap: {
      width: 52, height: 52, borderRadius: 16,
      alignItems: 'center', justifyContent: 'center',
    },
    cardLabel: { color: colors.text, fontSize: 18, fontWeight: '800' },
    cardSub: { color: colors.textDim, fontSize: 13, marginTop: 3 },
  });
