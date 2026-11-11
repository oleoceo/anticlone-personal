BEGIN;
CREATE TABLE administrative_change_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 project_id text,
 relation_name text NOT NULL,
 operation text NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
 reference jsonb NOT NULL,
 changed_fields text[] NOT NULL,
 transaction_id bigint NOT NULL,
 source text NOT NULL DEFAULT 'DATABASE_CONFIGURATION_WRITE',
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ON administrative_change_audit(project_id,id DESC);
CREATE INDEX ON administrative_change_audit(occurred_at);
-- Metadata only. A database write is not proof of which human used a session.
-- Domain-specific audit tables retain reviewed values and justifications.
CREATE FUNCTION audit_administrative_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE before_row jsonb; after_row jsonb; row_data jsonb; fields text[]; project text; ref jsonb;
BEGIN
 before_row := CASE WHEN TG_OP='INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
 after_row := CASE WHEN TG_OP='DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
 IF before_row=after_row THEN RETURN NULL; END IF;
 row_data := CASE WHEN TG_OP='DELETE' THEN before_row ELSE after_row END;
 project := row_data->>'project_id';
 IF TG_TABLE_NAME='projects' THEN project := row_data->>'id'; END IF;
 IF project IS NULL AND row_data ? 'page_id' THEN SELECT project_id INTO project FROM protected_pages WHERE id=(row_data->>'page_id')::uuid; END IF;
 IF project IS NULL AND row_data ? 'installation_id' THEN SELECT project_id INTO project FROM protected_pages WHERE installation_id=(row_data->>'installation_id')::uuid; END IF;
 SELECT array_agg(k ORDER BY k) INTO fields FROM (SELECT jsonb_object_keys(before_row || after_row) k) keys WHERE before_row->k IS DISTINCT FROM after_row->k;
 SELECT coalesce(jsonb_object_agg(k,v),'{}'::jsonb) INTO ref FROM jsonb_each(row_data) e(k,v) WHERE k IN ('id','page_id','installation_id','version','surface','point_id');
 INSERT INTO administrative_change_audit(project_id,relation_name,operation,reference,changed_fields,transaction_id)
 VALUES(project,TG_TABLE_NAME,TG_OP,ref,fields,txid_current());
 RETURN NULL;
END $$;
DO $$ DECLARE relation text; BEGIN
 FOREACH relation IN ARRAY ARRAY['projects','protected_pages','protected_page_urls','protection_policy_drafts','protection_policy_versions','active_protection_policies','cta_points','cta_destinations','cta_mappings','cta_selection_intents','cta_policy_versions','active_cta_policies','active_cta_surface_policies','cta_commercial_references','notification_settings','installations','installation_health_settings','page_entry_policy_bindings','page_cta_policy_bindings','page_policy_approvals','page_policy_approval_entries','page_policy_approval_ctas','estimate_assumptions','runtime_distributions','runtime_aliases','page_operational_authorizations','notification_reviews'] LOOP
  EXECUTE format('CREATE TRIGGER administrative_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_administrative_change()',relation);
 END LOOP;
END $$;
COMMIT;
