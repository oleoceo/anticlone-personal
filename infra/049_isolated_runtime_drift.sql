-- Runtime drift flags suspend their own point, while approved configuration stays immutable.
-- Approved destination, mapping, offer, marker, reference price/version, URL and policy changes
-- continue to invalidate the complete approval through the existing generation mechanism.
CREATE OR REPLACE FUNCTION invalidate_page_policy_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='cta_points' AND (to_jsonb(OLD)-ARRAY['review_required','review_after_observation'])=(to_jsonb(NEW)-ARRAY['review_required','review_after_observation']) THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='cta_commercial_references' AND (to_jsonb(OLD)-'suspension')=(to_jsonb(NEW)-'suspension') THEN RETURN NEW; END IF;
    IF OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
    IF OLD.project_id IS DISTINCT FROM NEW.project_id THEN
      UPDATE protected_pages SET config_generation=config_generation+1 WHERE project_id=OLD.project_id;
    END IF;
  END IF;
  UPDATE protected_pages SET config_generation=config_generation+1 WHERE project_id=CASE WHEN TG_OP='DELETE' THEN OLD.project_id ELSE NEW.project_id END;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
