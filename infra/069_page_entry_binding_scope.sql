CREATE FUNCTION invalidate_page_entry_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
  IF TG_OP <> 'INSERT' THEN
    UPDATE protected_pages SET config_generation=config_generation+1
      WHERE project_id=OLD.project_id AND id=OLD.page_id;
  END IF;
  IF TG_OP='INSERT' OR (TG_OP='UPDATE' AND (OLD.project_id, OLD.page_id) IS DISTINCT FROM (NEW.project_id, NEW.page_id)) THEN
    UPDATE protected_pages SET config_generation=config_generation+1
      WHERE project_id=NEW.project_id AND id=NEW.page_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER page_policy_configuration_invalidation ON page_entry_policy_bindings;
CREATE TRIGGER page_policy_configuration_invalidation
  AFTER INSERT OR UPDATE OR DELETE ON page_entry_policy_bindings
  FOR EACH ROW EXECUTE FUNCTION invalidate_page_entry_binding();
