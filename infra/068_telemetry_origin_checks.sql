ALTER TABLE telemetry_origins
 ADD COLUMN check_status text CHECK (check_status IN ('OPERATIONAL','DNS_FAILED','HTTPS_FAILED','GATEWAY_NOT_READY')),
 ADD COLUMN checked_at timestamptz,
 ADD CHECK ((check_status IS NULL) = (checked_at IS NULL));

CREATE INDEX runtime_aliases_origin_installation_version ON runtime_aliases(origin, installation_id, version);
