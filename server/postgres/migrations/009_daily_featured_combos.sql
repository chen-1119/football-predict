-- Frozen directions and mutable settlement occupy separate columns.
CREATE TABLE IF NOT EXISTS football.daily_featured_combos (
  id text PRIMARY KEY,
  business_date date NOT NULL,
  size integer NOT NULL CHECK (size IN (2,3)),
  payload jsonb NOT NULL,
  settlement jsonb NOT NULL,
  UNIQUE (business_date, size)
);
CREATE TABLE IF NOT EXISTS football.daily_featured_combo_state (
  id integer PRIMARY KEY CHECK (id = 1),
  payload jsonb NOT NULL
);
