// segmented control — same visual language as the client Routines tabs
import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';

/**
 * Segmented control matching the Routines tab visual language.
 */
export default function Segmented({ styles, value, onChange, options }) {
  return (
    <View style={styles.segRow}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <TouchableOpacity key={o.value} style={[styles.segBtn, on && styles.segBtnOn]} onPress={() => onChange(o.value)}>
            <Text style={[styles.segText, on && { color: '#fff' }]}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

