import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, ActivityIndicator } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useColors } from '../theme';

// Full-screen barcode scanner. Emits the scanned code via onScanned(code)
// and closes. Handles the Android 13+ permission flow; a denied permission
// offers a jump to the app settings (typed entry remains the fallback).
export default function BarcodeScannerModal({ visible, onClose, onScanned }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);

  useEffect(() => {
    if (visible) setScanned(false); // fresh scan state each open
  }, [visible]);

  const handleBarcode = ({ data }) => {
    if (scanned) return; // one scan per open — debounce the rapid re-fires
    setScanned(true);
    onScanned?.(String(data).replace(/\s+/g, ''));
    onClose();
  };

  if (!visible) return null;

  // permission still loading
  if (permission === null || permission === undefined) {
    return (
      <Modal visible transparent animationType="fade">
        <View style={[styles.center, { backgroundColor: colors.bg }]}>
          <ActivityIndicator color={colors.primary} />
        </View>
      </Modal>
    );
  }

  // permission not granted yet — request it with a friendly explainer
  if (!permission.granted) {
    return (
      <Modal visible transparent animationType="fade">
        <View style={[styles.center, { backgroundColor: colors.bg, padding: 28 }]}>
          <Ionicons name="camera-outline" size={40} color={colors.textDim} />
          <Text style={styles.permTitle}>Camera access needed</Text>
          <Text style={styles.permText}>
            To scan barcodes, allow camera access. You can also type the barcode number instead.
          </Text>
          <TouchableOpacity
            style={styles.permBtn}
            onPress={async () => {
              const result = await requestPermission();
              // user denied permanently → Linking to settings is the only
              // path left; for v1 the typed fallback covers this case
              if (!result.granted) onClose();
            }}
          >
            <Text style={styles.permBtnText}>Allow Camera</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.permCancel} onPress={onClose}>
            <Text style={styles.permCancelText}>Type barcode instead</Text>
          </TouchableOpacity>
        </View>
      </Modal>
    );
  }

  return (
    <Modal visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <CameraView
          style={styles.camera}
          barcodeScannerSettings={{
            barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128'],
          }}
          onBarcodeScanned={handleBarcode}
        />
        {/* framing overlay: darkened edges + clear scan window */}
        <View style={styles.overlay} pointerEvents="none">
          <View style={styles.scanWindow} />
        </View>
        {scanned && (
          <View style={styles.foundBadge}>
            <ActivityIndicator size="small" color={colors.primary} />
          </View>
        )}
        {/* header controls */}
        <View style={styles.header}>
          <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
            <Ionicons name="close" size={26} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title}>Scan Barcode</Text>
          <View style={{ width: 40 }} />
        </View>
        <Text style={styles.hint}>Point at the product's barcode</Text>
      </View>
    </Modal>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: '#000' },
    camera: { flex: 1 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    overlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center', justifyContent: 'center',
    },
    scanWindow: {
      width: '78%', height: 200, borderRadius: 16,
      borderWidth: 2, borderColor: '#fff', backgroundColor: 'transparent',
    },
    header: {
      position: 'absolute', top: 44, left: 0, right: 0,
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: 14,
    },
    closeBtn: { padding: 8 },
    title: { color: '#fff', fontSize: 17, fontWeight: '800' },
    hint: {
      position: 'absolute', bottom: 60, alignSelf: 'center',
      color: '#fff', fontSize: 13, opacity: 0.85,
    },
    foundBadge: {
      position: 'absolute', top: '50%', left: '50%',
      marginTop: -24, marginLeft: -24, width: 48, height: 48,
      borderRadius: 24, backgroundColor: '#fff',
      alignItems: 'center', justifyContent: 'center',
    },
    permTitle: { color: colors.text, fontSize: 18, fontWeight: '800', marginTop: 14 },
    permText: { color: colors.textDim, fontSize: 13, textAlign: 'center', marginTop: 8, lineHeight: 19 },
    permBtn: {
      backgroundColor: colors.primary, borderRadius: 12,
      paddingHorizontal: 28, paddingVertical: 12, marginTop: 20,
    },
    permBtnText: { color: '#fff', fontWeight: '800' },
    permCancel: { padding: 12, marginTop: 4 },
    permCancelText: { color: colors.textDim, fontWeight: '700', fontSize: 13 },
  });