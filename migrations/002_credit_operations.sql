CREATE TABLE velotv_credit_operations (
  operation_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reseller_id INT NOT NULL,
  actor_id INT NOT NULL,
  kind VARCHAR(32) NOT NULL,
  reference VARCHAR(128) NOT NULL,
  result JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX credit_operations_reseller (reseller_id, created_at)
) ENGINE=InnoDB;
