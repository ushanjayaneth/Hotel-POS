import {useState,type FormEvent} from 'react';
import {ArchiveRestore,Check,Database,HardDrive,LoaderCircle,LockKeyhole} from 'lucide-react';
import type {User} from '../../shared/types';
import {initializeLocalWorkspace,getLocalWorkspaceInfo} from '../lib/local/core';
import {requestDevicePersistence} from '../lib/local/storage';
import {inspectEncryptedBackup,restoreDeviceBackup} from '../lib/local/backup';
import {setWorkspaceMode} from '../lib/workspace-mode';
import {Modal} from './ui';
import '../styles/storage.css';

export function DeviceSetup({onClose,onComplete}:{onClose:()=>void;onComplete:(user:User)=>void}){
  const [name,setName]=useState('DEMO HOTEL');const [owner,setOwner]=useState('Administrator');const [pin,setPin]=useState('');const [confirm,setConfirm]=useState('');
  const [demo,setDemo]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function setup(event:FormEvent){
    event.preventDefault();if(busy)return;if(pin!==confirm){setError('The owner PINs do not match.');return;}
    setBusy(true);setError('');
    try{
      const initialized=await initializeLocalWorkspace({businessName:name,ownerName:owner,pin,demo});
      if(!(await getLocalWorkspaceInfo()))throw new Error('The device database could not be verified. Keep this page open and try again.');
      // One permission attempt after a committed setup. Refusal does not interrupt billing or repeat on launch.
      await requestDevicePersistence().catch(()=>false);
      setWorkspaceMode('device');onComplete(initialized.user);
    }catch(cause){setError((cause as Error).message);setBusy(false);}
  }
  return <Modal title="Set up this device" subtitle="Create a private workspace that keeps working without a hosted backend." onClose={()=>busy?false:onClose()}>
    <form className="storage-backup-form" onSubmit={setup}>
      <div className="storage-dialog-note"><Database size={20}/><p>Bills, payments, products and stock are saved on this device. Other devices will have separate workspaces until a shared hub is connected.</p></div>
      <label className="field"><span>Business name</span><input className="input" required minLength={2} maxLength={100} value={name} onChange={event=>setName(event.target.value)} disabled={busy}/></label>
      <label className="field"><span>Owner name</span><input className="input" required minLength={2} maxLength={120} value={owner} onChange={event=>setOwner(event.target.value)} disabled={busy}/></label>
      <div className="form-grid"><label className="field"><span>Owner PIN</span><input className="input" type="password" inputMode="numeric" pattern="[0-9]{6,12}" minLength={6} maxLength={12} autoComplete="new-password" required value={pin} onChange={event=>setPin(event.target.value.replace(/\D/g,''))} disabled={busy}/><small>Choose a private PIN with 6–12 digits.</small></label><label className="field"><span>Confirm owner PIN</span><input className="input" type="password" inputMode="numeric" pattern="[0-9]{6,12}" minLength={6} maxLength={12} autoComplete="new-password" required value={confirm} onChange={event=>setConfirm(event.target.value.replace(/\D/g,''))} disabled={busy}/></label></div>
      <label className="storage-replace-checkbox"><input type="checkbox" checked={demo} onChange={event=>setDemo(event.target.checked)} disabled={busy}/><span>Include sample menu and stock for evaluation. Leave unchecked for a new business.</span></label>
      <p className="storage-footnote"><LockKeyhole size={12}/> Your PIN unlocks this device workspace. Export encrypted backups from Settings and keep a copy outside this browser. Setup will stay completed when you reopen the app.</p>
      {error&&<div className="error-message" role="alert">{error}</div>}
      <div className="form-actions"><button type="button" className="button button-ghost" disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy?<LoaderCircle size={15} className="spin"/>:<HardDrive size={15}/>}{busy?'Creating device workspace…':'Create device workspace'}</button></div>
    </form>
  </Modal>;
}

export function InitialDeviceRestore({onClose}:{onClose:()=>void}){
  const [file,setFile]=useState<File|null>(null);const [password,setPassword]=useState('');const [preview,setPreview]=useState<Awaited<ReturnType<typeof inspectEncryptedBackup>>|null>(null);const [accepted,setAccepted]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function inspect(event:FormEvent){event.preventDefault();if(!file||busy)return;setBusy(true);setError('');try{setPreview(await inspectEncryptedBackup(file,password));setPassword('');}catch(cause){setError((cause as Error).message);}finally{setBusy(false);}}
  async function restore(){if(!preview||!accepted||busy)return;setBusy(true);setError('');try{await restoreDeviceBackup(preview.payload);setWorkspaceMode('device');location.reload();}catch(cause){setError((cause as Error).message);setBusy(false);}}
  return <Modal title="Restore device workspace" subtitle="Open an encrypted backup on this device." onClose={()=>busy?false:onClose()}>{!preview?<form className="storage-backup-form" onSubmit={inspect}><label className="field"><span>Encrypted backup file</span><input type="file" className="input storage-file-input" accept=".hotelbackup" required disabled={busy} onChange={event=>setFile(event.target.files?.[0]||null)}/></label><label className="field"><span>Backup password</span><input className="input" type="password" autoComplete="off" required disabled={busy} value={password} onChange={event=>setPassword(event.target.value)}/></label>{error&&<div className="error-message" role="alert">{error}</div>}<div className="form-actions"><button className="button button-primary" disabled={busy||!file}>{busy?<LoaderCircle size={15} className="spin"/>:<ArchiveRestore size={15}/>}{busy?'Checking backup…':'Review backup'}</button></div></form>:<div className="storage-backup-form"><div className="storage-backup-preview"><span className="storage-preview-label">BACKUP CONTENTS</span><h3>{preview.workspace.businessName}</h3><p>{preview.records.toLocaleString('en-GB')} records · {new Date(preview.createdAt).toLocaleString('en-GB')}</p></div><p className="storage-footnote">Sign in with a staff PIN from this backup after restoring. Historical bills keep their identifiers; new bills use this device’s own identity.</p><label className="storage-replace-checkbox"><input type="checkbox" checked={accepted} onChange={event=>setAccepted(event.target.checked)} disabled={busy}/><span>Restore this workspace on this device.</span></label>{error&&<div className="error-message" role="alert">{error}</div>}<div className="form-actions"><button className="button button-primary" disabled={busy||!accepted} onClick={()=>void restore()}>{busy?<LoaderCircle size={15} className="spin"/>:<Check size={15}/>}{busy?'Restoring…':'Restore workspace'}</button></div></div>}</Modal>;
}
