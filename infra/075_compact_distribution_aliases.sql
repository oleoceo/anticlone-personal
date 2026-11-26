-- The UUID remains the internal key for correlation and foreign keys.
ALTER TABLE runtime_aliases ADD COLUMN public_token text
  CHECK (public_token ~ '^[A-Za-z0-9_-]{21}[AQgw]$');
CREATE UNIQUE INDEX runtime_aliases_public_token ON runtime_aliases(public_token)
  WHERE public_token IS NOT NULL;

-- The old probe checked only /healthz; publication now requires the asset route.
UPDATE telemetry_origins SET check_status = NULL, checked_at = NULL, updated_at = clock_timestamp();
