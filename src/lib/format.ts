export const money = (value: number) => `Rs. ${new Intl.NumberFormat('en-LK',{minimumFractionDigits:2,maximumFractionDigits:2}).format((value || 0)/100)}`;
export const compactMoney = (value: number) => new Intl.NumberFormat('en-LK',{notation:'compact',maximumFractionDigits:1}).format((value || 0)/100);
export const number = (value: number) => new Intl.NumberFormat('en-LK',{maximumFractionDigits:3}).format(value || 0);
export const dateTime = (value: string) => new Intl.DateTimeFormat('en-LK',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Colombo'}).format(new Date(value));
export const time = (value: string) => new Intl.DateTimeFormat('en-LK',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Colombo'}).format(new Date(value));
export const elapsed = (value: string) => Math.max(0,Math.floor((Date.now()-new Date(value).getTime())/60000));
export const commandId = (): string => globalThis.crypto?.randomUUID?.() ?? `cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`;
