-- Browser claims only; never proof of installation or checkout authority.
CREATE TABLE page_installation_signals (
 project_id text NOT NULL,
 page_id uuid NOT NULL,
 source text NOT NULL CHECK(source IN ('core','fallback')),
 last_observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,page_id,source),
 FOREIGN KEY(page_id,project_id) REFERENCES protected_pages(id,project_id)
);
