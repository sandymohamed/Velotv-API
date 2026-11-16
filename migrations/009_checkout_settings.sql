CREATE TABLE velotv_checkout_settings (
  method VARCHAR(24) NOT NULL PRIMARY KEY,
  enabled BOOLEAN NOT NULL,
  instructions VARCHAR(1000) NOT NULL DEFAULT ''
) ENGINE=InnoDB;
