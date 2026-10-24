import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArchiveRestore, Check, Database, Download, HardDrive, LoaderCircle, RefreshCw, ShieldCheck, Smartphone, Upload } from 'lucide-react';
import { usePOS } from '../lib/context';
import { isDeviceWorkspace, useWorkspaceMode } from '../lib/workspace-mode';
import { sharedCloudSource } from '../lib/cloud-shared';
import { deviceStorageStatus, requestDevicePersistence, storageBytes, type DeviceStorageStatus } from '../lib/local/storage';
import { createEncryptedBackup, downloadBackupFile, inspectEncryptedBackup, markBackupDownloaded, restoreDeviceBackup } from '../lib/local/backup';
import { Modal } from './ui';
import '../styles/storage.css';

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}
let pendingInstall: InstallPrompt | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    pendingInstall = event as InstallPrompt;
    window.dispatchEvent(new Event('device-install-ready'));
  });
  window.addEventListener('appinstalled', () => {
    pendingInstall = null;
    window.dispatchEvent(new Event('device-install-ready'));
  });
}

function installedDisplay() {
  return window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
}
const dateLabel = (value: string) => new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
type InspectedBackup = Awaited<ReturnType<typeof inspectEncryptedBackup>>;

export function DeviceStorage() {
  useWorkspaceMode();
  const sharedSource=sharedCloudSource();
  return isDeviceWorkspace()||sharedSource ? <DeviceStoragePanel sharedSource={sharedSource} /> : null;
}
export default DeviceStorage;

