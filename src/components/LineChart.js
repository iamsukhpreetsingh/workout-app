import React from 'react';
import { View, Text } from 'react-native';
import Svg, { Polyline, Line, Circle, Text as SvgText } from 'react-native-svg';
import { useColors } from '../theme';
import { fmtShortDate } from '../shared/utils/format';

// Simple line chart built on react-native-svg.
// data: [{ x: timestamp, y: number }]
export default function LineChart({ data, height = 180, color, yLabel = '' }) {
  const colors = useColors();
  const chartColor = color ?? colors.primary;

  const styles = {
    empty: {
      height: 120,
      justifyContent: 'center',
      alignItems: 'center',
    },
    emptyText: { color: colors.textDim },
  };

  const W = 320;
  const H = height;
  const padL = 40;
  const padR = 12;
  const padT = 14;
  const padB = 26;

  if (!data || data.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>No data yet</Text>
      </View>
    );
  }

  const ys = data.map((d) => d.y);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);
  if (minY === maxY) {
    minY = Math.max(0, minY - 1);
    maxY = minY + 2;
  }
  const rangeY = maxY - minY;
  minY -= rangeY * 0.1;
  maxY += rangeY * 0.1;

  const xs = data.map((d) => d.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs) || minX + 1;

  const px = (x) => padL + ((x - minX) / (maxX - minX || 1)) * (W - padL - padR);
  const py = (y) => H - padB - ((y - minY) / (maxY - minY || 1)) * (H - padT - padB);

  const points = data.map((d) => `${px(d.x).toFixed(1)},${py(d.y).toFixed(1)}`).join(' ');
  const gridYs = [0, 0.5, 1].map((t) => minY + t * (maxY - minY));

  const labelEvery = Math.max(1, Math.ceil(data.length / 5));

  return (
    <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
      {gridYs.map((g, i) => (
        <Line
          key={i}
          x1={padL}
          x2={W - padR}
          y1={py(g)}
          y2={py(g)}
          stroke={colors.border}
          strokeWidth={1}
        />
      ))}
      {gridYs.map((g, i) => (
        <SvgText key={`t${i}`} x={4} y={py(g) + 4} fill={colors.textDim} fontSize={9}>
          {g >= 1000 ? `${(g / 1000).toFixed(1)}k` : Math.round(g)}
        </SvgText>
      ))}
      {data.map((d, i) =>
        i % labelEvery === 0 || i === data.length - 1 ? (
          <SvgText
            key={`x${i}`}
            x={px(d.x)}
            y={H - 8}
            fill={colors.textDim}
            fontSize={8}
            textAnchor="middle"
          >
            {fmtShortDate(d.x)}
          </SvgText>
        ) : null
      )}
      <Polyline
        points={points}
        fill="none"
        stroke={chartColor}
        strokeWidth={2.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {data.map((d, i) => (
        <Circle key={`c${i}`} cx={px(d.x)} cy={py(d.y)} r={2.5} fill={chartColor} />
      ))}
      {yLabel ? (
        <SvgText x={W - padR} y={10} fill={colors.textDim} fontSize={9} textAnchor="end">
          {yLabel}
        </SvgText>
      ) : null}
    </Svg>
  );
}
