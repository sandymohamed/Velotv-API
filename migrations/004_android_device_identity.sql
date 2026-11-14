ALTER TABLE devices
  MODIFY COLUMN mac VARCHAR(255) NULL,
  ADD COLUMN android_id VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE KEY uq_devices_android_type (android_id, type);
