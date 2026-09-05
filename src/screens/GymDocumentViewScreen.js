// Gym Document Viewer (Mobile M3) — opens the actual bytes of ONE gym
// document, pushed from the Documents list (tap a card) or from the sign
// flow ("view before you sign").
//
// The file streams from GET /gym/my/documents/:id/file with the JWT and is
// cached locally by lib/gymDocuments.js (bytes are immutable per document
// id — superseding issues a NEW row — so a cached copy is always current).
//
// Viewing per content type (uploads are locked to PDF/PNG/JPEG server-side):
//   • PDF   → iOS: in-app WKWebView (renders PDFs natively).
//             Android: WebView has no PDF engine, so the file is opened
//             with the device's PDF viewer via ACTION_VIEW — the standard
//             Android flow. The pane stays here with a re-open button.
//   • Image → shown in-app (pinch-zoom on iOS).
//
// SIGNING lives here too for PENDING waivers — the natural
// review-then-sign flow: read the document, then sign it right below.
// The signature sheet is the shared GymSignSheet (same behavior as the
// Documents list); a successful sign swaps in the updated row the API
// returns, so the status, signature line and CTA flip without a refetch.
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Image,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { WebView } from 'react-native-webview';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useColors } from '../theme';
import useAsyncData from '../shared/hooks/useAsyncData';
import LoadError from '../shared/components/LoadError';
import GymSignSheet from '../components/GymSignSheet';
import {
  downloadGymDocument, documentKind, documentExtension, humanFileSize,
  openPdfWithSystemViewer,
} from '../lib/gymDocuments';

const STATUS_COLORS = {
  PENDING: '#D97706',
  AUTHORIZED: '#16A34A',
  EXPIRED: '#EA580C',
  REPLACED: '#78716C',
  REVOKED: '#DC2626',
};

