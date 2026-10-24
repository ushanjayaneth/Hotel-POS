import {localDb, type LocalDatabase} from './db';

export interface DeviceStorageStatus{usage:number|null;quota:number|null;persistent:boolean;attempted:boolean;records:number;journal:number;lastBackup:string|null;lastBackupRecords:number;available:boolean}
export async function deviceStorageStatus(db:LocalDatabase=localDb):Promise<DeviceStorageStatus>{
  let estimate:StorageEstimate={};let persistent=false;
  const storage=typeof navigator==='undefined'?undefined:navigator.storage;
  try{estimate=await storage?.estimate?.()||{};}catch{/* Some browsers withhold estimates. */}
  try{persistent=await storage?.persisted?.()||false;}catch{/* The actual database read checks availability. */}
  try{
    const [records,journal,attempt,lastBackup,lastBackupRecords]=await Promise.all([db.records.count(),db.journal.count(),db.metadata.get('storagePersistenceAttempted'),db.metadata.get('lastBackup'),db.metadata.get('lastBackupRecords')]);
    return{usage:estimate.usage??null,quota:estimate.quota??null,persistent,attempted:!!attempt?.value,records,journal,lastBackup:typeof lastBackup?.value==='string'?lastBackup.value:null,lastBackupRecords:Number(lastBackupRecords?.value)||0,available:true};
  }catch{return{usage:estimate.usage??null,quota:estimate.quota??null,persistent,attempted:false,records:0,journal:0,lastBackup:null,lastBackupRecords:0,available:false};}
}
/** Automatic calls run once after a real workspace opens; force is for a Settings click only. */
export async function requestDevicePersistence(force=false,db:LocalDatabase=localDb):Promise<boolean>{
  const storage=typeof navigator==='undefined'?undefined:navigator.storage;
  try{if(await storage?.persisted?.())return true;}catch{/* A supported request may still work. */}
  // Do not record a refusal when this browser has no persistence API. A later
  // supported browser version can make its first real request after setup.
  if(typeof storage?.persist!=='function')return false;
  try{
    // Claim the one automatic attempt atomically, including across open tabs.
    // Do not hold an IndexedDB transaction open while the browser asks permission.
    const claimed=await db.transaction('rw',db.metadata,async()=>{
      if(!force&&(await db.metadata.get('storagePersistenceAttempted'))?.value)return false;
      await db.metadata.put({key:'storagePersistenceAttempted',value:true});
      return true;
    });
    if(!claimed)return false;
  }catch{return false;}
  try{return await storage.persist();}catch{return false;}
}
export function storageBytes(bytes:number|null){if(bytes===null)return'Not reported';if(bytes<1024)return`${bytes} B`;const scale=bytes>=1024**3?3:bytes>=1024**2?2:1;return`${(bytes/1024**scale).toFixed(1)} ${['B','KB','MB','GB'][scale]}`;}
