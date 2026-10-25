import {useId, useRef, useState} from 'react';
import {Camera, ImagePlus, Link, Upload, X} from 'lucide-react';
import {isProductImageReference} from '../../shared/media';
import {compressFile} from '../lib/media';
import {isDeviceWorkspace} from '../lib/workspace-mode';
import {sharedCloudSource} from '../lib/cloud-shared';
import ProductPhoto from './ProductPhoto';
import '../styles/photos.css';

export function PhotoPicker({value, onChange, onBusyChange, disabled = false}: {value: string; onChange: (value: string) => void; onBusyChange?: (busy: boolean) => void; disabled?: boolean}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const uploaded = /^(?:local-image:|\/api\/media\/)/.test(value);
  const shared=Boolean(sharedCloudSource());
  async function select(file?: File) {
    if (!file || busy) return;
    setBusy(true); onBusyChange?.(true); setError('');
    try {onChange(await compressFile(file));}
    catch (cause) {setError(cause instanceof Error ? cause.message : 'This photo could not be saved.');}
    finally {setBusy(false); onBusyChange?.(false); if (input.current) input.current.value = ''; if (camera.current) camera.current.value = '';}
  }
  return <div className="photo-picker product-field-full">
    <div className="photo-picker-heading"><span>Product photo</span><small>Camera, file or image link</small></div>
    <div className="photo-picker-content">
      <div className="photo-picker-preview">{value && isProductImageReference(value) ? <ProductPhoto src={value} alt="Product photo preview" /> : <ImagePlus size={28} />}</div>
      <div className="photo-picker-controls">
        <label className="photo-picker-link" htmlFor={`${id}-url`}><Link size={14} /><input id={`${id}-url`} className="input" aria-label="Photo URL" type="text" maxLength={500} placeholder="https://example.com/photo.jpg" value={uploaded ? '' : value} disabled={disabled || busy} onChange={event => {onChange(event.target.value); setError('');}} /></label>
        <div className="photo-picker-buttons"><button type="button" className="button button-ghost" disabled={disabled || busy} onClick={() => camera.current?.click()}><Camera size={14} />Take photo</button><button type="button" className="button button-ghost" disabled={disabled || busy} onClick={() => input.current?.click()}><Upload size={14} />{busy ? 'Preparing photo…' : 'Choose photo'}</button>{value && <button type="button" className="icon-button" aria-label="Remove photo" disabled={disabled || busy} onClick={() => onChange('')}><X size={15} /></button>}</div>
        <input ref={input} id={`${id}-file`} className="photo-picker-file" type="file" accept="image/jpeg,image/png,image/webp" aria-label="Upload product photo" disabled={disabled || busy} onChange={event => {void select(event.target.files?.[0]);}} />
        <input ref={camera} id={`${id}-camera`} className="photo-picker-file" type="file" accept="image/*" capture="environment" aria-label="Take product photo" disabled={disabled || busy} onChange={event => {void select(event.target.files?.[0]);}} />
        <small role="status">{busy ? 'Compressing and saving. Please keep this form open.' : uploaded ? shared ? 'Saved on this device. Photos sync automatically when online.' : isDeviceWorkspace() ? 'Saved on this device. Included in encrypted backups; cloud upload needs a connected hub.' : 'Compressed photo saved to the branch database.' : 'JPEG, PNG or WebP. Optimized for clear product photos.'}</small>
      </div>
    </div>
    {value && !isProductImageReference(value) && <p className="error-message" role="alert">Use an HTTPS image link or upload a photo.</p>}
    {error && <p className="error-message" role="alert">{error}</p>}
  </div>;
}
export default PhotoPicker;
