CREATE TABLE IF NOT EXISTS risk_assessment_days (
  project_id text NOT NULL, host text NOT NULL, day date NOT NULL,
  level text NOT NULL CHECK (level IN ('HIGH','LOW','UNCERTAIN')),
  evaluator_version text NOT NULL,
  source text NOT NULL CHECK (source IN ('server_default','lab_configuration')),
  reason text NOT NULL CHECK (reason IN ('insufficient_evidence','controlled_fixture')),
  confidence text NOT NULL CHECK (confidence IN ('insufficient','test_only')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id,host,day,level,evaluator_version,source,reason,confidence)
);
