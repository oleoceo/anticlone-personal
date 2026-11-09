-- URL changes invalidate URL-dependent decisions until explicit review exists.
ALTER TABLE protected_pages ADD COLUMN IF NOT EXISTS url_review_required boolean NOT NULL DEFAULT false;
