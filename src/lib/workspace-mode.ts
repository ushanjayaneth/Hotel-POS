import {useSyncExternalStore} from 'react';
import {sharedCloudSource} from './cloud-shared';

export type WorkspaceMode = 'hub' | 'device';
const modeKey = 'dh-workspace-mode';
let selected: WorkspaceMode = readSavedWorkspaceMode() || 'hub';

export function readSavedWorkspaceMode(): WorkspaceMode | null {
  try {const value=localStorage.getItem(modeKey);return value==='hub'||value==='device'?value:null;} catch {return null;}
}
export function isDeviceWorkspace(){return selected==='device'&&!sharedCloudSource();}
export function setWorkspaceMode(mode:WorkspaceMode){
  selected=mode;
  try {localStorage.setItem(modeKey,mode);} catch {/* IndexedDB remains the system of record. */}
  if(typeof window!=='undefined')window.dispatchEvent(new Event('workspace-mode-change'));
}
const subscribe=(callback:()=>void)=>{
  const sync=(event:StorageEvent)=>{if(event.key===modeKey){selected=readSavedWorkspaceMode()||'hub';callback();}};
  window.addEventListener('workspace-mode-change',callback);window.addEventListener('storage',sync);
  return()=>{window.removeEventListener('workspace-mode-change',callback);window.removeEventListener('storage',sync);};
};
export function useWorkspaceMode(){return useSyncExternalStore(subscribe,()=>selected);}
export function deviceDraftId(branchId:string){const source=sharedCloudSource();return source?`cloud:${source}:${branchId}`:isDeviceWorkspace()?`device:${branchId}`:branchId;}
