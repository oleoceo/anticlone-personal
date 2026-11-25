-- Contract 4 uses 80-bit hex tokens in filenames. Keep indexed tokens from 075.
ALTER TABLE runtime_distributions
  DROP CONSTRAINT runtime_distributions_named_contract_check,
  ADD CONSTRAINT runtime_distributions_asset_file_contract_check CHECK (contract_version IN (1,2,3,4));

ALTER TABLE runtime_aliases
  DROP CONSTRAINT runtime_aliases_public_token_check,
  ADD CONSTRAINT runtime_aliases_public_token_check CHECK (
    public_token ~ '^[A-Za-z0-9_-]{21}[AQgw]$'
    OR (public_token ~ '^[0-9a-f]{20}$' AND public_token <> '00000000000000000000')
  );

-- Readiness must be checked through the filename route before new publication.
UPDATE telemetry_origins SET check_status = NULL, checked_at = NULL, updated_at = clock_timestamp();
