-- F45 is optional; the existing installation and notification paths continue without it.
CREATE TABLE installation_health_settings (
 project_id text PRIMARY KEY REFERENCES installations(project_id),
 enabled boolean NOT NULL DEFAULT false,
 operational_enabled boolean NOT NULL DEFAULT false,
 inactivity_seconds integer NOT NULL DEFAULT 86400 CHECK (inactivity_seconds BETWEEN 60 AND 2592000)
);
CREATE TABLE installation_last_signal (
 project_id text PRIMARY KEY REFERENCES installations(project_id),
 first_observed_at timestamptz,
 last_observed_at timestamptz NOT NULL
);
INSERT INTO installation_last_signal(project_id,first_observed_at,last_observed_at)
 SELECT project_id,min(last_observed_at),max(last_observed_at) FROM installation_signals GROUP BY project_id;
CREATE FUNCTION remember_installation_signal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO installation_last_signal(project_id,first_observed_at,last_observed_at) VALUES(NEW.project_id,NEW.last_observed_at,NEW.last_observed_at)
 ON CONFLICT(project_id) DO UPDATE SET first_observed_at=least(coalesce(installation_last_signal.first_observed_at,excluded.first_observed_at),excluded.first_observed_at), last_observed_at=greatest(installation_last_signal.last_observed_at,excluded.last_observed_at);
 RETURN NEW;
END $$;
CREATE TRIGGER remember_installation_signal AFTER INSERT OR UPDATE ON installation_signals
 FOR EACH ROW EXECUTE FUNCTION remember_installation_signal();
CREATE FUNCTION invalidate_health_baseline() RETURNS trigger LANGUAGE plpgsql AS $tag$
BEGIN
 IF OLD.enabled IS DISTINCT FROM NEW.enabled THEN
  UPDATE installation_last_signal SET first_observed_at=NULL WHERE project_id=NEW.project_id;
  WITH invalidated AS (UPDATE health_episodes SET invalidated_at=clock_timestamp() WHERE project_id=NEW.project_id
    AND kind='INACTIVE' AND recovered_at IS NULL AND invalidated_at IS NULL RETURNING id),
  expired AS (UPDATE health_delivery d SET expired_at=clock_timestamp() FROM invalidated i
    WHERE d.episode_id=i.id AND d.sent_at IS NULL AND d.expired_at IS NULL RETURNING d.episode_id)
  INSERT INTO health_history(episode_id,event) SELECT id,'INVALIDATED' FROM invalidated;
 END IF;
 RETURN NEW;
END $tag$;
CREATE TRIGGER invalidate_health_baseline AFTER UPDATE OF enabled ON installations
 FOR EACH ROW EXECUTE FUNCTION invalidate_health_baseline();
CREATE TABLE health_episodes (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 observation_key uuid UNIQUE,
 project_id text NOT NULL REFERENCES projects(id),
 kind text NOT NULL CHECK (kind IN ('INACTIVE','OPERATIONAL')),
 source text NOT NULL, nature text NOT NULL, safe_code text,
 opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 recovered_at timestamptz, invalidated_at timestamptz
);
CREATE UNIQUE INDEX health_one_open ON health_episodes(project_id,kind,source) WHERE recovered_at IS NULL AND invalidated_at IS NULL;
CREATE TABLE health_operational_keys (
 observation_key uuid PRIMARY KEY,
 episode_id bigint NOT NULL REFERENCES health_episodes(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE health_delivery (
 episode_id bigint PRIMARY KEY REFERENCES health_episodes(id) ON DELETE CASCADE,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
 next_attempt timestamptz NOT NULL DEFAULT clock_timestamp(),
 sent_at timestamptz, expired_at timestamptz
);
CREATE TABLE health_history (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 episode_id bigint NOT NULL REFERENCES health_episodes(id) ON DELETE CASCADE,
 event text NOT NULL CHECK (event IN ('OPENED','ATTEMPT','FAILED_UNCERTAIN','SENT','RECOVERED','EXPIRED','DEFERRED','INVALIDATED')),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
