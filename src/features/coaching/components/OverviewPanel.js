// ── Overview panel ──────────────────────────────────────────────────────
// Week/month stat cards + the one place all three assign actions live
// together + a merged recent-activity feed.
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, Switch, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../lib/api';
import ProgressionStrategyEditor from '../../../components/ProgressionStrategyEditor';
import { getFormula } from '../../../progressionFormulas';
import { fmtVolume } from '../../../shared/utils/format';
import {
  ASSIGN_WORKOUT,
  ASSIGN_WORKOUT_PICKER,
  DIET_PLAN_BUILDER,
  SUPPLEMENT_PLAN_BUILDER,
} from '../../../shared/constants/routes';
import { relativeTime } from '../utils/clientAnalytics';

const NUMS = { fontVariant: ['tabular-nums'] };

/**
 * Trainer's client-detail Overview tab: week/month stat cards, notification
 * toggle, progression-strategy card, quick actions (assign/remove) and the
 * merged recent-activity feed.
 */
export default function OverviewPanel({
  styles, colors, navigation, clientId, clientName, readOnly,
  summaries, activity, onLoadActivity,
  notificationPref, onNotificationToggle, loadingNotificationPref,
  progResolved, progOverride, onProgSave, onProgClear, progBusy,
}) {
  // Editing state lives HERE — it's pure UI state for this card, and this
  // is the only component that uses it.
  const [progEditing, setProgEditing] = React.useState(false);
  const [progDraft, setProgDraft] = React.useState(null);
  const confirmRemoveClient = () =>
    Alert.alert(
      'Remove client',
      `You'll keep read-only access to ${clientName || 'this client'}'s workout history, diet plans, and supplement plans for 30 days, after which they'll be permanently removed. They will immediately lose access to anything you've assigned them.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              await api(`/trainer/clients/${clientId}/unlink`, { method: 'POST' });
              navigation.goBack();
            } catch (e) {
              Alert.alert('Could not remove client', e.message || 'Please try again.');
            }
          },
        },
      ]
    );

  React.useEffect(() => { onLoadActivity && onLoadActivity(); }, []);

  const now = Date.now();
  const week = summaries.filter((s) => now - new Date(s.performed_at).getTime() < 7 * 86400000);
  const month = summaries.filter((s) => now - new Date(s.performed_at).getTime() < 30 * 86400000);
  const stat = (rows) => ({
    count: rows.length,
    vol: rows.reduce((n, r) => n + (Number(r.total_volume) || 0), 0),
  });
  const wk = stat(week);
  const mo = stat(month);

  const actions = [
    { label: 'Assign Workout', icon: 'barbell-outline', to: ASSIGN_WORKOUT_PICKER },
    { label: 'Assign Diet', icon: 'nutrition-outline', to: DIET_PLAN_BUILDER, kind: 'diet' },
    { label: 'Assign Supplement', icon: 'medkit-outline', to: SUPPLEMENT_PLAN_BUILDER, kind: 'supplement' },
  ];

  return (
    <View>
      <View style={styles.statRow}>
        <View style={styles.statCard}>
          <Text style={[styles.statBig, NUMS]}>{wk.count}</Text>
          <Text style={styles.statLabel}>workouts this week</Text>
          <Text style={[styles.statVol, NUMS]}>{fmtVolume(wk.vol)} vol</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statBig, NUMS]}>{mo.count}</Text>
          <Text style={styles.statLabel}>workouts this month</Text>
          <Text style={[styles.statVol, NUMS]}>{fmtVolume(mo.vol)} vol</Text>
        </View>
      </View>

      <Text style={styles.groupLabel}>Notifications</Text>
      {!readOnly && (
        <View style={[styles.qaRow, { marginBottom: 12 }]}>
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 }}>
            <Text style={styles.qaText}>Notify me about this client</Text>
            <Switch
              value={notificationPref}
              onValueChange={onNotificationToggle}
              disabled={loadingNotificationPref}
              trackColor={{ false: colors.border, true: colors.primary }}
              thumbColor="#fff"
            />
          </View>
        </View>
      )}

            <Text style={styles.groupLabel}>Progression Strategy</Text>
      <View style={styles.card}>
        {progEditing ? (
          <View>
            {/* <Text style={{ color: styles.seeAll.color, fontSize: 12, marginBottom: 4 }}> */}
              <Text style={{ color: colors.textDim, fontSize: 12, marginBottom: 4 }}>
              Override for {clientName || 'this client'}:
            </Text>
            <ProgressionStrategyEditor
              value={progDraft || { formula_key: 'linear_progression', params: {} }}
              onValueChange={setProgDraft}
              busy={progBusy}
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
              <TouchableOpacity
                style={[styles.editBtn, { flex: 1 }]}
                onPress={() => { setProgEditing(false); setProgDraft(null); }}
                disabled={progBusy}
              >
                <Text style={styles.editBtnText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.qaBtn, { flex: 1, justifyContent: 'center' }]}
                // onPress={() => progDraft && onProgSave(progDraft.formula_key, progDraft.params)}
                  onPress={async () => {
                  if (!progDraft) return;
                  const ok = await onProgSave(progDraft.formula_key, progDraft.params);
                  if (ok) setProgEditing(false); // close editor only on success
                }}
                disabled={progBusy || !progDraft}
              >
                <Text style={styles.qaText}>Save Override</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <View>
            {(() => {
              const f = progResolved ? getFormula(progResolved.formula_key) : null;
              const sourceLabel =
                progResolved?.source === 'trainer_override'
                  ? 'your override'
                  : progResolved?.source === 'user_setting'
                  ? "client's own setting"
                  : 'app default';
              return (
                <View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Ionicons name="trending-up" size={15} color={colors.primary} />
                    <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700', flex: 1 }}>
                      Active: {f ? f.displayName : progResolved?.formula_key || '—'}
                    </Text>
                  </View>
                  <Text style={{ color: colors.textDim, fontSize: 12, marginTop: 3 }}>
                    ({sourceLabel})
                  </Text>
                  {!readOnly && (
                    <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
                      <TouchableOpacity
                        style={[styles.editBtn, { flex: 1 }]}
                        onPress={() => {
                          setProgDraft(
                            progOverride
                              ? { ...progOverride }
                              : { formula_key: progResolved?.formula_key || 'linear_progression', params: { ...(progResolved?.params || {}) } }
                          );
                          setProgEditing(true);
                        }}
                      >
                        <Ionicons name="create-outline" size={15} color={colors.primary} />
                        <Text style={styles.editBtnText}>
                          {progOverride ? 'Edit Override' : 'Override'}
                        </Text>
                      </TouchableOpacity>
                      {progOverride && (
                        <TouchableOpacity
                          style={[styles.removeClientBtn, { marginBottom: 0 }]}
                          onPress={onProgClear}
                          disabled={progBusy}
                        >
                          <Text style={styles.removeClientText}>Reset</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  )}
                </View>
              );
            })()}
          </View>
        )}
      </View>


      <Text style={styles.groupLabel}>Quick Actions</Text>
      {!readOnly ? (
        <TouchableOpacity style={styles.removeClientBtn} onPress={confirmRemoveClient}>
          <Ionicons name="person-remove-outline" size={14} color={colors.red} />
          <Text style={styles.removeClientText}>Remove Client</Text>
        </TouchableOpacity>
      ) : null}
      <View style={styles.qaRow}>
        {actions.map((a) => (
          <TouchableOpacity
            key={a.to}
            style={styles.qaBtn}
            activeOpacity={0.8}
            onPress={() =>
              navigation.navigate(a.to, a.kind ? { clientId, clientName, kind: a.kind } : { clientId, clientName })
            }
          >
            <Ionicons name={a.icon} size={18} color={colors.primary} />
            <Text style={styles.qaText}>{a.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.groupLabel}>Recent Activity</Text>
      {activity.length === 0 && (
        <Text style={styles.emptySub}>Nothing synced yet for this client.</Text>
      )}
      {activity.map((a, i) => (
        <View key={i} style={styles.activityRow}>
          <Ionicons name={a.icon} size={15} color={colors.textDim} />
          <Text style={styles.activityText} numberOfLines={1}>
            {a.text}
          </Text>
          <Text style={styles.activityWhen}>{relativeTime(a.at)}</Text>
        </View>
      ))}
    </View>
  );
}

