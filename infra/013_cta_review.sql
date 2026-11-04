DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='cta_points' AND column_name='review_after_observation') THEN
  ALTER TABLE cta_points ADD COLUMN review_after_observation bigint NOT NULL DEFAULT 0;
  UPDATE cta_points p SET review_after_observation=COALESCE((SELECT max(id) FROM cta_observations WHERE project_id=p.project_id),0) WHERE review_required;
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS cta_review_audit (
 id bigserial PRIMARY KEY, project_id text NOT NULL, point_id uuid NOT NULL,
 observation_id bigint NOT NULL, observed_url text NOT NULL, destination_id uuid NOT NULL, offer text NOT NULL,
 reviewed_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(project_id,point_id) REFERENCES cta_points(project_id,id),
 FOREIGN KEY(project_id,offer,destination_id) REFERENCES cta_destinations(project_id,offer,id)
);
