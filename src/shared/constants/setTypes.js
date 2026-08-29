// Set-type vocabulary — THE single definition (previously duplicated in
// SessionDetailScreen and WorkoutContext). Values are historical: W / WU /
// DS / F as displayed, stored as working / warmup / dropset / failure.
export const SET_TYPES = ['working', 'warmup', 'dropset', 'failure'];

export const TYPE_TAG = { working: 'W', warmup: 'WU', dropset: 'DS', failure: 'F' };

// theme.js color keys per type
export const TYPE_COLOR = { working: 'primary', warmup: 'textDim', dropset: 'orange', failure: 'red' };

// The tap-cycle order used by both the live workout and the explicit
// history edit mode.
export function nextSetType(current) {
  return SET_TYPES[(SET_TYPES.indexOf(current) + 1) % SET_TYPES.length];
}
