-- Version 3 pins the named compact resource map. Versions 1 and 2 keep their paths.
ALTER TABLE runtime_distributions
  DROP CONSTRAINT runtime_distributions_contract_version_check,
  ADD CONSTRAINT runtime_distributions_named_contract_check CHECK (contract_version IN (1,2,3));

-- A prior probe only verified the abbreviated script route.
UPDATE telemetry_origins SET check_status = NULL, checked_at = NULL, updated_at = clock_timestamp();
