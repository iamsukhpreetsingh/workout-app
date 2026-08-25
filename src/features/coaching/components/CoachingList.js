// diet/supplement list body for the content tabs
import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import {
  COACHING_PLAN_DETAIL,
  DIET_PLAN_BUILDER,
  SUPPLEMENT_PLAN_BUILDER,
} from '../../../shared/constants/routes';

const NUMS = { fontVariant: ['tabular-nums'] };

/**
 * Diet/supplement list body for the client-detail content tabs.
 */
export default function CoachingList({ kind, plans, styles, colors, navigation, clientId, clientName, emptyLabel }) {
  const builder = kind === 'diet' ? DIET_PLAN_BUILDER : SUPPLEMENT_PLAN_BUILDER;
  return (
    <View>
      {plans.length === 0 && <Text style={styles.emptySub}>{emptyLabel}</Text>}
      {plans.map((p) => (
        <TouchableOpacity
          key={p.id}
          style={styles.card}
          activeOpacity={0.8}
          onPress={() =>
            navigation.navigate(COACHING_PLAN_DETAIL, { planId: p.id, kind, clientId, clientName })
          }
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.sessName} numberOfLines={1}>
              {p.name}
            </Text>
            <Text style={[styles.meta, NUMS]}>
              {p.item_count} {kind === 'diet' ? 'meals' : 'supplements'} · assigned{' '}
              {new Date(p.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
        </TouchableOpacity>
      ))}
      <TouchableOpacity
        style={styles.assignBtn}
        onPress={() => navigation.navigate(builder, { clientId, clientName, kind })}
      >
        <Ionicons name="add-circle-outline" size={20} color="#fff" />
        <Text style={styles.assignText}>
          {kind === 'diet' ? 'Assign Diet Plan' : 'Assign Supplement Plan'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

