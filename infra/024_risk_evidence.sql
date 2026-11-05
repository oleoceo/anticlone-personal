-- Additive upgrade: legacy rows did not retain the evidence used by a decision.
ALTER TABLE risk_assessment_days ADD COLUMN IF NOT EXISTS evidence_kind text NOT NULL DEFAULT 'legacy_unavailable';
ALTER TABLE risk_assessment_days ADD COLUMN IF NOT EXISTS evidence_provenance text NOT NULL DEFAULT 'legacy_unavailable';
ALTER TABLE risk_assessment_days ADD COLUMN IF NOT EXISTS evidence_reliability text NOT NULL DEFAULT 'legacy_unavailable';
