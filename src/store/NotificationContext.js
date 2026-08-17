// Notification context for managing notification state across the app
import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { AppState } from 'react-native';
import { registerPushToken, fetchUnreadCount } from '../lib/notificationApi';
import { useAuth } from '../store/AuthContext';

const NotificationContext = createContext(null);

// Configure notification handling
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

export function NotificationProvider({ children }) {
  const { user, authStatus } = useAuth();
  const [unreadCount, setUnreadCount] = useState(0);
  const [expoPushToken, setExpoPushToken] = useState(null);

  // Register for push notifications
  const registerForPushNotifications = useCallback(async () => {
    if (!user) return;

    try {
      const { status: existingStatus } = await Notifications.getPermissionsAsync();
      let finalStatus = existingStatus;

      if (existingStatus !== 'granted') {
        const { status } = await Notifications.requestPermissionsAsync();
        finalStatus = status;
      }

      if (finalStatus !== 'granted') {
        // Permission denied - app works normally, just no push notifications
        return;
      }

      const token = await Notifications.getExpoPushTokenAsync();
      setExpoPushToken(token.data);

      // Send token to backend
      await registerPushToken(token.data);
    } catch (error) {
      console.error('Error registering for push notifications:', error);
    }
  }, [user]);

  // Refresh unread count
  const refreshUnreadCount = useCallback(async () => {
    if (authStatus !== 'authenticated') return;
    try {
      const count = await fetchUnreadCount();
      setUnreadCount(count);
    } catch (error) {
      console.error('Error fetching unread count:', error);
    }
  }, [authStatus]);

  // Register on auth and app state change
  useEffect(() => {
    if (authStatus === 'authenticated' && user) {
      registerForPushNotifications();
      refreshUnreadCount();
    }
  }, [authStatus, user, registerForPushNotifications, refreshUnreadCount]);

  // Refresh on app foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && authStatus === 'authenticated') {
        refreshUnreadCount();
      }
    });
    return () => sub.remove();
  }, [authStatus, refreshUnreadCount]);

  // Listen for incoming notifications
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(() => {
      refreshUnreadCount();
    });
    return () => sub.remove();
  }, [refreshUnreadCount]);

  const value = {
    unreadCount,
    refreshUnreadCount,
    registerForPushNotifications,
    expoPushToken,
  };

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) {
    throw new Error('useNotifications must be used inside NotificationProvider');
  }
  return ctx;
}