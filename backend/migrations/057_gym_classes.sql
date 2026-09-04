-- 057: Gym class scheduling & bookings (Phase 17).
--
-- ARCHITECTURE: a gym_class is a SCHEDULED INSTANCE of a class type —
-- "Yoga with Simran, tomorrow 18:00, Studio A, 20 seats". One row per
-- occurrence (recurring schedules are out of scope; the portal creates
-- instances directly). All wall times (class_date / start_time /
-- end_time) are GYM-LOCAL, matching the billing and attendance rules.
--
-- CLASS (gym_classes)
--   class_type        free-form label shown to members ("Yoga", "Spin").
--   trainer_staff_id  a TRAINER-role gym_staff row (nullable = TBA).
--                     Overlap guard: the same trainer cannot have two
--                     SCHEDULED classes at the same wall-clock window.
--   branch_id         nullable = gym-wide. When set, the branch must be
--                     ACTIVE and members can book only if the branch is
--                     within {primary} ∪ allowed (legacy members: all).
--   room              free text ("Studio A"); same-branch same-room
--                     double-booking is rejected.
--   capacity          1..500. Occupied seats = BOOKED + ATTENDED.
--   status            SCHEDULED | CANCELLED. Cancelling is terminal for
--                     the class and cascades to its live bookings.
--
-- BOOKING (gym_class_bookings)
--   status  BOOKED      holds a seat
--           WAITLISTED  class was full; FIFO queue by booked_at
--           CANCELLED   member/desk cancelled, or the class was cancelled
--           ATTENDED    marked present at the class
--           NO_SHOW     marked absent; frees the seat (waitlist promotes)
--   source  DESK (front desk / admin booked a member — works for members
--           without an app account) | SELF (the app member booked).
--   A member holds AT MOST one live row per class, enforced by two
--   partial unique indexes (BOOKED/ATTENDED and WAITLISTED), so a
--   duplicate booking can never be created even under a race.
--
-- WAITLIST PROMOTION: any transition that frees a seat on a SCHEDULED
-- class (booking cancelled, no-show marked) promotes the earliest
-- WAITLISTED booking (FIFO). Class cancellation promotes nobody.

CREATE TABLE IF NOT EXISTS gym_classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  branch_id UUID NULL REFERENCES gym_branches(id) ON DELETE RESTRICT,
  class_type TEXT NOT NULL CHECK (length(btrim(class_type)) BETWEEN 1 AND 80),
  trainer_staff_id UUID NULL REFERENCES gym_staff(id) ON DELETE SET NULL,
  room TEXT,
  class_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  capacity INTEGER NOT NULL CHECK (capacity BETWEEN 1 AND 500),
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'CANCELLED')),
  cancelled_at TIMESTAMPTZ,
  cancelled_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason TEXT,
  created_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_time > start_time)
);

CREATE INDEX IF NOT EXISTS idx_gym_classes_schedule
  ON gym_classes (gym_id, class_date, start_time);
CREATE INDEX IF NOT EXISTS idx_gym_classes_trainer
  ON gym_classes (trainer_staff_id, class_date);
CREATE INDEX IF NOT EXISTS idx_gym_classes_branch
  ON gym_classes (branch_id, class_date);

CREATE TABLE IF NOT EXISTS gym_class_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  gym_id UUID NOT NULL REFERENCES gyms(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES gym_classes(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES gym_members(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'BOOKED'
    CHECK (status IN ('BOOKED', 'WAITLISTED', 'CANCELLED', 'ATTENDED', 'NO_SHOW')),
  source TEXT NOT NULL DEFAULT 'DESK' CHECK (source IN ('DESK', 'SELF')),
  booked_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  booked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  cancel_reason TEXT,
  attended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gym_class_bookings_class
  ON gym_class_bookings (class_id, status, booked_at);
CREATE INDEX IF NOT EXISTS idx_gym_class_bookings_member
  ON gym_class_bookings (gym_id, member_id, booked_at DESC);

-- at most one live seat per member per class, and at most one waitlist
-- row per member per class — DB-level backstops behind the 409 checks
CREATE UNIQUE INDEX IF NOT EXISTS uq_gym_class_booking_live
  ON gym_class_bookings (class_id, member_id)
  WHERE status IN ('BOOKED', 'ATTENDED');
CREATE UNIQUE INDEX IF NOT EXISTS uq_gym_class_booking_waitlist
  ON gym_class_bookings (class_id, member_id)
  WHERE status = 'WAITLISTED';
