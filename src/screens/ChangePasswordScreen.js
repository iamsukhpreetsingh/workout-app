import React from 'react';
import { View, ScrollView, StyleSheet } from 'react-native';
import { useColors } from '../theme';
import ChangePasswordCard from '../components/ChangePasswordCard';

// Change Password — its own screen (moved from Settings per the profile
// consolidation). Deliberately a thin wrapper around the EXISTING
// ChangePasswordCard: the auth implementation is untouched.
export default function ChangePasswordScreen() {
  const colors = useColors();
  const styles = makeStyles(colors);
  return (
    <ScrollView style={styles.container} contentContainerStyle={{ padding: 20, paddingBottom: 48 }}>
      <ChangePasswordCard />
    </ScrollView>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
  });
