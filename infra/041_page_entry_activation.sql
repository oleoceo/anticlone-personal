-- Page bindings activate published versions without rewriting historical policies.
-- Project activation remains available only to legacy installations.
DROP TRIGGER page_policy_configuration_invalidation ON active_protection_policies;
DROP TRIGGER page_policy_configuration_invalidation ON page_entry_policy_bindings;
DROP TRIGGER page_policy_configuration_invalidation ON page_cta_policy_bindings;
CREATE FUNCTION invalidate_page_binding_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  IF TG_OP IN ('UPDATE','DELETE') THEN
    UPDATE protected_pages SET config_generation=config_generation+1 WHERE id=OLD.page_id AND project_id=OLD.project_id;
  END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND (OLD.page_id,OLD.project_id) IS DISTINCT FROM (NEW.page_id,NEW.project_id)) THEN
    UPDATE protected_pages SET config_generation=config_generation+1 WHERE id=NEW.page_id AND project_id=NEW.project_id;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER page_policy_configuration_invalidation AFTER INSERT OR UPDATE OR DELETE ON page_entry_policy_bindings
FOR EACH ROW EXECUTE FUNCTION invalidate_page_binding_configuration();
CREATE TRIGGER page_policy_configuration_invalidation AFTER INSERT OR UPDATE OR DELETE ON page_cta_policy_bindings
FOR EACH ROW EXECUTE FUNCTION invalidate_page_binding_configuration();
