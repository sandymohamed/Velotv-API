CREATE TABLE velotv_reseller_memberships (
  reseller_id INT NOT NULL PRIMARY KEY,
  plan_id INT NOT NULL,
  starts_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  paused_at DATETIME NULL,
  archived_at DATETIME NULL,
  FOREIGN KEY (reseller_id) REFERENCES resellers(id),
  FOREIGN KEY (plan_id) REFERENCES velotv_reseller_plans(id)
) ENGINE=InnoDB;
