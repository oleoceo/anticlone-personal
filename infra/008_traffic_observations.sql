CREATE TABLE IF NOT EXISTS traffic_observation_days (
  project_id text NOT NULL, host text NOT NULL, day date NOT NULL,
  traffic_class text NOT NULL CHECK (traffic_class IN ('PAID_ATTRIBUTED','ORGANIC','REFERRAL','DIRECT_UNKNOWN')),
  evidence text NOT NULL CHECK (evidence IN ('paid_click_id','paid_utm','organic_referrer','external_referrer','none')),
  source text NOT NULL CHECK (source IN ('gclid','fbclid','ttclid','msclkid','utm_medium','google.com','bing.com','duckduckgo.com','external_referrer','none')),
  observed_at timestamptz NOT NULL DEFAULT now(),
  certainty text NOT NULL CHECK (certainty IN ('insufficient','browser_declared_uncorroborated')),
  PRIMARY KEY (project_id, host, day, traffic_class, evidence, source)
);