function DeviceStoragePanel({sharedSource}:{sharedSource:string|null}) {
  const { data, notify } = usePOS();
  const [status, setStatus] = useState<DeviceStorageStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [persisting, setPersisting] = useState(false);
  const [dialog, setDialog] = useState<'export' | 'restore' | null>(null);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<InspectedBackup | null>(null);
  const [replaceAccepted, setReplaceAccepted] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [installed, setInstalled] = useState(installedDisplay);
  const [canInstall, setCanInstall] = useState(Boolean(pendingInstall));
  const [installing, setInstalling] = useState(false);
  const owner = data.user.role === 'owner';
  const businessName = data.settings.businessName;
  const persistenceSupported = typeof navigator.storage?.persist === 'function';

  const refreshStorage = useCallback(async () => {
    setRefreshing(true);
    try {
      setStatus(await deviceStorageStatus());
      setStatusError('');
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause.message : 'Storage information is unavailable.');
    } finally { setRefreshing(false); }
  }, []);

  useEffect(() => { void refreshStorage(); }, [refreshStorage, data.serverTime]);
  useEffect(() => {
    const refreshOnFocus = () => void refreshStorage();
    const installStatus = () => { setInstalled(installedDisplay()); setCanInstall(Boolean(pendingInstall)); };
    const onInstalled = () => { setInstalled(true); setCanInstall(false); };
    const standalone = window.matchMedia('(display-mode: standalone)');
    window.addEventListener('focus', refreshOnFocus);
    window.addEventListener('device-install-ready', installStatus);
    window.addEventListener('appinstalled', onInstalled);
    standalone.addEventListener('change', installStatus);
    return () => {
      window.removeEventListener('focus', refreshOnFocus);
      window.removeEventListener('device-install-ready', installStatus);
      window.removeEventListener('appinstalled', onInstalled);
      standalone.removeEventListener('change', installStatus);
    };
  }, [refreshStorage]);

  function closeDialog() {
    if (busy) return false;
    setDialog(null); setPassword(''); setConfirmPassword(''); setFile(null); setPreview(null); setReplaceAccepted(false); setConfirmName(''); setError('');
    return true;
  }
  function openDialog(next: 'export' | 'restore') {
    setPassword(''); setConfirmPassword(''); setFile(null); setPreview(null); setReplaceAccepted(false); setConfirmName(''); setError(''); setDialog(next);
  }
  async function persist() {
    setPersisting(true);
    try {
      const allowed = await requestDevicePersistence(true);
      await refreshStorage();
      notify(allowed ? 'Persistent storage is allowed for this workspace.' : 'The browser did not grant persistent storage. Keep an encrypted backup of your workspace.', allowed ? 'success' : 'error');
    } catch (cause) {
      setStatusError(cause instanceof Error ? cause.message : 'Unable to request persistent storage.');
    } finally { setPersisting(false); }
  }
  async function exportBackup(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (password.length < 10) { setError('Use a backup password with at least 10 characters.'); return; }
    if (password !== confirmPassword) { setError('The backup passwords do not match.'); return; }
    setBusy(true); setError('');
    try {
      const backup = await createEncryptedBackup(password);
      downloadBackupFile(backup.text, backup.filename);
      await markBackupDownloaded(backup.recordCount).catch(()=>{});
      setDialog(null); setPassword(''); setConfirmPassword('');
      await refreshStorage();
      notify('Encrypted backup download requested. Check your browser’s downloads.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to create the encrypted backup.'); }
    finally { setBusy(false); }
  }
  async function inspectBackup(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!file) { setError('Choose an encrypted .hotelbackup file.'); return; }
    setBusy(true); setError('');
    try {
      setPreview(await inspectEncryptedBackup(file, password));
      setPassword(''); setReplaceAccepted(false); setConfirmName('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to open this backup. Check the file and password.'); }
    finally { setBusy(false); }
  }
  async function restoreBackup(event: FormEvent) {
    event.preventDefault();
    if (!preview || busy || !replaceAccepted || confirmName.trim() !== businessName) return;
    setBusy(true); setError('');
    try {
      await restoreDeviceBackup(preview.payload);
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to restore this backup.');
      setBusy(false);
    }
  }
  async function install() {
    const prompt = pendingInstall;
    if (!prompt || installed || installing) return;
    setInstalling(true);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      pendingInstall = null; setCanInstall(false);
      if (choice.outcome === 'accepted') setInstalled(true);
    } catch (cause) { notify(cause instanceof Error ? cause.message : 'Use your browser’s Install app option.', 'error'); }
    finally { setInstalling(false); }
  }

  const percent = status?.usage !== null && status?.usage !== undefined && status.quota !== null && status.quota > 0 ? Math.min(100, status.usage / status.quota * 100) : null;
  const almostFull = percent !== null && percent >= 90;
  return <section className="panel preference-card device-storage" aria-label="Device storage and backups">
    <div className="preference-heading">
      <div className="preference-icon"><HardDrive size={20} /></div>
      <div><h2>Device storage & backups</h2><p>{sharedSource?'This device caches app data and unfinished drafts. Confirmed transactions are saved in the shared cloud workspace.':'Your workspace is saved in this browser on this device.'}</p></div>
      <span className="badge">{sharedSource?'Shared cloud workspace':'Device workspace'}</span>
    </div>
    <div className="storage-scope-note"><Database size={16} /><p>{sharedSource?'Use the same shared workspace on every device. After losing browser data, sign in with the cloud owner account and open the saved workspace to download confirmed cloud records. Unsaved drafts cannot be recovered from the cloud.':'This is an independent local workspace. Settings → Cloud connection can upload a copy for owner viewing; a shared cloud workspace is required for several online devices to use the same stock. Keep an encrypted backup outside this browser.'}</p></div>
    <div className="storage-meter-heading"><span>Browser storage for this website</span><button type="button" className="icon-button" aria-label="Refresh device storage" onClick={() => void refreshStorage()} disabled={refreshing}><RefreshCw size={14} className={refreshing ? 'spin' : ''} /></button></div>
    <div className="storage-meter-values"><strong>{status ? storageBytes(status.usage) : 'Checking storage…'}</strong><span>{status?.quota !== null && status?.quota !== undefined ? `of ${storageBytes(status.quota)} browser quota` : 'Browser quota not reported'}</span></div>
    {percent !== null && <div className={`storage-meter ${almostFull ? 'storage-meter-high' : ''}`} role="progressbar" aria-label="Browser storage used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}><span style={{width:`${percent}%`}} /></div>}
    {almostFull && <p className="storage-quota-note">Browser storage is nearly full. Save a backup and make room on this device for new transactions.</p>}
    <div className="storage-facts">
      {!sharedSource&&<div><span>Saved records</span><strong>{status ? status.records.toLocaleString('en-GB') : '—'}</strong></div>}
      {!sharedSource&&<div><span>Journal entries</span><strong>{status ? status.journal.toLocaleString('en-GB') : '—'}</strong></div>}
      <div><span>Persistent storage</span><strong className={status?.persistent ? 'storage-positive' : ''}>{status ? status.persistent ? 'Allowed' : 'Not granted' : 'Checking…'}</strong></div>
      {sharedSource?<div><span>Recovery account</span><strong>Cloud owner sign-in</strong><small>Open the same saved workspace after signing in.</small></div>:<div><span>Last backup download requested</span><strong>{status?.lastBackup ? dateLabel(status.lastBackup) : 'No backup recorded'}</strong>{status?.lastBackup ? <small>{status.lastBackupRecords.toLocaleString('en-GB')} records included</small> : null}</div>}
    </div>
    <div className="storage-persistence"><div><ShieldCheck size={17} /><p>{status?.persistent ? 'This browser has granted persistent storage. Keep an external backup for recovery.' : 'Persistent storage helps protect this workspace from automatic browser eviction.'}</p></div>{!status?.persistent && <button type="button" className="button button-small" onClick={() => void persist()} disabled={persisting || !persistenceSupported || !status?.available}>{persisting ? <LoaderCircle size={14} className="spin" /> : <ShieldCheck size={14} />}{persistenceSupported ? 'Request persistent storage' : 'Not supported by this browser'}</button>}</div>
    {(statusError || status && !status.available) && <div className="error-message" role="alert">{statusError || 'This browser’s workspace storage could not be opened. Keep the app open and try refreshing the storage information.'}</div>}
    <p className="storage-footnote">Usage includes this website’s cached app and saved data. The browser sets the available quota. Persistent storage protects against automatic eviction; it does not prevent deliberate site-data clearing, formatting or device loss. Installing the PWA does not provide that protection either.</p>
    {sharedSource?<p className="storage-owner-note">Local .hotelbackup export and replacement apply to the original device workspace, not this shared cloud workspace. Keep the original encrypted backup and a separate cloud recovery plan.</p>:owner ? <div className="storage-backup-actions"><button type="button" className="button button-primary" onClick={() => openDialog('export')} disabled={!status?.available}><Download size={15} /> Export encrypted backup</button><button type="button" className="button" onClick={() => openDialog('restore')} disabled={!status?.available}><ArchiveRestore size={15} /> Restore backup</button></div> : <p className="storage-owner-note">Ask the workspace owner to export or restore an encrypted backup.</p>}
    <div className="storage-install"><Smartphone size={20} /><div><strong>{installed ? 'App installed' : 'Open this workspace as an app'}</strong><p>{installed ? 'Launch the installed app from this device’s home screen or app list.' : canInstall ? 'Install the app for a dedicated window and quick access from this device.' : 'Use your browser’s Install app or Add to Home Screen option. In Safari, open Share, then Add to Home Screen.'}</p></div>{!installed && canInstall && <button type="button" className="button button-small" onClick={() => void install()} disabled={installing}><Download size={14} />{installing ? 'Installing…' : 'Install app'}</button>}{installed && <Check size={18} className="storage-positive" />}</div>

    {dialog === 'export' && <Modal title="Export encrypted backup" subtitle="Save a password-protected copy of this device’s workspace." onClose={closeDialog}>
      <form className="storage-backup-form" onSubmit={exportBackup}>
        <div className="storage-dialog-note"><ShieldCheck size={18} /><p>The backup includes business records, staff credentials, the journal and saved device drafts. Sessions are excluded.</p></div>
        <label className="field"><span>Backup password</span><input className="input" type="password" autoComplete="new-password" minLength={10} required value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /><small>Use at least 10 characters. This password cannot be recovered.</small></label>
        <label className="field"><span>Confirm backup password</span><input className="input" type="password" autoComplete="new-password" minLength={10} required value={confirmPassword} disabled={busy} onChange={event => setConfirmPassword(event.target.value)} /></label>
        <p className="storage-footnote">Keep the downloaded file somewhere outside this browser and store its password safely.</p>
        {error && <div className="error-message" role="alert">{error}</div>}
        <div className="form-actions"><button type="button" className="button button-ghost" onClick={closeDialog} disabled={busy}>Cancel</button><button className="button button-primary" disabled={busy}>{busy ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{busy ? 'Encrypting backup…' : 'Download encrypted backup'}</button></div>
      </form>
    </Modal>}
    {dialog === 'restore' && <Modal title="Restore encrypted backup" subtitle={preview ? 'Review the backup before replacing this device’s saved workspace.' : 'Choose a backup file and enter its password to review it.'} onClose={closeDialog}>
      {!preview ? <form className="storage-backup-form" onSubmit={inspectBackup}>
        <label className="field"><span>Encrypted backup file</span><input className="input storage-file-input" type="file" accept=".hotelbackup,application/octet-stream" required disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setError(''); }} /></label>
        <label className="field"><span>Backup password</span><input className="input" type="password" autoComplete="off" required disabled={busy} value={password} onChange={event => setPassword(event.target.value)} /></label>
        <p className="storage-footnote">Your current data remains in place while the backup is decrypted and checked.</p>
        {error && <div className="error-message" role="alert">{error}</div>}
        <div className="form-actions"><button type="button" className="button button-ghost" onClick={closeDialog} disabled={busy}>Cancel</button><button className="button button-primary" disabled={busy || !file}>{busy ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}{busy ? 'Checking backup…' : 'Review backup'}</button></div>
      </form> : <form className="storage-backup-form" onSubmit={restoreBackup}>
        <div className="storage-backup-preview"><span className="storage-preview-label">BACKUP CONTENTS</span><h3>{preview.workspace.businessName}</h3><dl><div><dt>Created</dt><dd>{dateLabel(preview.createdAt)}</dd></div><div><dt>Business records</dt><dd>{preview.records.toLocaleString('en-GB')}</dd></div><div><dt>Journal entries</dt><dd>{preview.payload.tables.journal.length.toLocaleString('en-GB')}</dd></div><div><dt>Staff credentials</dt><dd>{preview.payload.tables.credentials.length.toLocaleString('en-GB')}</dd></div><div><dt>Saved drafts</dt><dd>{preview.payload.drafts.length.toLocaleString('en-GB')}</dd></div></dl></div>
        <p className="storage-restore-notice">Restoring replaces this device’s saved workspace. You will need to sign in using a staff PIN from the backup.</p>
        <label className="storage-replace-checkbox"><input type="checkbox" checked={replaceAccepted} disabled={busy} onChange={event => setReplaceAccepted(event.target.checked)} /><span>Replace the workspace stored on this device with this backup.</span></label>
        <label className="field"><span>Type {businessName} to confirm</span><input className="input" autoComplete="off" required disabled={busy} value={confirmName} onChange={event => setConfirmName(event.target.value)} /></label>
        {error && <div className="error-message" role="alert">{error}</div>}
        <div className="form-actions"><button type="button" className="button button-ghost" disabled={busy} onClick={() => { setPreview(null); setFile(null); setPassword(''); setReplaceAccepted(false); setConfirmName(''); setError(''); }}>Choose another backup</button><button className="button button-danger" disabled={busy || !replaceAccepted || confirmName.trim() !== businessName}>{busy ? <LoaderCircle size={15} className="spin" /> : <ArchiveRestore size={15} />}{busy ? 'Restoring workspace…' : 'Replace and restore'}</button></div>
      </form>}
    </Modal>}
  </section>;
}
