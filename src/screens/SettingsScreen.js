import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Switch, ScrollView, Alert } from 'react-native';
import { getSettings, updateSettings } from '../db/settings';
import { useColors } from '../theme';
import { useApp } from '../store/AppContext';
import { useAuth } from '../store/AuthContext';
import { getPendingSyncCount } from '../db/queries';

export default function SettingsScreen({ onSwitchView }) {
  const { themeMode, setThemeMode } = useApp();
  const { logout } = useAuth();
  const colors = useColors();
  const [settings, setSettings] = useState(null);
  const [platesText, setPlatesText] = useState('');
  const [pendingSync, setPendingSync] = useState(0);

  useEffect(() => {
    getPendingSyncCount().then(setPendingSync).catch(() => {});
  }, []);

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      setPlatesText(s.plates.join(', '));
    });
  }, []);

  if (!settings) return null;

  const save = async (patch) => setSettings(await updateSettings(patch));

  const styles = {
    container: { flex: 1 },
    heading: { fontSize: 28, fontWeight: '800', marginBottom: 16 },
    card: { borderRadius: 12, padding: 16, marginBottom: 12 },
    cardTitle: { fontSize: 16, fontWeight: '700' },
    rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    hint: { fontSize: 12, marginTop: 6 },
    label: { fontSize: 12, marginTop: 12, marginBottom: 4 },
    input: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
    unitRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
    unitBtn: { flex: 1, borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
    unitBtnText: { fontWeight: '700' },
    saveBtn: { borderRadius: 8, paddingVertical: 10, alignItems: 'center', marginTop: 10 },
    saveBtnText: { color: '#fff', fontWeight: '700' },
  };

  const savePlates = () => {
    const unit = settings.weight_unit || 'kg';
    const plates = platesText
      .split(',')
      .map((p) => parseFloat(p.trim()))
      .filter((n) => !isNaN(n) && n > 0)
      .sort((a, b) => b - a);
    if (!plates.length) {
      Alert.alert('Plates', 'Enter at least one plate size, comma separated.');
      return;
    }
    save({ plates, unit });
  };

  const setWeightUnit = (unit) => {
    const defaults = unit === 'lb'
      ? { bar_weight: 45, plates: [45, 35, 25, 10, 5, 2.5] }
      : { bar_weight: 20, plates: [20, 15, 10, 5, 2.5, 1.25] };
    setPlatesText(defaults.plates.join(', '));
    save({ weight_unit: unit, ...defaults });
  };

  const setTheme = (mode) => {
    setThemeMode(mode); // persists + restyles the whole app live
  };

  const setHaptics = (enabled) => {
    save({ haptics_enabled: enabled ? 1 : 0 });
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.bg }]} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Appearance</Text>
        <Text style={[styles.label, { color: colors.textDim }]}>Theme</Text>
        <View style={styles.unitRow}>
          {['system', 'light', 'dark'].map((m) => (
            <TouchableOpacity
              key={m}
              style={[styles.unitBtn, { backgroundColor: colors.cardLight }, themeMode === m && { backgroundColor: colors.primary }]}
              onPress={() => setTheme(m)}
            >
              <Text style={[styles.unitBtnText, { color: themeMode === m ? '#fff' : colors.textDim }]}>
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Weight Unit</Text>
        <View style={styles.unitRow}>
          {['kg', 'lb'].map((u) => (
            <TouchableOpacity
              key={u}
              style={[styles.unitBtn, { backgroundColor: colors.cardLight }, (settings.weight_unit || 'kg') === u && { backgroundColor: colors.primary }]}
              onPress={() => setWeightUnit(u)}
            >
              <Text style={[styles.unitBtnText, { color: (settings.weight_unit || 'kg') === u ? '#fff' : colors.textDim }]}>
                {u}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={[styles.hint, { color: colors.textDim }]}>All weights will be displayed in this unit.</Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <View style={styles.rowBetween}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Haptic Feedback</Text>
          <Switch
            value={settings.haptics_enabled !== 0}
            onValueChange={setHaptics}
            trackColor={{ true: colors.primary, false: colors.cardLight }}
          />
        </View>
        <Text style={[styles.hint, { color: colors.textDim }]}>Vibration on set completion, PRs, and timer end.</Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Rest timer</Text>
        <Text style={[styles.label, { color: colors.textDim }]}>Default rest (seconds)</Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.cardLight, color: colors.text }]}
          keyboardType="numeric"
          value={String(settings.default_rest_seconds)}
          onChangeText={(t) => save({ default_rest_seconds: Math.max(5, parseInt(t, 10) || 90) })}
        />
      </View>

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <View style={styles.rowBetween}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>RPE logging</Text>
          <Switch
            value={settings.rpe_enabled === 1}
            onValueChange={(v) => save({ rpe_enabled: v ? 1 : 0 })}
            trackColor={{ true: colors.primary, false: colors.cardLight }}
          />
        </View>
        <Text style={[styles.hint, { color: colors.textDim }]}>Show an optional RPE picker after completing a set.</Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Plate Calculator</Text>
        <Text style={[styles.label, { color: colors.textDim }]}>Bar weight ({settings.weight_unit || 'kg'})</Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.cardLight, color: colors.text }]}
          keyboardType="numeric"
          value={String(settings.bar_weight)}
          onChangeText={(t) => save({ bar_weight: parseFloat(t) || 0 })}
        />
        <Text style={[styles.label, { color: colors.textDim }]}>Available plates ({settings.weight_unit || 'kg'}, comma separated)</Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.cardLight, color: colors.text }]}
          value={platesText}
          onChangeText={setPlatesText}
          onEndEditing={savePlates}
        />
        <TouchableOpacity style={[styles.saveBtn, { backgroundColor: colors.primary }]} onPress={savePlates}>
          <Text style={styles.saveBtnText}>Save</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Volume Warnings</Text>
        <Text style={[styles.label, { color: colors.textDim }]}>Alert if volume drops more than (%)</Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.cardLight, color: colors.text }]}
          keyboardType="numeric"
          value={String(Math.abs(settings.vol_warning_threshold_low || -30))}
          onChangeText={(t) => save({ vol_warning_threshold_low: -Math.abs(parseInt(t, 10) || 30) })}
        />
        <Text style={[styles.label, { color: colors.textDim }]}>Alert if volume spikes more than (%)</Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.cardLight, color: colors.text }]}
          keyboardType="numeric"
          value={String(settings.vol_warning_threshold_high || 30)}
          onChangeText={(t) => save({ vol_warning_threshold_high: Math.abs(parseInt(t, 10) || 30) })}
        />
        <Text style={[styles.hint, { color: colors.textDim }]}>Compare current week vs. 4-week average.</Text>
      </View>
      {onSwitchView ? (
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Trainer Account</Text>
          <Text style={[styles.hint, { color: colors.textDim }]}>
            You are in User View — logging your own workouts.
          </Text>
          <TouchableOpacity
            style={[styles.saveBtn, { backgroundColor: colors.blue, marginTop: 14 }]}
            onPress={() => onSwitchView('trainer')}
          >
            <Text style={styles.saveBtnText}>Switch to Trainer View</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.cardTitle, { color: colors.text }]}>Account</Text>
        <Text style={[styles.hint, { color: colors.textDim }]}>
          Profile info lives in Home → profile icon. Logout is an account action, so it stays here.
        </Text>
        {pendingSync > 0 && (
          <Text style={[styles.hint, { color: colors.textDim }]}>
            {pendingSync} session{pendingSync === 1 ? '' : 's'} pending sync — will upload when you're back online.
          </Text>
        )}
        <TouchableOpacity
          style={[styles.saveBtn, { backgroundColor: colors.red, marginTop: 14 }]}
          onPress={() => logout()}
        >
          <Text style={styles.saveBtnText}>Log Out</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}