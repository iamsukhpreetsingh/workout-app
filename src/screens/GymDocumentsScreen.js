// Gym Documents — the member-facing document list & digital waivers (Phase 18).
//
// Shown from Profile → My Gym → Documents. Lists the member's documents
// across ACTIVE gym memberships: waivers, membership agreements, ID
// verification, medical clearances. Paperwork the desk filed BEFORE the
// app account was connected appears here too — documents belong to the
// gym member row, not the app account.
//
// SIGNING is the core action: a PENDING waiver is signed by typing the
// legal name (retained server-side as the signature of record). Expired
// documents refuse to sign — the gym issues a fresh copy. REPLACED and
// REVOKED copies stay at the desk (retention); the app shows live
// documents only, with expiry surfaced so the member sees what needs
// renewing. Byte downloads stay on the web portal where authenticated
// file saving works natively.
import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, Modal, TextInput,
  ActivityIndicator, ScrollView, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useColors } from '../theme';
import useAsyncData from '../shared/hooks/useAsyncData';
import LoadError from '../shared/components/LoadError';
import { fetchMyGymDocuments, signGymDocument } from '../lib/gymApi';

const STATUS_COLORS = {
  PENDING: '#D97706',
  AUTHORIZED: '#16A34A',
  EXPIRED: '#EA580C',
  REPLACED: '#78716C',
  REVOKED: '#DC2626',
};

