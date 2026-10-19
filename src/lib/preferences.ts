import {useSyncExternalStore} from 'react';
import type {Settings} from '../../shared/types';

export const shortcutActions=[
  {id:'search',label:'Search products',group:'Point of sale',defaultKey:'F2'},
  {id:'new-bill',label:'New bill',group:'Point of sale',defaultKey:'F3'},
  {id:'hold-bill',label:'Hold current bill',group:'Point of sale',defaultKey:'F4'},
  {id:'order-drawer',label:'Show order',group:'Point of sale',defaultKey:'F6'},
  {id:'checkout',label:'Take payment',group:'Point of sale',defaultKey:'F8'},
  {id:'send-kitchen',label:'Send to kitchen',group:'Point of sale',defaultKey:'F9'},
  {id:'print',label:'Print receipt',group:'Workspace',defaultKey:'F10'},
  {id:'help',label:'Show keyboard shortcuts',group:'Workspace',defaultKey:'F1'},
  {id:'back',label:'Go back one step',group:'Workspace',defaultKey:'Escape'},
  {id:'go-pos',label:'Point of sale',group:'Navigation',defaultKey:'Alt+1'},
  {id:'go-held',label:'Held bills',group:'Navigation',defaultKey:'Alt+2'},
  {id:'go-sales',label:'Sales history',group:'Navigation',defaultKey:'Alt+3'},
  {id:'go-products',label:'Products',group:'Navigation',defaultKey:'Alt+4'},
  {id:'go-customers',label:'Customers & dues',group:'Navigation',defaultKey:'Alt+5'},
  {id:'go-reports',label:'Reports',group:'Navigation',defaultKey:'Alt+6'},
  {id:'go-finance',label:'Day end & expenses',group:'Navigation',defaultKey:'Alt+7'},
  {id:'go-settings',label:'Settings',group:'Navigation',defaultKey:'Alt+0'},
] as const;
export type ShortcutAction=typeof shortcutActions[number]['id'];
export type ReceiptLayout=Pick<Settings,'receiptPaperWidthMm'|'receiptContentWidthMm'|'receiptMarginMm'|'receiptOffsetMm'|'receiptFontSize'>;
export interface DevicePreferences{fontScale:number;shortcuts:Record<ShortcutAction,string>;receipt:Partial<ReceiptLayout>}
const key='demo-hotel-device-preferences';
const defaults:DevicePreferences={fontScale:1,shortcuts:Object.fromEntries(shortcutActions.map(action=>[action.id,action.defaultKey])) as Record<ShortcutAction,string>,receipt:{}};
let current:DevicePreferences=read();
function read():DevicePreferences{try{const stored=JSON.parse(localStorage.getItem(key)||'null');return {fontScale:Math.min(1.4,Math.max(.9,Number(stored?.fontScale)||1)),shortcuts:{...defaults.shortcuts,...stored?.shortcuts},receipt:stored?.receipt||{}};}catch{return structuredClone(defaults);}}
const subscribe=(callback:()=>void)=>{window.addEventListener('device-preferences',callback);const storage=(event:StorageEvent)=>{if(event.key===key){current=read();callback();}};window.addEventListener('storage',storage);return()=>{window.removeEventListener('device-preferences',callback);window.removeEventListener('storage',storage);};};
export function useDevicePreferences(){return useSyncExternalStore(subscribe,()=>current);}
export function getDevicePreferences(){return current;}
export function saveDevicePreferences(update:Partial<DevicePreferences>){current={...current,...update};try{localStorage.setItem(key,JSON.stringify(current));}catch{}document.documentElement.style.setProperty('--font-scale',String(current.fontScale));window.dispatchEvent(new Event('device-preferences'));}
export function resetShortcuts(){saveDevicePreferences({shortcuts:{...defaults.shortcuts}});}
export function keyboardCombination(event:Pick<KeyboardEvent,'key'|'ctrlKey'|'metaKey'|'altKey'|'shiftKey'>):string{
  const key=event.key===' '?'Space':event.key.length===1?event.key.toUpperCase():event.key;
  if(['Control','Alt','Shift','Meta'].includes(key))return '';
  return [...(event.ctrlKey||event.metaKey?['Ctrl']:[]),...(event.altKey?['Alt']:[]),...(event.shiftKey?['Shift']:[]),key].join('+');
}
export function reservedShortcut(value:string){return /^(Ctrl\+(?:Shift\+)?(?:R|W|T|N|L|Tab)|Alt\+F4|F5|F11|F12)$/i.test(value);}
export function dispatchShortcut(action:ShortcutAction){window.dispatchEvent(new CustomEvent('workspace-shortcut',{detail:action}));}
export function fontScaleCss(scale:number):string{return `calc(1em * ${scale})`;}
