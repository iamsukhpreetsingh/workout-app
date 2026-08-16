import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useColors } from '../theme';
import { scheduleRestNotification, cancelRestNotification } from '../lib/notifications';
import { updateSettings } from '../db/settings';
import { timerEnd } from '../lib/haptics';

// Persistent rest-timer pill for the live session screen.
export default function RestTimerBar({ timer, onAdjust, onSkip }) {
  const colors = useColors();
  const [remaining, setRemaining] = useState(0);
  const notifIdRef = useRef(null);

  const styles = {
    wrap: {
      backgroundColor: colors.card,
      borderTopWidth: 1,
      borderTopColor: colors.border,
      overflow: 'hidden',
    },
    bar: { height: 3, backgroundColor: colors.primary },
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 10 },
    time: { color: colors.primary, fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
    label: { color: colors.textDim, flex: 1, fontSize: 12 },
    btn: {
      backgroundColor: colors.cardLight,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    btnText: { color: colors.text, fontWeight: '700', fontSize: 12 },
    skipBtn: { backgroundColor: colors.primary },
    skipText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  };

  // A new timer instance (id change) → schedule its completion notification
  useEffect(() => {
    if (!timer) return;
    notifIdRef.current &&
      cancelRestNotification(notifIdRef.current).then(() => (notifIdRef.current = null));
    const secs = (timer.endsAt - Date.now()) / 1000;
    scheduleRestNotification(secs, timer.label).then((id) => (notifIdRef.current = id));
    // Persist so a cold launch can restore or clear it
    updateSettings({
      rest_timer_ends_at: timer.endsAt,
      rest_timer_total: timer.total,
      rest_timer_label: timer.label,
    });
    return () => {
      notifIdRef.current && cancelRestNotification(notifIdRef.current);
    };
  }, [timer?.id]);

  // Cancel the scheduled notification when the timer is skipped/finished early
  useEffect(() => {
    if (!timer && notifIdRef.current) {
      cancelRestNotification(notifIdRef.current);
      notifIdRef.current = null;
      updateSettings({ rest_timer_ends_at: null, rest_timer_total: null, rest_timer_label: null });
    }
  }, [!!timer]);

  useEffect(() => {
    if (!timer) return;
    const tick = () => {
      const secs = Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000));
      setRemaining(secs);
      if (secs === 0) {
        timerEnd();
        onSkip(); // clears timer + persisted state
      }
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [timer?.endsAt, timer?.id]);

  if (!timer) return null;

  const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
  const ss = String(remaining % 60).padStart(2, '0');
  const pct = timer.total > 0 ? Math.max(0, remaining / timer.total) : 0;

  return (
    <View style={styles.wrap}>
      <View style={[styles.bar, { width: `${pct * 100}%` }]} />
      <View style={styles.row}>
        <Text style={styles.time}>{mm}:{ss}</Text>
        <Text style={styles.label} numberOfLines={1}>rest · {timer.label}</Text>
        <TouchableOpacity style={styles.btn} onPress={() => onAdjust(-15)}>
          <Text style={styles.btnText}>−15s</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.btn} onPress={() => onAdjust(15)}>
          <Text style={styles.btnText}>+15s</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, styles.skipBtn]} onPress={onSkip}>
          <Text style={styles.skipText}>Skip</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
