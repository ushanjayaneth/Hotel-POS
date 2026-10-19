import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isPrivatePrinterAddress, parseCupsPrinters, parseWindowsPrinters, selectPrivatePrinterAddress, validatePrinterTarget} from '../server/peripherals';
import {classifyScannerInput} from '../src/lib/peripherals';

test('Windows printer discovery accepts one or multiple queues and preserves honest OS status', () => {
  const queues = parseWindowsPrinters(JSON.stringify([
    {Name: 'Kitchen receipt', DriverName: 'ESC/POS', PortName: '192.168.1.90', PrinterStatus: 'Offline', IsDefault: false},
    {Name: 'Cashier receipt', DriverName: 'Thermal 80', PortName: 'USB001', PrinterStatus: 'Normal', IsDefault: true},
    {Name: 'Microsoft Print to PDF', DriverName: 'PDF', PortName: 'PORTPROMPT:', PrinterStatus: 'Unknown'},
  ]));
  assert.equal(queues[0].name, 'Cashier receipt');
  assert.equal(queues[0].reportedStatus, 'ready');
  assert.equal(queues.find(printer => printer.name === 'Kitchen receipt')!.reportedStatus, 'offline');
  assert.equal(queues.find(printer => printer.name === 'Microsoft Print to PDF')!.reportedStatus, 'unknown');
  assert.equal(parseWindowsPrinters('{"Name":"Single","PrinterStatus":"PaperOut"}')[0].reportedStatus, 'unknown');
  assert.equal(parseWindowsPrinters('{"Name":"Single","PrinterStatus":"Normal","WorkOffline":true}')[0].reportedStatus, 'offline');
  assert.deepEqual(parseWindowsPrinters('[]'), []);
  assert.deepEqual(parseWindowsPrinters('null'), []);
  assert.throws(() => parseWindowsPrinters('invalid JSON'));
});

test('printer names remain data and stable IDs do not contain command text', () => {
  const name = 'Receipt $(Get-Secret); <b>"quoted"</b>';
  const printer = parseWindowsPrinters(JSON.stringify({Name: name, PrinterStatus: 'Normal'}))[0];
  assert.equal(printer.name, name);
  assert.match(printer.id, /^printer-[a-f0-9]{16}$/);
  assert.equal(parseWindowsPrinters(JSON.stringify({Name: name}))[0].id, printer.id);
});

test('CUPS parsing reads default queue and disabled status without exposing URI credentials', () => {
  const printers = parseCupsPrinters('printer cashier is idle. enabled since Sun 18 Oct\nprinter kitchen disabled since Sun 18 Oct -\nsystem default destination: cashier\ndevice for cashier: ipp://operator:secret@192.168.1.90/ipp/print?token=secret\ndevice for kitchen: usb://EPSON/TM-T20\n');
  assert.equal(printers[0].name, 'cashier');
  assert.equal(printers[0].isDefault, true);
  assert.equal(printers[0].reportedStatus, 'ready');
  assert.equal(printers[0].portName, 'ipp://192.168.1.90/ipp/print');
  assert.equal(printers[1].reportedStatus, 'offline');
  assert.deepEqual(parseCupsPrinters('no system default destination\n'), []);
});

test('a network printer check accepts only an explicit LAN target and valid TCP port', () => {
  assert.deepEqual(validatePrinterTarget(' 192.168.1.90 ', 9100), {host: '192.168.1.90', port: 9100});
  assert.deepEqual(validatePrinterTarget('Kitchen-Printer.local', 631), {host: 'kitchen-printer.local', port: 631});
  for (const host of ['https://192.168.1.90', '192.168.1.90:9100', 'printer/path', 'printer;whoami', 'printer$(cmd)', 'localhost', '127.0.0.1', '169.254.169.254', '8.8.8.8', '224.0.0.1', '::1', '192.168.1.999', '']) assert.throws(() => validatePrinterTarget(host, 9100), /LAN|hostname|IPv4|address/);
  for (const port of [0, -1, 65536, 9100.5, NaN, Infinity]) assert.throws(() => validatePrinterTarget('192.168.1.90', port), /port/);
});

test('DNS results are checked before opening a socket and cannot escape the LAN', () => {
  assert.equal(isPrivatePrinterAddress('10.10.0.2'), true);
  assert.equal(isPrivatePrinterAddress('172.31.255.1'), true);
  assert.equal(isPrivatePrinterAddress('172.32.0.1'), false);
  assert.equal(selectPrivatePrinterAddress([{address: '192.168.2.10', family: 4}]), '192.168.2.10');
  assert.throws(() => selectPrivatePrinterAddress([]), /private LAN/);
  assert.throws(() => selectPrivatePrinterAddress([{address: '192.168.2.10', family: 4}, {address: '8.8.8.8', family: 4}]), /private LAN/);
  assert.throws(() => selectPrivatePrinterAddress([{address: '127.0.0.1', family: 4}]), /private LAN/);
});

test('scanner input distinguishes rapid keys from typing or pasted values without asserting hardware connection', () => {
  assert.equal(classifyScannerInput(' 1234567890123 ', 75, 13).scannerLike, true);
  assert.equal(classifyScannerInput('1234567890123', 5000, 13).scannerLike, false);
  assert.equal(classifyScannerInput('1234567890123', 30, 13, true).scannerLike, false);
  assert.equal(classifyScannerInput('1234567890123', null, 0).scannerLike, false);
  assert.equal(classifyScannerInput('001234', 40, 6).value, '001234');
  assert.throws(() => classifyScannerInput('', null, 0), /product code/);
  assert.throws(() => classifyScannerInput('x'.repeat(257), 20, 257), /product code/);
  assert.throws(() => classifyScannerInput('value\u0000', 20, 6), /product code/);
});
