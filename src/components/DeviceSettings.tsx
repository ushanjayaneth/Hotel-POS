import {isDeviceWorkspace} from '../lib/workspace-mode';
import {sharedCloudSource} from '../lib/cloud-shared';
import {useCallback, useEffect, useRef, useState} from 'react';
import {Check, CheckCircle2, CircleHelp, Clock3, Printer, RefreshCw, ScanBarcode, Unplug, Usb, Wifi, XCircle} from 'lucide-react';
import type {NetworkPrinterCheck, PrinterDevice, PrinterDiscovery} from '../../shared/types';
import {usePOS} from '../lib/context';
import {browserHID, classifyScannerInput, hidDeviceKey, loadPrinterPreference, savePrinterPreference, type HIDConnectionLike, type HIDDeviceLike, type HIDInputReportLike, type PrinterPreference, type ScannerInputResult} from '../lib/peripherals';
import {printTestReceipt} from '../lib/receipt';
import '../styles/devices.css';

const checkedTime = (value: string) => new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Colombo'}).format(new Date(value));

export default function DeviceSettings() {
  const {data, branchId, mutate, notify} = usePOS();
  const [discovery, setDiscovery] = useState<PrinterDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [printerError, setPrinterError] = useState('');
  const [preference, setPreference] = useState(() => loadPrinterPreference(branchId));
  const [networkHost, setNetworkHost] = useState(preference.networkHost);
  const [networkPort, setNetworkPort] = useState(String(preference.networkPort));
  const [networkCheck, setNetworkCheck] = useState<NetworkPrinterCheck | null>(null);
  const [checkingNetwork, setCheckingNetwork] = useState(false);
  const hid = browserHID();
  const [authorizedDevices, setAuthorizedDevices] = useState<HIDDeviceLike[]>([]);
  const [usbDevice, setUsbDevice] = useState<HIDDeviceLike | null>(null);
  const usbRef = useRef(usbDevice);
  usbRef.current = usbDevice;
  const [usbBusy, setUsbBusy] = useState(false);
  const [usbMessage, setUsbMessage] = useState('');
  const [lastReport, setLastReport] = useState<{bytes: number; hex: string; at: string} | null>(null);
  const [scanText, setScanText] = useState('');
  const [lastScan, setLastScan] = useState<ScannerInputResult | null>(null);
  const [scanError, setScanError] = useState('');
  const scanTiming = useRef<{started: number | null; count: number; pasted: boolean}>({started: null, count: 0, pasted: false});
  const canInspect = !isDeviceWorkspace() && !sharedCloudSource() && ['owner', 'manager', 'cashier'].includes(data.user.role);

  useEffect(() => {
    const saved = loadPrinterPreference(branchId);
    setPreference(saved); setNetworkHost(saved.networkHost); setNetworkPort(String(saved.networkPort)); setNetworkCheck(null);
  }, [branchId]);

  const refreshPrinters = useCallback(async () => {
    if (!canInspect) return;
    setDiscovering(true); setPrinterError('');
    try {setDiscovery(await mutate<PrinterDiscovery>('/devices/printers', undefined, 'GET'));}
    catch (error) {setPrinterError((error as Error).message);}
    finally {setDiscovering(false);}
  }, [canInspect, mutate]);
  useEffect(() => {void refreshPrinters();}, [refreshPrinters]);

  useEffect(() => {
    if (!hid) return;
    let active = true;
    const refresh = async () => {
      try {
        const devices = await hid.getDevices();
        if (!active) return;
        setAuthorizedDevices(devices);
        const opened = devices.find(item => item.opened);
        if (opened) setUsbDevice(opened);
      } catch {if (active) setUsbMessage('USB device access could not be read. You can still test a keyboard scanner below.');}
    };
    const connected = () => {void refresh();};
    const disconnected = (event: Event) => {
      const device = (event as HIDConnectionLike).device;
      if (usbRef.current === device) {setUsbDevice(null); setUsbMessage('The USB device was disconnected. Reconnect it, then open its device channel.');}
      void refresh();
    };
    void refresh();
    hid.addEventListener('connect', connected); hid.addEventListener('disconnect', disconnected);
    return () => {active = false; hid.removeEventListener('connect', connected); hid.removeEventListener('disconnect', disconnected);};
  }, [hid]);

  useEffect(() => {
    if (!usbDevice) return;
    const onReport = (event: Event) => {
      const report = (event as HIDInputReportLike).data;
      const bytes = new Uint8Array(report.buffer, report.byteOffset, report.byteLength);
      setLastReport({bytes: bytes.length, hex: Array.from(bytes.slice(0, 24), byte => byte.toString(16).padStart(2, '0')).join(' '), at: new Date().toISOString()});
    };
    usbDevice.addEventListener('inputreport', onReport);
    return () => usbDevice.removeEventListener('inputreport', onReport);
  }, [usbDevice]);

  function persist(next: PrinterPreference) {
    try {savePrinterPreference(branchId, next); setPreference(next); notify('Printer preference saved on this device.');}
    catch {notify('This browser could not save the printer preference. Check device storage permissions.', 'error');}
  }
  function selectPrinter(printer: PrinterDevice) {persist({...preference, selectedPrinterId: printer.id, selectedPrinterName: printer.name});}

  async function checkNetwork(event: React.FormEvent) {
    event.preventDefault(); setCheckingNetwork(true); setPrinterError(''); setNetworkCheck(null);
    try {
      const result = await mutate<NetworkPrinterCheck>('/devices/printer-check', {host: networkHost.trim(), port: Number(networkPort)});
      setNetworkCheck(result);
      const next = {...preference, networkHost: result.host, networkPort: result.port};
      try {savePrinterPreference(branchId, next); setPreference(next);} catch {notify('Connection checked; this browser could not save the address.', 'error');}
    } catch (error) {setPrinterError((error as Error).message);}
    finally {setCheckingNetwork(false);}
  }

  async function openDevice(existing?: HIDDeviceLike) {
    if (!hid) return;
    setUsbBusy(true); setUsbMessage('');
    try {
      const devices = existing ? [existing] : await hid.requestDevice({filters: []});
      if (!devices.length) {setUsbMessage('No USB device was selected.'); return;}
      const selected = devices[0];
      if (!selected.opened) await selected.open();
      setUsbDevice(selected); setLastReport(null); setAuthorizedDevices(await hid.getDevices());
      setUsbMessage('USB device channel opened. Scan to check whether this device sends input reports.');
    } catch (error) {
      setUsbMessage((error as Error).name === 'NotFoundError' ? 'No USB device was selected.' : 'This USB device could not be opened. Close other apps using it, or use keyboard scanner mode below.');
    } finally {setUsbBusy(false);}
  }
  async function closeDevice() {
    if (!usbDevice) return;
    setUsbBusy(true);
    try {await usbDevice.close(); setUsbDevice(null); setUsbMessage('USB device channel closed.'); setLastReport(null);}
    catch {setUsbMessage('The device channel could not be closed. Unplug the device if necessary.');}
    finally {setUsbBusy(false);}
  }

  function receiveScan() {
    setScanError('');
    const timing = scanTiming.current;
    try {setLastScan(classifyScannerInput(scanText, timing.started === null ? null : performance.now() - timing.started, timing.count, timing.pasted)); setScanText('');}
    catch (error) {setScanError((error as Error).message);}
    scanTiming.current = {started: null, count: 0, pasted: false};
  }

  return <section className="device-settings" aria-label="Printers and scanners">
    <div className="device-section-heading"><div><span className="management-eyebrow">COUNTER EQUIPMENT</span><h2>Printers & scanners</h2><p>Check your branch equipment and verify it with a real test.</p></div><Printer size={21}/></div>
    <section className="panel device-card">
      <div className="device-card-heading"><div className="device-icon"><Printer size={20}/></div><div><h3>Printers on the branch hub</h3><p>Installed queues and the status reported by the operating system.</p></div>{canInspect && <button className="button button-ghost button-small" onClick={() => void refreshPrinters()} disabled={discovering}><RefreshCw size={14} className={discovering ? 'spin' : ''}/>{discovering ? 'Checking…' : 'Refresh printers'}</button>}</div>
      {printerError && <div className="device-error" role="alert">{printerError}</div>}
      {!canInspect ? <p className="device-note">{isDeviceWorkspace() ? 'Use this device?s browser print dialog. OS printer discovery needs a connected branch hub.' : 'An owner, manager, or cashier can inspect hub printers.'}</p> : <>
        {discovery && <p className="device-note">{discovery.message}</p>}
        {discovery && discovery.printers.length > 0 && <div className="device-printer-list">{discovery.printers.map(printer => <div className={`device-printer ${preference.selectedPrinterId === printer.id ? 'selected' : ''}`} key={printer.id}><div className="device-printer-top"><div><strong>{printer.name}</strong><span>{printer.driver || 'Installed printer'}{printer.portName ? ` · ${printer.portName}` : ''}</span></div><span className={`device-status ${printer.reportedStatus}`} title={printer.statusDetail}>{printer.reportedStatus === 'ready' ? <CheckCircle2 size={12}/> : printer.reportedStatus === 'offline' ? <XCircle size={12}/> : <CircleHelp size={12}/>} {printer.reportedStatus === 'ready' ? 'OS reports ready' : printer.reportedStatus === 'offline' ? 'OS reports offline' : 'Status unknown'}</span></div><div className="device-printer-bottom"><small>{printer.isDefault ? 'System default' : printer.statusDetail}</small><button className="button button-ghost button-small" onClick={() => selectPrinter(printer)}>{preference.selectedPrinterId === printer.id ? <><Check size={12}/> Saved preference</> : 'Save preference'}</button></div></div>)}</div>}
        {discovery && !discovery.printers.length && <div className="device-empty"><Printer size={23}/><span>{discovery.supported ? 'No printer queues available' : 'Use browser printer selection'}</span></div>}
        {preference.selectedPrinterName && <div className="device-preference"><span>Preferred printer: <strong>{preference.selectedPrinterName}</strong></span><button className="button button-ghost button-small" onClick={() => persist({...preference, selectedPrinterId: '', selectedPrinterName: ''})}>Clear</button></div>}
        <div className="device-print-footer"><p>Choose the printer in your browser print dialog. A saved preference cannot select or confirm a physical printer automatically.</p><button className="button button-ghost" onClick={() => {try {printTestReceipt(data.settings);} catch (error) {notify((error as Error).message, 'error');}}}><Printer size={14}/> Print test receipt</button></div>
        {discovery && <div className="device-checked"><Clock3 size={11}/> Last checked {checkedTime(discovery.checkedAt)} · {discovery.source === 'windows' ? 'Windows' : discovery.source === 'cups' ? 'CUPS' : 'Branch hub'}</div>}
      </>}
    </section>
    {canInspect && <section className="panel device-card"><div className="device-card-heading"><div className="device-icon"><Wifi size={20}/></div><div><h3>Network printer connection</h3><p>Check the address and TCP port of one configured LAN printer.</p></div></div><form className="device-network-form" onSubmit={event => void checkNetwork(event)}><label className="field"><span>Printer address</span><input className="input" required maxLength={253} value={networkHost} onChange={event => {setNetworkHost(event.target.value); setNetworkCheck(null);}} placeholder="192.168.1.90 or kitchen-printer.local" autoComplete="off" spellCheck={false}/></label><label className="field"><span>TCP port</span><input className="input" type="number" required min="1" max="65535" step="1" value={networkPort} onChange={event => {setNetworkPort(event.target.value); setNetworkCheck(null);}}/></label><button className="button button-primary" disabled={checkingNetwork}><RefreshCw size={14} className={checkingNetwork ? 'spin' : ''}/>{checkingNetwork ? 'Checking…' : 'Check connection'}</button></form>{networkCheck && <div className={`device-check-result ${networkCheck.reachable ? 'success' : 'warning'}`} role="status">{networkCheck.reachable ? <CheckCircle2 size={18}/> : <XCircle size={18}/>}<div><strong>{networkCheck.reachable ? 'TCP port reachable' : 'TCP port unreachable'}</strong><p>{networkCheck.message}</p><small>{networkCheck.host}:{networkCheck.port}{networkCheck.latencyMs !== null ? ` · ${networkCheck.latencyMs} ms` : ''} · Checked {checkedTime(networkCheck.checkedAt)}</small></div></div>}<p className="device-note">Default raw-print port: 9100. A responding port confirms network reachability; paper, printer errors, and print output still need a test receipt.</p></section>}
    <section className="panel device-card"><div className="device-card-heading"><div className="device-icon"><Usb size={20}/></div><div><h3>USB device channel</h3><p>Open a compatible HID scanner with your browser's device chooser.</p></div><span className={`device-status ${usbDevice?.opened ? 'ready' : 'unknown'}`}>{usbDevice?.opened ? 'Channel open' : hid ? 'No open channel' : 'Chooser unavailable'}</span></div>{hid ? <><div className="device-usb-actions"><button className="button button-ghost" disabled={usbBusy} onClick={() => void openDevice()}><Usb size={14}/>{usbBusy ? 'Opening…' : 'Choose USB device'}</button>{usbDevice?.opened && <button className="button button-ghost" onClick={() => void closeDevice()} disabled={usbBusy}><Unplug size={14}/> Close channel</button>}</div>{authorizedDevices.length > 0 && <div className="device-authorized-list">{authorizedDevices.map((device, index) => <div key={`${hidDeviceKey(device)}:${index}`}><span><strong>{device.productName || 'Authorized USB device'}</strong><small>USB {device.vendorId.toString(16).padStart(4, '0')}:{device.productId.toString(16).padStart(4, '0')}{device.opened ? ' · channel open' : ' · permission granted'}</small></span>{!device.opened && <button className="button button-ghost button-small" onClick={() => void openDevice(device)} disabled={usbBusy}>Open channel</button>}</div>)}</div>}{usbMessage && <p className="device-note" role="status">{usbMessage}</p>}{lastReport && <div className="device-report"><strong>Input report received · {lastReport.bytes} bytes</strong><code>{lastReport.hex || '(empty report)'}</code><small>{checkedTime(lastReport.at)} · Raw HID data; barcode decoding depends on the scanner protocol.</small></div>}</> : <p className="device-note">This browser does not offer WebHID here. Use a supporting desktop browser over HTTPS, or use a USB/Bluetooth scanner in keyboard mode below.</p>}<p className="device-note">Most barcode scanners act as keyboards and will not appear in this chooser. Test their actual input below.</p></section>
    <section className="panel device-card"><div className="device-card-heading"><div className="device-icon"><ScanBarcode size={20}/></div><div><h3>Keyboard scanner test</h3><p>Focus the field, then scan a code with an Enter suffix.</p></div><span className={`device-status ${lastScan ? 'ready' : 'unknown'}`}>{lastScan ? 'Input received' : 'Awaiting input'}</span></div><label className="field device-scan-field"><span>Scan a barcode</span><input className="input" value={scanText} onChange={event => setScanText(event.target.value)} maxLength={256} placeholder="Click here, then scan…" autoComplete="off" spellCheck={false} onPaste={() => {scanTiming.current.pasted = true;}} onKeyDown={event => {if (event.key === 'Enter') {event.preventDefault(); receiveScan();} else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {if (scanTiming.current.started === null) scanTiming.current.started = performance.now(); scanTiming.current.count++;}}}/></label>{scanError && <div className="device-error" role="alert">{scanError}</div>}{lastScan && <div className="device-scan-result" role="status"><CheckCircle2 size={19}/><div><span>{lastScan.scannerLike ? 'Rapid scanner-style input received' : 'Input received'}</span><strong>{lastScan.value}</strong><small>{checkedTime(lastScan.receivedAt)}{lastScan.elapsedMs !== null ? ` · ${lastScan.elapsedMs} ms` : ''} · {lastScan.value.length} characters</small></div><button className="button button-ghost button-small" onClick={() => {setLastScan(null); setScanText(''); scanTiming.current = {started: null, count: 0, pasted: false};}}>Clear</button></div>}<p className="device-note">Keyboard scanners type like a keyboard. The browser can verify received input, but it cannot continuously query their physical connection.</p></section>
  </section>;
}
