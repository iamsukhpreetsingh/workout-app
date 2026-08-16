import * as Notifications from 'expo-notifications';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

let permissionRequested = false;

export async function ensurePermission() {
  if (permissionRequested) return true;
  permissionRequested = true;
  const settings = await Notifications.getPermissionsAsync();
  if (settings.granted || settings.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
    return true;
  }
  const req = await Notifications.requestPermissionsAsync();
  return !!req.granted;
}

// Schedule the "rest complete" notification. Returns the notification id
// (or null if notifications are unavailable / permission denied).
export async function scheduleRestNotification(secondsRemaining, nextExerciseName) {
  try {
    const granted = await ensurePermission();
    if (!granted) return null;
    const id = await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Rest complete',
        body: nextExerciseName ? `Time for your next set — ${nextExerciseName}` : 'Time for your next set',
        sound: true,
      },
      trigger: { seconds: Math.max(1, Math.ceil(secondsRemaining)) },
    });
    return id;
  } catch {
    return null;
  }
}

export async function cancelRestNotification(id) {
  if (!id) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(id);
  } catch {
    // already fired or unknown id — nothing to do
  }
}
