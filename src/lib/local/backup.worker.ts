import {encryptDeviceBackup,decryptDeviceBackup} from './backup-crypto';

self.addEventListener('message',async(event:MessageEvent)=>{
  try{
    const {operation,value,password}=event.data;
    const result=operation==='encrypt'?await encryptDeviceBackup(value,password):await decryptDeviceBackup(value,password);
    self.postMessage({ok:true,result});
  }catch(error){self.postMessage({ok:false,error:(error as Error).message});}
});
