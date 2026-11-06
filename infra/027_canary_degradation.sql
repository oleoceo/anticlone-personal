-- Extend the existing bounded F44 journal; old observations remain valid for
-- the existing fallback correlation, but cannot establish a canary baseline.
ALTER TABLE degradation_events DROP CONSTRAINT IF EXISTS degradation_events_source_check;
ALTER TABLE degradation_events ADD CONSTRAINT degradation_events_source_check
  CHECK (source IN ('core','fallback','html_canary','css_canary'));
ALTER TABLE degradation_events ADD COLUMN IF NOT EXISTS origin text;
ALTER TABLE degradation_audit ADD COLUMN IF NOT EXISTS evidence jsonb;
-- One bounded marker per project records an interval where claims could be lost.
CREATE TABLE IF NOT EXISTS degradation_collection_gaps (
 project_id text PRIMARY KEY, last_dropped_at timestamptz NOT NULL
);
