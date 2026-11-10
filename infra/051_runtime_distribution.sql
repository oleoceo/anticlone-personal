-- Additive distribution contract. Public correlation handles, never credentials.
CREATE TABLE runtime_distributions (
 installation_id uuid NOT NULL REFERENCES protected_pages(installation_id),
 version integer NOT NULL CHECK(version>0),
 contract_version integer NOT NULL DEFAULT 1 CHECK(contract_version=1),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(installation_id,version)
);
CREATE TABLE runtime_aliases (
 alias uuid PRIMARY KEY,
 installation_id uuid NOT NULL,
 version integer NOT NULL,
 role text NOT NULL CHECK(role IN ('SCRIPT','TELEMETRY','STATIC_ASSETS')),
 origin text NOT NULL,
 UNIQUE(installation_id,version,role),
 FOREIGN KEY(installation_id,version) REFERENCES runtime_distributions(installation_id,version)
);
ALTER TABLE page_installation_signals DROP CONSTRAINT page_installation_signals_source_check;
ALTER TABLE page_installation_signals ADD CHECK(source IN ('core','fallback','html_canary','css_canary'));
CREATE FUNCTION runtime_distribution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'published distribution is immutable'; END $$;
CREATE TRIGGER runtime_distribution_immutable BEFORE UPDATE OR DELETE ON runtime_distributions
 FOR EACH ROW EXECUTE FUNCTION runtime_distribution_immutable();
CREATE TRIGGER runtime_alias_immutable BEFORE UPDATE OR DELETE ON runtime_aliases
 FOR EACH ROW EXECUTE FUNCTION runtime_distribution_immutable();
