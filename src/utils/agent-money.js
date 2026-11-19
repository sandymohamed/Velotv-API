const { HttpError } = require('./errors');

function cents(value) {
  const match=/^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(String(value));
  if(!match)throw new HttpError(400,'Use a positive EUR amount with at most two decimal places.');
  return BigInt(match[1])*100n+BigInt((match[2]||'').padEnd(2,'0'));
}
function euro(value) {
  if(value<0n||value>999999999999n)throw new HttpError(409,'Agent balance is outside the supported range.');
  return `${value/100n}.${String(value%100n).padStart(2,'0')}`;
}
function transferTerms(amount,bps=1000) {
  const face=cents(amount);
  if(face<=0n||face>9999999n||!Number.isInteger(bps)||bps<0||bps>=10000)throw new HttpError(400,'Invalid transfer amount or margin.');
  // Round the cost up to the next cent so the agent margin never exceeds 10%.
  const cost=(face*BigInt(10000-bps)+9999n)/10000n;
  return {face_amount:euro(face),cost_amount:euro(cost),margin_amount:euro(face-cost),margin_bps:bps,currency:'EUR'};
}
module.exports={cents,euro,transferTerms};
