import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes,scryptSync} from 'node:crypto';

// Local helper: secrets are written only to the ignored artifacts directory.
const [email,servicePath,databaseUrl]=process.argv.slice(2);
if(!email||!servicePath||!databaseUrl){
  console.log('Usage: node scripts/create-cloud-config.mjs OWNER_EMAIL SERVICE_ACCOUNT_FILE DATABASE_URL');
  process.exit(1);
}
if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Enter a valid owner email.');
const service=JSON.parse(readFileSync(resolve(servicePath),'utf8'));
if(!service.private_key||!service.client_email||!service.project_id)throw new Error('Choose the Firebase Admin service-account JSON file.');
const url=new URL(databaseUrl);
if(url.protocol!=='https:'||!/(?:\.firebaseio\.com|\.firebasedatabase\.app)$/.test(url.hostname)||url.pathname!=='/'||url.search||url.hash)throw new Error('Use the Firebase database HTTPS origin.');
const password=randomBytes(24).toString('base64url'),salt=randomBytes(32);
const values={FIREBASE_DATABASE_URL:url.origin,FIREBASE_SERVICE_ACCOUNT_JSON:JSON.stringify(service),CLOUD_OWNER_EMAIL:email,CLOUD_OWNER_PASSWORD_HASH:`scrypt$${salt.toString('hex')}$${scryptSync(password,salt,64).toString('hex')}`,CLOUD_SESSION_SECRET:randomBytes(48).toString('base64url')};
const directory=resolve('artifacts','cloud-config',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(directory,{recursive:true});
for(const [name,value] of Object.entries(values))writeFileSync(resolve(directory,`${name}.txt`),value,{mode:0o600});
writeFileSync(resolve(directory,'OWNER-LOGIN.txt'),`Owner email: ${email}\nOwner password: ${password}\n\nKeep this local file private. The password is not a staff PIN.\n`,{mode:0o600});
console.log(`Created private configuration files in ${directory}. Add the five environment values to Vercel Production environment variables, then redeploy. Credentials were not printed.`);
