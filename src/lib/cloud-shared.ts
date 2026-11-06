import {cloudRuntimeApi} from './cloud-runtime';

const sourceChanged='cloud-workspace-open';

export function sharedCloudSource():string|null {
  if(typeof location==='undefined')return null;
  const value=new URLSearchParams(location.search).get('shared');
  return value&&/^[A-Za-z0-9_-]{1,160}$/.test(value)?value:null;
}
/** Enter an already verified shop without downloading and evaluating the app
 * a second time. App observes the URL change before mounting its workspace. */
export function openSharedCloudWorkspace(sourceId:string):void {
  if(!/^[A-Za-z0-9_-]{1,160}$/.test(sourceId))throw new Error('Invalid cloud workspace.');
  const url=new URL(location.href);
  url.searchParams.delete('local');url.searchParams.set('shared',sourceId);
  history.replaceState(history.state,'',`${url.pathname}${url.search}${url.hash}`);
  window.dispatchEvent(new Event(sourceChanged));
}
export function subscribeSharedCloudSource(changed:()=>void):()=>void {
  window.addEventListener(sourceChanged,changed);window.addEventListener('popstate',changed);
  return()=>{window.removeEventListener(sourceChanged,changed);window.removeEventListener('popstate',changed);};
}
export async function sharedCloudApi<T>(path:string,body?:unknown,method?:string):Promise<T>{
  return cloudRuntimeApi<T>(sharedCloudSource()!,path,body,method);
}
