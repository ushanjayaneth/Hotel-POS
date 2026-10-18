import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import staticPlugin from '@fastify/static';
import { createApp } from './app';

const app=await createApp({logger:true});
const dist=resolve('dist');
if(existsSync(dist)) {
  await app.register(staticPlugin,{root:dist,prefix:'/',wildcard:false});
  app.setNotFoundHandler((request,reply)=>request.url.startsWith('/api/')?reply.code(404).send({error:'API route not found.',code:'NOT_FOUND'}):reply.sendFile('index.html',{cacheControl:false}));
}
const close=async()=>{await app.close();process.exit(0);};
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
await app.listen({port:Number(process.env.PORT??3001),host:process.env.HOST??'0.0.0.0'});
