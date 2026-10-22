import type {IncomingMessage,ServerResponse} from 'node:http';
import {createMonitorHandler} from '../server/monitor/handler.js';

const handler=createMonitorHandler();
export default async function cloud(request:IncomingMessage&{body?:unknown},response:ServerResponse) {
  const host=request.headers.host??'localhost';
  const protocol=request.headers['x-forwarded-proto']==='http'?'http':'https';
  const headers=new Headers();
  for(const [key,value] of Object.entries(request.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
  let body:string|undefined;
  if(!['GET','HEAD'].includes(request.method??'GET')){
    if(request.body!==undefined)body=typeof request.body==='string'?request.body:JSON.stringify(request.body);
    else{const chunks:Buffer[]=[];let bytes=0;for await(const part of request){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>700000){response.writeHead(413);response.end();return;}chunks.push(chunk);}body=Buffer.concat(chunks).toString();}
  }
  const result=await handler(new Request(`${protocol}://${host}${request.url}`,{method:request.method,headers,body}));
  response.writeHead(result.status,Object.fromEntries(result.headers));response.end(await result.text());
}