const KIND_LABELS = { pdf: 'PDF', image: 'Image' };

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function GymDocumentViewScreen() {
  const colors = useColors();
  const navigation = useNavigation();
  const route = useRoute();
  const [doc, setDoc] = useState(route.params?.document || null);
  const [signOpen, setSignOpen] = useState(false);
  const [intentFailed, setIntentFailed] = useState(false);
  const autoOpenRef = useRef(false);

  const styles = makeStyles(colors);

  // Header shows the document's own title, like every other detail screen.
  useEffect(() => {
    if (doc) navigation.setOptions({ title: doc.title || doc.category_label || 'Document' });
  }, [doc, navigation]);

  const { data, loading, error, reload } = useAsyncData(
    () => downloadGymDocument(doc),
    [doc?.id],
    { immediate: !!doc }
  );

  // Android PDFs: hand to the system viewer once, automatically. The
  // button below re-opens after the member comes back (or declines).
  useEffect(() => {
    if (!data || data.kind !== 'pdf' || Platform.OS !== 'android') return;
    if (autoOpenRef.current) return;
    autoOpenRef.current = true;
    openPdfWithSystemViewer(data.uri).catch(() => setIntentFailed(true));
  }, [data]);

  if (!doc) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <Ionicons name="document-outline" size={40} color={colors.textDim} />
        <Text style={styles.emptyTitle}>Document unavailable.</Text>
        <Text style={styles.emptyBody}>Go back and pick a document from your list.</Text>
      </View>
    );
  }

  const kind = documentKind(doc.content_type);
  const signable = doc.status === 'PENDING' && !doc.expired;
  const statusColor = STATUS_COLORS[doc.effective_status] || colors.textDim;
  const fileBits = [
    doc.original_filename,
    humanFileSize(doc.file_size),
    KIND_LABELS[kind] || String(doc.content_type || '').toUpperCase(),
  ].filter(Boolean);

  const onSigned = (updated) => {
    setSignOpen(false);
    if (updated) setDoc((prev) => ({ ...(prev || {}), ...updated }));
  };

  return (
    <View style={[styles.screen, { backgroundColor: colors.bg }]}>
      {kind === 'image' && data ? (
        <ScrollView
          style={styles.viewerArea}
          contentContainerStyle={styles.imageWrap}
          maximumZoomScale={3}
          minimumZoomScale={1}
          centerContent
        >
          <Image source={{ uri: data.uri }} style={styles.image} resizeMode="contain" />
        </ScrollView>
      ) : kind === 'pdf' && data && Platform.OS === 'ios' ? (
        // WKWebView renders PDFs natively — a real in-app reader with
        // paging and zoom, no external app hop.
        <WebView
          source={{ uri: data.uri }}
          style={styles.viewerArea}
          originWhitelist={['*']}
          accessibilityLabel={`PDF viewer for ${doc.title || doc.category_label}`}
        />
      ) : kind === 'pdf' && data && Platform.OS === 'android' ? (
        <ScrollView style={styles.viewerArea} contentContainerStyle={styles.androidPane}>
          <Ionicons
            name={intentFailed ? 'alert-circle-outline' : 'open-outline'}
            size={34}
            color={intentFailed ? STATUS_COLORS.REVOKED : colors.primary}
          />
          <Text style={styles.androidTitle}>
            {intentFailed ? 'No PDF viewer found' : 'PDF ready to view'}
          </Text>
          <Text style={styles.androidBody}>
            {intentFailed
              ? 'This device has no app that can open PDF files. Install a PDF viewer (most phones already have one) and try again.'
              : 'PDFs open in your device\u2019s PDF viewer. Come back here when you\u2019re done — signing stays in the app.'}
          </Text>
          <TouchableOpacity
            style={styles.openButton}
            onPress={() => {
              setIntentFailed(false);
              openPdfWithSystemViewer(data.uri).catch(() => setIntentFailed(true));
            }}
            accessibilityRole="button"
            accessibilityLabel="Open PDF in device viewer"
          >
            <Ionicons name="open-outline" size={15} color="#fff" />
            <Text style={styles.openButtonText}>
              {intentFailed ? 'Try again' : 'Open document'}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      ) : loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.loadingText}>Opening document…</Text>
        </View>
      ) : error ? (
        <LoadError message={error?.message || "Couldn't open the document."} onRetry={reload} />
      ) : null}

      {/* identity + actions — below the viewer so the file stays the hero */}
      <View style={styles.footer}>
        <View style={styles.footerTop}>
          <View style={styles.footerMain}>
            <Text style={styles.title} numberOfLines={2}>{doc.title || doc.category_label}</Text>
            <Text style={styles.sub} numberOfLines={1}>
              {doc.gym_name ? `${doc.gym_name} · ` : ''}{doc.category_label}
            </Text>
          </View>
          <View style={[styles.badge, { backgroundColor: `${statusColor}22` }]}>
            <Text style={[styles.badgeText, { color: statusColor }]}>{doc.effective_status}</Text>
          </View>
        </View>
        {fileBits.length > 0 && (
          <View style={styles.fileRow}>
            <Ionicons name="attach-outline" size={13} color={colors.textDim} />
            <Text style={styles.fileText} numberOfLines={1}>{fileBits.join(' · ')}</Text>
          </View>
        )}
        {doc.authorized_signature ? (
          <Text style={styles.signedLine} numberOfLines={1}>
            Signed “{doc.authorized_signature}”{doc.authorized_at ? ` · ${formatDate(doc.authorized_at)}` : ''}
          </Text>
        ) : signable ? (
          <TouchableOpacity
            style={styles.signButton}
            onPress={() => setSignOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={`Sign ${doc.title || doc.category_label}`}
          >
            <Ionicons name="create-outline" size={15} color="#fff" />
            <Text style={styles.signButtonText}>Sign this document</Text>
          </TouchableOpacity>
        ) : doc.expires_at && doc.expired ? (
          <Text style={[styles.signedLine, { color: STATUS_COLORS.EXPIRED }]}>
            Expired {formatDate(doc.expires_at)} — ask the gym for a fresh copy
          </Text>
        ) : null}
      </View>

      <GymSignSheet
        doc={signOpen ? doc : null}
        onClose={() => setSignOpen(false)}
        onSigned={onSigned}
      />
    </View>
  );
}

const makeStyles = (colors) => StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  loadingText: { color: colors.textDim, marginTop: 12, fontSize: 13 },
  emptyTitle: { color: colors.text, fontWeight: '800', marginTop: 12, fontSize: 15 },
  emptyBody: { color: colors.textDim, marginTop: 6, textAlign: 'center', fontSize: 13, lineHeight: 19 },
  viewerArea: { flex: 1 },
  imageWrap: { flexGrow: 1 },
  image: { flex: 1 },
  androidPane: { alignItems: 'center', padding: 40, paddingTop: 72 },
  androidTitle: { color: colors.text, fontWeight: '800', fontSize: 15, marginTop: 14 },
  androidBody: {
    color: colors.textDim, fontSize: 13, lineHeight: 19, marginTop: 8,
    textAlign: 'center',
  },
  openButton: {
    marginTop: 20,
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  openButtonText: { color: '#fff', fontWeight: '800', fontSize: 13 },
  footer: {
    backgroundColor: colors.card,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 14,
  },
  footerTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  footerMain: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 15, fontWeight: '800' },
  sub: { color: colors.textDim, fontSize: 12, marginTop: 2 },
  badge: {
    borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 10, fontWeight: '800', letterSpacing: 0.4 },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 8 },
  fileText: { color: colors.textDim, fontSize: 11.5, flexShrink: 1 },
  signedLine: { color: colors.textDim, fontSize: 12, marginTop: 8 },
  signButton: {
    marginTop: 12,
    backgroundColor: colors.primary,
    borderRadius: 10,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  signButtonText: { color: '#fff', fontWeight: '800', fontSize: 13 },
});
