import {useEffect,useState} from 'react';
import {getCloudSyncState,getLastCloudContact,type CloudSyncState} from '../lib/cloud-sync';
import {sharedCloudSource} from '../lib/cloud-shared';
import '../styles/cloud-monitor.css';

export default function ConnectivityStatus(){
  const [online,setOnline]=useState(navigator.onLine),[state,setState]=useState<CloudSyncState|null>(null),[contact,setContact]=useState(getLastCloudContact),[clock,setClock]=useState(Date.now());
  const shared=Boolean(sharedCloudSource());
  useEffect(()=>{
    const net=()=>setOnline(navigator.onLine);
    const load=()=>{if(!shared)void getCloudSyncState().then(setState).catch(()=>{});};
    const cloud=()=>setContact(Date.now());
    net();load();
    const failed=()=>setContact(0);
    window.addEventListener('online',net);window.addEventListener('offline',net);window.addEventListener('cloud-monitor-change',load);window.addEventListener('cloud-contact',cloud);window.addEventListener('cloud-failure',failed);
    const timer=setInterval(()=>setClock(Date.now()),15000);return()=>{clearInterval(timer);window.removeEventListener('online',net);window.removeEventListener('offline',net);window.removeEventListener('cloud-monitor-change',load);window.removeEventListener('cloud-contact',cloud);window.removeEventListener('cloud-failure',failed);};
  },[]);
  const recent=online&&(shared?contact>0&&clock-contact<90000:Boolean(state?.lastSeenAt&&clock-new Date(state.lastSeenAt).getTime()<90000&&!state.lastError));
  const pending=!shared?state?.pending??0:0;
  const label=shared?(recent?'Connected':'Unavailable'):!state?'Not connected':state.needsReconnect?'Sign in again':state.shared?'Shared POS':pending?`${pending} pending`:recent?'Synced':'Offline';
  const dotColor=!online?'red':recent&&!pending?'green':pending?'amber':'red';
  return <div className="cloud-dots" aria-label="Connection status"><span title="This device’s network connection"><i className={`cloud-dot ${online?'green':'red'}`}/><span>{online?'Online':'Offline'}</span></span><span title={(!shared&&state?.lastError)||'Cloud status reflects the last successful server response. Sign in to the restaurant workspace to connect.'}><i className={`cloud-dot ${dotColor}`}/><span>Cloud {label}</span></span></div>;
}
