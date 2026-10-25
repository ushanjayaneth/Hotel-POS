import {useEffect,useState} from 'react';
import {getCloudSyncState,getLastCloudContact,type CloudSyncState} from '../lib/cloud-sync';
import {sharedCloudSource} from '../lib/cloud-shared';
import {getOfflineStatus,type CloudOfflineStatus} from '../lib/cloud-offline';
import '../styles/cloud-monitor.css';

export default function ConnectivityStatus(){
  const [online,setOnline]=useState(navigator.onLine),[state,setState]=useState<CloudSyncState|null>(null),[contact,setContact]=useState(getLastCloudContact),[clock,setClock]=useState(Date.now());
  const source=sharedCloudSource(),shared=Boolean(source);
  const [offlineState,setOfflineState]=useState<CloudOfflineStatus|null>(null);
  useEffect(()=>{
    const net=()=>setOnline(navigator.onLine);
    const load=()=>{if(source)void getOfflineStatus(source).then(setOfflineState).catch(()=>{});else void getCloudSyncState().then(setState).catch(()=>{});};
    const cloud=()=>setContact(Date.now());
    net();load();
    const failed=()=>setContact(0);
    window.addEventListener('online',net);window.addEventListener('offline',net);window.addEventListener('cloud-monitor-change',load);window.addEventListener('cloud-offline-change',load);window.addEventListener('cloud-contact',cloud);window.addEventListener('cloud-failure',failed);
    const timer=setInterval(()=>{setClock(Date.now());load();},15000);return()=>{clearInterval(timer);window.removeEventListener('online',net);window.removeEventListener('offline',net);window.removeEventListener('cloud-monitor-change',load);window.removeEventListener('cloud-offline-change',load);window.removeEventListener('cloud-contact',cloud);window.removeEventListener('cloud-failure',failed);};
  },[]);
  const recent=online&&(shared?contact>0&&clock-contact<90000:Boolean(state?.lastSeenAt&&clock-new Date(state.lastSeenAt).getTime()<90000&&!state.lastError));
  const pending=shared?offlineState?.pending??0:state?.pending??0;
  const label=shared?(pending?`${pending} pending`:!online&&offlineState?.ready?'Offline ready':recent?'Connected':'Reconnecting'):!state?'Not connected':state.needsReconnect?'Sign in again':state.shared?'Shared POS':pending?`${pending} pending`:recent?'Synced':'Offline';
  const dotColor=pending||shared&&!online&&offlineState?.ready?'amber':!online?'red':recent?'green':'red';
  return <div className="cloud-dots" aria-label="Connection status"><span title="This device’s network connection"><i className={`cloud-dot ${online?'green':'red'}`}/><span>{online?'Online':'Offline'}</span></span><span title={(!shared&&state?.lastError)||'Cloud status reflects the last successful server response. Sign in to the restaurant workspace to connect.'}><i className={`cloud-dot ${dotColor}`}/><span>Cloud {label}</span></span></div>;
}
