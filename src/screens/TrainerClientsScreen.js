import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
  Share,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api } from '../lib/api';
import { useColors } from '../theme';
import { useHeaderActions } from '../components/HeaderActions';
import { CLIENT_DETAIL, NOTIFICATION_CENTER } from '../shared/constants/routes';

const NUMS = { fontVariant: ['tabular-nums'] };

function initialsOf(name = '?') {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function relativeTime(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Live client list for trainer accounts. Pending requests sit above active
// clients in a visually distinct muted style; active cards carry real
// adherence + last-activity data from the backend.
export default function TrainerClientsScreen({ navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [clients, setClients] = useState([]);
  const [archived, setArchived] = useState([]);
  const [pending, setPending] = useState([]);
  const [dietStatus, setDietStatus] = useState({}); // client_id -> overview row
  const [error, setError] = useState(null);
  const [invite, setInvite] = useState(null); // { code, expires_at }

  const load = useCallback(async () => {
    try {
      setError(null);
      const [roster, pendingReqs, dietOverview] = await Promise.all([
        api('/trainer/clients'),
        api('/trainer/associations?status=pending'),
        // exception-first diet status per client (best-effort: the list must
        // render even if the monitoring endpoint is unavailable)
        api('/trainer/diet-monitoring/overview').catch(() => []),
      ]);
      setClients(roster.filter((c) => c.status === 'active'));
      setArchived(roster.filter((c) => c.status === 'archived'));
      setPending(pendingReqs);
      const byId = {};
      for (const o of dietOverview || []) byId[o.client_id] = o;
      setDietStatus(byId);
    } catch (e) {
      setError(e.message || 'Could not load clients');
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load().finally(() => setLoading(false));
    }, [load])
  );

  // Invite code management lives in Trainer Settings (dedicated card with
  // the code always visible) — the old header icon generated codes whose
  // display only rendered in the zero-clients empty state.

  useHeaderActions(navigation);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const respond = async (assocId, action, finalDecision = null) => {
    // optimistic local update, re-sync on failure
    const snapshot = pending;
    setPending((p) => p.filter((a) => a.id !== assocId));
    try {
      await api(`/trainer/associations/${assocId}/${action}`, {
        method: 'POST',
        body: finalDecision ? { final_decision: finalDecision } : undefined,
      });
      await load(); // accept → move into the active list
    } catch (e) {
      setPending(snapshot);
      setError(e.message || `Could not ${action} request`);
    }
  };

  const showInviteCode = async () => {
    try {
      const code = await api('/trainer/invite-code', { method: 'POST' });
      setInvite(code);
    } catch (e) {
      setError(e.message || 'Could not generate invite code');
    }
  };

  const shareInvite = async () => {
    if (!invite) return;
    try {
      await Share.share({
        message: `Join me as your trainer on Workout Tracker! Invite code: ${invite.code}`,
        title: 'Trainer invite code',
      });
    } catch {
      // user dismissed the sheet
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const isEmpty = clients.length === 0 && pending.length === 0;

  return (
    <View style={styles.container}>
      <FlatList
        data={clients}
        keyExtractor={(c) => c.id}
        refreshing={refreshing}
        onRefresh={refresh}
        contentContainerStyle={{ padding: 20, paddingBottom: 48, flexGrow: 1 }}
        ListHeaderComponent={
          <View>
            {error && <Text style={styles.error}>{error}</Text>}

            {/* Pending requests — muted/outlined, no session data yet */}
            {pending.length > 0 && (
              <>
                <Text style={styles.groupLabel}>Pending</Text>
                {pending.map((p) => (
                  <View key={p.id} style={styles.pendingCard}>
                    <View style={styles.pendingHeader}>
                      <View style={[styles.avatar, styles.avatarMuted]}>
                        <Text style={styles.avatarMutedText}>{initialsOf(p.client_name)}</Text>
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.pendingName}>{p.client_name}</Text>
                        {p.is_reactivation ? (
                          <>
                            <Text style={styles.reactivationTag}>
                              ↻ Reconnecting · archived{' '}
                              {p.archived_at
                                ? `${Math.max(0, Math.floor((Date.now() - new Date(p.archived_at).getTime()) / 86400000))} days ago`
                                : ''}
                            </Text>
                            <Text style={styles.prefLine}>
                              {(p.client_name || 'They').split(' ')[0]} prefer
                              {p.restore_preference === 'restore' ? 's: Restore history' : 's: Start fresh'}
                            </Text>
                          </>
                        ) : (
                          <Text style={styles.pendingSub}>wants to train with you</Text>
                        )}
                      </View>
                      {!p.is_reactivation && (
                        <TouchableOpacity style={styles.rejectBtn} onPress={() => respond(p.id, 'reject')}>
                          <Ionicons name="close" size={16} color={colors.red} />
                        </TouchableOpacity>
                      )}
                    </View>
                    {!p.is_reactivation && (
                      <TouchableOpacity style={styles.acceptBtn} onPress={() => respond(p.id, 'accept')}>
                        <Ionicons name="checkmark" size={16} color="#fff" />
                      </TouchableOpacity>
                    )}
                    {p.is_reactivation && (
                      <View style={styles.reactivationActions}>
                        <View style={styles.decisionRow}>
                          <TouchableOpacity
                            style={p.restore_preference === 'restore' ? styles.decideBtnSolid : styles.decideBtnOutline}
                            onPress={() => respond(p.id, 'accept', 'restore')}
                          >
                            <Text style={p.restore_preference === 'restore' ? styles.decideTextSolid : styles.decideTextOutline}>
                              Restore History
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={p.restore_preference === 'fresh' ? styles.decideBtnSolid : styles.decideBtnOutline}
                            onPress={() => respond(p.id, 'accept', 'fresh')}
                          >
                            <Text style={p.restore_preference === 'fresh' ? styles.decideTextSolid : styles.decideTextOutline}>
                              Start Fresh
                            </Text>
                          </TouchableOpacity>
                        </View>
                        <TouchableOpacity style={styles.declineBtn} onPress={() => respond(p.id, 'reject')}>
                          <Text style={styles.declineText}>Decline</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                ))}
              </>
            )}

            {clients.length > 0 && (
              <Text style={[styles.groupLabel, { marginTop: pending.length > 0 ? 20 : 0 }]}>
                Active
              </Text>
            )}
          </View>
        }
        ListFooterComponent={
          archived.length > 0 ? (
            <View>
              <Text style={styles.groupLabel}>Archived</Text>
              {archived.map((c) => (
                <TouchableOpacity
                  key={c.id}
                  style={[styles.card, styles.archivedRow]}
                  onPress={() =>
                    navigation.navigate(CLIENT_DETAIL, {
                      clientId: c.id,
                      clientName: c.name,
                      adherence: c.adherence_pct,
                      lastActive: c.last_active_at,
                      associatedAt: c.responded_at,
                      archived: true,
                      daysRemaining: c.days_remaining,
                    })
                  }
                >
                  <View style={[styles.avatar, styles.avatarMuted]}>
                    <Text style={styles.avatarMutedText}>{initialsOf(c.name)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.archivedName}>{c.name}</Text>
                    <Text style={styles.meta}>
                      Archived · {c.days_remaining} day{c.days_remaining === 1 ? '' : 's'} left
                    </Text>
                  </View>
                  <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
                </TouchableOpacity>
              ))}
              <Text style={styles.archivedHint}>
                Read-only — content is removed permanently after the window ends.
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          isEmpty ? (
            <View style={styles.emptyWrap}>
              <Ionicons name="people-outline" size={40} color={colors.textDim} />
              <Text style={styles.emptyTitle}>No clients yet</Text>
              <Text style={styles.emptySub}>
                Share your invite code and they can request to train with you.
              </Text>
              <TouchableOpacity style={styles.emptyBtn} onPress={showInviteCode}>
                <Ionicons name="person-add-outline" size={17} color={colors.primary} />
                <Text style={styles.emptyBtnText}>Show My Invite Code</Text>
              </TouchableOpacity>
              {invite && (
                <View style={styles.inviteCard}>
                  <Text style={styles.inviteLabel}>YOUR INVITE CODE</Text>
                  <Text style={styles.inviteCode}>{invite.code}</Text>
                  <Text style={styles.inviteExpiry}>
                    Expires {new Date(invite.expires_at).toLocaleDateString()}
                  </Text>
                  <TouchableOpacity style={styles.inviteShare} onPress={shareInvite}>
                    <Ionicons name="share-social-outline" size={15} color="#fff" />
                    <Text style={styles.inviteShareText}>Share Code</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ) : null
        }
        renderItem={({ item }) => (
          <TouchableOpacity
            style={styles.card}
            activeOpacity={0.8}
            onPress={() => navigation.navigate(CLIENT_DETAIL, { clientId: item.id, clientName: item.name, adherence: item.adherence_pct, lastActive: item.last_active_at, associatedAt: item.associated_at })}
          >
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{initialsOf(item.name)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{item.name}</Text>
              {(() => {
                // exception-first diet line: who needs attention at a glance
                const d = dietStatus[item.id];
                if (!d) return null;
                const map = {
                  on_track: { icon: 'checkmark-circle', color: colors.green, label: 'On track' },
                  needs_attention: { icon: 'warning', color: colors.red, label: 'Needs attention' },
                  not_enough_data: { icon: 'remove', color: colors.textDim, label: 'Not enough data' },
                };
                const s = map[d.status] || map.not_enough_data;
                const detail =
                  d.top_alert ||
                  [
                    d.target_calories
                      ? `${Number(d.target_calories).toLocaleString()} kcal ${d.target_source === 'trainer_override' ? '(trainer target)' : '(auto)'}`
                      : null,
                    d.days_tracked > 0
                      ? `${d.days_tracked}/7 logged${d.days_on_target ? ` · ${d.days_on_target} on target` : ''}`
                      : 'No food logged',
                  ]
                    .filter(Boolean)
                    .join(' · ');
                return (
                  <View style={styles.dietStatusRow}>
                    <Ionicons name={s.icon} size={12} color={s.color} />
                    <Text style={[styles.dietStatusText, { color: s.color }]}>{s.label}</Text>
                    <Text style={[styles.dietStatusDetail, NUMS]} numberOfLines={1}>· {detail}</Text>
                  </View>
                );
              })()}
              <Text style={[styles.meta, NUMS]}>
                {item.adherence_pct != null ? `${Math.round(item.adherence_pct)}% adherence` : '—'}
                {' · '}
                {item.last_active_at ? relativeTime(item.last_active_at) : 'No workouts yet'}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
          </TouchableOpacity>
        )}
      />

      {/* Invite modal for the non-empty case (header action) */}
      <Modal visible={!!invite && !isEmpty} transparent animationType="fade" onRequestClose={() => setInvite(null)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setInvite(null)}>
          <View style={styles.inviteCardModal}>
            <Text style={styles.inviteLabel}>YOUR INVITE CODE</Text>
            <Text style={styles.inviteCode}>{invite?.code}</Text>
            <Text style={styles.inviteExpiry}>
              Expires {invite && new Date(invite.expires_at).toLocaleDateString()}
            </Text>
            <TouchableOpacity style={styles.inviteShare} onPress={shareInvite}>
              <Ionicons name="share-social-outline" size={15} color="#fff" />
              <Text style={styles.inviteShareText}>Share Code</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.inviteClose} onPress={() => setInvite(null)}>
              <Text style={styles.inviteCloseText}>Close</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    error: { color: colors.red, fontSize: 12, marginBottom: 10 },

    groupLabel: {
      color: colors.textDim,
      fontSize: 12,
      fontWeight: '800',
      letterSpacing: 1.2,
      textTransform: 'uppercase',
      marginBottom: 10,
    },

    // Active clients — solid cards (same family as History/Routines)
    archivedRow: { opacity: 0.7 },
    archivedName: { color: colors.textDim, fontSize: 15, fontWeight: '700' },
    archivedHint: { color: colors.textDim, fontSize: 11, marginTop: 6, opacity: 0.8 },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 12,
      marginBottom: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12,
      shadowRadius: 8,
      elevation: 2,
    },
    avatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { color: '#fff', fontWeight: '800' },
    name: { color: colors.text, fontSize: 15, fontWeight: '700' },
    meta: { color: colors.textDim, fontSize: 12, marginTop: 3 },
    dietStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
    dietStatusText: { fontSize: 12, fontWeight: '700' },
    dietStatusDetail: { color: colors.textDim, fontSize: 11, flex: 1 },

    // Pending — muted, outlined, visually distinct from data-backed cards
    pendingCard: {
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.border,
      borderStyle: 'dashed',
      padding: 12,
      marginBottom: 8,
    },
    pendingHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    avatarMuted: { backgroundColor: colors.cardLight },
    avatarMutedText: { color: colors.textDim, fontWeight: '800' },
    pendingName: { color: colors.text, fontSize: 15, fontWeight: '700' },
    pendingSub: { color: colors.textDim, fontSize: 12, marginTop: 2 },
    reactivationTag: { color: colors.blue, fontSize: 11, fontWeight: '700', marginTop: 4 },
  prefLine: { color: colors.text, fontSize: 12, marginTop: 6 },
  reactivationActions: { marginTop: 12 },
  decisionRow: { flexDirection: 'row', gap: 8 },
  decideBtnSolid: {
    flex: 1, backgroundColor: colors.primary, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center',
  },
  decideBtnOutline: {
    flex: 1, borderWidth: 1.5, borderColor: colors.primary, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center',
  },
  decideTextSolid: { color: '#fff', fontWeight: '700', fontSize: 12 },
  decideTextOutline: { color: colors.primary, fontWeight: '700', fontSize: 12 },
  declineBtn: {
    marginTop: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 10,
    paddingVertical: 9, alignItems: 'center',
  },
  declineText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },
  acceptBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.green,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rejectBtn: {
      width: 34,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.cardLight,
      alignItems: 'center',
      justifyContent: 'center',
    },

    // Empty state + invite code
    emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 },
    emptyTitle: { color: colors.text, fontSize: 19, fontWeight: '800', marginTop: 14 },
    emptySub: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 6, marginBottom: 20 },
    emptyBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: colors.primary,
      paddingHorizontal: 20,
      paddingVertical: 12,
    },
    emptyBtnText: { color: colors.primary, fontWeight: '700' },

    inviteCard: {
      marginTop: 20,
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 18,
      alignItems: 'center',
      alignSelf: 'stretch',
    },
    inviteCardModal: {
      marginHorizontal: 40,
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 22,
      alignItems: 'center',
    },
    inviteLabel: {
      color: colors.textDim,
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 1.2,
    },
    inviteCode: { color: colors.primary, fontSize: 32, fontWeight: '800', letterSpacing: 4, marginTop: 8 },
    inviteExpiry: { color: colors.textDim, fontSize: 11, marginTop: 4 },
    inviteShare: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 9,
      marginTop: 14,
    },
    inviteShareText: { color: '#fff', fontWeight: '700', fontSize: 13 },
    inviteClose: { marginTop: 10, padding: 8 },
    inviteCloseText: { color: colors.textDim, fontWeight: '700', fontSize: 13 },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' },
  });
