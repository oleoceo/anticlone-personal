BEGIN;
-- One owner; immutable global definitions and pinned account connections.
CREATE TABLE commerce_models (
 id uuid NOT NULL, version integer NOT NULL CHECK(version>0), name text NOT NULL,
 config jsonb NOT NULL, approved boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(id,version)
);
CREATE TABLE commerce_connections (
 id uuid PRIMARY KEY, model_id uuid NOT NULL, model_version integer NOT NULL,
 account text NOT NULL, secret_encrypted text NOT NULL,
 state text NOT NULL CHECK(state IN ('TEST','ACTIVE','INACTIVE','ARCHIVED')),
 version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(model_id,model_version) REFERENCES commerce_models(id,version),
 UNIQUE(model_id,account)
);
CREATE TABLE commerce_bindings (
 id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
 connection_id uuid NOT NULL REFERENCES commerce_connections(id),
 project_id text NOT NULL REFERENCES projects(id), page_id uuid,
 offer text NOT NULL, product text NOT NULL, checkout text NOT NULL,
 url text NOT NULL, price_minor bigint NOT NULL CHECK(price_minor BETWEEN 0 AND 1000000000000),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 state text NOT NULL CHECK(state IN ('ACTIVE','INACTIVE','ARCHIVED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(id,version),
 FOREIGN KEY(page_id,project_id) REFERENCES protected_pages(id,project_id)
);
CREATE TABLE commerce_orders (
 connection_id uuid NOT NULL REFERENCES commerce_connections(id), order_id text NOT NULL,
 binding_id uuid, binding_version integer, amount_minor bigint NOT NULL, currency text NOT NULL,
 product text NOT NULL, offer text NOT NULL, checkout text NOT NULL, paid_reported boolean NOT NULL DEFAULT false,
 status text NOT NULL CHECK(status IN ('PENDING','PAID','CANCELLED','REFUNDED','CHARGEBACK')),
 occurred_at timestamptz NOT NULL, paid_at timestamptz, adjusted_at timestamptz, reversed_at timestamptz, rank integer NOT NULL,
 attribution text NOT NULL DEFAULT 'UNVERIFIED' CHECK(attribution='UNVERIFIED'),
 PRIMARY KEY(connection_id,order_id),
 FOREIGN KEY(binding_id,binding_version) REFERENCES commerce_bindings(id,version)
);
CREATE TABLE commerce_events (
 connection_id uuid NOT NULL, event_id text NOT NULL, order_id text NOT NULL,
 digest text NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(connection_id,event_id),
 FOREIGN KEY(connection_id,order_id) REFERENCES commerce_orders(connection_id,order_id)
);
-- Shape only: neither raw payloads nor arbitrary string values are persisted.
CREATE TABLE commerce_samples (
 connection_id uuid PRIMARY KEY REFERENCES commerce_connections(id),
 shape jsonb NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE commerce_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 entity uuid NOT NULL, operation text NOT NULL, version integer NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON commerce_bindings(connection_id,project_id);
CREATE INDEX ON commerce_events(received_at);
COMMIT;
