import {cloudRuntimeApi} from './cloud-runtime';

export function sharedCloudSource():string|null {
  if(typeof location==='undefined')return null;
  const value=new URLSearchParams(location.search).get('shared');
  return value&&/^[A-Za-z0-9_-]{1,160}$/.test(value)?value:null;
}
export async function sharedCloudApi<T>(path:string,body?:unknown,method?:string):Promise<T>{
  return cloudRuntimeApi<T>(sharedCloudSource()!,path,body,method);
}
