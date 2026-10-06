import {createPublicKey,verify} from 'node:crypto';
const denied=()=>Object.assign(new Error('Sign in through Cloudflare Access to open Receipt Box.'),{status:403});
export function createAccessVerifier({issuer,audience,fetcher=fetch,clock=Date.now}){
 if(!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer)||!audience)throw new Error('Invalid Cloudflare Access configuration.');
 let keys=[],expires=0,pending;
 async function refresh(){
  if(!pending)pending=(async()=>{
   const response=await fetcher(issuer+'/cdn-cgi/access/certs',{signal:AbortSignal.timeout(8000),redirect:'error'});
   if(!response.ok)throw denied();
   const body=await response.json();if(!Array.isArray(body.keys))throw denied();
   keys=body.keys.filter(k=>k.kty==='RSA'&&k.kid&&(!k.alg||k.alg==='RS256')).map(k=>({kid:k.kid,key:createPublicKey({key:k,format:'jwk'})}));
   expires=clock()+300000;
  })().finally(()=>{pending=null;});
  await pending;
 }
 return async token=>{
  try{
   if(typeof token!=='string'||token.length>16000)throw denied();
   const parts=token.split('.');if(parts.length!==3||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))throw denied();
   const header=JSON.parse(Buffer.from(parts[0],'base64url'));
   if(header.alg!=='RS256'||typeof header.kid!=='string'||header.crit)throw denied();
   if(clock()>=expires)await refresh();
   const key=keys.find(k=>k.kid===header.kid);if(!key||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),key.key,Buffer.from(parts[2],'base64url')))throw denied();
   const claims=JSON.parse(Buffer.from(parts[1],'base64url')),now=clock()/1000;
   if(claims.iss!==issuer||!Array.isArray(claims.aud)||!claims.aud.includes(audience)||claims.type!=='app'||typeof claims.sub!=='string'||!claims.sub||typeof claims.email!=='string'||!claims.email)throw denied();
   if(!Number.isFinite(claims.exp)||claims.exp<=now||!Number.isFinite(claims.iat)||claims.iat>now+30||(claims.nbf!==undefined&&(!Number.isFinite(claims.nbf)||claims.nbf>now+30)))throw denied();
   return claims;
  }catch{throw denied();}
 };
}
// The listener decides the trust boundary, never a caller-controlled header/Host.
export async function authenticateRequest(req,{cloudflare,verifyAccess,allowedLogin}){
 if(cloudflare)return verifyAccess(req.headers['cf-access-jwt-assertion']);
 if(allowedLogin&&req.headers['tailscale-user-login']!==allowedLogin)throw Object.assign(new Error('Connect with the authorised Tailscale account to access Receipt Box.'),{status:403});
}
