CREATE TABLE velotv_agents (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(120) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(50) NOT NULL DEFAULT '',
  password VARCHAR(255) NOT NULL,
  status TINYINT NOT NULL DEFAULT 1,
  margin_bps INT NOT NULL DEFAULT 1000,
  default_plan_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE velotv_agent_wallets (
  agent_id INT NOT NULL PRIMARY KEY,
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE velotv_agent_fundings (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  agent_id INT NOT NULL,
  admin_id INT NOT NULL,
  reference VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  request_hash CHAR(64) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  balance_after DECIMAL(12,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX agent_fundings (agent_id,created_at)
) ENGINE=InnoDB;

CREATE TABLE velotv_agent_transfers (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  agent_id INT NOT NULL,
  reseller_id INT NOT NULL,
  reference VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) NOT NULL,
  face_amount DECIMAL(12,2) NOT NULL,
  cost_amount DECIMAL(12,2) NOT NULL,
  margin_amount DECIMAL(12,2) NOT NULL,
  margin_bps INT NOT NULL,
  agent_balance_after DECIMAL(12,2) NOT NULL,
  reseller_balance_after DECIMAL(10,5) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY agent_transfer_reference (agent_id,reference),
  INDEX agent_transfers (agent_id,created_at),
  INDEX agent_reseller_transfers (reseller_id,created_at)
) ENGINE=InnoDB;

CREATE TABLE velotv_agent_wallet_entries (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  agent_id INT NOT NULL,
  kind VARCHAR(20) NOT NULL,
  operation_id CHAR(36) NOT NULL,
  delta DECIMAL(12,2) NOT NULL,
  old_balance DECIMAL(12,2) NOT NULL,
  new_balance DECIMAL(12,2) NOT NULL,
  actor_role VARCHAR(10) NOT NULL,
  actor_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY agent_wallet_operation (kind,operation_id),
  INDEX agent_wallet_history (agent_id,created_at)
) ENGINE=InnoDB;

ALTER TABLE resellers ADD COLUMN agent_id INT NULL,
  ADD COLUMN onboarding_pending BOOLEAN NOT NULL DEFAULT FALSE,
  ADD INDEX reseller_agent (agent_id,id);

CREATE TABLE velotv_reseller_invitations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  reseller_id INT NOT NULL,
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  revoked_at DATETIME NULL,
  delivery_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX reseller_invitations (reseller_id,created_at)
) ENGINE=InnoDB;

CREATE TABLE velotv_staff_creation_lock (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB;
INSERT INTO velotv_staff_creation_lock(id) VALUES (1);

ALTER TABLE credit_logs ADD INDEX agent_spend_reseller (reseller_id);
ALTER TABLE payment_reseller ADD INDEX agent_paid_reseller (reseller_id,status);
ALTER TABLE reseller_devices ADD INDEX agent_latest_device (id_device,id);
