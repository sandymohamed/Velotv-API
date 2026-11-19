const stateSql=`CASE WHEN r.archived_at IS NOT NULL OR m.archived_at IS NOT NULL THEN 'archived'
  WHEN r.status<>1 OR m.paused_at IS NOT NULL THEN 'paused'
  WHEN r.onboarding_pending=1 THEN 'invitation pending'
  WHEN m.expires_at<=UTC_TIMESTAMP() THEN 'expired' ELSE 'active' END`;

async function resellers(pool,agentId,{search='',page=0}={}){
  const where=`FROM resellers r LEFT JOIN velotv_reseller_memberships m ON m.reseller_id=r.id
    WHERE r.agent_id=? AND (?='' OR LOCATE(LOWER(?),LOWER(CONCAT_WS(' ',r.username,r.email,r.phone)))>0)`;
  const args=[agentId,search,search];
  // Explicit safe projection: no profiles, devices, device IDs, packages or URLs.
  const [rows]=await pool.execute(`SELECT r.id,r.username,r.email,r.phone,r.onboarding_pending,${stateSql} AS state,
    COALESCE((SELECT amount FROM credits WHERE reseller_id=r.id LIMIT 1),0) AS wallet_balance,
    COALESCE((SELECT SUM(GREATEST(CAST(oldcredits AS DECIMAL(15,5))-CAST(newcredits AS DECIMAL(15,5)),0))
      FROM credit_logs WHERE reseller_id=r.id),0)+COALESCE((SELECT SUM(payment_amount) FROM payment_reseller WHERE reseller_id=r.id AND status=1),0) AS spent_total,
    (SELECT COUNT(*) FROM reseller_devices rd JOIN
      (SELECT id_device,MAX(id) AS last_id FROM reseller_devices GROUP BY id_device) latest ON latest.last_id=rd.id
      WHERE rd.id_reseller=r.id) AS device_count
    ${where} ORDER BY r.id DESC LIMIT 50 OFFSET ?`,[...args,page*50]);
  const [[{count}]]=await pool.execute(`SELECT COUNT(*) AS count ${where}`,args);
  return {rows,count};
}
async function overview(pool,agentId){
  const [[row]]=await pool.execute(`SELECT a.id,a.username,a.email,a.margin_bps,w.amount AS balance,
    (SELECT COUNT(*) FROM resellers WHERE agent_id=a.id) AS reseller_count,
    COALESCE((SELECT SUM(face_amount) FROM velotv_agent_transfers WHERE agent_id=a.id),0) AS sales_total,
    COALESCE((SELECT SUM(cost_amount) FROM velotv_agent_transfers WHERE agent_id=a.id),0) AS cost_total,
    COALESCE((SELECT SUM(margin_amount) FROM velotv_agent_transfers WHERE agent_id=a.id),0) AS margin_total
    FROM velotv_agents a JOIN velotv_agent_wallets w ON w.agent_id=a.id WHERE a.id=?`,[agentId]);
  return row;
}
async function transfers(pool,agentId,page=0){
  const [rows]=await pool.execute(`SELECT t.id,t.reseller_id,t.reference,t.face_amount,t.cost_amount,t.margin_amount,
    t.margin_bps,t.agent_balance_after,t.currency,t.created_at FROM velotv_agent_transfers t
    WHERE agent_id=? ORDER BY created_at DESC,id DESC LIMIT 100 OFFSET ?`,[agentId,page*100]);
  const [[{count}]]=await pool.execute('SELECT COUNT(*) AS count FROM velotv_agent_transfers WHERE agent_id=?',[agentId]);
  return {rows,count};
}
async function entries(pool,agentId,page=0){
  const [rows]=await pool.execute(`SELECT id,kind,operation_id,delta,old_balance,new_balance,created_at
    FROM velotv_agent_wallet_entries WHERE agent_id=? ORDER BY id DESC LIMIT 100 OFFSET ?`,[agentId,page*100]);
  const [[{count}]]=await pool.execute('SELECT COUNT(*) AS count FROM velotv_agent_wallet_entries WHERE agent_id=?',[agentId]);
  return {rows,count};
}
module.exports={resellers,overview,transfers,entries};
