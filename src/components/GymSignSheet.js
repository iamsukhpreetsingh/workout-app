// GymSignSheet — the digital-waiver signature sheet, shared by the
// Documents list AND the document viewer (Mobile M3).
//
// Extracted verbatim from GymDocumentsScreen so "sign" behaves identically
// wherever it's offered: the member types their full legal name, which the
// server retains as the signature of record (PENDING → AUTHORIZED). The
// API returns the freshly-updated row, handed to onSigned so the caller
// can refresh its own copy of the document.
import React, { useEffect, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ActivityIndicator, ScrollView,
  Modal, StyleSheet, Alert,
} from 'react-native';
import { useColors } from '../theme';
import { signGymDocument } from '../lib/gymApi';

export default function GymSignSheet({ doc, onClose, onSigned }) {
  const colors = useColors();
  const [signature, setSignature] = useState('');
  const [signing, setSigning] = useState(false);

  // Fresh sheet per document — a typed name must never leak from one
  // waiver into the next.
  useEffect(() => {
    setSignature('');
    setSigning(false);
  }, [doc?.id]);

  if (!doc) return null;

  const doSign = () => {
    const name = signature.trim();
    if (!name) return;
    setSigning(true);
    signGymDocument(doc.id, name)
      .then((updated) => {
        onSigned?.(updated || null);
      })
      .catch((e) => {
        // signing errors surface inline: expired, already signed, membership inactive
        onClose?.();
        Alert.alert('Could not sign', e?.message || 'Please try again.');
      })
      .finally(() => setSigning(false));
  };

  const styles = makeStyles(colors);

  return (
    <Modal visible={!!doc} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <ScrollView contentContainerStyle={styles.modalScroll} keyboardShouldPersistTaps="handled">
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>
              Sign {doc.title || doc.category_label}
            </Text>
            <Text style={styles.modalBody}>
              Type your full legal name below. It is kept as the signature of
              record for {doc.gym_name || 'your gym'} and cannot be undone here.
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
              <TouchableOpacity style={styles.modalCancel} onPress={onClose}>
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
  );
}

const makeStyles = (colors) => StyleSheet.create({
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
