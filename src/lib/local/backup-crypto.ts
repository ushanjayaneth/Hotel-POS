export interface EncryptedDeviceBackup {
  format:'demo-hotel-device-backup';version:1;createdAt:string;
  kdf:{name:'PBKDF2';hash:'SHA-256';iterations:310000;salt:string};
  cipher:{name:'AES-GCM';iv:string};compression:'gzip'|'none';data:string;
}
const encoder=new TextEncoder();
function base64(bytes:Uint8Array){
  const parts:string[]=[];for(let i=0;i<bytes.length;i+=16384)parts.push(String.fromCharCode(...bytes.subarray(i,i+16384)));
  return btoa(parts.join(''));
}
function unbase64(value:string){const text=atob(value);return Uint8Array.from(text,char=>char.charCodeAt(0));}
async function key(password:string,salt:Uint8Array){
  if(!crypto?.subtle)throw new Error('Encrypted backups require HTTPS and Web Crypto support.');
  const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt:salt as Uint8Array<ArrayBuffer>,iterations:310000},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
function header(value:Omit<EncryptedDeviceBackup,'data'>){return encoder.encode(JSON.stringify(value));}
export async function encryptDeviceBackup(value:unknown,password:string):Promise<string>{
  if(password.length<10||password.length>256)throw new Error('Use a backup password with 10–256 characters.');
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const compression=typeof CompressionStream!=='undefined'?'gzip':'none';
  const plain=encoder.encode(JSON.stringify(value));
  const bytes=compression==='gzip'?new Uint8Array(await new Response(new Blob([plain]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()):plain;
  const info:Omit<EncryptedDeviceBackup,'data'>={format:'demo-hotel-device-backup',version:1,createdAt:new Date().toISOString(),kdf:{name:'PBKDF2',hash:'SHA-256',iterations:310000,salt:base64(salt)},cipher:{name:'AES-GCM',iv:base64(iv)},compression};
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:header(info)},await key(password,salt),bytes as Uint8Array<ArrayBuffer>);
  return JSON.stringify({...info,data:base64(new Uint8Array(encrypted))});
}
export async function decryptDeviceBackup(text:string,password:string):Promise<unknown>{
  let value:EncryptedDeviceBackup;
  try{value=JSON.parse(text);}catch{throw new Error('This is not a valid device backup file.');}
  if(value?.format!=='demo-hotel-device-backup'||value.version!==1||value.kdf?.name!=='PBKDF2'||value.kdf.hash!=='SHA-256'||value.kdf.iterations!==310000||value.cipher?.name!=='AES-GCM'||!['gzip','none'].includes(value.compression)||typeof value.data!=='string')throw new Error('This backup format is not supported.');
  const {data,...info}=value;
  let decrypted:ArrayBuffer;
  try{
    const salt=unbase64(value.kdf.salt),iv=unbase64(value.cipher.iv);
    if(salt.length!==16||iv.length!==12)throw new Error('Invalid encryption header');
    decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv,additionalData:header(info)},await key(password,salt),unbase64(data));
  }catch{throw new Error('The backup password is incorrect, or the backup file is damaged.');}
  let plain=decrypted;
  if(value.compression==='gzip'){
    if(typeof DecompressionStream==='undefined')throw new Error('This browser cannot open compressed backups. Use a current browser.');
    plain=await new Response(new Blob([decrypted]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  try{return JSON.parse(new TextDecoder().decode(plain),(name,item)=>{if(['__proto__','prototype','constructor'].includes(name))throw new Error('Unsafe field');return item;});}
  catch{throw new Error('The backup contents could not be read.');}
}
