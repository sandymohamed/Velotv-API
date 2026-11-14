CREATE TABLE velotv_paypal_orders (
  id CHAR(36) PRIMARY KEY,
  paypal_order_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin UNIQUE,
  capture_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin UNIQUE,
  reseller_id INT NOT NULL,
  purpose VARCHAR(16) NOT NULL,
  package_id INT,
  duration INT,
  coupon_count INT,
  amount DECIMAL(10,2) NOT NULL,
  currency CHAR(3) NOT NULL,
  fulfilled_at DATETIME,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX paypal_orders_reseller (reseller_id)
) ENGINE=InnoDB;
