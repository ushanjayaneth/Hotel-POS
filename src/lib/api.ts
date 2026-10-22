import {isDeviceWorkspace} from './workspace-mode';
import {sharedCloudSource,sharedCloudApi} from './cloud-shared';

export class ApiError extends Error {
  constructor(message: string, public status = 0) { super(message); this.name = 'ApiError'; }
}
export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  if(sharedCloudSource()){
    try{return await sharedCloudApi<T>(path,body,method);}catch(error){const value=error as Error&{status?:number};throw new ApiError(value.message,value.status??0);}
  }
  if(isDeviceWorkspace()){
    try {const {localApi}=await import('./local/core');return await localApi(path,body,method) as T;}
    catch(error){const value=error as Error&{status?:number;statusCode?:number};throw new ApiError(value.message,value.status??value.statusCode??0);}
  }
  return hubApi<T>(path,body,method);
}
export async function hubApi<T>(path:string,body?:unknown,method?:string):Promise<T>{
  const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {method:method ?? (body === undefined ? 'GET':'POST'),credentials:'same-origin',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  } catch { throw new ApiError('The branch hub is unavailable. Your draft is saved on this device.'); }
  if (response.status === 404 && !response.headers.get('content-type')?.includes('application/json')) {
    throw new ApiError('The POS backend is not connected to this website. Connect the branch hub to enable sign-in.', 404);
  }
  const result = await response.json().catch(()=>({message:'The server returned an invalid response.'}));
  if (!response.ok) throw new ApiError(result.message ?? result.error ?? 'This action could not be completed.',response.status);
  return result as T;
}

/** Downloads and printable reports use the selected workspace, just like JSON API calls. */
export async function apiResponse(path:string):Promise<Response>{
  if(!isDeviceWorkspace()&&!sharedCloudSource())return fetch(path.startsWith('/api/')?path:`/api${path}`,{credentials:'same-origin'});
  try{
    const result=await api<unknown>(path);
    return new Response(typeof result==='string'?result:JSON.stringify(result),{headers:{'Content-Type':typeof result==='string'?'text/csv;charset=utf-8':'application/json','Cache-Control':'no-store'}});
  }catch(error){const value=error as ApiError;return new Response(JSON.stringify({error:value.message}),{status:value.status>=400?value.status:500,headers:{'Content-Type':'application/json'}});}
}
