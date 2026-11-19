ALTER TABLE packages_reseller
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN offer_only BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE velotv_package_offers (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  package_id INT NOT NULL,
  name VARCHAR(120) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  offer_amount DECIMAL(10,3) NOT NULL,
  max_purchases_per_reseller INT NULL,
  audience VARCHAR(16) NOT NULL DEFAULT 'all',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX package_offer_window (package_id, enabled, starts_at, ends_at)
) ENGINE=InnoDB;

CREATE TABLE velotv_package_offer_resellers (
  offer_id INT NOT NULL,
  reseller_id INT NOT NULL,
  PRIMARY KEY (offer_id, reseller_id),
  INDEX reseller_offers (reseller_id, offer_id)
) ENGINE=InnoDB;

CREATE TABLE velotv_package_purchases (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  reseller_id INT NOT NULL,
  package_id INT NOT NULL,
  offer_id INT NULL,
  channel VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  reference VARCHAR(128) NOT NULL,
  base_amount DECIMAL(10,3) NOT NULL,
  amount DECIMAL(10,3) NOT NULL,
  currency CHAR(3) NOT NULL,
  duration INT NOT NULL,
  coupon_count INT NOT NULL,
  snapshot JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fulfilled_at DATETIME NULL,
  INDEX reseller_purchases (reseller_id, created_at),
  INDEX reseller_offer_limit (reseller_id, offer_id, status),
  INDEX package_purchases (package_id, created_at)
) ENGINE=InnoDB;

ALTER TABLE reseller_packages ADD COLUMN purchase_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD INDEX coupon_purchase (purchase_id);

ALTER TABLE velotv_paypal_orders ADD COLUMN purchase_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE INDEX paypal_package_purchase (purchase_id);
