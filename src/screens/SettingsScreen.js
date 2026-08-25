import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, Switch, ScrollView, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { getSettings, updateSettings } from '../db/settings';
import { useColors } from '../theme';
import { useApp } from '../store/AppContext';
import { useAuth } from '../store/AuthContext';
import { api } from '../lib/api';
import { getPendingSyncCount } from '../db/queries';
import { getSyncSettings } from '../lib/sync';
import { getCachedProgressionSetting, fetchAndCacheProgressionSetting } from '../lib/progression';
import { getFormula } from '../progressionFormulas';
import ProgressionStrategyEditor from '../components/ProgressionStrategyEditor';
import { INTAKE_FORM, SYNC_SETTINGS } from '../shared/constants/routes';

export default function SettingsScreen({ onSwitchView }) {
  const { themeMode, setThemeMode } = useApp();
  const { user, logout } = useAuth();
  const navigation = useNavigation();
  const [trainer, setTrainer] = useState(null); // active association state

  const [isLocalOnly, setIsLocalOnly] = useState(false);
  const [progression, setProgression] = useState(null); // resolved setting
  const [progDraft, setProgDraft] = useState(null); // editable {formula_key, params}
  const [progBusy, setProgBusy] = useState(false);

  useEffect(() => {
  //   getSyncSettings().then((s) => setIsLocalOnly(s.sync_mode === 'local')).catch(() => {});
  // }, []);
      getSyncSettings().then((s) => setIsLocalOnly(s.sync_mode === 'local')).catch(() => {});
    (async () => {
      const cached = await getCachedProgressionSetting();
      setProgression(cached);
      setProgDraft({ formula_key: cached.formula_key, params: { ...cached.params } });
      // refresh in the background — the trainer may have changed things
      const fresh = await fetchAndCacheProgressionSetting();
      if (fresh) {
        setProgression(fresh);
        setProgDraft({ formula_key: fresh.formula_key, params: { ...(fresh.params || {}) } });
      }
    })();
  }, []);




  useEffect(() => {
    api('/client/trainer')
      .then((assoc) => {
        if (assoc?.status === 'active') setTrainer(assoc);
        else setTrainer(null);
      })
      .catch(() => setTrainer(null));
  }, []);


    const progDraftChanged = () => {
    if (!progression || !progDraft) return false;
    if (progDraft.formula_key !== progression.formula_key) return true;
    const a = progression.params || {};
    const b = progDraft.params || {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if ((a[k] ?? null) !== (b[k] ?? null)) return true;
    }
    return false;
  };

  const saveProgression = async () => {
    if (progBusy) return;
    setProgBusy(true);
    try {
      await api('/user/progression-settings', {
        method: 'PUT',
        body: { formula_key: progDraft.formula_key, params: progDraft.params || {} },
      });
      const fresh = await fetchAndCacheProgressionSetting(); // re-cache
      if (fresh) {
        setProgression(fresh);
        setProgDraft({ formula_key: fresh.formula_key, params: { ...(fresh.params || {}) } });
      }
      Alert.alert('Saved', 'Your progression strategy has been updated.');
    } catch (e) {
      Alert.alert('Could not save', e.message || 'Please try again.');
    } finally {
      setProgBusy(false);
    }
  };


  const disconnect = () =>
    Alert.alert(
      'Disconnect from trainer',
      `You'll lose access to workouts, diet plans, and supplement plans assigned by ${trainer?.trainer_name || 'your trainer'}. Your own workout history stays exactly as it is.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: async () => {
            try {
              await api('/client/trainer/unlink', { method: 'POST' });
              setTrainer(null);
              Alert.alert('Disconnected', "Your trainer's assigned content has been removed from your app.");
            } catch (e) {
              Alert.alert('Could not disconnect', e.message || 'Please try again.');
            }
          },
        },
      ]
    );
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
      {isLocalOnly && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1.5, borderColor: colors.red, borderRadius: 12, padding: 12, marginBottom: 12, backgroundColor: colors.card }}>
          <Ionicons name="lock-closed" size={15} color={colors.red} />
          <Text style={{ color: colors.red, fontWeight: '800', fontSize: 13, flex: 1 }}>Local Only — not backed up</Text>
        </View>
      )}

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

      <TouchableOpacity 
        style={[styles.card, { backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
        onPress={() => navigation.navigate(SYNC_SETTINGS)}
      >
        <View>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Data & Sync</Text>
          <Text style={[styles.hint, { color: colors.textDim }]}>Backup settings, sync preferences, offline mode</Text>
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.textDim} />
      </TouchableOpacity>


      {user?.role !== 'trainer' && progression && (
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Progression Strategy</Text>
          {progression.source === 'trainer_override' ? (
            <View>
              <View style={{
                flexDirection: 'row', alignItems: 'center', gap: 8,
                backgroundColor: colors.cardLight, borderLeftWidth: 3, borderLeftColor: colors.blue,
                borderRadius: 8, borderTopLeftRadius: 4, borderBottomLeftRadius: 4,
                paddingHorizontal: 10, paddingVertical: 8, marginTop: 8,
              }}>
                <Ionicons name="lock-closed" size={14} color={colors.blue} />
                <Text style={{ color: colors.blue, fontSize: 12, fontWeight: '700', flex: 1 }}>
                  Your trainer has set your progression strategy. Contact them to change it.
                </Text>
              </View>
              <View style={{ marginTop: 12 }}>
                <ProgressionStrategyEditor
                  value={progDraft}
                  onValueChange={() => {}} // read-only — trainer owns it
                  busy={false}
                />
              </View>
            </View>
          ) : (
            <View style={{ marginTop: 4 }}>
              <ProgressionStrategyEditor
                value={progDraft}
                onValueChange={setProgDraft}
                busy={progBusy}
              />
              {progDraftChanged() && (
                <TouchableOpacity
                  style={[styles.saveBtn, { backgroundColor: colors.primary, marginTop: 12 }]}
                  onPress={saveProgression}
                  disabled={progBusy}
                >
                  <Text style={styles.saveBtnText}>
                    {progBusy ? 'Saving…' : 'Save Progression Strategy'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </View>
      )}

        <TouchableOpacity 
          style={[styles.card, { backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }]}
          onPress={() => navigation.navigate(INTAKE_FORM)}
        >
          <View style={{ flex: 1, paddingRight: 8 }}>
            <Text style={[styles.cardTitle, { color: colors.text }]}>Health Profile</Text>
            <Text style={[styles.hint, { color: colors.textDim }]}>
              Allergies, goals, injuries — shared with your trainer for safer plans
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={20} color={colors.textDim} />
        </TouchableOpacity>


      {trainer ? (
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <Text style={[styles.cardTitle, { color: colors.text }]}>Trainer</Text>
          <Text style={[styles.hint, { color: colors.textDim }]}>
            Connected to {trainer.trainer_name || 'your trainer'}
          </Text>
          <TouchableOpacity
            style={[styles.saveBtn, { borderColor: colors.red, borderWidth: 1, backgroundColor: 'transparent', marginTop: 14 }]}
            onPress={disconnect}
          >
            <Text style={[styles.saveBtnText, { color: colors.red }]}>Disconnect from Trainer</Text>
          </TouchableOpacity>
        </View>
      ) : null}

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