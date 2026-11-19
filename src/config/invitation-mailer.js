function createInvitationMailer(env=process.env){
  if(!env.SMTP_HOST)return null;
  const nodemailer=require('nodemailer');
  const port=Number(env.SMTP_PORT||587);
  if(!env.SMTP_USER||!env.SMTP_PASSWORD||!env.SMTP_FROM||![465,587].includes(port))throw new Error('Configure SMTP credentials, SMTP_FROM and port 465 or 587.');
  const transport=nodemailer.createTransport({host:env.SMTP_HOST,port,secure:port===465,requireTLS:port===587,
    auth:{user:env.SMTP_USER,pass:env.SMTP_PASSWORD},connectionTimeout:10000,greetingTimeout:10000,socketTimeout:15000,
    tls:{rejectUnauthorized:true},logger:false,debug:false});
  return async({to,link})=>{
    await transport.sendMail({from:env.SMTP_FROM,to,subject:'Set up your VeloTV reseller account',
      text:`Your VeloTV reseller account is ready for setup. Choose your own password using this private link:\n\n${link}\n\nThe link expires in 24 hours. Do not share it with your sales agent or anyone else. If you did not request an account, ignore this message.`});
  };
}
module.exports={createInvitationMailer};
