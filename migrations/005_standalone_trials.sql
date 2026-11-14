CREATE TABLE velotv_standalone_trials (
  device_digest CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  started_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL
) ENGINE=InnoDB;
