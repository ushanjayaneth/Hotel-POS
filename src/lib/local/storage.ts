import {localDb} from './db';

export interface DeviceStorageStatus{usage:number|null;quota:number|null;persistent:boolean;attempted:boolean;records:number;journal:number;lastBackup:string|null;lastBackupRecords:number;available:boolean}
export async function deviceStorageStatus():Promise<DeviceStorageStatus>{
  let estimate:StorageEstimate={};let persistent=false;
  try{estimate=await navigator.storage?.estimate()||{};persistent=await navigator.storage?.persisted()||false;}catch{/* The actual database read is the storage availability check. */}
  try{
    const [records,journal,attempt,lastBackup,lastBackupRecords]=await Promise.all([localDb.records.count(),localDb.journal.count(),localDb.metadata.get('storagePersistenceAttempted'),localDb.metadata.get('lastBackup'),localDb.metadata.get('lastBackupRecords')]);
    return{usage:estimate.usage??null,quota:estimate.quota??null,persistent,attempted:!!attempt?.value,records,journal,lastBackup:typeof lastBackup?.value==='string'?lastBackup.value:null,lastBackupRecords:Number(lastBackupRecords?.value)||0,available:true};
  }catch{return{usage:estimate.usage??null,quota:estimate.quota??null,persistent,attempted:false,records:0,journal:0,lastBackup:null,lastBackupRecords:0,available:false};}
}
/** Called once after successful setup. A refusal never creates a repeating prompt. */
export async function requestDevicePersistence(force=false):Promise<boolean>{
  if(!force&&(await localDb.metadata.get('storagePersistenceAttempted'))?.value)return !!(await navigator.storage?.persisted().catch(()=>false));
  await localDb.metadata.put({key:'storagePersistenceAttempted',value:true});
  try{return await navigator.storage?.persist?.()||false;}catch{return false;}
}
export function storageBytes(bytes:number|null){if(bytes===null)return'Not reported';if(bytes<1024)return`${bytes} B`;const scale=bytes>=1024**3?3:bytes>=1024**2?2:1;return`${(bytes/1024**scale).toFixed(1)} ${['B','KB','MB','GB'][scale]}`;}
