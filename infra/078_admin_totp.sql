-- Existing installations created these tables when the administrator started.
-- Keep their contents, including the replay counters, intact on upgrade.
CREATE TABLE IF NOT EXISTS admin_totp_replay (
  factor_id text PRIMARY KEY,
  last_counter bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_totp_codes (
  factor_id text NOT NULL,
  digest text NOT NULL,
  valid_until bigint NOT NULL,
  PRIMARY KEY (factor_id, digest)
);
