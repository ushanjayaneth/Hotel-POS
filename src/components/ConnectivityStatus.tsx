import {useEffect,useState} from 'react';
import {getCloudSyncState,type CloudSyncState} from '../lib/cloud-sync';
import {sharedCloudSource} from '../lib/cloud-shared';
import '../styles/cloud-monitor.css';

export default function ConnectivityStatus(){
  const [online,setOnline]=useState(navigator.onLine),[state,setState]=useState<CloudSyncState|null>(null),[contact,setContact]=useState(0),[clock,setClock]=useState(Date.now());
  const shared=Boolean(sharedCloudSource());
  useEffect(()=>{const net=()=>setOnline(navigator.onLine),load=()=>void getCloudSyncState().then(setState).catch(()=>{}),cloud=()=>setContact(Date.now());net();load();
    const failed=()=>setContact(0);
    window.addEventListener('online',net);window.addEventListener('offline',net);window.addEventListener('cloud-monitor-change',load);window.addEventListener('cloud-contact',cloud);window.addEventListener('cloud-failure',failed);
    const timer=setInterval(()=>setClock(Date.now()),15000);return()=>{clearInterval(timer);window.removeEventListener('online',net);window.removeEventListener('offline',net);window.removeEventListener('cloud-monitor-change',load);window.removeEventListener('cloud-contact',cloud);window.removeEventListener('cloud-failure',failed);};
  },[]);
  const recent=online&&(shared?clock-contact<90000:Boolean(state?.lastSeenAt&&clock-new Date(state.lastSeenAt).getTime()<90000&&!state.lastError));
  const label=shared?(recent?'Connected':'Unavailable'):!state?'Not linked':state.shared?'Shared POS':state.pending?`${state.pending} pending`:recent?'Synced':'Offline';
  return <div className="cloud-dots" aria-label="Connection status"><span title="This device’s network connection"><i className={`cloud-dot ${online?'green':'red'}`}/><span>{online?'Online':'Offline'}</span></span><span title={state?.lastError||'A successful cloud response is required for a green cloud indicator.'}><i className={`cloud-dot ${recent&&!state?.pending?'green':state?.pending?'amber':'red'}`}/><span>Cloud {label}</span></span></div>;
}
