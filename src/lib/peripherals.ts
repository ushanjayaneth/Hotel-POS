export interface PrinterPreference {
  selectedPrinterId: string;
  selectedPrinterName: string;
  networkHost: string;
  networkPort: number;
}

const emptyPreference: PrinterPreference = {selectedPrinterId: '', selectedPrinterName: '', networkHost: '', networkPort: 9100};

export function loadPrinterPreference(branchId: string): PrinterPreference {
  try {
    const saved = JSON.parse(localStorage.getItem(`dh-printer-${branchId}`) || '{}') as Partial<PrinterPreference>;
    return {
      selectedPrinterId: typeof saved.selectedPrinterId === 'string' ? saved.selectedPrinterId.slice(0, 120) : '',
      selectedPrinterName: typeof saved.selectedPrinterName === 'string' ? saved.selectedPrinterName.slice(0, 240) : '',
      networkHost: typeof saved.networkHost === 'string' ? saved.networkHost.slice(0, 253) : '',
      networkPort: typeof saved.networkPort === 'number' && Number.isInteger(saved.networkPort) && saved.networkPort > 0 && saved.networkPort <= 65535 ? saved.networkPort : 9100,
    };
  } catch {return {...emptyPreference};}
}

export function savePrinterPreference(branchId: string, preference: PrinterPreference) {
  localStorage.setItem(`dh-printer-${branchId}`, JSON.stringify(preference));
}

export interface HIDInputReportLike extends Event {data: DataView; reportId: number}
export interface HIDDeviceLike extends EventTarget {
  opened: boolean;
  productName: string;
  vendorId: number;
  productId: number;
  open(): Promise<void>;
  close(): Promise<void>;
}
export interface HIDConnectionLike extends Event {device: HIDDeviceLike}
export interface HIDManagerLike extends EventTarget {
  getDevices(): Promise<HIDDeviceLike[]>;
  requestDevice(options: {filters: {vendorId?: number; productId?: number; usagePage?: number; usage?: number}[]}): Promise<HIDDeviceLike[]>;
}

export function browserHID(): HIDManagerLike | null {
  if (typeof navigator === 'undefined' || typeof window === 'undefined' || !window.isSecureContext) return null;
  return (navigator as Navigator & {hid?: HIDManagerLike}).hid || null;
}

export function hidDeviceKey(device: HIDDeviceLike) {
  return `${device.vendorId}:${device.productId}:${device.productName}`;
}

export interface ScannerInputResult {value: string; elapsedMs: number | null; scannerLike: boolean; receivedAt: string}

/** Timing identifies rapid input, not the physical presence of a keyboard scanner. */
export function classifyScannerInput(value: string, elapsedMs: number | null, keyCount: number, pasted = false): ScannerInputResult {
  const code = value.trim();
  if (!code || code.length > 256 || /[\u0000-\u001f\u007f]/.test(code)) throw new Error('Scan a printable product code between 1 and 256 characters.');
  const timed = typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs > 0;
  const scannerLike = !pasted && code.length >= 4 && keyCount >= code.length && timed && elapsedMs <= Math.min(1500, code.length * 80);
  return {value: code, elapsedMs: timed ? Math.round(elapsedMs) : null, scannerLike, receivedAt: new Date().toISOString()};
}
