import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes,randomInt,scryptSync} from 'node:crypto';

// Local helper: secrets are written only to the ignored artifacts directory.
const args=process.argv.slice(2);
if(![2,3].includes(args.length)){
  console.log('Usage: node scripts/create-cloud-config.mjs [OWNER_EMAIL] SERVICE_ACCOUNT_FILE DATABASE_URL');
  console.log('Optional: provide the existing private POS PIN through POS_SETUP_PIN in the process environment. Do not put a PIN in command arguments.');
  process.exit(1);
}
const [email,servicePath,databaseUrl]=args.length===3?args:[undefined,...args];
if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Enter a valid owner email for optional legacy account compatibility.');
const suppliedPin=process.env.POS_SETUP_PIN;
if(suppliedPin!==undefined&&!/^[0-9]{6,16}$/.test(suppliedPin))throw new Error('POS_SETUP_PIN must contain 6 to 16 digits. The four-digit demo PIN cannot be used.');
let service;
try{service=JSON.parse(readFileSync(resolve(servicePath),'utf8'));}catch{throw new Error('Choose a readable Firebase Admin service-account JSON file.');}
if(!service||typeof service.private_key!=='string'||typeof service.client_email!=='string'||typeof service.project_id!=='string')throw new Error('Choose the Firebase Admin service-account JSON file.');
const url=new URL(databaseUrl);
if(url.protocol!=='https:'||!/(?:\.firebaseio\.com|\.firebasedatabase\.app)$/.test(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('Use the Firebase database HTTPS origin.');
const pin=suppliedPin??String(randomInt(10_000_000,100_000_000));
const encoded=value=>{const salt=randomBytes(32);return `scrypt$${salt.toString('hex')}$${scryptSync(value,salt,64).toString('hex')}`;};
const values={FIREBASE_DATABASE_URL:url.origin,FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify(service),CLOUD_POS_PIN_HASH:encoded(pin),CLOUD_SESSION_SECRET:randomBytes(48).toString('base64url')};
const password=email?randomBytes(24).toString('base64url'):null;
if(email){values.CLOUD_OWNER_EMAIL=email;values.CLOUD_OWNER_PASSWORD_HASH=encoded(password);}
const directory=resolve('artifacts','cloud-config',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(directory,{recursive:true});
for(const [name,value] of Object.entries(values))writeFileSync(resolve(directory,`${name}.txt`),value,{mode:0o600});
writeFileSync(resolve(directory,'POS-PIN.txt'),`POS PIN: ${pin}\n\nUse the normal app address on each authorized device. This is the single POS sign-in PIN, not a separate cloud account. Keep this local file private and deliver it only to the authorized owner. Do not upload this file or create an environment variable from it.\n`,{mode:0o600});
if(email)writeFileSync(resolve(directory,'OWNER-LOGIN.txt'),`Owner email: ${email}\nOwner password: ${password}\n\nOptional legacy account compatibility only. The normal POS uses POS-PIN.txt and does not ask for this account. Keep this local file private.\n`,{mode:0o600});
console.log(`Created private configuration files in ${directory}. Add the ${Object.keys(values).length} environment-value files to Vercel Production environment variables, then redeploy. POS-PIN.txt${email?' and OWNER-LOGIN.txt are private handover files':' is a private handover file'}, not environment variables. Credentials were not printed.`);
