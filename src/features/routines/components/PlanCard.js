import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const NUMS = { fontVariant: ['tabular-nums'] };

/**
 * Presentational plan/routine card used by every list on the Routines tab
 * (my routines, assigned workouts, diet plans, supplement plans).
 *
 * Renders: [accent bar] [icon tile] [name / meta / swap badge / tag chips]
 * [optional pin button] [chevron]. Visual variants are selected by props;
 * all styles come from the parent screen's stylesheet so pixel output is
 * owned in one place.
 *
 * @param {{
 *   styles: object,
 *   colors: object,
 *   onPress: () => void,
 *   icon?: string|null,       // Ionicons name for the leading tile (null = no tile)
 *   iconColor?: string,       // defaults to colors.primary
 *   variant?: 'card'|'assigned',
 *   accent?: boolean,         // render the blue assigned-plan accent bar
 *   name: string,
 *   meta?: string,
 *   tags?: string[],
 *   trainerTagStyle?: boolean,
 *   swapBadgeCount?: number|null,
 *   pinned?: boolean,
 *   onTogglePin?: () => void,
 * }} props
 */
export default function PlanCard({
  styles,
  colors,
  onPress,
  icon = null,
  iconColor,
  variant = 'card',
  accent = false,
  name,
  meta,
  tags = [],
  trainerTagStyle = false,
  swapBadgeCount = null,
  pinned,
  onTogglePin,
}) {
  return (
    <TouchableOpacity
      style={variant === 'assigned' ? styles.assignedCard : styles.card}
      activeOpacity={0.8}
      onPress={onPress}
    >
      {accent && <View style={styles.assignedAccent} />}
      {icon && (
        <View style={styles.templateTag}>
          <Ionicons name={icon} size={13} color={iconColor || colors.primary} />
        </View>
      )}
      <View style={{ flex: 1 }}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        {!!meta && <Text style={[styles.meta, NUMS]}>{meta}</Text>}
        {swapBadgeCount != null && swapBadgeCount > 0 && (
          <View style={styles.swapBadge}>
            <Ionicons name="swap-horizontal" size={11} color={colors.blue} />
            <Text style={styles.swapBadgeText}>
              {swapBadgeCount} swap option{swapBadgeCount === 1 ? '' : 's'}
            </Text>
          </View>
        )}
        {tags.length > 0 && (
          <View style={styles.tagRow}>
            {tags.slice(0, 3).map((tag) => (
              <View key={tag} style={[styles.tagChip, trainerTagStyle && styles.tagChipTrainer]}>
                <Text style={[styles.tagChipText, trainerTagStyle && styles.tagChipTextTrainer]}>{tag}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
      {onTogglePin && (
        <PinButton styles={styles} colors={colors} pinned={pinned} onPress={onTogglePin} />
      )}
      <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
    </TouchableOpacity>
  );
}

/**
 * Star toggle shown on pinnable cards (routines + assigned workouts).
 */
export function PinButton({ styles, colors, pinned, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} style={styles.pinBtn} hitSlop={{ top: 10, bottom: 10, left: 6, right: 6 }}>
      <Ionicons
        name={pinned ? 'star' : 'star-outline'}
        size={18}
        color={pinned ? colors.yellow : colors.textDim}
      />
    </TouchableOpacity>
  );
}

/**
 * Centered empty state for a plans list: icon, title, subtitle and an
 * optional primary action button.
 */
export function PlanEmptyState({
  styles,
  colors,
  icon,
  iconSize = 40,
  title,
  subtitle,
  actionLabel,
  actionIconSize = 17,
  onAction,
}) {
  return (
    <View style={styles.emptyWrap}>
      <Ionicons name={icon} size={iconSize} color={colors.textDim} />
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySub}>{subtitle}</Text>
      {actionLabel && (
        <TouchableOpacity style={styles.emptyBtn} onPress={onAction}>
          <Ionicons name="add" size={actionIconSize} color={colors.primary} />
          <Text style={styles.emptyBtnText}>{actionLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

/**
 * Dashed "+ New …" button rendered at the top of non-empty lists.
 */
export function NewPlanButton({ styles, colors, label, onPress }) {
  return (
    <TouchableOpacity style={styles.newRoutineBtn} onPress={onPress}>
      <Ionicons name="add" size={17} color={colors.primary} />
      <Text style={styles.newRoutineText}>{label}</Text>
    </TouchableOpacity>
  );
}
