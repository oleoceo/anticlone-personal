-- An older executable may delete directly or implement its own tally. Reject
-- either expiry path, so no mixed deployment can lose or double-count facts.
-- The marker is a compatibility guard. ACLs enforce the database boundary.
CREATE FUNCTION consolidate_expired_observed_actions() RETURNS trigger
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM expired_facts) THEN
    RETURN NULL;
  END IF;

  IF current_setting('anticlone.observed_expiry',true) IS DISTINCT FROM 'consolidating' THEN
    RAISE EXCEPTION 'observed expiry must use consolidation';
  END IF;

  INSERT INTO observed_daily_actions(project_id,page_id,day,action,traffic_class,evidence,copy_origin,copy_path,marker,surface,events)
  SELECT project_id,page_id,(received_at AT TIME ZONE 'UTC')::date,action,traffic_class,evidence,
    COALESCE(copy_cta->>'origin',session_copy->>'origin'),
    COALESCE(copy_cta->>'pathname',session_copy->>'pathname'),
    copy_cta->>'marker',copy_cta->>'surface',count(*)
  FROM expired_facts
  WHERE received_at < statement_timestamp()-interval '7 days'
    AND (received_at AT TIME ZONE 'UTC')::date >= (statement_timestamp() AT TIME ZONE 'UTC')::date-90
  GROUP BY 1,2,3,4,5,6,7,8,9,10
  ORDER BY 1,2,3,4,5,6,7,8,9,10
  ON CONFLICT (project_id,day,page_id,action,traffic_class,evidence,copy_origin,copy_path,marker,surface)
  DO UPDATE SET events=observed_daily_actions.events+EXCLUDED.events;
  RETURN NULL;
END;
$$;

CREATE TRIGGER observed_actions_expiry_guard
AFTER DELETE ON observed_action_facts
REFERENCING OLD TABLE AS expired_facts
FOR EACH STATEMENT EXECUTE FUNCTION consolidate_expired_observed_actions();

CREATE FUNCTION expire_observed_facts(project text) RETURNS void
LANGUAGE plpgsql SET search_path FROM CURRENT AS $$
BEGIN
  PERFORM set_config('anticlone.observed_expiry','consolidating',true);
  DELETE FROM observed_action_facts
    WHERE project_id=project AND received_at<statement_timestamp()-interval '7 days';
  PERFORM set_config('anticlone.observed_expiry','',true);

  INSERT INTO observed_daily_progress(project_id,complete_before)
  VALUES (project,((statement_timestamp()-interval '7 days') AT TIME ZONE 'UTC')::date)
  ON CONFLICT (project_id) DO UPDATE SET complete_before=EXCLUDED.complete_before
  WHERE observed_daily_progress.complete_before<EXCLUDED.complete_before;
END;
$$;

REVOKE EXECUTE ON FUNCTION expire_observed_facts(text) FROM PUBLIC;
