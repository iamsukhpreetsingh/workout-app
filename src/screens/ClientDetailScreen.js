import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  RefreshControl,
  TextInput,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { api, ApiError } from '../lib/api';
import LineChart from '../components/LineChart';
import BarChart from '../components/BarChart';
import CapsuleDropdown from '../components/CapsuleDropdown';
import { useColors } from '../theme';

const NUMS = { fontVariant: ['tabular-nums'] };

function fmtK(v) {
  const n = Number(v) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

function fmtDuration(sec) {
  if (!sec) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function relativeTime(iso) {
  if (!iso) return null;
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.floor(diff / 86400000);
  if (days < 1) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function isoDay(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

function weeklyVolumeBuckets(summaries) {
  const startOfWeek = (d) => {
    const date = new Date(d);
    const day = (date.getDay() + 6) % 7;
    date.setDate(date.getDate() - day);
    date.setHours(0, 0, 0, 0);
    return date;
  };
  const buckets = new Map();
  for (const s of summaries) {
    const key = startOfWeek(new Date(s.performed_at)).getTime();
    buckets.set(key, (buckets.get(key) || 0) + (Number(s.total_volume) || 0));
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([x, y]) => ({ x, y }));
}

// Trainer's Client Detail: identity + analytics tabs (Volume / Strength /
// Measurements) + content tabs (Workouts / Diet / Supplements). The selected
// time range persists across analytics-tab switches within a visit.
export default function ClientDetailScreen({ route, navigation }) {
  const colors = useColors();
  const styles = makeStyles(colors);
  const { clientId, clientName, adherence, lastActive, associatedAt } = route.params || {};

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);
  const [error, setError] = useState(null);

  // analytics
  const [aTab, setATab] = useState('volume');
  const [volumeView, setVolumeView] = useState('trend'); // trend | perSession | muscle
  const [range, setRange] = useState('week');
  const [customFrom, setCustomFrom] = useState(isoDay(-30));
  const [customTo, setCustomTo] = useState(isoDay(0));
  const [customOpen, setCustomOpen] = useState(false);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartData, setChartData] = useState([]);
  const [chartMode, setChartMode] = useState('line'); // line | bars-v | bars-h
  const [chartEmptyMsg, setChartEmptyMsg] = useState(null);
  const [exerciseList, setExerciseList] = useState([]);
  const [strengthExercise, setStrengthExercise] = useState(null);
  const [metricTypes, setMetricTypes] = useState([]);
  const [metricType, setMetricType] = useState(null);

  // content
  const [cTab, setCTab] = useState('workouts');
  const [activeTab, setActiveTab] = useState('overview'); // overview | analytics | workouts | diet | supplements
  const [activity, setActivity] = useState([]);
  const [summaries, setSummaries] = useState([]);
  const [assignedPlans, setAssignedPlans] = useState([]);
  const [dietPlans, setDietPlans] = useState([]);
  const [supplementPlans, setSupplementPlans] = useState([]);
  const [expanded, setExpanded] = useState(null);
  const detailCache = useRef({}); // summaryId → per-set detail (per visit)

  React.useLayoutEffect(() => {
    navigation.setOptions({ title: clientName || 'Client' });
  }, [navigation, clientName]);

  const rangeParams = useMemo(() => {
    if (range === 'week') return { from: isoDay(-7), to: isoDay(0) };
    if (range === 'month') return { from: isoDay(-30), to: isoDay(0) };
    return { from: customFrom, to: customTo };
  }, [range, customFrom, customTo]);

  const loadContent = useCallback(async () => {
    try {
      const [rows, plans, diet, supp] = await Promise.all([
        api(`/trainer/clients/${clientId}/session-summaries?limit=100&offset=0`),
        api(`/trainer/clients/${clientId}/assigned-plans`).catch(() => []),
        api(`/trainer/clients/${clientId}/diet-plans`).catch(() => []),
        api(`/trainer/clients/${clientId}/supplement-plans`).catch(() => []),
      ]);
      setSummaries(rows);
      setAssignedPlans(plans);
      setDietPlans(diet);
      setSupplementPlans(supp);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setAccessDenied(true);
      else setError(e.message || 'Could not load client');
    }
  }, [clientId]);

  useFocusEffect(
    useCallback(() => {
      loadContent().finally(() => setLoading(false));
    }, [loadContent])
  );

  const refresh = async () => {
    setRefreshing(true);
    await loadContent();
    setRefreshing(false);
  };

  // analytics re-query — runs on tab / range / picker changes; loading state
  // prevents stale-chart flashes between tabs
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      setChartLoading(true);
      setChartEmptyMsg(null);
      try {
        const { from, to } = rangeParams;
        const q = `from=${from}&to=${to}`;
        if (aTab === 'volume') {
          if (volumeView === 'trend') {
            const rows = await api(`/trainer/clients/${clientId}/session-summaries?limit=100&offset=0&${q}`);
            const buckets = weeklyVolumeBuckets(rows);
            if (cancelled) return;
            setChartMode('line');
            setChartData(buckets);
            if (buckets.length < 2) setChartEmptyMsg('Not enough data in this range yet.');
          } else if (volumeView === 'perSession') {
            // reuses the range-filtered summaries endpoint (no dedicated one)
            const rows = await api(`/trainer/clients/${clientId}/session-summaries?limit=100&offset=0&${q}`);
            if (cancelled) return;
            setChartMode('bars-v');
            setChartData(
              rows.slice().reverse().map((r) => ({
                label: String(new Date(r.performed_at).getDate()),
                value: Number(r.total_volume) || 0,
              }))
            );
            if (!rows.length) setChartEmptyMsg('No sessions in this range yet.');
          } else {
            const rows = await api(`/trainer/clients/${clientId}/volume-by-muscle-group?${q}`);
            if (cancelled) return;
            setChartMode('bars-h');
            // NULL muscle group renders as "Untagged" so totals reconcile
            setChartData(
              rows.map((r) => ({ label: r.muscle_group || 'Untagged', value: Number(r.volume) || 0 }))
            );
            if (!rows.length) setChartEmptyMsg('No volume data in this range yet.');
          }
        } else if (aTab === 'strength') {
          setChartMode('line');
          const exercises = await api(`/trainer/clients/${clientId}/exercises`);
          if (cancelled) return;
          setExerciseList(exercises.map((e) => ({ value: e.exercise_name, label: e.exercise_name })));
          if (!exercises.length) {
            setChartData([]);
            setChartEmptyMsg('No synced strength data yet.');
            return;
          }
          const pick = strengthExercise || exercises[0].exercise_name;
          if (!strengthExercise) setStrengthExercise(pick);
          const rows = await api(`/trainer/clients/${clientId}/strength?exercise=${encodeURIComponent(pick)}&${q}`);
          if (cancelled) return;
          const pts = rows.map((r) => ({ x: new Date(r.performed_at).getTime(), y: Number(r.best_e1rm) }));
          setChartData(pts);
          if (pts.length < 2) setChartEmptyMsg('Not enough sessions for this exercise in this range.');
        } else {
          setChartMode('line');
          const types = await api(`/trainer/clients/${clientId}/measurement-types`);
          if (cancelled) return;
          setMetricTypes(types.map((t) => ({ value: t, label: t.replace(/_/g, ' ') })));
          if (!types.length) {
            setChartData([]);
            setChartEmptyMsg('No measurements logged yet.');
            return;
          }
          const pick = metricType || types[0];
          if (!metricType) setMetricType(pick);
          const rows = await api(`/trainer/clients/${clientId}/measurements?metric_type=${encodeURIComponent(pick)}&${q}`);
          if (cancelled) return;
          const pts = rows.map((r) => ({ x: new Date(r.date).getTime(), y: Number(r.value) }));
          setChartData(pts);
          if (pts.length < 2) setChartEmptyMsg('Not enough entries in this range yet.');
        }
      } catch (e) {
        if (!cancelled) {
          setChartData([]);
          setChartEmptyMsg(e.message || 'Could not load chart');
        }
      } finally {
        if (!cancelled) setChartLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [clientId, aTab, rangeParams, strengthExercise, metricType, volumeView]);

  // Overview's unified Recent Activity feed - workouts, measurements, and
  // diet/supplement check-ins merged and sorted by date. Read-only
  // composition of existing endpoints (no new aggregations).
  const loadActivity = useCallback(async () => {
    try {
      const from = isoDay(-30);
      const dietReqs = dietPlans.map((pl) =>
        api(`/trainer/clients/${clientId}/diet-plans/${pl.id}/checkins?from=${from}`).catch(() => [])
      );
      const suppReqs = supplementPlans.map((pl) =>
        api(`/trainer/clients/${clientId}/supplement-plans/${pl.id}/checkins?from=${from}`).catch(() => [])
      );
      const [meas, ...rest] = await Promise.all([
        api(`/trainer/clients/${clientId}/measurements?from=${from}`).catch(() => []),
        ...dietReqs,
        ...suppReqs,
      ]);
      const dietCis = rest.slice(0, dietPlans.length);
      const suppCis = rest.slice(dietPlans.length);

      const items = [];
      for (const sm of summaries.slice(0, 8)) {
        items.push({
          at: new Date(sm.performed_at).getTime(),
          icon: 'barbell-outline',
          text: `Completed "${sm.name || 'Workout'}" - ${fmtK(sm.total_volume)} vol`,
        });
      }
      for (const m2 of meas) {
        items.push({
          at: new Date(m2.date).getTime(),
          icon: 'scale-outline',
          text: `Logged ${m2.metric_type.replace(/_/g, ' ')} - ${m2.value}${m2.unit || ''}`,
        });
      }
      dietPlans.forEach((pl, i) => {
        for (const c of dietCis[i] || []) {
          items.push({
            at: new Date(c.date).getTime(),
            icon: 'nutrition-outline',
            text: `${c.followed ? 'Followed' : 'Missed'} diet "${pl.name}"`,
          });
        }
      });
      supplementPlans.forEach((pl, i) => {
        for (const c of suppCis[i] || []) {
          items.push({
            at: new Date(c.date).getTime(),
            icon: 'medkit-outline',
            text: `${c.taken ? 'Took' : 'Missed'} supplements "${pl.name}"`,
          });
        }
      });
      items.sort((a, b) => b.at - a.at);
      setActivity(items.slice(0, 8));
    } catch {
      setActivity([]);
    }
  }, [clientId, dietPlans, supplementPlans, summaries]);


  // accordion — fetch drill-down exactly once per visit, then cache
  const toggleExpand = async (summaryId) => {
    if (expanded === summaryId) {
      setExpanded(null);
      return;
    }
    setExpanded(summaryId);
    if (!detailCache.current[summaryId]) {
      try {
        const details = await api(`/trainer/clients/${clientId}/sessions/${summaryId}/details`);
        detailCache.current[summaryId] = details;
      } catch (e) {
        detailCache.current[summaryId] = { error: e.message || 'Could not load detail' };
      }
      // re-render with the populated cache
      setExpanded(null);
      requestAnimationFrame(() => setExpanded(summaryId));
    }
  };

  if (loading) {
    return (
      <View style={[styles.container, { justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (accessDenied) {
    return (
      <View style={[styles.container, styles.centerWrap]}>
        <Ionicons name="lock-closed-outline" size={36} color={colors.textDim} />
        <Text style={styles.emptyTitle}>No longer your client</Text>
        <Text style={styles.emptySub}>
          This association was revoked. You no longer have access to this client's data.
        </Text>
      </View>
    );
  }

  const initials = (clientName || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const sinceLabel = associatedAt
    ? new Date(associatedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : null;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={{ padding: 20, paddingBottom: 48 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
    >
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {/* identity */}
      <View style={styles.heroRow}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{initials}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.name}>{clientName || 'Client'}</Text>
          <Text style={[styles.meta, NUMS]}>
            {sinceLabel ? `Client since ${sinceLabel} · ` : ''}
            {adherence != null ? `${Math.round(adherence)}% adherence` : '—'}
          </Text>
          <Text style={styles.meta}>
            {lastActive ? `Last workout ${relativeTime(lastActive).toLowerCase()}` : 'No workouts yet'}
          </Text>
        </View>
      </View>

      {/* ── Top tabs (scrollable second-level nav) ── */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.topTabScroll} contentContainerStyle={styles.topTabRow}>
        {[
          { key: 'overview', label: 'Overview' },
          { key: 'analytics', label: 'Analytics' },
          { key: 'workouts', label: 'Workouts' },
          { key: 'diet', label: 'Diet' },
          { key: 'supplements', label: 'Supplements' },
        ].map((t) => {
          const on = activeTab === t.key;
          return (
            <TouchableOpacity
              key={t.key}
              style={[styles.topTab, on && styles.topTabOn]}
              onPress={() => setActiveTab(t.key)}
            >
              <Text style={[styles.topTabText, on && { color: '#fff' }]}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {activeTab === 'overview' && (
        <OverviewPanel
          styles={styles}
          colors={colors}
          navigation={navigation}
          clientId={clientId}
          clientName={clientName}
          summaries={summaries}
          dietPlans={dietPlans}
          supplementPlans={supplementPlans}
          activity={activity}
          onLoadActivity={loadActivity}
        />
      )}

      {activeTab === 'analytics' && (
        <>
      {/* ── Analytics tabs ── */}
      <Segmented
        styles={styles}
        value={aTab}
        onChange={setATab}
        options={[
          { value: 'volume', label: 'Volume' },
          { value: 'strength', label: 'Strength' },
          { value: 'measurements', label: 'Measurements' },
        ]}
      />

      <View style={styles.rangeRow}>
        {['week', 'month'].map((r) => (
          <TouchableOpacity
            key={r}
            style={[styles.rangeChip, range === r && styles.rangeChipOn]}
            onPress={() => setRange(r)}
          >
            <Text style={[styles.rangeChipText, range === r && { color: '#fff' }]}>
              {r === 'week' ? 'Week' : 'Month'}
            </Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          style={[styles.rangeChip, styles.rangeCustom, range === 'custom' && styles.rangeChipOn]}
          onPress={() => setCustomOpen(true)}
        >
          <Text style={[styles.rangeChipText, range === 'custom' && { color: '#fff' }]} numberOfLines={1}>
            {range === 'custom' ? `${customFrom} → ${customTo}` : 'Custom'}
          </Text>
        </TouchableOpacity>
      </View>

      {aTab === 'volume' && (
        <View style={{ marginBottom: 10 }}>
          <View style={styles.viewByRow}>
            <Text style={styles.viewByLabel}>View by</Text>
            <CapsuleDropdown
              value={volumeView}
              options={[
                { value: 'trend', label: 'Weekly Trend' },
                { value: 'perSession', label: 'Per Session' },
                { value: 'muscle', label: 'By Muscle Group' },
              ]}
              onChange={setVolumeView}
              placeholder="Select view"
              disabled={false}
            />
          </View>
        </View>
      )}

      {aTab === 'strength' && (
        <View style={{ marginBottom: 10 }}>
          <CapsuleDropdown
            value={strengthExercise}
            options={exerciseList}
            onChange={setStrengthExercise}
            placeholder="Select an exercise"
            disabled={!exerciseList.length}
          />
        </View>
      )}
      {aTab === 'measurements' && (
        <View style={{ marginBottom: 10 }}>
          <CapsuleDropdown
            value={metricType}
            options={metricTypes}
            onChange={setMetricType}
            placeholder="Select a measurement"
            disabled={!metricTypes.length}
          />
        </View>
      )}

      <View style={styles.card}>
        {chartLoading ? (
          <View style={styles.chartLoading}><ActivityIndicator color={colors.primary} /></View>
        ) : chartEmptyMsg ? (
          <Text style={styles.emptyChart}>{chartEmptyMsg}</Text>
        ) : chartMode === 'line' ? (
          <LineChart
            data={chartData}
            height={170}
            color={aTab === 'measurements' ? colors.green : aTab === 'strength' ? colors.blue : undefined}
            yLabel={aTab === 'measurements' ? '' : aTab === 'strength' ? 'e1RM' : 'vol'}
          />
        ) : (
          <BarChart data={chartData} height={170} horizontal={chartMode === 'bars-h'} />
        )}
      </View>
        </>
      )}

      {activeTab === 'workouts' && (
        <View>
          <Text style={styles.groupLabel}>Recent</Text>
          {summaries.length === 0 && (
            <Text style={styles.emptySub}>
              No synced workouts yet — sessions appear here as your client trains.
            </Text>
          )}
          {summaries.map((s) => {
            const isOpen = expanded === s.id;
            const details = detailCache.current[s.id];
            return (
              <View key={s.id} style={styles.card}>
                <TouchableOpacity style={styles.sessRow} onPress={() => toggleExpand(s.id)}>
                  <View style={styles.dateBlock}>
                    <Text style={[styles.dateDay, NUMS]}>{new Date(s.performed_at).getDate()}</Text>
                    <Text style={styles.dateMon}>
                      {new Date(s.performed_at).toLocaleDateString(undefined, { month: 'short' })}
                    </Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sessName} numberOfLines={1}>
                      {s.name || 'Workout'}
                    </Text>
                    <Text style={[styles.meta, NUMS]}>
                      {s.exercise_count} ex · {s.working_set_count} sets · {fmtK(s.total_volume)} vol
                      {s.duration_seconds ? ` · ${fmtDuration(s.duration_seconds)}` : ''}
                    </Text>
                  </View>
                  <Ionicons name={isOpen ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textDim} />
                </TouchableOpacity>

                {isOpen && (
                  <View style={styles.detailWrap}>
                    {!details ? (
                      <ActivityIndicator color={colors.primary} size="small" />
                    ) : details.error ? (
                      <Text style={styles.error}>{details.error}</Text>
                    ) : (
                      details.map((ex) => (
                        <View key={`${ex.exercise_name}-${ex.order_index}`} style={styles.detailEx}>
                          <Text style={styles.detailExName}>{ex.exercise_name}</Text>
                          {ex.sets.map((set, i) => (
                            <View key={i} style={styles.detailSetRow}>
                              <Text style={[styles.detailCell, NUMS]}>{set.set_number}</Text>
                              <Text style={[styles.detailCell, set.set_type === 'warmup' && styles.warmupText]}>
                                {TYPE_TAG[set.set_type] || 'W'}
                              </Text>
                              <Text style={[styles.detailCell, NUMS, set.set_type === 'warmup' && styles.warmupText]}>
                                {set.weight}
                              </Text>
                              <Text style={[styles.detailCell, NUMS, set.set_type === 'warmup' && styles.warmupText]}>
                                {set.reps}
                              </Text>
                            </View>
                          ))}
                        </View>
                      ))
                    )}
                  </View>
                )}
              </View>
            );
          })}

          <Text style={[styles.groupLabel, { marginTop: 18 }]}>Assigned</Text>
          {assignedPlans.length === 0 && (
            <Text style={styles.emptySub}>Nothing assigned yet — build one below.</Text>
          )}
          {assignedPlans.map((ap) => (
            <View key={ap.id} style={styles.card}>
              <TouchableOpacity
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 }}
                activeOpacity={0.8}
                onPress={() => navigation.navigate('AssignedPlanDetail', { planId: ap.id, clientId, clientName })}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.sessName} numberOfLines={1}>
                    {ap.name}
                  </Text>
                  <Text style={[styles.meta, NUMS]}>
                    {ap.exercise_count} exercises · assigned{' '}
                    {new Date(ap.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.editIconBtn}
                onPress={() => navigation.navigate('AssignWorkout', { clientId, clientName, planId: ap.id })}
              >
                <Ionicons name="create-outline" size={18} color={colors.textDim} />
              </TouchableOpacity>
            </View>
          ))}

          <TouchableOpacity
            style={styles.assignBtn}
            onPress={() => navigation.navigate('AssignWorkout', { clientId, clientName })}
          >
            <Ionicons name="add-circle-outline" size={20} color="#fff" />
            <Text style={styles.assignText}>Assign Workout</Text>
          </TouchableOpacity>
        </View>
      )}

      {activeTab === 'diet' && (
        <CoachingList
          kind="diet"
          plans={dietPlans}
          styles={styles}
          colors={colors}
          navigation={navigation}
          clientId={clientId}
          clientName={clientName}
          emptyLabel="No diet plans assigned yet."
        />
      )}

      {activeTab === 'supplements' && (
        <CoachingList
          kind="supplement"
          plans={supplementPlans}
          styles={styles}
          colors={colors}
          navigation={navigation}
          clientId={clientId}
          clientName={clientName}
          emptyLabel="No supplement plans assigned yet."
        />
      )}

      {/* custom range modal */}
      <Modal visible={customOpen} transparent animationType="fade" onRequestClose={() => setCustomOpen(false)}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={() => setCustomOpen(false)}>
          <View style={styles.customSheet}>
            <Text style={styles.sheetTitle}>Custom Range</Text>
            <Text style={styles.dateLabel}>From (YYYY-MM-DD)</Text>
            <TextInput
              style={styles.dateInput}
              value={customFrom}
              onChangeText={setCustomFrom}
              placeholder="2026-07-01"
              placeholderTextColor={colors.textDim}
            />
            <Text style={styles.dateLabel}>To (YYYY-MM-DD)</Text>
            <TextInput
              style={styles.dateInput}
              value={customTo}
              onChangeText={setCustomTo}
              placeholder="2026-08-01"
              placeholderTextColor={colors.textDim}
            />
            <TouchableOpacity
              style={styles.applyBtn}
              onPress={() => {
                if (/^\d{4}-\d{2}-\d{2}$/.test(customFrom) && /^\d{4}-\d{2}-\d{2}$/.test(customTo)) {
                  setRange('custom');
                  setCustomOpen(false);
                }
              }}
            >
              <Text style={styles.applyBtnText}>Apply</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </ScrollView>
  );
}

const TYPE_TAG = { working: 'W', warmup: 'WU', dropset: 'DS', failure: 'F' };

// ── Overview panel ──────────────────────────────────────────────────────
// Week/month stat cards + the one place all three assign actions live
// together + a merged recent-activity feed.
function OverviewPanel({
  styles, colors, navigation, clientId, clientName,
  summaries, activity, onLoadActivity,
}) {
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
    { label: 'Assign Workout', icon: 'barbell-outline', to: 'AssignWorkout' },
    { label: 'Assign Diet', icon: 'nutrition-outline', to: 'DietPlanBuilder', kind: 'diet' },
    { label: 'Assign Supplement', icon: 'medkit-outline', to: 'SupplementPlanBuilder', kind: 'supplement' },
  ];

  return (
    <View>
      <View style={styles.statRow}>
        <View style={styles.statCard}>
          <Text style={[styles.statBig, NUMS]}>{wk.count}</Text>
          <Text style={styles.statLabel}>workouts this week</Text>
          <Text style={[styles.statVol, NUMS]}>{fmtK(wk.vol)} vol</Text>
        </View>
        <View style={styles.statCard}>
          <Text style={[styles.statBig, NUMS]}>{mo.count}</Text>
          <Text style={styles.statLabel}>workouts this month</Text>
          <Text style={[styles.statVol, NUMS]}>{fmtK(mo.vol)} vol</Text>
        </View>
      </View>

      <Text style={styles.groupLabel}>Quick Actions</Text>
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

// diet/supplement list body for the content tabs
function CoachingList({ kind, plans, styles, colors, navigation, clientId, clientName, emptyLabel }) {
  const builder = kind === 'diet' ? 'DietPlanBuilder' : 'SupplementPlanBuilder';
  return (
    <View>
      {plans.length === 0 && <Text style={styles.emptySub}>{emptyLabel}</Text>}
      {plans.map((p) => (
        <TouchableOpacity
          key={p.id}
          style={styles.card}
          activeOpacity={0.8}
          onPress={() =>
            navigation.navigate('CoachingPlanDetail', { planId: p.id, kind, clientId, clientName })
          }
        >
          <View style={{ flex: 1 }}>
            <Text style={styles.sessName} numberOfLines={1}>
              {p.name}
            </Text>
            <Text style={[styles.meta, NUMS]}>
              {p.item_count} {kind === 'diet' ? 'meals' : 'supplements'} · assigned{' '}
              {new Date(p.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
        </TouchableOpacity>
      ))}
      <TouchableOpacity
        style={styles.assignBtn}
        onPress={() => navigation.navigate(builder, { clientId, clientName, kind })}
      >
        <Ionicons name="add-circle-outline" size={20} color="#fff" />
        <Text style={styles.assignText}>
          {kind === 'diet' ? 'Assign Diet Plan' : 'Assign Supplement Plan'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// segmented control — same visual language as the client Routines tabs
function Segmented({ styles, value, onChange, options }) {
  return (
    <View style={styles.segRow}>
      {options.map((o) => {
        const on = value === o.value;
        return (
          <TouchableOpacity key={o.value} style={[styles.segBtn, on && styles.segBtnOn]} onPress={() => onChange(o.value)}>
            <Text style={[styles.segText, on && { color: '#fff' }]}>{o.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const makeStyles = (colors) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bg },
    centerWrap: { alignItems: 'center', justifyContent: 'center', padding: 32 },
    error: { color: colors.red, fontSize: 12, marginBottom: 10 },

    heroRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 16 },
    avatar: {
      width: 52, height: 52, borderRadius: 26, backgroundColor: colors.primary,
      alignItems: 'center', justifyContent: 'center',
    },
    avatarText: { color: '#fff', fontWeight: '800', fontSize: 18 },
    name: { color: colors.text, fontSize: 20, fontWeight: '800' },
    meta: { color: colors.textDim, fontSize: 12, marginTop: 2 },

    topTabScroll: { flexGrow: 0, marginTop: 4, marginBottom: 12 },
    topTabRow: { gap: 8, paddingHorizontal: 0, paddingBottom: 2 },
    topTab: {
      borderRadius: 16, paddingHorizontal: 14, paddingVertical: 7,
      backgroundColor: colors.cardLight,
    },
    topTabOn: { backgroundColor: colors.blue },
    topTabText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },

    statRow: { flexDirection: 'row', gap: 10, marginBottom: 6 },
    statCard: {
      flex: 1, backgroundColor: colors.card, borderRadius: 14, padding: 14, alignItems: 'center',
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    statBig: { color: colors.primary, fontSize: 26, fontWeight: '800' },
    statLabel: { color: colors.textDim, fontSize: 11, marginTop: 2 },
    statVol: { color: colors.text, fontSize: 12, fontWeight: '700', marginTop: 4 },
    qaRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 6 },
    qaBtn: {
      flexDirection: 'row', alignItems: 'center', gap: 7,
      borderWidth: 1.5, borderColor: colors.primary, borderRadius: 12,
      paddingHorizontal: 13, paddingVertical: 10,
    },
    qaText: { color: colors.primary, fontWeight: '700', fontSize: 12 },
    activityRow: {
      flexDirection: 'row', alignItems: 'center', gap: 10,
      backgroundColor: colors.card, borderRadius: 12, padding: 12, marginBottom: 6,
    },
    activityText: { color: colors.text, fontSize: 13, flex: 1 },
    activityWhen: { color: colors.textDim, fontSize: 11 },

    segRow: {
      flexDirection: 'row', backgroundColor: colors.cardLight,
      borderRadius: 12, padding: 3, marginBottom: 10,
    },
    segBtn: { flex: 1, alignItems: 'center', justifyContent: 'center', borderRadius: 10, paddingVertical: 8 },
    segBtnOn: { backgroundColor: colors.primary },
    segText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },

    rangeRow: { flexDirection: 'row', gap: 8, marginBottom: 10 },
    rangeChip: {
      backgroundColor: colors.cardLight, borderRadius: 14,
      paddingHorizontal: 14, paddingVertical: 6,
    },
    rangeCustom: { flex: 1, alignItems: 'center' },
    rangeChipOn: { backgroundColor: colors.primary },
    rangeChipText: { color: colors.textDim, fontWeight: '700', fontSize: 12 },

    viewByRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    viewByLabel: { color: colors.textDim, fontWeight: '600', fontSize: 12 },

    card: {
      backgroundColor: colors.card, borderRadius: 14, padding: 12, marginBottom: 8,
      shadowColor: '#000', shadowOffset: { width: 0, height: 3 },
      shadowOpacity: 0.12, shadowRadius: 8, elevation: 2,
    },
    chartLoading: { height: 170, alignItems: 'center', justifyContent: 'center' },
    emptyChart: { color: colors.textDim, fontSize: 12, textAlign: 'center', paddingVertical: 24 },

    groupLabel: {
      color: colors.textDim, fontSize: 12, fontWeight: '800',
      letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 10,
    },

    sessRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
    dateBlock: {
      width: 46, height: 46, borderRadius: 12, backgroundColor: colors.cardLight,
      alignItems: 'center', justifyContent: 'center',
    },
    dateDay: { color: colors.text, fontSize: 17, fontWeight: '800', lineHeight: 18 },
    dateMon: { color: colors.textDim, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 },
    sessName: { color: colors.text, fontSize: 15, fontWeight: '700' },

    detailWrap: { marginTop: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
    detailEx: { marginBottom: 10 },
    detailExName: { color: colors.text, fontWeight: '700', fontSize: 13, marginBottom: 4 },
    detailSetRow: { flexDirection: 'row' },
    detailCell: { color: colors.text, flex: 1, textAlign: 'center', fontSize: 12 },
    warmupText: { color: colors.textDim },

    emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '800', marginTop: 12 },
    emptySub: { color: colors.textDim, fontSize: 13, marginBottom: 10 },

    assignBtn: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
      backgroundColor: colors.primary, borderRadius: 14, padding: 16, marginTop: 16,
    },
    assignText: { color: '#fff', fontWeight: '800' },
    editIconBtn: { padding: 8 },

    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 28 },
    customSheet: { backgroundColor: colors.card, borderRadius: 16, padding: 20 },
    sheetTitle: { color: colors.text, fontSize: 17, fontWeight: '800', marginBottom: 12 },
    dateLabel: { color: colors.textDim, fontSize: 12, marginBottom: 4 },
    dateInput: {
      backgroundColor: colors.cardLight, color: colors.text, borderRadius: 10,
      paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12,
    },
    applyBtn: { backgroundColor: colors.primary, borderRadius: 10, padding: 12, alignItems: 'center' },
    applyBtnText: { color: '#fff', fontWeight: '700' },
  });
