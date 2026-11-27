CREATE TABLE official_cta_inventory (
  page_id uuid NOT NULL,
  origin text NOT NULL,
  pathname text NOT NULL,
  points jsonb NOT NULL CHECK (jsonb_typeof(points) = 'array' AND jsonb_array_length(points) <= 50),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, origin, pathname),
  FOREIGN KEY (page_id, origin, pathname) REFERENCES protected_page_urls(page_id, origin, pathname) ON DELETE CASCADE
);
