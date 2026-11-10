ALTER TABLE runtime_distributions DROP CONSTRAINT runtime_distributions_contract_version_check;
ALTER TABLE runtime_distributions ADD CHECK(contract_version IN (1,2));
ALTER TABLE runtime_distributions ALTER COLUMN contract_version SET DEFAULT 2;
ALTER TABLE runtime_distributions ADD COLUMN publication_reason text NOT NULL DEFAULT 'publish'
 CHECK(publication_reason IN ('publish','rotate'));
CREATE TABLE runtime_alias_activity (
 alias uuid NOT NULL REFERENCES runtime_aliases(alias),
 source text NOT NULL CHECK(source IN ('html_canary','css_canary')),
 last_received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(alias,source)
);
