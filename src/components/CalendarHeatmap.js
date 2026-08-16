import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { useColors } from '../theme';

export default function CalendarHeatmap({ data, months = 6 }) {
  const colors = useColors();
  const [weeks, setWeeks] = useState([]);

  const styles = {
    container: { marginTop: 8 },
    dayLabels: { flexDirection: 'row', marginBottom: 4 },
    dayLabel: { flex: 1, textAlign: 'center', color: colors.textDim, fontSize: 10 },
    grid: { flexDirection: 'row', gap: 2 },
    week: { flex: 1, gap: 2 },
    cell: { flex: 1, aspectRatio: 1, borderRadius: 2 },
    today: { borderWidth: 1, borderColor: colors.primary },
    legend: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginTop: 8, gap: 4 },
    legendLabel: { color: colors.textDim, fontSize: 10 },
    legendCell: { width: 12, height: 12, borderRadius: 2 },
  };

  useEffect(() => {
    const generateCalendar = () => {
      const today = new Date();
      const startDate = new Date(today);
      startDate.setMonth(startDate.getMonth() - months);
      startDate.setDate(startDate.getDate() - startDate.getDay());

      const weeksData = [];
      let current = new Date(startDate);

      while (current <= today) {
        const week = [];
        for (let i = 0; i < 7; i++) {
          const dateStr = current.toISOString().split('T')[0];
          const volume = data[dateStr] || 0;
          week.push({ date: dateStr, volume, isToday: dateStr === today.toISOString().split('T')[0] });
          current.setDate(current.getDate() + 1);
        }
        weeksData.push(week);
      }
      setWeeks(weeksData);
    };

    generateCalendar();
  }, [data, months]);

  const getLevel = (volume) => {
    if (volume === 0) return 0;
    if (volume < 1000) return 1;
    if (volume < 5000) return 2;
    if (volume < 10000) return 3;
    return 4;
  };

  const levelColors = [
    colors.cardLight,
    '#1a4d1a',
    '#2d7a2d',
    '#4da64d',
    colors.green,
  ];

  const dayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  return (
    <View style={styles.container}>
      <View style={styles.dayLabels}>
        {dayLabels.map((d, i) => (
          <Text key={i} style={styles.dayLabel}>{d}</Text>
        ))}
      </View>
      <View style={styles.grid}>
        {weeks.map((week, wi) => (
          <View key={wi} style={styles.week}>
            {week.map((day, di) => (
              <View
                key={`${wi}-${di}`}
                style={[
                  styles.cell,
                  { backgroundColor: levelColors[getLevel(day.volume)] },
                  day.isToday && styles.today,
                ]}
              />
            ))}
          </View>
        ))}
      </View>
      <View style={styles.legend}>
        <Text style={styles.legendLabel}>Less</Text>
        {levelColors.map((c, i) => (
          <View key={i} style={[styles.legendCell, { backgroundColor: c }]} />
        ))}
        <Text style={styles.legendLabel}>More</Text>
      </View>
    </View>
  );
}