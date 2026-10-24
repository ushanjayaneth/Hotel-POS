import {cloudRequest} from './cloud-sync';
import type {User,Snapshot} from '../../shared/types';
const snapshots=new Map<string,Snapshot&{cloudVersion?:number}>();

export function sharedCloudSource():string|null {
  if(typeof location==='undefined')return null;
  const value=new URLSearchParams(location.search).get('shared');
  return value&&/^[A-Za-z0-9_-]{1,160}$/.test(value)?value:null;
}
const user:User={id:'cloud-owner',name:'Administrator',initials:'A',role:'owner',branchId:null};
export async function sharedCloudApi<T>(path:string,body?:unknown,method?:string):Promise<T>{
  const sourceId=sharedCloudSource()!;
  const url=new URL(path.replace(/^\/api(?=\/)/,''),'https://workspace');
  if(url.pathname==='/session'){const result=await cloudRequest<{authenticated:boolean}>('pos-session');return {user:result.authenticated?user:null,demo:false} as T;}
  if(url.pathname==='/login'){await cloudRequest('pos-login',body);return {user,demo:false} as T;}
  if(url.pathname==='/logout'){await cloudRequest('pos-logout',{});snapshots.clear();location.href='/';return {ok:true} as T;}
  if(url.pathname==='/bootstrap'){
    const key=`${sourceId}:${url.searchParams.get('branchId')??''}`,cached=snapshots.get(key);
    const result=await cloudRequest<Snapshot&{cloudVersion?:number;notModified?:boolean}>(`bootstrap&sourceId=${encodeURIComponent(sourceId)}&${url.searchParams}${cached?`&ifVersion=${cached.cloudVersion??0}`:''}`);
    if(result.notModified&&cached)return {...cached,serverTime:result.serverTime} as T;
    snapshots.set(key,result);return result as T;
  }
  const verb=method??(body===undefined?'GET':'POST');
  return cloudRequest<T>('command',{sourceId,path:url.pathname+url.search,method:verb,...(body===undefined?{}:{body:{...body as object,...(verb==='GET'?{}:{commandId:(body as {commandId?:string}).commandId??`command-${crypto.randomUUID()}`})}})});
}
