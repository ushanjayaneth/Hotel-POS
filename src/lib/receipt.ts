import type {Settings} from '../../shared/types';
import {getDevicePreferences} from './preferences';

export function receiptDimensions(settings:Settings){
  settings={...settings,...getDevicePreferences().receipt};
  const paper=Math.min(120,Math.max(40,Number(settings.receiptPaperWidthMm)||80));
  const margin=Math.min(10,Math.max(0,Number(settings.receiptMarginMm) || 0));
  const content=Math.min(paper-2*margin,Math.max(30,Number(settings.receiptContentWidthMm)||72));
  const maxOffset=Math.max(0,(paper-content)/2-margin);
  const offset=Math.min(maxOffset,Math.max(-maxOffset,Number(settings.receiptOffsetMm)||0));
  const font=Math.min(18,Math.max(6,Number(settings.receiptFontSize)||10));
  return {paper,margin,content,offset,font};
}
export function receiptPrintCss(settings:Settings){
  const {paper,margin,content,offset,font}=receiptDimensions(settings);
  return `@page{size:auto;margin:0} @media print{html,body{width:${paper}mm!important;min-width:0!important;margin:0!important;padding:0!important;background:white!important;color:black!important} .print-receipt{display:block!important;box-sizing:border-box!important;width:${content}mm!important;max-width:none!important;margin:0 auto!important;padding:${margin}mm 0!important;position:relative!important;left:${offset}mm!important;font:${font}pt ui-monospace,Consolas,monospace!important;--font-scale:1} .print-receipt h2{font-size:1.4em!important;line-height:1.3!important} .print-receipt p,.print-receipt .receipt-meta,.print-receipt .receipt-totals{font-size:.85em!important} .print-receipt table{font-size:.9em!important;width:100%!important} .print-receipt th,.print-receipt td{overflow-wrap:anywhere;padding:1.2mm 0!important} .print-receipt td:last-child,.print-receipt th:last-child{text-align:right;white-space:nowrap} .print-receipt .receipt-totals>div{display:flex;justify-content:space-between;gap:2mm} .print-receipt .receipt-meta>div{display:flex;justify-content:space-between;gap:2mm} .print-receipt .total{border-top:1px dashed black;padding-top:2mm!important} .print-receipt .receipt-thanks{text-align:center;margin-top:3mm!important}}`;
}
const escapeHtml=(text:string)=>text.replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
export function printTestReceipt(settings:Settings):void{
  const popup=window.open('','_blank','width=480,height=650');
  if(!popup)throw new Error('Allow the print window to open, then try the test again.');
  popup.opener=null;
  const {paper,content,offset,font}=receiptDimensions(settings);
  popup.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Printer alignment test</title><style>body{font:14px ui-monospace,monospace;background:#eceeea;padding:24px;color:#111}button{padding:12px;margin:20px auto;display:block}.print-receipt{width:${content}mm;margin:auto;background:white;padding:12px}h2,p{text-align:center}table{width:100%}td:last-child{text-align:right}hr{border:0;border-top:1px dashed #222}${receiptPrintCss(settings)}@media print{button{display:none}}</style></head><body><div class="print-receipt"><h2>${escapeHtml(settings.businessName)}</h2><p>PRINTER ALIGNMENT TEST<br>NOT A SALE</p><hr><p>← CENTER ALIGNMENT →</p><table><tr><td>Paper width</td><td>${paper} mm</td></tr><tr><td>Content width</td><td>${content} mm</td></tr><tr><td>Horizontal offset</td><td>${offset} mm</td></tr><tr><td>Text size</td><td>${font} pt</td></tr><tr><td>Sample item × 2</td><td>1,200.00</td></tr></table><hr><p>Check that both sides fit your paper.</p><p>${escapeHtml(settings.receiptFooter)}</p></div><button onclick="window.print()">Print test</button></body></html>`);
  popup.document.close();popup.focus();setTimeout(()=>popup.print(),250);
}
