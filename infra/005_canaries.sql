CREATE TABLE IF NOT EXISTS canary_observations (
 project_id text NOT NULL, host text NOT NULL, source text NOT NULL CHECK (source IN ('html_canary','css_canary')),
 day date NOT NULL, observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (project_id,host,source,day)
);
