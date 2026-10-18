/** Server-only configuration. Never import this module into the web app. */
export function firebaseDatabaseUrl(): string | undefined {
  const value=process.env.FIREBASE_DATABASE_URL?.trim();
  if(!value)return undefined;
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'){
    throw new Error('FIREBASE_DATABASE_URL must be an HTTPS database origin without credentials, query parameters, or a path.');
  }
  return url.origin;
}
