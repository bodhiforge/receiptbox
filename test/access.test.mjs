import {test} from 'node:test';import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';import {createAccessVerifier,authenticateRequest} from '../src/access.mjs';
const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});const jwk={...publicKey.export({format:'jwk'}),kid:'test',alg:'RS256'};
const now=1800000000000,issuer='https://fixture.cloudflareaccess.com',audience='receipt-app';
const claims={iss:issuer,aud:[audience],type:'app',sub:'user',email:'fixture@example.com',iat:now/1000-10,exp:now/1000+100};
const token=(c=claims,h={alg:'RS256',kid:'test'},key=privateKey)=>{const data=[h,c].map(o=>Buffer.from(JSON.stringify(o)).toString('base64url')).join('.');return data+'.'+sign('RSA-SHA256',Buffer.from(data),key).toString('base64url');};
test('Access validates signature, issuer, application, expiry and human identity',async()=>{
 let calls=0;const verify=createAccessVerifier({issuer,audience,clock:()=>now,fetcher:async()=>{calls++;return Response.json({keys:[jwk]});}});
 assert.equal((await verify(token())).email,claims.email);await verify(token());assert.equal(calls,1);
 for(const patch of [{iss:'https://other.cloudflareaccess.com'},{aud:['other']},{exp:now/1000},{exp:'later'},{iat:now/1000+120},{nbf:now/1000+120},{type:'meta'},{email:''},{sub:''}])await assert.rejects(verify(token({...claims,...patch})),{status:403});
 for(const value of [undefined,'garbage',token(claims,{alg:'none',kid:'test'}),token(claims,{alg:'RS256',kid:'unknown'}),token().slice(0,-20)+'AAAAAAAAAAAAAAAAAAAA'])await assert.rejects(verify(value),{status:403});
 const other=generateKeyPairSync('rsa',{modulusLength:2048});await assert.rejects(verify(token(claims,{alg:'RS256',kid:'test'},other.privateKey)),{status:403});
});
test('Cloudflare listener never trusts forged Tailscale or email headers; failures deny access',async()=>{
 const verifyAccess=createAccessVerifier({issuer,audience,clock:()=>now,fetcher:async()=>{throw Error('offline');}});
 await assert.rejects(authenticateRequest({headers:{'tailscale-user-login':'owner','cf-access-authenticated-user-email':'fixture@example.com'}},{cloudflare:true,verifyAccess,allowedLogin:'owner'}),{status:403});
 await assert.rejects(verifyAccess(token()),{status:403});
 await authenticateRequest({headers:{'tailscale-user-login':'owner'}},{cloudflare:false,allowedLogin:'owner'});
 await assert.rejects(authenticateRequest({headers:{}},{cloudflare:false,allowedLogin:'owner'}),{status:403});
});
