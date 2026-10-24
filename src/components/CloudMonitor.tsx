import {useCallback,useEffect,useMemo,useRef,useState,type FormEvent} from 'react';
import {Cloud,RefreshCw,ArrowLeft,Download} from 'lucide-react';
import type {CloudSnapshot,CloudSource,CloudStatus} from '../../shared/cloud-monitor';
import {monitoringSnapshot} from '../../shared/cloud-view';
import {businessDate,profitability,profitCsv} from '../../shared/costing';
import {money} from '../lib/format';
import {cloudRequest,openAutomaticCloudWorkspace} from '../lib/cloud-sync';
import '../styles/cloud-monitor.css';

function download(name:string,text:string){const url=URL.createObjectURL(new Blob(['\ufeff',text],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function csv(rows:unknown[][]){return rows.map(row=>row.map(value=>{let text=String(value??'');if(/^\s*[=+@-]/.test(text)&&!/^[-+]?\d+(\.\d+)?$/.test(text))text="'"+text;return `"${text.replaceAll('"','""')}"`;}).join(',')).join('\r\n');}
export default function CloudMonitor({sharedSource,restore=false,automatic=false}:{sharedSource?:string;restore?:boolean;automatic?:boolean}){
  const [status,setStatus]=useState<CloudStatus|null>(null),[auth,setAuth]=useState(false),[starting,setStarting]=useState(true),[email,setEmail]=useState(''),[password,setPassword]=useState('');
  const [sources,setSources]=useState<CloudSource[]>([]),[sourceId,setSourceId]=useState(''),[snapshot,setSnapshot]=useState<CloudSnapshot|null>(null),[branchId,setBranchId]=useState(''),[tab,setTab]=useState('Overview');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[lastContact,setLastContact]=useState(0),[clock,setClock]=useState(Date.now()),[accepted,setAccepted]=useState(false),[search,setSearch]=useState('');
  const today=businessDate(new Date().toISOString()),[from,setFrom]=useState(today),[to,setTo]=useState(today);
  const selected=useRef(sourceId);selected.current=sourceId;
  const generation=useRef(0),lastRevision=useRef('');
  const inFlight=useRef<{sourceId:string;promise:Promise<void>}|null>(null);
  useEffect(()=>{
    let active=true;
    void(async()=>{
      try{
        const value=await cloudRequest<CloudStatus>('status');
        if(!active)return;
        setStatus(value);
        if(value.configured){
          const session=await cloudRequest<{authenticated:boolean}>('session');
          if(!active)return;
          if(session.authenticated&&sharedSource){location.replace(`/?shared=${encodeURIComponent(sharedSource)}`);return;}
          setAuth(session.authenticated);
        }
      }catch(error){if(active)setError((error as Error).message);}
      finally{if(active)setStarting(false);}
    })();
    return()=>{active=false;};
  },[sharedSource]);
  const refresh=useCallback(async(force=false)=>{
    if(!auth||!navigator.onLine||document.visibilityState==='hidden')return;
    const requestedSource=selected.current;
    if(inFlight.current?.sourceId===requestedSource)return inFlight.current.promise;
    const current=++generation.current;
    const request=(async()=>{
      try{
        const value=await cloudRequest<{sources:CloudSource[]}>('sources');
        if(current!==generation.current)return;
        setSources(value.sources);setLastContact(Date.now());setClock(Date.now());
        if(automatic){
          const workspace=await openAutomaticCloudWorkspace();
          if(current!==generation.current)return;
          if(workspace){location.replace(`/?shared=${encodeURIComponent(workspace)}`);return;}
        }
        const recoverable=value.sources.filter(source=>source.shared&&source.ready&&!source.revoked);
        if(restore){
          const recovery=await cloudRequest<{sourceId:string|null}>('active-source');
          if(current!==generation.current)return;
          if(recovery.sourceId){location.replace(`/?shared=${encodeURIComponent(recovery.sourceId)}`);return;}
        }
        const source=value.sources.find(source=>source.sourceId===selected.current)??recoverable[0]??value.sources[0];
        if(!source){setSourceId('');setSnapshot(null);setError('');return;}
        if(source.sourceId!==selected.current){
          selected.current=source.sourceId;
          setSourceId(source.sourceId);setSnapshot(null);setAccepted(false);lastRevision.current='';return;
        }
        const revision=`${source.sourceId}:${source.dataVersion??source.sequence}:${source.updatedAt}`;
        if(source.ready&&(force||revision!==lastRevision.current)){
          const next=await cloudRequest<CloudSnapshot>(`snapshot&sourceId=${encodeURIComponent(source.sourceId)}`);
          if(current!==generation.current||selected.current!==source.sourceId)return;
          setSnapshot(next);lastRevision.current=revision;
        }
        setError('');
      }catch(error){
        if(current!==generation.current)return;
        const value=error as Error&{status?:number};
        if(value.status===401){setAuth(false);setSnapshot(null);setSources([]);}
        setError(value.message);
      }
    })();
    inFlight.current={sourceId:requestedSource,promise:request};
    try{await request;}finally{if(inFlight.current?.promise===request)inFlight.current=null;}
  },[auth,restore,automatic]);
  useEffect(()=>{
    generation.current++;lastRevision.current='';setSnapshot(null);setBranchId('');setAccepted(false);
    void refresh(true);
  },[sourceId,refresh]);
  useEffect(()=>{
    if(!auth)return;
    const poll=()=>{setClock(Date.now());void refresh();};
    const timer=setInterval(poll,10000);
    window.addEventListener('focus',poll);window.addEventListener('online',poll);window.addEventListener('offline',poll);document.addEventListener('visibilitychange',poll);
    return()=>{clearInterval(timer);window.removeEventListener('focus',poll);window.removeEventListener('online',poll);window.removeEventListener('offline',poll);document.removeEventListener('visibilitychange',poll);};
  },[auth,refresh]);
  const {data,snapshotError}=useMemo(()=>{
    if(!snapshot)return {data:null,snapshotError:''};
    try{return {data:monitoringSnapshot(snapshot.records,branchId),snapshotError:''};}
    catch(error){return {data:null,snapshotError:(error as Error).message+' Select another workspace or finish the original device upload.'};}
  },[snapshot,branchId]);
  const report=useMemo(()=>data?profitability(data,from,to):null,[data,from,to]);
  async function login(event:FormEvent){event.preventDefault();setBusy(true);setError('');try{await cloudRequest('login',{email,password});setPassword('');if(sharedSource){location.replace(`/?shared=${encodeURIComponent(sharedSource)}`);return;}setAuth(true);}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  async function promote(){if(!sourceId||!accepted)return;setBusy(true);try{await cloudRequest('promote',{sourceId});location.href=`/?shared=${encodeURIComponent(sourceId)}`;}catch(error){setError((error as Error).message);}finally{setBusy(false);}}
  async function signOut(){
    setBusy(true);setError('');
    try{await cloudRequest('logout',{});generation.current++;setAuth(false);setSnapshot(null);setSources([]);}
    catch(error){setError((error as Error).message);}
    finally{setBusy(false);}
  }
  const source=sources.find(row=>row.sourceId===sourceId);
  const connected=Boolean(navigator.onLine&&source&&clock-new Date(source.lastSeenAt).getTime()<90000&&clock-lastContact<90000&&!error);
  if(starting)return <div className="cloud-shell">Opening cloud connection…</div>;
  if(!auth)return <div className="panel cloud-login"><a className="button button-ghost" href="/?local=1"><ArrowLeft size={15}/> Back to POS</a><Cloud size={30}/><h1>{sharedSource?'Shared cloud POS':automatic?'Sign in to your POS':restore?'Restore cloud workspace':'Owner live view'}</h1><p className="cloud-note">Sign in with the cloud owner email and password. After sign-in, a shared workspace loads its saved cloud data on this device. Local-only changes need a device backup.</p>{status&&!status.configured?<div className="error-message">Server setup required: {status.missing.join(', ')}. Local device sales are available from Back to POS.</div>:<form onSubmit={event=>void login(event)}><label className="field"><span>Cloud owner email</span><input className="input" type="email" autoComplete="username" required value={email} onChange={event=>setEmail(event.target.value)}/></label><label className="field"><span>Cloud owner password</span><input className="input" type="password" autoComplete="current-password" required value={password} onChange={event=>setPassword(event.target.value)}/></label><button className="button button-primary" disabled={busy}>{busy?'Signing in…':'Open cloud workspace'}</button></form>}{error&&<p className="error-message" role="alert">{error}</p>}</div>;
  const orders=(data?.orders??[]).filter(row=>{const day=businessDate(row.createdAt);return day>=from&&day<=to;}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const stock=(data?.inventory??[]).filter(row=>row.name.toLowerCase().includes(search.toLowerCase()));
  const expenses=(data?.expenses??[]).filter(row=>{const day=businessDate(row.createdAt);return day>=from&&day<=to;});
  return <div className="cloud-shell"><header className="cloud-header"><div><span className="eyebrow">DEMO HOTEL · CLOUD WORKSPACE</span><h1>{restore?'Choose your cloud workspace':'Owner live view'}</h1><p><i className={`cloud-dot ${connected?'green':'red'}`}/> {connected?'Shop connected':'Showing last uploaded data'} · Last upload {source?.updatedAt?new Date(source.updatedAt).toLocaleString('en-GB'):'Pending'}</p></div><div className="cloud-actions"><a className="button" href="/">Shop POS</a><a className="button button-ghost" href="/?local=1">Original device copy</a><button className="button" onClick={()=>void refresh(true)} aria-label="Refresh cloud view"><RefreshCw size={15}/></button><button className="button" disabled={busy} onClick={()=>void signOut()}>Sign out</button></div></header>
    {snapshotError&&<div className="error-message" role="alert">{snapshotError}</div>}
    {error&&<div className="error-message" role="alert">{error} · Previously uploaded data may be out of date.</div>}
    {!sources.length?<div className="panel cloud-empty">No ready workspace is available yet. Keep the original shop device open while its first upload finishes, then refresh this view.</div>:<>
    <div className="cloud-toolbar"><label className="field"><span>Shop device / workspace</span><select className="input" aria-label="Cloud workspace" value={sourceId} onChange={event=>{generation.current++;setSnapshot(null);setSourceId(event.target.value);}}>{sources.map(source=><option key={source.sourceId} value={source.sourceId}>{source.businessName} · {source.deviceName}</option>)}</select></label>{data&&<label className="field"><span>Branch</span><select className="input" value={data.branch.id} onChange={event=>setBranchId(event.target.value)}>{data.branches.map(branch=><option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}<label className="field"><span>From</span><input className="input" type="date" value={from} max={to} onChange={event=>setFrom(event.target.value)}/></label><label className="field"><span>To</span><input className="input" type="date" value={to} min={from} onChange={event=>setTo(event.target.value)}/></label></div>
    {source&&!source.ready?<div className="panel cloud-empty">The shop device’s first upload is still in progress. Keep that app open and online.</div>:!data?<div className="cloud-empty">Loading uploaded records…</div>:<>
    <nav className="cloud-tabs" aria-label="Cloud reports">{['Overview','Stock','Sales','Customers & dues','Reports'].map(value=><button key={value} className={`button ${value===tab?'button-primary':''}`} onClick={()=>setTab(value)}>{value}</button>)}</nav>
    {report&&['Overview','Reports'].includes(tab)&&<><div className="cloud-stats">{[['Net sales',report.netSales],['Gross profit',report.grossProfit],['Operating expenses',report.operatingExpenses],['Operating estimate',report.operatingProfit]].map(([label,value])=><div className="panel cloud-stat" key={label}><span>{label}</span><strong>{money(Number(value))}</strong></div>)}</div><p className="cloud-note">Confirmed bill basis, including unpaid and loan bills. Tax/service and stock purchases are excluded from net sales. {report.estimatedLines>0?`${report.estimatedLines} historical lines include estimated cost.`:'Costs captured on sale are retained.'}</p></>}
    {tab==='Stock'&&<><label className="field"><span>Search stock</span><input className="input" value={search} onChange={event=>setSearch(event.target.value)}/></label><div className="panel cloud-table"><table><thead><tr><th>Stock item</th><th>Available</th><th>Low-stock alert</th><th>Unit cost</th></tr></thead><tbody>{stock.map(row=><tr key={row.id}><td>{row.name}</td><td className={row.quantity<=row.minimum?'cloud-low':''}>{row.quantity} {row.unit}</td><td>{row.minimum}</td><td>{money(row.unitCost)}</td></tr>)}</tbody></table></div></>}
    {['Overview','Sales'].includes(tab)&&<div className="panel cloud-table"><h2>Sales & orders</h2><table><thead><tr><th>Bill</th><th>Items</th><th>Total</th><th>Paid / loan</th><th>Status</th></tr></thead><tbody>{orders.map(order=><tr key={order.id}><td>{order.number}<small>{new Date(order.createdAt).toLocaleString('en-GB')}</small></td><td>{order.lines.map(line=>`${line.name} × ${line.quantity}`).join(', ')}</td><td>{money(order.total)}</td><td>{money(order.paid)}<small>Loan {money(order.payments.filter(payment=>payment.method==='credit').reduce((sum,payment)=>sum+payment.amount,0))}</small></td><td>{order.status} · {order.paymentStatus}</td></tr>)}</tbody></table>{!orders.length&&<p>No bills in this date range.</p>}</div>}
    {tab==='Customers & dues'&&<div className="panel cloud-table"><table><thead><tr><th>Customer</th><th>Phone</th><th>Outstanding</th><th>Recent repayments</th></tr></thead><tbody>{data.customers.map(customer=><tr key={customer.id}><td>{customer.name}</td><td>{customer.phone}</td><td>{money(customer.balance)}</td><td>{data.creditEntries.filter(entry=>entry.customerId===customer.id&&entry.type==='collection').slice(-5).map(entry=>`${money(entry.amount)} (${businessDate(entry.createdAt)})`).join(', ')||'—'}</td></tr>)}</tbody></table></div>}
    {tab==='Reports'&&report&&<><div className="cloud-actions"><button className="button button-primary" onClick={()=>download(`profit-${from}-${to}.csv`,profitCsv(report))}><Download size={15}/> Download profit report</button><button className="button" onClick={()=>download(`stock-${today}.csv`,csv([['Stock item','Quantity','Unit','Low stock at','Unit cost (LKR)'],...data.inventory.map(row=>[row.name,row.quantity,row.unit,row.minimum,(row.unitCost/100).toFixed(2)])]))}>Download stock report</button><button className="button" onClick={()=>download(`sales-${from}-${to}.csv`,csv([['Bill','Date','Status','Total (LKR)','Paid / account (LKR)'],...orders.map(order=>[order.number,businessDate(order.createdAt),order.status,(order.total/100).toFixed(2),(order.paid/100).toFixed(2)])]))}>Download sales report</button></div><div className="panel cloud-table"><h2>Expenses</h2><table><thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Amount</th></tr></thead><tbody>{expenses.map(expense=><tr key={expense.id}><td>{businessDate(expense.createdAt)}</td><td>{expense.category}</td><td>{expense.description}</td><td>{money(expense.amount)}</td></tr>)}</tbody></table></div></>}
    {source?.shared?<section className="panel cloud-promote"><h2>Shared POS is enabled</h2><p className="cloud-note">Use this same workspace link on each authorized device. Transactions use cloud stock checks; new offline orders stay as drafts.</p><a className="button button-primary" href={`/?shared=${encodeURIComponent(sourceId)}`}>Open shared POS</a></section>:<section className="panel cloud-promote"><h2>Work from multiple devices</h2><p className="cloud-note">Enabling shared POS transfers new sales and stock changes to this cloud workspace. Automatic uploads from the old independent device stop to prevent overwriting shared stock. Use the shared POS link on the shop device and every other authorized device. Internet is required to confirm shared sales; drafts remain on their own device during an outage.</p><label><input type="checkbox" checked={accepted} onChange={event=>setAccepted(event.target.checked)}/> I have exported a backup and will use the shared POS link on all devices after enabling it.</label><button className="button button-primary" disabled={!accepted||busy} onClick={()=>void promote()}>Enable shared POS</button></section>}
    </>}
    </>}
    <footer className="cloud-note">Independent shop devices are shown separately. This view does not add or merge their stock balances.</footer>
  </div>;
}
