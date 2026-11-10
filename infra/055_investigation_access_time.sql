-- Optional extension; imported_at remains the existing first_received_at.
ALTER TABLE investigation_receipts ADD COLUMN accessed_at timestamptz;
ALTER TABLE investigation_receipts ADD CONSTRAINT original_access_time_only CHECK(accessed_at IS NULL OR kind='original_request');
CREATE INDEX investigation_receipts_project_cursor ON investigation_receipts(project_id,id);
CREATE INDEX investigation_receipts_page_cursor ON investigation_receipts(project_id,page_id,id);
CREATE INDEX investigation_receipts_access_retention ON investigation_receipts(project_id,accessed_at) WHERE accessed_at IS NOT NULL;
