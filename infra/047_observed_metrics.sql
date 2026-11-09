CREATE TABLE IF NOT EXISTS observed_action_facts (
 project_id text NOT NULL REFERENCES projects(id),
 page_id uuid NOT NULL,
 event_id uuid NOT NULL,
 session_id text NOT NULL CHECK(session_id ~ '^[a-f0-9]{32}$'),
 action text NOT NULL CHECK(action IN ('SESSION_OBSERVED','DECISION_PREPARED','PAGE_REDIRECT_ATTEMPT','CTA_CLICK_OBSERVED','CHECKOUT_HANDOFF_ATTEMPT')),
 traffic_class text NOT NULL CHECK(traffic_class IN ('PAID_ATTRIBUTED','ORGANIC','REFERRAL','DIRECT_UNKNOWN')),
 policy_version integer CHECK(policy_version > 0),
 evidence text NOT NULL CHECK(evidence IN ('BROWSER_UNVERIFIED','GATEWAY_PREPARED')),
 received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,event_id),
 FOREIGN KEY(page_id,project_id) REFERENCES protected_pages(id,project_id),
 CHECK((action='DECISION_PREPARED') = (evidence='GATEWAY_PREPARED'))
);
CREATE INDEX IF NOT EXISTS observed_action_period ON observed_action_facts(project_id,page_id,received_at);
CREATE TABLE IF NOT EXISTS estimate_assumptions (
 project_id text NOT NULL REFERENCES projects(id),
 version integer NOT NULL CHECK(version>0),
 ticket_minor bigint NOT NULL CHECK(ticket_minor BETWEEN 0 AND 1000000000000),
 conversion_basis_points integer NOT NULL CHECK(conversion_basis_points BETWEEN 0 AND 10000),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 configured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(project_id,version)
);
