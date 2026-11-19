BEGIN;
ALTER TABLE notification_settings
  ADD COLUMN smtp_login text,
  ADD COLUMN smtp_secret_encrypted text,
  ADD CONSTRAINT notification_smtp_credentials_pair
    CHECK ((smtp_login IS NULL) = (smtp_secret_encrypted IS NULL));
COMMIT;
