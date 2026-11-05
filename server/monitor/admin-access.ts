import {createCipheriv,createHash,createHmac,pbkdf2Sync,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import type {AdminAccessConfiguration,SealedAdminAccess} from '../../shared/admin-access.js';

const digest=(value:string)=>createHash('sha256').update(value).digest();
const equal=(left:string,right:string)=>timingSafeEqual(digest(left),digest(right));
const pinPattern=/^\d{4,16}$/;
const scryptPattern=/^scrypt\$[a-fA-F0-9]{64}\$[a-fA-F0-9]{128}$/;
export function createAdminAccess(env:NodeJS.ProcessEnv){
  const enabled=()=>Boolean(env.CLOUD_ADMIN_PIN||env.CLOUD_ADMIN_PIN_HASH);
  const version=()=>createHmac('sha256',env.CLOUD_SESSION_SECRET!).update(`hotel-pos-admin-v1:${env.CLOUD_ADMIN_PIN_HASH??env.CLOUD_ADMIN_PIN}`).digest('hex');
  const sign=(payload:Record<string,unknown>)=>{
    const text=Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${text}.${createHmac('sha256',env.CLOUD_SESSION_SECRET!).update(`admin:${text}`).digest('base64url')}`;
  };
  function validPIN(pin:string){
    if(!pinPattern.test(pin))return false;
    if(env.CLOUD_ADMIN_PIN_HASH){
      try{if(!scryptPattern.test(env.CLOUD_ADMIN_PIN_HASH))return false;const [,salt,hash]=env.CLOUD_ADMIN_PIN_HASH.split('$');return equal(scryptSync(pin,Buffer.from(salt,'hex'),64).toString('hex'),hash.toLowerCase());}catch{return false;}
    }
    return Boolean(env.CLOUD_ADMIN_PIN&&pinPattern.test(env.CLOUD_ADMIN_PIN)&&equal(pin,env.CLOUD_ADMIN_PIN));
  }
  function validGrant(grant:unknown,sourceId:string){
    if(typeof grant!=='string'||grant.length>10000)return false;
    try{
      const [text,signature,...extra]=grant.split('.');
      if(!text||!signature||extra.length||!equal(signature,createHmac('sha256',env.CLOUD_SESSION_SECRET!).update(`admin:${text}`).digest('base64url')))return false;
      const value=JSON.parse(Buffer.from(text,'base64url').toString());
      return value.purpose==='admin-offline-v1'&&value.sourceId===sourceId&&value.version===version()&&typeof value.exp==='number'&&Number.isFinite(value.exp)&&value.exp>Date.now();
    }catch{return false;}
  }
  const packages=new Map<string,SealedAdminAccess>();
  function configuration(sourceId:string,pin?:string):AdminAccessConfiguration{
    if(!enabled())return {enabled:false};
    const previous=packages.get(sourceId);
    if(previous?.version===version()&&previous.expiresAt>Date.now()+86400000)return {enabled:true,offline:previous};
    const password=pin??env.CLOUD_ADMIN_PIN;
    if(!password||!validPIN(password))return {enabled:true};
    const expiresAt=Date.now()+365*86400000,stamp=version();
    const grant=sign({purpose:'admin-offline-v1',sourceId,version:stamp,exp:expiresAt,nonce:randomBytes(16).toString('hex')});
    const salt=randomBytes(32),iv=randomBytes(12),iterations=600000;
    const key=pbkdf2Sync(password,salt,iterations,32,'sha256');
    const cipher=createCipheriv('aes-256-gcm',key,iv);
    cipher.setAAD(Buffer.from(`hotel-pos-admin:${sourceId}`));
    const encrypted=Buffer.concat([cipher.update(JSON.stringify({grant}),'utf8'),cipher.final(),cipher.getAuthTag()]);
    const offline:SealedAdminAccess={v:1,sourceId,version:stamp,salt:salt.toString('hex'),iv:iv.toString('hex'),iterations,ciphertext:encrypted.toString('base64'),expiresAt};
    packages.set(sourceId,offline);return {enabled:true,offline};
  }
  return {enabled,validPIN,validGrant,configuration};
}
