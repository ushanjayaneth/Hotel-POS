import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {createConnection, isIP} from 'node:net';
import {promisify} from 'node:util';
import type {NetworkPrinterCheck, PrinterDevice, PrinterDiscovery} from '../shared/types';
import {ApiError} from './database';

const execute = promisify(execFile);
const printerId = (name: string) => `printer-${createHash('sha256').update(name).digest('hex').slice(0, 16)}`;
const string = (value: unknown) => typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';

function device(name: string, driver: string, portName: string, isDefault: boolean, rawStatus: string, offline = false): PrinterDevice {
  const reportedStatus: PrinterDevice['reportedStatus'] = offline || /offline|disconnected|not connected/i.test(rawStatus)
    ? 'offline' : /^(normal|ready|idle|printing|processing|warmup|0)$/i.test(rawStatus) ? 'ready' : 'unknown';
  return {id: printerId(name), name, driver, portName, isDefault, reportedStatus, statusDetail: rawStatus.slice(0, 160) || 'No status reported by the operating system'};
}

/** Parse only the fixed Get-Printer projection; never execute printer names. */
export function parseWindowsPrinters(json: string): PrinterDevice[] {
  const parsed: unknown = JSON.parse(json.replace(/^\uFEFF/, '').trim() || '[]');
  const records = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? [parsed] : [];
  const printers: PrinterDevice[] = [];
  for (const item of records.slice(0, 500)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = string(record.Name).slice(0, 240);
    if (!name) continue;
    printers.push(device(name, string(record.DriverName).slice(0, 240), string(record.PortName).slice(0, 240), record.IsDefault === true || record.Default === true, string(record.PrinterStatus), record.WorkOffline === true));
  }
  return printers.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

function safePort(port: string) {
  try {
    const url = new URL(port);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`;
  } catch {return port.slice(0, 240);}
}

export function parseCupsPrinters(output: string): PrinterDevice[] {
  const defaultName = output.match(/^system default destination:\s*(.+)$/m)?.[1]?.trim();
  const devices = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^device for (\S+):\s*(.+)$/);
    if (match) devices.set(match[1], safePort(match[2]));
  }
  return output.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^printer (\S+) (.+)$/);
    if (!match) return [];
    const [, name, detail] = match;
    const status = /disabled|offline|not connected/i.test(detail) ? 'Offline' : /is idle|now printing/i.test(detail) ? 'Ready' : '';
    const printer = device(name, 'CUPS', devices.get(name) || '', name === defaultName, status);
    printer.statusDetail = detail.slice(0, 160);
    return [printer];
  }).slice(0, 500).sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
}

// This script is constant. No host, printer name, or other request input reaches it.
const windowsDiscoveryScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$defaultName = $null
try { $defaultName = (Get-CimInstance Win32_Printer -Filter 'Default=True' -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Name) } catch {}
$printers = @(Get-Printer -ErrorAction Stop | ForEach-Object {
  [pscustomobject]@{ Name=$_.Name; DriverName=$_.DriverName; PortName=$_.PortName; PrinterStatus=$_.PrinterStatus.ToString(); IsDefault=($_.Name -eq $defaultName) }
})
ConvertTo-Json -InputObject $printers -Depth 3 -Compress
`;

export async function listSystemPrinters(): Promise<PrinterDiscovery> {
  const checkedAt = new Date().toISOString();
  if (process.platform === 'win32') {
    try {
      const {stdout} = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsDiscoveryScript], {timeout: 7000, windowsHide: true, maxBuffer: 512 * 1024, encoding: 'utf8'});
      const printers = parseWindowsPrinters(stdout);
      return {printers, source: 'windows', supported: true, checkedAt, message: printers.length ? 'Installed printers reported by the branch hub. OS status does not prove a successful print.' : 'No printers are installed on the branch hub. Add the printer in Windows, then refresh.'};
    } catch {
      return {printers: [], source: 'windows', supported: true, checkedAt, message: 'The Windows print service could not be read. Check Print Spooler and hub account permissions, then refresh.'};
    }
  }
  try {
    const {stdout} = await execute('lpstat', ['-p', '-d', '-v'], {timeout: 5000, maxBuffer: 512 * 1024, encoding: 'utf8', env: {...process.env, LC_ALL: 'C', LANG: 'C'}});
    const printers = parseCupsPrinters(stdout);
    return {printers, source: 'cups', supported: true, checkedAt, message: printers.length ? 'Installed CUPS queues reported by the branch hub. Queue status does not prove a successful print.' : 'No CUPS printer queues were found. Add a printer to the hub, then refresh.'};
  } catch {
    return {printers: [], source: 'unsupported', supported: false, checkedAt, message: 'Printer discovery is unavailable on this hub. Use your device print dialog or check a configured LAN printer below.'};
  }
}

export function isPrivatePrinterAddress(address: string) {
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}

export function validatePrinterTarget(host: string, port: number) {
  const normalized = typeof host === 'string' ? host.trim().toLowerCase() : '';
  if (!normalized || normalized.length > 253 || normalized === 'localhost' || normalized.endsWith('.localhost')) throw new ApiError(400, 'Enter the private IPv4 address or hostname of your LAN printer.', 'INVALID_PRINTER_TARGET');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(400, 'Enter a printer TCP port between 1 and 65535.', 'INVALID_PRINTER_TARGET');
  if (isIP(normalized)) {
    if (!isPrivatePrinterAddress(normalized)) throw new ApiError(400, 'Only private LAN IPv4 printer addresses are supported.', 'INVALID_PRINTER_TARGET');
  } else if (/^[\d.]+$/.test(normalized) || !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(normalized)) {
    throw new ApiError(400, 'Use a LAN hostname or IPv4 address without a URL, path, or port.', 'INVALID_PRINTER_TARGET');
  }
  return {host: normalized, port};
}

export function selectPrivatePrinterAddress(addresses: {address: string; family: number}[]) {
  if (!addresses.length || addresses.some(item => !isPrivatePrinterAddress(item.address))) throw new ApiError(400, 'The printer hostname must resolve only to private LAN IPv4 addresses.', 'INVALID_PRINTER_TARGET');
  return addresses[0].address;
}

export async function probeNetworkPrinter(host: string, port: number): Promise<NetworkPrinterCheck> {
  const target = validatePrinterTarget(host, port);
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  const result = (reachable: boolean, message: string): NetworkPrinterCheck => ({...target, reachable, latencyMs: reachable ? Date.now() - started : null, checkedAt, message});
  let address = target.host;
  if (!isIP(address)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const addresses = await Promise.race([
        lookup(address, {all: true, verbatim: true}),
        new Promise<never>((_, reject) => {timer = setTimeout(() => reject(new Error('DNS_TIMEOUT')), 1500);}),
      ]);
      address = selectPrivatePrinterAddress(addresses);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      return result(false, 'The LAN printer hostname could not be resolved. Check its address and branch network.');
    } finally {if (timer) clearTimeout(timer);}
  }
  const remaining = 1500 - (Date.now() - started);
  if (remaining <= 0) return result(false, 'The configured printer did not respond within 1.5 seconds.');
  return new Promise(resolve => {
    // Pin the already checked address; never re-resolve an untrusted hostname.
    const socket = createConnection({host: address, port: target.port, family: 4});
    let finished = false;
    const finish = (reachable: boolean, message: string) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(result(reachable, message));
    };
    socket.setTimeout(remaining);
    socket.once('connect', () => finish(true, 'The TCP port responded. Use a test receipt to verify printing and paper alignment.'));
    socket.once('timeout', () => finish(false, 'No response from the configured TCP port. Check printer power, address, and network.'));
    socket.once('error', () => finish(false, 'The TCP port could not be reached. Check printer power, address, and network.'));
  });
}