const CATEGORY_ICONS = {
  WAIVER: 'shield-checkmark-outline',
  MEMBERSHIP_AGREEMENT: 'document-text-outline',
  ID_VERIFICATION: 'id-card-outline',
  MEDICAL_CLEARANCE: 'medkit-outline',
  OTHER: 'folder-open-outline',
};

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function GymDocumentsScreen() {
  const colors = useColors();
  const [signTarget, setSignTarget] = useState(null);
  const [signature, setSignature] = useState('');
  const [signing, setSigning] = useState(false);
  const { data, loading, error, reload } = useAsyncData(fetchMyGymDocuments, []);

  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  const documents = Array.isArray(data) ? data : [];

  const doSign = () => {
    const name = signature.trim();
    if (!name) return;
    setSigning(true);
    signGymDocument(signTarget.id, name)
      .then(() => {
        setSignTarget(null);
        setSignature('');
        reload();
      })
      .catch((e) => {
        // signing errors surface inline: expired, already signed, membership inactive
        setSignTarget(null);
        setSignature('');
        Alert.alert('Could not sign', e?.message || 'Please try again.');
      })
      .finally(() => setSigning(false));
  };

  const styles = makeStyles(colors);

  if (loading && !documents.length) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }
  if (error) {
    return <LoadError message="Couldn't load your documents." onRetry={reload} />;
  }

  return (
    <View style={styles.screen}>
      <FlatList
        data={documents}
        keyExtractor={(d) => d.id}
        refreshing={loading && documents.length > 0}
        onRefresh={reload}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="folder-open-outline" size={40} color={colors.textDim} />
            <Text style={styles.emptyTitle}>No documents yet</Text>
            <Text style={styles.emptyBody}>
              Waivers and agreements your gym files for you will appear here.
            </Text>
          </View>
        }
        renderItem={({ item: d }) => {
          const signable = d.status === 'PENDING' && !d.expired;
          return (
            <View style={styles.card}>
              <View style={styles.cardTop}>
                <View style={[styles.iconWrap, { backgroundColor: `${STATUS_COLORS[d.effective_status] || colors.textDim}22` }]}>
                  <Ionicons
                    name={CATEGORY_ICONS[d.category] || 'folder-open-outline'}
                    size={18}
                    color={STATUS_COLORS[d.effective_status] || colors.textDim}
                  />
                </View>
                <View style={styles.cardMain}>
                  <Text style={styles.cardTitle} numberOfLines={1}>
                    {d.title || d.category_label}
                  </Text>
                  <Text style={styles.cardSub} numberOfLines={1}>
                    {d.gym_name} · {d.category_label}
                  </Text>
                </View>
                <View style={[styles.badge, { backgroundColor: `${STATUS_COLORS[d.effective_status] || colors.textDim}22` }]}>
                  <Text style={[styles.badgeText, { color: STATUS_COLORS[d.effective_status] || colors.textDim }]}>
                    {d.effective_status}
                  </Text>
                </View>
              </View>
              <View style={styles.cardMeta}>
                {d.authorized_signature ? (
                  <Text style={styles.metaText} numberOfLines={1}>
                    Signed “{d.authorized_signature}”{d.authorized_at ? ` · ${formatDate(d.authorized_at)}` : ''}
                  </Text>
                ) : d.expires_at ? (
                  <Text style={[styles.metaText, d.expired && { color: STATUS_COLORS.EXPIRED }]}>
                    {d.expired ? `Expired ${formatDate(d.expires_at)}` : `Valid until ${formatDate(d.expires_at)}`}
                  </Text>
                ) : (
                  <Text style={styles.metaText}>Filed {formatDate(d.created_at)}</Text>
                )}
              </View>
              {signable && (
                <TouchableOpacity
                  style={styles.signButton}
                  onPress={() => { setSignature(''); setSignTarget(d); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Sign ${d.title || d.category_label}`}
                >
                  <Ionicons name="create-outline" size={15} color="#fff" />
                  <Text style={styles.signButtonText}>Sign document</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        }}
      />

      <Modal visible={!!signTarget} transparent animationType="fade" onRequestClose={() => setSignTarget(null)}>
        <View style={styles.modalBackdrop}>
          <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
            <View style={styles.modalCard}>
              <Text style={styles.modalTitle}>
                Sign {signTarget?.title || signTarget?.category_label}
              </Text>
              <Text style={styles.modalBody}>
                Type your full legal name below. It is kept as the signature of
                record for {signTarget?.gym_name || 'your gym'} and cannot be undone here.
              </Text>
              <TextInput
                style={styles.signInput}
                value={signature}
                onChangeText={setSignature}
                placeholder="Your full legal name"
                placeholderTextColor={colors.textDim}
                maxLength={80}
                autoCapitalize="words"
                autoFocus
              />
              <View style={styles.modalActions}>
                <TouchableOpacity style={styles.modalCancel} onPress={() => setSignTarget(null)}>
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.modalSign, (signing || !signature.trim()) && { opacity: 0.5 }]}
                  onPress={doSign}
                  disabled={signing || !signature.trim()}
                >
                  {signing
                    ? <ActivityIndicator size="small" color="#fff" />
                    : <Text style={styles.modalSignText}>Sign</Text>}
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', padding: 40, paddingTop: 80 },
  emptyTitle: { color: colors.text, fontWeight: '800', marginTop: 12, fontSize: 15 },
  emptyBody: { color: colors.textDim, marginTop: 6, textAlign: 'center', fontSize: 13, lineHeight: 19 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: 14,
    marginHorizontal: 16,
    marginTop: 12,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconWrap: {
    width: 34, height: 34, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  cardMain: { flex: 1, minWidth: 0 },
  cardTitle: { color: colors.text, fontSize: 14, fontWeight: '700' },
  cardSub: { color: colors.textDim, fontSize: 11, marginTop: 2 },
  badge: {
    borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  cardMeta: { marginTop: 10, paddingLeft: 2 },
  metaText: { color: colors.textDim, fontSize: 12 },
  signButton: {
    marginTop: 12,
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  signButtonText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  modalScroll: { flexGrow: 1, justifyContent: 'center', width: '100%' },
  modalCard: {
    backgroundColor: colors.card, borderRadius: 16, padding: 18, width: '100%',
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  modalTitle: { color: colors.text, fontSize: 16, fontWeight: '800', marginBottom: 8 },
  modalBody: { color: colors.textDim, fontSize: 13, lineHeight: 19, marginBottom: 14 },
  signInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: 10,
    color: colors.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14,
    marginBottom: 14,
  },
  modalActions: { flexDirection: 'row', gap: 10 },
  modalCancel: {
    flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: 10,
    borderWidth: 1, borderColor: colors.border,
  },
  modalCancelText: { color: colors.textDim, fontWeight: '700' },
  modalSign: {
    flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 11,
    borderRadius: 10, backgroundColor: colors.primary,
  },
  modalSignText: { color: '#fff', fontWeight: '800' },
});
