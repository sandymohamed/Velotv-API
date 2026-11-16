ALTER TABLE profiles
  ADD COLUMN source_format ENUM('m3u', 'xtream') NULL,
  ADD COLUMN website_managed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN added_by_reseller_id INT NULL,
  ADD INDEX idx_profiles_reseller (added_by_reseller_id),
  ADD INDEX idx_profiles_device (id_device);
