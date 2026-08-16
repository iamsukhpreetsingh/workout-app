-- 009: supplement plans, items, and adherence check-ins (mirrors 008)
CREATE TABLE IF NOT EXISTS supplement_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id UUID NOT NULL REFERENCES users(id),
  client_id UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS supplement_plan_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplement_plan_id UUID NOT NULL REFERENCES supplement_plans(id) ON DELETE CASCADE,
  supplement_name TEXT NOT NULL,
  dosage TEXT,
  timing TEXT,
  notes TEXT,
  order_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS supplement_checkins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplement_plan_id UUID NOT NULL REFERENCES supplement_plans(id),
  client_id UUID NOT NULL REFERENCES users(id),
  date DATE NOT NULL,
  taken BOOLEAN NOT NULL,
  UNIQUE(supplement_plan_id, date)
);
