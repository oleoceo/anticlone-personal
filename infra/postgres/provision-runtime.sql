\set ON_ERROR_STOP on
-- Run once, in the approved AntiClone database, as the migration/object owner
-- with role creation rights. Supply -v app_schema=<existing schema>.
BEGIN;
SET LOCAL search_path TO :"app_schema", pg_catalog;
SELECT current_schema() = :'app_schema' AND to_regprocedure('expire_observed_facts(text)') IS NOT NULL AS schema_ready \gset
\if :schema_ready
\else
  ROLLBACK;
  DO $$ BEGIN RAISE EXCEPTION 'AntiClone schema or migration 080 unavailable'; END $$;
\endif

CREATE ROLE anticlone_admin NOLOGIN;
CREATE ROLE anticlone_gateway NOLOGIN;
CREATE ROLE anticlone_maintenance NOLOGIN;
CREATE ROLE anticlone_notification_worker NOLOGIN;
CREATE ROLE anticlone_admin_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE anticlone_gateway_public_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE anticlone_gateway_private_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE anticlone_maintenance_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE anticlone_worker_login LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT CONNECT ON DATABASE :"DBNAME" TO anticlone_admin, anticlone_gateway, anticlone_maintenance, anticlone_notification_worker;
GRANT USAGE ON SCHEMA :"app_schema" TO anticlone_admin, anticlone_gateway, anticlone_maintenance, anticlone_notification_worker;
GRANT anticlone_admin TO anticlone_admin_login;
GRANT anticlone_gateway TO anticlone_gateway_public_login, anticlone_gateway_private_login;
GRANT anticlone_maintenance TO anticlone_maintenance_login;
GRANT anticlone_notification_worker TO anticlone_worker_login;

\ir runtime-grants.sql
\ir notification-worker-grants.sql
COMMIT;
-- Set individual passwords out of band before switching service references.
