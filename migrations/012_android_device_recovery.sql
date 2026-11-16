ALTER TABLE devices
  ADD COLUMN android_recovery_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL;
