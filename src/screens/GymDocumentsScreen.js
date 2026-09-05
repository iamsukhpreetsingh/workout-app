// Gym Documents — the member-facing document list & digital waivers (Phase 18).
//
// Shown from Profile → My Gym → Documents. Lists the member's documents
// across ACTIVE gym memberships: waivers, membership agreements, ID
// verification, medical clearances. Paperwork the desk filed BEFORE the
// app account was connected appears here too — documents belong to the
// gym member row, not the app account.
//
// TAPPING a card opens the actual document (Mobile M3): PDFs and scans
// stream with the member's JWT into an in-app viewer (iOS) / the device's
// PDF viewer (Android) — so the member can review the full text BEFORE
// signing, and re-read anything they've already signed. REPLACED/REVOKED
// copies stay at the desk (retention) and don't open; the app shows live
// documents only, with expiry surfaced so the member sees what needs
// renewing.
//
// SIGNING is the core action: a PENDING waiver is signed by typing the
// legal name (retained server-side as the signature of record) via the
// shared GymSignSheet — the same sheet the viewer offers after reading.
// Expired documents refuse to sign — the gym issues a fresh copy.
import React, { useCallback, useState } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, ActivityIndicator,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useColors } from '../theme';
import useAsyncData from '../shared/hooks/useAsyncData';
import LoadError from '../shared/components/LoadError';
import { fetchMyGymDocuments } from '../lib/gymApi';
import { documentKind, humanFileSize } from '../lib/gymDocuments';
import GymSignSheet from '../components/GymSignSheet';
import { GYM_DOCUMENT_VIEW } from '../shared/constants/routes';

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

const KIND_LABELS = { pdf: 'PDF', image: 'Image' };

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function GymDocumentsScreen() {
  const colors = useColors();
  const navigation = useNavigation();
  const [signTarget, setSignTarget] = useState(null);
  const { data, loading, error, reload } = useAsyncData(fetchMyGymDocuments, []);

  useFocusEffect(useCallback(() => { reload(); }, [reload]));

  const documents = Array.isArray(data) ? data : [];

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
          const viewable = !!documentKind(d.content_type) && d.is_live !== false;
          const fileBits = [
            d.original_filename,
            humanFileSize(d.file_size),
            KIND_LABELS[documentKind(d.content_type)] || '',
          ].filter(Boolean);
          return (
            <TouchableOpacity
              style={styles.card}
              activeOpacity={0.75}
              disabled={!viewable}
              onPress={() => navigation.navigate(GYM_DOCUMENT_VIEW, { document: d })}
              accessibilityRole={viewable ? 'button' : undefined}
              accessibilityLabel={viewable ? `View ${d.title || d.category_label}` : undefined}
            >
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
                {viewable && (
                  <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
                )}
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
                {viewable && fileBits.length > 0 && (
                  <View style={styles.fileRow}>
                    <Ionicons name="document-attach-outline" size={13} color={colors.textDim} />
                    <Text style={styles.fileText} numberOfLines={1}>
                      {fileBits.join(' · ')} · Tap to view
                    </Text>
                  </View>
                )}
              </View>
              {signable && (
                <TouchableOpacity
                  style={styles.signButton}
                  onPress={() => setSignTarget(d)}
                  accessibilityRole="button"
                  accessibilityLabel={`Sign ${d.title || d.category_label}`}
                >
                  <Ionicons name="create-outline" size={15} color="#fff" />
                  <Text style={styles.signButtonText}>Sign document</Text>
                </TouchableOpacity>
              )}
            </TouchableOpacity>
          );
        }}
      />

      <GymSignSheet
        doc={signTarget}
        onClose={() => setSignTarget(null)}
        onSigned={() => {
          setSignTarget(null);
          reload();
        }}
      />
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
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
  fileText: { color: colors.textDim, fontSize: 11.5, flexShrink: 1 },
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
});
