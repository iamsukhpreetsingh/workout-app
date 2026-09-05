// Shared 7-day operating-hours editor (wizard step + settings tab).
// Value shape matches the backend's normalized operating_hours:
//   { mon: {open:'05:00', close:'23:00'} | {closed:true}, ... }
// Omitted days read as CLOSED on the server, and the editor shows that
// state explicitly so "closed" is always a visible, deliberate choice.
import React from 'react';
import { Switch, TimePicker } from 'antd';
import dayjs, { Dayjs } from 'dayjs';

import { OperatingHours } from '../api';

const DAYS: [key: string, label: string][] = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'],
  ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];

function toRange(value: OperatingHours[string] | undefined): [Dayjs, Dayjs] | null {
  if (!value || value.closed || !value.open || !value.close) return null;
  return [dayjs(value.open, 'HH:mm'), dayjs(value.close, 'HH:mm')];
}

interface Props {
  value?: OperatingHours | null;
  onChange: (hours: OperatingHours) => void;
}

export default function OperatingHoursEditor({ value, onChange }: Props) {
  const hours: OperatingHours = value || {};

  const setDay = (day: string, patch: OperatingHours[string]) => {
    onChange({ ...hours, [day]: { ...hours[day], ...patch } });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {DAYS.map(([day, label]) => {
        const closed = !hours[day] || hours[day].closed;
        const range = toRange(hours[day]);
        return (
          <div key={day} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ width: 90, flexShrink: 0 }}>{label}</span>
            <Switch
              checked={!closed}
              checkedChildren="Open"
              unCheckedChildren="Closed"
              onChange={(open) => setDay(day, open ? {} : { closed: true })}
            />
            {!closed && (
              <TimePicker.RangePicker
                format="HH:mm"
                minuteStep={15}
                order={false}
                value={range}
                placeholder={['Opens', 'Closes']}
                onChange={(vals) => {
                  if (vals && vals[0] && vals[1]) {
                    setDay(day, {
                      open: vals[0].format('HH:mm'),
                      close: vals[1].format('HH:mm'),
                      closed: false,
                    });
                  }
                }}
              />
            )}
            {closed && <span style={{ color: 'rgba(255,255,255,0.45)' }}>Closed all day</span>}
          </div>
        );
      })}
    </div>
  );
}

// Build the payload from editor state; the backend is the authority and
// re-validates every time anyway.
export function hoursComplete(hours: OperatingHours | null | undefined): boolean {
  if (!hours) return false;
  return DAYS.every(([day]) => {
    const d = hours[day];
    if (!d || d.closed) return true;
    return !!d.open && !!d.close;
  });
}
