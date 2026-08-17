import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  RefreshControl,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useColors } from '../theme';
import { useNotifications } from '../store/NotificationContext';
import {
  fetchNotifications,
  markNotificationRead,
  dismissNotification,
  markAllNotificationsRead,
} from '../lib/notificationApi';

function formatRelativeTime(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function NotificationRow({ notification, onPress, onDismiss }) {
  const colors = useColors();
  const [dismissing, setDismissing] = useState(false);

  const handleDismiss = async () => {
    setDismissing(true);
    try {
      await dismissNotification(notification.id);
      onDismiss();
    } catch (err) {
      setDismissing(false);
      Alert.alert('Error', 'Failed to dismiss notification');
    }
  };

  return (
    <TouchableOpacity
      style={[
        styles.notificationRow,
        { backgroundColor: colors.card, borderBottomColor: colors.border },
        !notification.is_read && styles.unreadRow,
      ]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={styles.notificationContent}>
        <View style={styles.notificationHeader}>
          {!notification.is_read && <View style={[styles.unreadDot, { backgroundColor: colors.primary }]} />}
          <Text style={[styles.notificationTitle, { color: colors.text }]} numberOfLines={1}>
            {notification.title}
          </Text>
        </View>
        <Text style={[styles.notificationBody, { color: colors.textDim }]} numberOfLines={2}>
          {notification.body}
        </Text>
        <Text style={[styles.notificationTime, { color: colors.textDim }]}>
          {formatRelativeTime(notification.created_at)}
        </Text>
      </View>
      <TouchableOpacity
        style={styles.dismissButton}
        onPress={handleDismiss}
        disabled={dismissing}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
      >
        <Ionicons name="close" size={18} color={colors.textDim} />
      </TouchableOpacity>
    </TouchableOpacity>
  );
}

export default function NotificationCenterScreen() {
  const navigation = useNavigation();
  const colors = useColors();
  const { refreshUnreadCount } = useNotifications();
  const [notifications, setNotifications] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadNotifications = useCallback(async () => {
    try {
      const data = await fetchNotifications({ limit: 50, offset: 0 });
      setNotifications(data || []);
    } catch (err) {
      console.error('Failed to load notifications:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadNotifications();
    }, [loadNotifications])
  );

  const handleRefresh = async () => {
    setRefreshing(true);
    await loadNotifications();
    await refreshUnreadCount();
    setRefreshing(false);
  };

  const handleMarkAllRead = async () => {
    try {
      await markAllNotificationsRead();
      setNotifications((prev) => prev.map((n) => ({ ...n, is_read: true })));
      await refreshUnreadCount();
    } catch (err) {
      Alert.alert('Error', 'Failed to mark all as read');
    }
  };

  const handleNotificationPress = async (notification) => {
    // Mark as read
    if (!notification.is_read) {
      try {
        await markNotificationRead(notification.id);
        setNotifications((prev) =>
          prev.map((n) => (n.id === notification.id ? { ...n, is_read: true } : n))
        );
        await refreshUnreadCount();
      } catch (err) {
        console.error('Failed to mark as read:', err);
      }
    }

    // Navigate based on notification type
    const { type, deep_link_ref, related_client_id } = notification;

    switch (type) {
      case 'workout_assigned':
        if (deep_link_ref) {
          navigation.navigate('ClientAssignedDetail', { planId: deep_link_ref });
        }
        break;
      case 'diet_assigned':
        if (deep_link_ref) {
          navigation.navigate('ClientDietPlanDetail', { planId: deep_link_ref });
        }
        break;
      case 'supplement_assigned':
        if (deep_link_ref) {
          navigation.navigate('CoachingPlanDetail', { planId: deep_link_ref });
        }
        break;
      case 'workout_completed':
        if (related_client_id && deep_link_ref) {
          navigation.navigate('ClientDetail', { clientId: related_client_id });
        }
        break;
      case 'diet_checkin':
        if (related_client_id && deep_link_ref) {
          navigation.navigate('ClientDetail', { clientId: related_client_id, tab: 'diet' });
        }
        break;
      case 'supplement_checkin':
        if (related_client_id && deep_link_ref) {
          navigation.navigate('ClientDetail', { clientId: related_client_id, tab: 'supplements' });
        }
        break;
      default:
        break;
    }
  };

  const handleDismiss = (notificationId) => {
    setNotifications((prev) => prev.filter((n) => n.id !== notificationId));
    refreshUnreadCount();
  };

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Ionicons name="notifications-outline" size={64} color={colors.textDim} />
      <Text style={[styles.emptyText, { color: colors.textDim }]}>No notifications yet</Text>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <FlatList
        data={notifications}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <NotificationRow
            notification={item}
            onPress={() => handleNotificationPress(item)}
            onDismiss={() => handleDismiss(item.id)}
          />
        )}
        ListEmptyComponent={!loading ? renderEmpty : null}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
          />
        }
        contentContainerStyle={notifications.length === 0 ? styles.emptyList : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  notificationRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  unreadRow: {
    backgroundColor: 'rgba(0,0,0,0.02)',
  },
  notificationContent: {
    flex: 1,
    marginRight: 8,
  },
  notificationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 4,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  notificationTitle: {
    fontSize: 15,
    fontWeight: '600',
    flex: 1,
  },
  notificationBody: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 4,
  },
  notificationTime: {
    fontSize: 12,
  },
  dismissButton: {
    padding: 4,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 100,
  },
  emptyText: {
    marginTop: 16,
    fontSize: 16,
  },
  emptyList: {
    flexGrow: 1,
  },
});