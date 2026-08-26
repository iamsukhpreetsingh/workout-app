import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

/**
 * Presentational "Suggested Today" banner. Renders nothing while the
 * suggestion is pending, a suggestion card when one exists, or the
 * training-max prompt (until dismissed) when the formula needs one.
 */
export default function SuggestionBanner({
  sugg,
  dismissed,
  styles,
  colors,
  onUse,
  onDismissTmPrompt,
}) {
  if (!sugg || sugg.pending) return null;
  if (sugg.suggestion) {
    return (
      <View style={styles.suggestCard}>
        <Ionicons name="bulb" size={14} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={styles.suggestMain}>
            Suggested: {sugg.suggestion.suggestedWeight}kg × {sugg.suggestion.suggestedReps}
          </Text>
          {sugg.suggestion.rationale ? (
            <Text style={styles.suggestRationale}>{sugg.suggestion.rationale}</Text>
          ) : null}
        </View>
        <TouchableOpacity style={styles.useBtn} onPress={onUse}>
          <Text style={styles.useBtnText}>Use</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (sugg.missingTrainingMax && !dismissed) {
    return (
      <View style={styles.tmPromptCard}>
        <Ionicons name="information-circle-outline" size={14} color={colors.yellow} />
        <Text style={styles.tmPromptText}>
          Set a training max for this exercise to get percentage-based suggestions
        </Text>
        <TouchableOpacity
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          onPress={onDismissTmPrompt}
        >
          <Ionicons name="close" size={14} color={colors.textDim} />
        </TouchableOpacity>
      </View>
    );
  }
  return null;
}
