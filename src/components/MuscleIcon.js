import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

// Custom minimal SVG glyphs per muscle group — visually distinct at a glance
// rather than generic icon-library stand-ins. All shapes inherit `color`.
const SHAPES = {
  Chest: (
    <>
      <Path d="M4 8 L4 20 Q12 26 20 20 L20 8 Q12 12 4 8 Z" fill="currentColor" opacity="0.85" />
      <Rect x="11.4" y="8" width="1.2" height="14" fill="currentColor" />
    </>
  ),
  Back: (
    <>
      <Path d="M12 3 L18 7 L17 21 L12 24 L7 21 L6 7 Z" fill="currentColor" opacity="0.85" />
      <Path d="M12 6 L12 22" stroke="#fff" strokeWidth="1.2" strokeOpacity="0.5" />
    </>
  ),
  Legs: (
    <>
      <Rect x="8" y="3" width="8" height="9" rx="3" fill="currentColor" opacity="0.85" />
      <Rect x="8.5" y="13" width="3.2" height="9" rx="1.5" fill="currentColor" />
      <Rect x="12.3" y="13" width="3.2" height="9" rx="1.5" fill="currentColor" />
    </>
  ),
  Shoulders: (
    <>
      <Circle cx="12" cy="7" r="3.2" fill="currentColor" opacity="0.85" />
      <Path d="M3 12 Q7 8 10 11 L10 20 L4 18 Z" fill="currentColor" />
      <Path d="M21 12 Q17 8 14 11 L14 20 L20 18 Z" fill="currentColor" />
    </>
  ),
  Arms: (
    <>
      <Rect x="5" y="4" width="5" height="11" rx="2.5" fill="currentColor" transform="rotate(15 7 10)" />
      <Rect x="14" y="4" width="5" height="11" rx="2.5" fill="currentColor" transform="rotate(-15 17 10)" />
      <Circle cx="6.5" cy="17" r="2.6" fill="currentColor" opacity="0.85" />
      <Circle cx="17.5" cy="17" r="2.6" fill="currentColor" opacity="0.85" />
    </>
  ),
  Core: (
    <>
      <Rect x="7" y="4" width="10" height="17" rx="5" fill="none" stroke="currentColor" strokeWidth="2" />
      <Path d="M7 9 H17 M7 14 H17 M12 5 V20" stroke="currentColor" strokeWidth="1.4" />
    </>
  ),
  Cardio: (
    <>
      <Path
        d="M20.8 8.6 a4.4 4.4 0 0 0-8-2.6 a4.4 4.4 0 0 0-8 2.6 C4.8 13 12 17 12.8 21.5 C13.6 17 20.8 13 20.8 8.6 Z"
        fill="currentColor"
        opacity="0.85"
      />
    </>
  ),
};

export default function MuscleIcon({ group, size = 22, color = '#000' }) {
  const shape = SHAPES[group] || (
    <Circle cx="12" cy="12" r="8" fill="currentColor" opacity="0.6" />
  );
  return (
    <Svg width={size} height={size} viewBox="0 0 24 28" color={color}>
      {shape}
    </Svg>
  );
}
