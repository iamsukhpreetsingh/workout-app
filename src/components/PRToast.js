import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, Easing } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useColors } from '../theme';

export default function PRToast({ visible, prs, onDismiss }) {
  const colors = useColors();
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.8)).current;

  const styles = {
    container: {
      position: 'absolute',
      top: 100,
      left: 16,
      right: 16,
      zIndex: 1000,
    },
    toast: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: 12,
      padding: 14,
      borderLeftWidth: 4,
      borderLeftColor: '#FFD700',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
      elevation: 8,
    },
    trophy: {
      fontSize: 28,
      marginRight: 12,
    },
    textContainer: {
      flex: 1,
    },
    title: {
      color: '#FFD700',
      fontSize: 16,
      fontWeight: '800',
    },
    subtitle: {
      color: colors.text,
      fontSize: 13,
      marginTop: 2,
    },
    more: {
      color: colors.textDim,
      fontSize: 11,
      marginTop: 2,
    },
  };

  useEffect(() => {
    if (visible) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.spring(scale, {
          toValue: 1,
          friction: 8,
          tension: 100,
          useNativeDriver: true,
        }),
      ]).start();

      const timer = setTimeout(() => {
        Animated.parallel([
          Animated.timing(opacity, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true,
          }),
          Animated.timing(scale, {
            toValue: 0.8,
            duration: 200,
            useNativeDriver: true,
          }),
        ]).start(() => {
          onDismiss();
        });
      }, 2500);

      return () => clearTimeout(timer);
    }
  }, [visible]);

  if (!visible) return null;

  const mainPR = prs[0];
  const label = getPRLabel(mainPR.type);
  const value = formatPRValue(mainPR.type, mainPR.newValue);

  return (
    <Animated.View style={[styles.container, { opacity, transform: [{ scale }] }]}>
      <View style={styles.toast}>
        <Ionicons name="trophy" size={30} color="#FFD700" style={{ marginRight: 12 }} />
        <View style={styles.textContainer}>
          <Text style={styles.title}>New PR!</Text>
          <Text style={styles.subtitle}>
            {label}: {value}
          </Text>
          {prs.length > 1 && (
            <Text style={styles.more}>+{prs.length - 1} more</Text>
          )}
        </View>
      </View>
    </Animated.View>
  );
}

function getPRLabel(type) {
  switch (type) {
    case 'max_weight': return 'Max Weight';
    case 'estimated_1rm': return 'Est. 1RM';
    case 'max_volume_set': return 'Best Volume';
    case 'max_reps_at_weight': return 'Best Reps';
    default: return 'Record';
  }
}

function formatPRValue(type, value) {
  if (type === 'estimated_1rm' || type === 'max_volume_set' || type === 'max_weight') {
    return `${Math.round(value)} kg`;
  }
  return `${Math.round(value)} reps`;
}