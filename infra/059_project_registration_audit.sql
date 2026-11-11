BEGIN;
CREATE TABLE project_registration_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id text NOT NULL,
 name text NOT NULL,
 origin text NOT NULL,
 actor text NOT NULL DEFAULT 'AUTHENTICATED_OWNER' CHECK(actor='AUTHENTICATED_OWNER'),
 action text NOT NULL DEFAULT 'CREATE_PROJECT' CHECK(action='CREATE_PROJECT'),
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON project_registration_audit(project_id,id DESC);
-- Independent of project deletion. This contains operational configuration,
-- never visitor identifiers, credentials or historical events backfilled later.
COMMIT;
