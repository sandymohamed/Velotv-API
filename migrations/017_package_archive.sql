ALTER TABLE packages_reseller
  ADD COLUMN archived_at DATETIME NULL,
  ADD INDEX package_archive_status (archived_at, enabled);
