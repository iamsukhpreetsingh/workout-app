import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Rect, Text as SvgText, Line } from 'react-native-svg';
import { useColors } from '../theme';

// Lightweight bar chart (vertical bars) built on react-native-svg, matching
// the LineChart's token usage. data: [{ label, value }] or [{ x, y, label }].
// Horizontal mode renders label/value rows instead of an axis.
export default function BarChart({ data, height = 170, horizontal = false, color }) {
  const colors = useColors();
  const barColor = color || colors.primary;

  if (!data || !data.length) {
    return (
      <View style={styles.empty}>
        <Text style={{ color: colors.textDim }}>No data in this range</Text>
      </View>
    );
  }

  if (horizontal) {
    const max = Math.max(...data.map((d) => d.value), 1);
    return (
      <View style={styles.hWrap}>
        {data.map((d, i) => (
          <View key={i} style={styles.hRow}>
            <Text style={[styles.hLabel, { color: colors.textDim }]} numberOfLines={1}>
              {d.label}
            </Text>
            <View style={[styles.hTrack, { backgroundColor: colors.cardLight }]}>
              <View
                style={{
                  height: '100%',
                  width: `${Math.max(2, (d.value / max) * 100)}%`,
                  backgroundColor: barColor,
                  borderRadius: 4,
                }}
              />
            </View>
            <Text style={[styles.hValue, { color: colors.text }]}>{fmtNum(d.value)}</Text>
          </View>
        ))}
      </View>
    );
  }

  const W = 320;
  const H = height;
  const padB = 22;
  const padT = 8;
  const values = data.map((d) => d.value);
  const max = Math.max(...values, 1);
  const slot = (W - 8) / data.length;
  const barW = Math.min(26, slot * 0.65);

  return (
    <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
      <Line x1={4} x2={W - 4} y1={H - padB} y2={H - padB} stroke={colors.border} strokeWidth={1} />
      {data.map((d, i) => {
        const barH = ((d.value / max) * (H - padB - padT)) || 0;
        const x = 4 + i * slot + (slot - barW) / 2;
        const y = H - padB - barH;
        return (
          <Rect key={i} x={x} y={y} width={barW} height={Math.max(1, barH)} fill={barColor} rx={3} />
        );
      })}
      {data.map((d, i) =>
        d.label ? (
          <SvgText
            key={`l${i}`}
            x={4 + i * slot + slot / 2}
            y={H - 8}
            fill={colors.textDim}
            fontSize={7.5}
            textAnchor="middle"
          >
            {d.label}
          </SvgText>
        ) : null
      )}
      {data.map((d, i) =>
        i === 0 || i === data.length - 1 || data.length <= 6 ? (
          <SvgText
            key={`v${i}`}
            x={4 + i * slot + slot / 2}
            y={Math.max(10, H - padB - ((d.value / max) * (H - padB - padT)) - 3)}
            fill={colors.textDim}
            fontSize={8}
            textAnchor="middle"
          >
            {fmtNum(d.value)}
          </SvgText>
        ) : null
      )}
    </Svg>
  );
}

function fmtNum(v) {
  const n = Number(v) || 0;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));
}

const styles = StyleSheet.create({
  empty: { height: 120, justifyContent: 'center', alignItems: 'center' },
  hWrap: { paddingVertical: 4 },
  hRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  hLabel: { fontSize: 11, fontWeight: '600', width: 78, textAlign: 'right' },
  hTrack: { flex: 1, height: 14, borderRadius: 4, overflow: 'hidden' },
  hValue: { fontSize: 11, fontWeight: '700', width: 44, fontVariant: ['tabular-nums'] },
});
