ALTER TABLE devices
  ADD COLUMN android_public_key VARCHAR(160) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN android_challenge CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN android_challenge_expires_at DATETIME NULL,
  ADD COLUMN android_verified_at DATETIME NULL;
