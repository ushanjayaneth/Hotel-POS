export class ApiError extends Error {
  constructor(message: string, public status = 0) { super(message); this.name = 'ApiError'; }
}
export async function api<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const url = path.startsWith('/api/') ? path : `/api${path.startsWith('/') ? '' : '/'}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {method:method ?? (body === undefined ? 'GET':'POST'),credentials:'same-origin',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  } catch { throw new ApiError('The branch hub is unavailable. Your draft is saved on this device.'); }
  const result = await response.json().catch(()=>({message:'The server returned an invalid response.'}));
  if (!response.ok) throw new ApiError(result.message ?? result.error ?? 'This action could not be completed.',response.status);
  return result as T;
}
