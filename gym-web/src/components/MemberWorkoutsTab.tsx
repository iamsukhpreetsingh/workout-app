// Member's Workouts tab — gym workouts assigned to this member (works with
// or without an app account). Phase 13: rendered by the UNIFIED assignments
// section (dates, notes, window-aware status, version hints, trainer
// roster-scoping) with the content type pinned to WORKOUT.
import React from 'react';
import MemberAssignmentsSection from './MemberAssignmentsSection';

export default function MemberWorkoutsTab({ memberId }: { memberId: string }) {
  return <MemberAssignmentsSection memberId={memberId} contentType="WORKOUT" />;
}
