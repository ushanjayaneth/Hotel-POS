import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  Bell,
  Check,
  CheckCheck,
  ChevronRight,
  ClipboardList,
  CookingPot,
  Cloud,
  Flame,
  Grid2X2,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  RefreshCw,
  Settings,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Store,
  Users,
  UtensilsCrossed,
  Wallet,
  Wifi,
  WifiOff,
  X,
  LockKeyhole,
  Leaf,
  MonitorSmartphone,
  ArrowLeft,
  Keyboard,
  PauseCircle,
  Database,
} from "lucide-react";
import { registerSW } from "virtual:pwa-register";
import type { Page, Snapshot, User } from "../shared/types";
import { api, ApiError } from "./lib/api";
import { AppContext } from "./lib/context";
import { browserDb } from "./lib/db";
import { Spinner, Modal } from "./components/ui";
import POS from "./pages/POS";
import { Orders, Kitchen, Tables, Receipt } from "./pages/Operations";
import Management from "./pages/Management";
import Products from './pages/Products';
import HeldBills from './pages/HeldBills';
import {WorkspacePreferences} from './components/WorkspacePreferences';
import {NavigationProvider,useNavigation,useBackLayer} from './lib/navigation';
import {useDevicePreferences,shortcutActions,keyboardCombination,dispatchShortcut,type ShortcutAction} from './lib/preferences';
import {useWorkspaceMode,setWorkspaceMode,readSavedWorkspaceMode} from './lib/workspace-mode';
import {getLocalWorkspaceInfo,type LocalWorkspaceInfo} from './lib/local/core';
import {recoverRestoredDrafts} from './lib/local/backup';
import {DeviceSetup,InitialDeviceRestore} from './components/DeviceSetup';
import {syncLocalProductPhotos} from './lib/media';
import {flushBeforeAppUpdate} from './lib/update-safety';
import {sharedCloudSource} from './lib/cloud-shared';
import {cloudRequest,syncDeviceCloud} from './lib/cloud-sync';
import CloudMonitor from './components/CloudMonitor';
import ConnectivityStatus from './components/ConnectivityStatus';

// Optional UI preferences must never block access to committed business records.
const uiStorage = {
  getItem(key: string) {try {return localStorage.getItem(key);} catch {return null;}},
  setItem(key: string, value: string) {try {localStorage.setItem(key, value);} catch {/* The device database remains authoritative. */}},
  removeItem(key: string) {try {localStorage.removeItem(key);} catch {/* An unavailable preference store does not invalidate a session. */}},
};

const navigation = [
  {
    label: "WORKSPACE",
    items: [
      { id: "overview", label: "Overview", icon: LayoutDashboard },
      { id: "pos", label: "Point of sale", icon: Grid2X2 },
      { id: "orders", label: "Orders", icon: ClipboardList },
      { id: "held-bills", label: "Held bills", icon: PauseCircle },
      { id: "sales-history", label: "Sales history", icon: History },
      { id: "tables", label: "Tables", icon: UtensilsCrossed },
      { id: "kitchen", label: "Kitchen display", icon: CookingPot },
    ],
  },
  {
    label: "MANAGEMENT",
    items: [
      { id: "inventory", label: "Inventory", icon: Package },
      { id: "products", label: "Products", icon: ShoppingBag },
      { id: "production", label: "Production", icon: Flame },
      { id: "purchases", label: "Purchases", icon: ShoppingCart },
      { id: "customers", label: "Customers & dues", icon: Users },
      { id: "team", label: "Team", icon: Users },
      { id: "finance", label: "Day end & expenses", icon: Wallet },
      { id: "reports", label: "Reports", icon: BarChart3 },
      { id: "settings", label: "Settings", icon: Settings },
    ],
  },
];
const allPages = navigation.flatMap((n) => n.items.map((i) => i.id));
const allowedPages: Record<string, string[]> = {
  owner: allPages,
  manager: allPages,
  accountant: [
    "overview",
    "orders",
    "sales-history",
    "products",
    "purchases",
    "customers",
    "finance",
    "reports",
    "settings",
  ],
  cashier: ["pos", "orders", "held-bills", "sales-history", "products", "tables", "customers", "finance", "reports", "settings"],
  waiter: ["pos", "orders", "held-bills", "tables", "kitchen", "settings"],
  kitchen: ["kitchen", "settings"],
  storekeeper: ["products", "inventory", "production", "purchases", "settings"],
};
function Brand() {
  return (
    <div className="brand">
      <div className="brand-mark">
        <img src="/icons/app-icon-192.png" alt="" width="42" height="42" />
      </div>
      <div className="brand-wordmark">
        <div className="brand-name">DEMO HOTEL</div>
        <span className="brand-caption">RESTAURANT WORKSPACE</span>
      </div>
    </div>
  );
}

function Login({ onLogin,onSetup,onRestore,deviceInfo }: { onLogin: (user: User) => void;onSetup:()=>void;onRestore:()=>void;deviceInfo:LocalWorkspaceInfo|null }) {
  const mode=useWorkspaceMode();
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function login(value: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ user: User }>("/login", { pin: value });
      onLogin(result.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-page">
      <section className="login-art">
        <Brand />
        <div className="login-copy">
          <div className="eyebrow">
            <span className="status-dot" /> A LITTLE MORE ORDER. A LOT LESS
            FRICTION.
          </div>
          <h1>
            Every table.
            <br />
            Every order.
            <br />
            <em>Under control.</em>
          </h1>
          <p>
            One workspace for the floor, the kitchen, and everything that keeps
            your restaurant running.
          </p>
          <div className="login-badges">
            <span>
              <WifiOff size={14} /> Works without internet
            </span>
            <span>
              <MonitorSmartphone size={14} /> Made for every screen
            </span>
          </div>
        </div>
        <div className="login-footer">
          <ShieldCheck size={14} /> Stored at your branch. Synced on your terms.
        </div>
        <div className="login-orb" />
      </section>
      <section className="login-panel">
        <form
          className="login-box"
          onSubmit={(e) => {
            e.preventDefault();
            void login(pin);
          }}
        >
          <div className="login-lock">
            <LockKeyhole size={23} />
          </div>
          <div className="eyebrow">YOUR RESTAURANT, CONNECTED</div>
          <h2>Welcome back.</h2>
          <p>{mode==='device'?'Enter your private staff PIN to open this device’s saved workspace.':'Enter your staff PIN to open your workspace.'}</p>
          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}
          <label className="field">
            <span>Staff PIN</span>
            <input
              className="input pin-input"
              type="password"
              inputMode="numeric"
              pattern="[0-9]{4,12}"
              autoComplete="current-password"
              required
              minLength={4}
              maxLength={12}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              placeholder="••••"
              aria-label="Staff PIN"
            />
          </label>
          <button
            className="button button-primary login-submit"
            disabled={busy}
          >
            {busy ? (
              <RefreshCw size={15} className="spin" />
            ) : (
              <>
                Open workspace <ArrowRight size={15} />
              </>
            )}
          </button>
          {mode==='hub' && <><div className="login-divider">just looking around?</div>
          <button
            className="button demo-login"
            type="button"
            onClick={() => void login("1234")}
            disabled={busy}
          >
            <Leaf size={15} /> Explore demo workspace <ArrowUpRight size={14} />
          </button>
          <p className="demo-caption">
            Sample restaurant data · no real payments
            <br />
            Demo owner PIN: 1234
          </p></>}
          {mode==='hub'&&<div className="device-login-option"><div className="login-divider">work on this device</div>{deviceInfo?<button type="button" className="button full-width" onClick={()=>setWorkspaceMode('device')}><Database size={15}/> Open saved device workspace</button>:<><button type="button" className="button full-width" onClick={onSetup}><Database size={15}/> Set up this device</button><button type="button" className="button button-ghost full-width" onClick={onRestore}>Restore device backup</button><p className="demo-caption">Keep your workspace on this device. No hosted backend required.</p></>}</div>}
          {mode==='device'&&<><p className="demo-caption">{deviceInfo?'Saved on this device · Setup complete':'Device data is unavailable. Restore your backup or create a new workspace.'}<br/><button type="button" className="button button-ghost button-small" onClick={()=>setWorkspaceMode('hub')}>Use branch hub instead</button></p>{!deviceInfo&&<div className="device-login-option"><button type="button" className="button full-width" onClick={onRestore}>Restore device backup</button><button type="button" className="button button-ghost full-width" onClick={onSetup}>Set up this device</button></div>}</>}
        </form>
        <a className="button button-ghost" href="/?cloud=1"><Cloud size={14}/> Owner live view / shared cloud POS</a>
        <div className="login-bottom">
          <ShieldCheck size={12} /> Your session stays on this device.
        </div>
      </section>
    </div>
  );
}

function WorkspaceApp() {
  const mode=useWorkspaceMode();
  const deviceMode=mode==='device'&&!sharedCloudSource();
  const [deviceInfo,setDeviceInfo]=useState<LocalWorkspaceInfo|null>(null);
  const [deviceSetup,setDeviceSetup]=useState(false);
  const [deviceRestore,setDeviceRestore]=useState(false);
  const localWrites=useRef(0);
  const updateActivated=useRef(false);
  const updateRequested=useRef(false);
  const updateReloading=useRef(false);
  const updateActivationTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const {route,navigate:routeTo,back}=useNavigation();
  const preferences=useDevicePreferences();
  const [user, setUser] = useState<User | null>(null);
  const [starting, setStarting] = useState(true);
  const [data, setData] = useState<Snapshot | null>(null);
  const [branchId, setBranchId] = useState(
    () => uiStorage.getItem("dh-branch") || "b1",
  );
  const page=route.page;
  const [loadError, setLoadError] = useState("");
  const [hubOnline, setHubOnline] = useState(true);
  useEffect(()=>{
    if(!deviceMode||!user)return;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const upload=()=>{if(navigator.onLine!==false)void syncDeviceCloud().catch(()=>{});};
    const change=()=>{clearTimeout(timer);timer=setTimeout(upload,1000);};
    upload();const interval=setInterval(upload,30000);
    window.addEventListener('online',upload);window.addEventListener('focus',upload);window.addEventListener('local-workspace-change',change);
    return()=>{clearTimeout(timer);clearInterval(interval);window.removeEventListener('online',upload);window.removeEventListener('focus',upload);window.removeEventListener('local-workspace-change',change);};
  },[deviceMode,user]);
  const [mobileNav, setMobileNav] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const selectedOrder=route.orderId;
  const setSelectedOrder=(id:string|null)=>routeTo('pos',id);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [shortcutHelp,setShortcutHelp]=useState(false);
  useBackLayer(mobileNav,()=>setMobileNav(false),'navigation');
  useBackLayer(notifications,()=>setNotifications(false),'notifications');
  useEffect(()=>{document.documentElement.style.setProperty('--font-scale',String(preferences.fontScale));},[preferences.fontScale]);
  useEffect(()=>{
    if(!deviceMode||!user)return;
    const upload=()=>{void syncLocalProductPhotos().catch(()=>{});};
    upload();const timer=setInterval(upload,45000);
    window.addEventListener('online',upload);window.addEventListener('focus',upload);
    return()=>{clearInterval(timer);window.removeEventListener('online',upload);window.removeEventListener('focus',upload);};
  },[deviceMode,user]);
  const [toasts, setToasts] = useState<
    { id: number; message: string; type: string }[]
  >([]);
  const [updateReady, setUpdateReady] = useState(false);
  const [updateWorker, setUpdateWorker] = useState<
    ((reload?: boolean) => Promise<void>) | null
  >(null);
  const requestGeneration = useRef(0);
  const notify = useCallback(
    (message: string, type: "success" | "error" = "success") => {
      const id = Date.now() + Math.random();
      setToasts((v) => [...v.slice(-3), { id, message, type }]);
      setTimeout(() => setToasts((v) => v.filter((t) => t.id !== id)), 5500);
    },
    [],
  );
  const checkAppUpdate = useCallback(async () => {
    if (navigator.onLine === false || !("serviceWorker" in navigator)) return;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return;
      if (registration.waiting) setUpdateReady(true);
      await registration.update();
      if (registration.waiting) setUpdateReady(true);
    } catch {
      /* An unavailable update must not interrupt local sales or stored drafts. */
    }
  }, []);
  const finishAppUpdate = useCallback(async () => {
    if (updateReloading.current) return;
    updateReloading.current = true;
    try {
      if (localWrites.current > 0) throw new Error('Wait for the current save to finish before reloading the app.');
      await flushBeforeAppUpdate();
      // A payment may start while a worker activates or a draft is being flushed.
      if (localWrites.current > 0) throw new Error('Wait for the current save to finish before reloading the app.');
      window.location.reload();
    } catch (error) {
      updateRequested.current = false;
      updateReloading.current = false;
      notify((error as Error).message, 'error');
    }
  }, [notify]);
  useEffect(() => {
    const checkForUpdate=()=>{
      if(document.visibilityState==='visible')void checkAppUpdate();
    };
    const workerActivated = () => {
      clearTimeout(updateActivationTimer.current);
      updateActivated.current = true;
      setUpdateReady(true);
      // Activation in another tab never grants permission to reload this page.
      if (updateRequested.current) void finishAppUpdate();
    };
    let previousController = navigator.serviceWorker?.controller;
    const controllerChanged = () => {
      const next = navigator.serviceWorker.controller;
      if (previousController && next !== previousController) workerActivated();
      previousController = next;
    };
    const update = registerSW({
      immediate:true,
      onNeedRefresh() {
        setUpdateReady(true);
      },
      onRegisteredSW(_url, registration) {
        if (registration?.waiting) setUpdateReady(true);
      },
      onNeedReload: workerActivated,
      onRegisterError() {
        /* Local network use remains available without PWA installation. */
      },
    });
    setUpdateWorker(() => update);
    window.addEventListener('focus',checkForUpdate);
    window.addEventListener('online',checkForUpdate);
    document.addEventListener('visibilitychange',checkForUpdate);
    navigator.serviceWorker?.addEventListener('controllerchange',controllerChanged);
    const timer = window.setInterval(checkForUpdate, 5 * 60 * 1000);
    return()=>{window.clearInterval(timer);clearTimeout(updateActivationTimer.current);window.removeEventListener('focus',checkForUpdate);window.removeEventListener('online',checkForUpdate);document.removeEventListener('visibilitychange',checkForUpdate);navigator.serviceWorker?.removeEventListener('controllerchange',controllerChanged);};
  }, [checkAppUpdate,finishAppUpdate]);
  async function reloadAppUpdate() {
    if (updateReloading.current) return;
    if (localWrites.current > 0) {
      notify('Wait for the current save to finish before reloading the app.', 'error');
      return;
    }
    if (!updateWorker) {
      notify('The app update is not ready. Refresh the workspace and try again.', 'error');
      return;
    }
    try {
      if (updateActivated.current) {
        updateRequested.current = true;
        await finishAppUpdate();
        return;
      }
      const registration = await navigator.serviceWorker.getRegistration();
      if (updateActivated.current) {
        updateRequested.current = true;
        await finishAppUpdate();
        return;
      }
      if (!registration?.waiting) throw new Error('No waiting worker is available.');
      updateRequested.current = true;
      clearTimeout(updateActivationTimer.current);
      updateActivationTimer.current = setTimeout(() => {
        if (!updateRequested.current || updateActivated.current) return;
        updateRequested.current = false;
        notify('The app update has not finished activating. Keep this page open and click Reload again.', 'error');
      }, 10000);
      await updateWorker(true);
    } catch {
      clearTimeout(updateActivationTimer.current);
      updateRequested.current = false;
      notify('The app update could not be applied. Keep this app open and try Reload again.', 'error');
    }
  }
  useEffect(() => {
    let active = true;
    setStarting(true);setUser(null);setData(null);setLoadError('');
    setBranchId(uiStorage.getItem(sharedCloudSource()?`dh-cloud-branch:${sharedCloudSource()}`:deviceMode?'dh-device-branch':'dh-branch')||'b1');
    void (async()=>{
      const info=await getLocalWorkspaceInfo().catch(()=>null);
      if(!active)return null;
      setDeviceInfo(info);
      if(info&&!readSavedWorkspaceMode()&&!deviceMode){setWorkspaceMode('device');return null;}
      if(deviceMode)await recoverRestoredDrafts();
      return api<{user:User|null}>('/session');
    })()
      .then((result) => {
        if (!active||!result) return;
        setUser(result.user);
        if (result.user)
          uiStorage.setItem(deviceMode?'dh-device-last-user':'dh-last-user', JSON.stringify(result.user));
      })
      .catch(() => {
        if(!active)return;
        try {
          const saved = !deviceMode&&uiStorage.getItem("dh-last-user");
          if (saved) setUser(JSON.parse(saved));
          setHubOnline(false);
        } catch {
          uiStorage.removeItem("dh-last-user");
        }
      })
      .finally(() => active && setStarting(false));
    return () => {
      active = false;
    };
  }, [mode]);
  const refresh = useCallback(async () => {
    if (!user) return;
    const generation = ++requestGeneration.current;
    const cacheKey = sharedCloudSource()?`cloud:${sharedCloudSource()}:${user.id}:${branchId}`:`${user.id}:${branchId}`;
    try {
      const snapshot = await api<Snapshot>(
        `/bootstrap?branchId=${encodeURIComponent(branchId)}`,
      );
      if (generation !== requestGeneration.current) return;
      setData(snapshot);
      if(sharedCloudSource())uiStorage.setItem('dh-cloud-preferred-source',sharedCloudSource()!);
      setHubOnline(true);
      setLoadError("");
      if(!deviceMode)await browserDb.snapshots
        .put({
          id: cacheKey,
          data: snapshot,
          savedAt: new Date().toISOString(),
        })
        .catch(() => {});
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      setHubOnline(false);
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
        setData(null);
        uiStorage.removeItem(deviceMode?'dh-device-last-user':'dh-last-user');
        return;
      }
      if (
        err instanceof ApiError &&
        err.status === 403 &&
        user.branchId &&
        branchId !== user.branchId
      ) {
        setBranchId(user.branchId);
        return;
      }
      const cached = !deviceMode&&await browserDb.snapshots
        .get(cacheKey)
        .catch(() => undefined);
      if (cached) setData(cached.data);
      else setLoadError((err as Error).message);
    }
  }, [user, branchId,mode]);
  useEffect(() => {
    void refresh();
    if(deviceMode){
      let timer:ReturnType<typeof setTimeout>|undefined;
      const changed=()=>{if(localWrites.current)return;clearTimeout(timer);timer=setTimeout(()=>void refresh(),60);};
      const visible=()=>{if(document.visibilityState==='visible')changed();};
      const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('demo-hotel-device-changes'):null;
      if(channel)channel.onmessage=changed;
      window.addEventListener('local-workspace-change',changed);window.addEventListener('focus',changed);document.addEventListener('visibilitychange',visible);
      return()=>{clearTimeout(timer);channel?.close();window.removeEventListener('local-workspace-change',changed);window.removeEventListener('focus',changed);document.removeEventListener('visibilitychange',visible);};
    }
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, sharedCloudSource()?5000:12000);
    return () => clearInterval(interval);
  }, [refresh]);
  useEffect(() => {
    if (!user) return;
    const permitted = allowedPages[user.role] || ["pos"];
    if(sharedCloudSource()&&page==='team'){routeTo('pos',null,true);return;}
    if (!permitted.includes(page)) routeTo(permitted[0] as Page,null,true);
  }, [user, page,routeTo]);
  const mutate = useCallback(
    async <T,>(path: string, body?: unknown, method?: string): Promise<T> => {
      localWrites.current++;
      try{const result = await api<T>(path, body, method);await refresh();return result;}
      finally{localWrites.current--;}
    },
    [refresh],
  );
  function navigate(next: Page) {
    routeTo(next);
    setMobileNav(false);
    setNotifications(false);
  }
  function openOrder(id: string) {
    routeTo('pos',id);
    setMobileNav(false);
    setNotifications(false);
  }
  useEffect(()=>{
    const handler=(event:KeyboardEvent)=>{
      if(event.defaultPrevented||!user)return;
      const target=event.target as HTMLElement;
      if(target.closest('.shortcut-input')||target.isContentEditable)return;
      const combination=keyboardCombination(event);
      const action=shortcutActions.find(item=>preferences.shortcuts[item.id]===combination)?.id;
      if(!action)return;
      if(['INPUT','TEXTAREA','SELECT'].includes(target.tagName)&&event.key.length===1&&!event.ctrlKey&&!event.metaKey&&!event.altKey)return;
      event.preventDefault();
      if(action==='back'){back();return;}
      if(action==='help'){setShortcutHelp(true);return;}
      if(action==='print'&&receiptId){window.print();return;}
      if(document.querySelector('[role="dialog"]'))return;
      const shortcuts:Partial<Record<ShortcutAction,Page>>={'go-pos':'pos','go-held':'held-bills','go-sales':'sales-history','go-products':'products','go-customers':'customers','go-reports':'reports','go-finance':'finance','go-settings':'settings'};
      const destination=shortcuts[action];
      if(destination){if((allowedPages[user.role]||[]).includes(destination))navigate(destination);else notify('Your role does not have access to this page.','error');return;}
      if(page==='pos')dispatchShortcut(action);else notify('Open Point of sale to use this shortcut.');
    };
    window.addEventListener('keydown',handler);
    return()=>window.removeEventListener('keydown',handler);
  },[user,page,preferences.shortcuts,receiptId,back,routeTo,notify]);
  async function logout() {
    try {
      await api("/logout", {});
    } catch {}
    setUser(null);
    setData(null);
    uiStorage.removeItem(deviceMode?'dh-device-last-user':'dh-last-user');
    if(!deviceMode)await browserDb.snapshots.clear().catch(() => {});
  }
  function onLogin(next: User) {
    setUser(next);
    uiStorage.setItem(deviceMode?'dh-device-last-user':'dh-last-user', JSON.stringify(next));
    if (next.branchId) {
      setBranchId(next.branchId);
      uiStorage.setItem(deviceMode?'dh-device-branch':'dh-branch', next.branchId);
    }
    setStarting(false);
  }
  if (starting) return <Spinner />;
  if (!user&&sharedCloudSource())return <CloudMonitor sharedSource={sharedCloudSource()!}/>;
  if (!user) return <><Login onLogin={onLogin} onSetup={()=>setDeviceSetup(true)} onRestore={()=>setDeviceRestore(true)} deviceInfo={deviceInfo}/>{deviceSetup&&<DeviceSetup onClose={()=>setDeviceSetup(false)} onComplete={(next)=>{setDeviceSetup(false);setBranchId('b1');setUser(next);uiStorage.setItem('dh-device-last-user',JSON.stringify(next));void getLocalWorkspaceInfo().then(setDeviceInfo);}}/>}{deviceRestore&&<InitialDeviceRestore onClose={()=>setDeviceRestore(false)}/>}</>;
  if (!data || data.branch.id !== branchId) {
    if (loadError)
      return (
        <div className="boot-error panel">
          <h2>Let’s reconnect your workspace.</h2>
          <p>{loadError}</p>
          <button
            className="button button-primary"
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} /> Try again
          </button>
          <button className="button button-ghost" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      );
    return <Spinner label="Opening your branch workspace" />;
  }
  const title =
    navigation.flatMap((n) => n.items).find((n) => n.id === page)?.label ||
    "Workspace";
  const visiblePages = allowedPages[user.role] || ["pos"];
  const activeOrders = data.orders.filter(
    (o) => !["completed", "cancelled"].includes(o.status),
  );
  const lowStock = data.inventory.filter((i) => i.quantity <= i.minimum);
  const receipt = data.orders.find((o) => o.id === receiptId);
  const context = {
    data: { ...data, sync: { ...data.sync, hubOnline } },
    branchId,
    locale: "en" as const,
    t: (en: string, _si: string) => en,
    refresh,
    mutate,
    notify,
    navigate,
    back,
  };
  return (
    <AppContext.Provider value={context}>
      <div className="app">
        {mobileNav && (
          <div className="mobile-overlay" onClick={() => setMobileNav(false)} />
        )}
        <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
          <Brand />
          <nav className="sidebar-scroll" aria-label="Main navigation">
            {navigation.map((group) => (
              <div key={group.label}>
                <div className="nav-label">{group.label}</div>
                {group.items
                  .filter((item) => visiblePages.includes(item.id)&&(!sharedCloudSource()||item.id!=='team'))
                  .map((item) => (
                    <button
                      key={item.id}
                      title={item.label}
                      className={`nav-item ${page === item.id ? "active" : ""}`}
                      onClick={() => navigate(item.id as Page)}
                      aria-current={page === item.id ? "page" : undefined}
                    >
                      <item.icon size={17} strokeWidth={1.6} />
                      <span>{item.label}</span>
                      {item.id === "orders" && activeOrders.length > 0 && (
                        <small className="nav-count">
                          {activeOrders.length}
                        </small>
                      )}
                    </button>
                  ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-footer">
            <div className="hub-status">
              <i className={`status-dot ${!hubOnline ? "offline" : ""}`} />
              <span>
                {deviceMode?'Device database ready':hubOnline ? "Branch hub connected" : "Hub unavailable"}
              </span>
            </div>
            <div className="user-card">
              <div className="avatar">{user.initials}</div>
              <div className="user-details">
                <strong>{user.name}</strong>
                <small>{user.role}</small>
              </div>
              <button
                className="logout-button"
                onClick={() => void logout()}
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut size={15} />
              </button>
            </div>
          </div>
        </aside>
        <main className="main">
          <header className="topbar">
            <button className="icon-button app-back-button" onClick={back} aria-label="Go back one step" title="Go back"><ArrowLeft size={17}/></button>
            <button
              className="icon-button mobile-menu-button"
              onClick={() => setMobileNav(true)}
              aria-label="Open navigation"
            >
              <Menu size={19} />
            </button>
            <div className="breadcrumb">
              <span>Workspace</span>
              <ChevronRight size={12} />
              <strong>{title}</strong>
            </div>
            <div className="topbar-actions">
              <ConnectivityStatus/>
              <span className="topbar-date">
                {new Intl.DateTimeFormat("en-GB", {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  timeZone: "Asia/Colombo",
                }).format(new Date())}
              </span>
              <label className="branch-picker">
                <Store size={14} />
                <select
                  value={branchId}
                  aria-label="Choose branch"
                  disabled={!!user.branchId}
                  onChange={(e) => {
                    setBranchId(e.target.value);
                    uiStorage.setItem(sharedCloudSource()?`dh-cloud-branch:${sharedCloudSource()}`:deviceMode?'dh-device-branch':'dh-branch', e.target.value);
                    routeTo(page,null,true);
                  }}
                >
                  {data.branches.map((b) => (
                    <option value={b.id} key={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="icon-button refresh-button"
                onClick={() => {void refresh();void checkAppUpdate();}}
                title="Refresh workspace"
                aria-label="Refresh workspace"
              >
                <RefreshCw size={15} />
              </button>
              <button className="icon-button shortcut-help-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" onClick={()=>setShortcutHelp(true)}><Keyboard size={16}/></button>
              <button
                className="icon-button notification-button"
                onClick={() => setNotifications(!notifications)}
                aria-label="Notifications"
              >
                <Bell size={16} />
              </button>
            </div>
            {notifications && (
              <div className="notification-popover">
                <h3>Workspace updates</h3>
                <div className="notification-row">
                  <Package size={17} />
                  <div>
                    {lowStock.length
                      ? `${lowStock.length} items need a stock check.`
                      : "Stock levels are looking good."}
                    <small>Current branch inventory</small>
                  </div>
                </div>
                <div className="notification-row">
                  {data.sync.configured ? (
                    <Wifi size={17} />
                  ) : (
                    <ShieldCheck size={17} />
                  )}
                  <div>
                    {data.sync.configured
                      ? `${data.sync.pending} changes waiting to sync.`
                      : deviceMode?'Your data is stored on this device.':"Your data is stored at this branch."}
                    <small>
                      {data.sync.configured
                        ? "Cloud sync configured"
                        : deviceMode?'Export encrypted backups in Settings':"Connect cloud sync in Settings"}
                    </small>
                  </div>
                </div>
                <button
                  className="button button-ghost"
                  onClick={() => navigate("settings")}
                >
                  View workspace settings <ArrowRight size={13} />
                </button>
              </div>
            )}
          </header>
          <div className="workspace">
            {!hubOnline && (
              <div className="notice-banner">
                <WifiOff size={16} /> The branch hub is unavailable. Viewing
                saved data; new orders stay as drafts until you reconnect.
              </div>
            )}
            {page === "pos" ? (
              <POS
                selectedOrderId={selectedOrder}
                onSelectOrder={setSelectedOrder}
                onReceipt={setReceiptId}
              />
            ) : page === "orders" || page === 'sales-history' ? (
              <Orders key={page} historyView={page==='sales-history'} onOpen={openOrder} onReceipt={setReceiptId} />
            ) : page === 'held-bills' ? (
              <HeldBills onResume={bill=>{sessionStorage.setItem('dh-resume-held',bill.id);routeTo('pos');}}/>
            ) : page === 'products' ? (
              <Products/>
            ) : page === "kitchen" ? (
              <Kitchen />
            ) : page === "tables" ? (
              <Tables
                onOpen={openOrder}
                onNew={(tableId) => {
                  sessionStorage.setItem("dh-new-table", tableId);
                  setSelectedOrder(null);
                  navigate("pos");
                }}
              />
            ) : page==='settings'&&!['owner','manager'].includes(user.role) ? <><div className="page-heading"><div><div className="eyebrow">MAKE IT YOURS</div><h1>Settings<span className="heading-period">.</span></h1><p className="page-subtitle">Display, shortcuts, receipts and devices.</p></div></div><WorkspacePreferences/></> : (
              <Management page={page} />
            )}
            <div className="footer-line">
              <span>
                <ShieldCheck size={10} /> {deviceMode?'Device workspace · Saved locally':'Local-first restaurant workspace'}
              </span>
              <span>
                DEMO HOTEL <i style={{ opacity: 0.4 }}>·</i> v0.1.0
              </span>
            </div>
          </div>
        </main>
        <div className="toast-stack" aria-live="polite">
          {toasts.map((toast) => (
            <div
              className={`toast ${toast.type === "error" ? "error" : ""}`}
              key={toast.id}
            >
              {toast.type === "error" ? (
                <X size={16} />
              ) : (
                <CheckCheck size={17} />
              )}
              <span>{toast.message}</span>
              <button
                onClick={() =>
                  setToasts((v) => v.filter((t) => t.id !== toast.id))
                }
                aria-label="Dismiss notification"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
        {updateReady && (
          <div className="update-banner">
            <span>
              A workspace update is ready. Save drafts before reloading.
            </span>
            <button
              className="button button-primary button-small"
              onClick={() => void reloadAppUpdate()}
            >
              Reload
            </button>
            <button
              className="icon-button"
              onClick={() => setUpdateReady(false)}
              aria-label="Dismiss update"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      {receipt && (
        <Receipt
          order={receipt}
          branch={data.branch}
          settings={data.settings}
          onClose={() => setReceiptId(null)}
        />
      )}
      {shortcutHelp&&<Modal title="Keyboard shortcuts" subtitle="Your current shortcuts for this device." onClose={()=>setShortcutHelp(false)} wide><div className="shortcut-help">{shortcutActions.map(action=><div key={action.id}><span>{action.label}</span><kbd>{preferences.shortcuts[action.id]}</kbd></div>)}</div><div className="form-actions"><button className="button button-ghost" onClick={()=>{setShortcutHelp(false);navigate('settings');}}>Customize in Settings</button><button className="button button-primary" onClick={()=>setShortcutHelp(false)}>Done</button></div></Modal>}
    </AppContext.Provider>
  );
}

function SharedCloudGate(){
  const [ready,setReady]=useState<boolean|null>(null);
  useEffect(()=>{void cloudRequest<{authenticated:boolean}>('session').then(value=>setReady(value.authenticated)).catch(()=>setReady(false));},[]);
  if(ready===null)return <Spinner label="Connecting to shared cloud POS"/>;
  return ready?<NavigationProvider><WorkspaceApp/></NavigationProvider>:<CloudMonitor sharedSource={sharedCloudSource()!}/>;
}
function PreferredCloudRedirect({source}:{source:string}){useEffect(()=>{location.replace(`/?shared=${encodeURIComponent(source)}`);},[source]);return <Spinner label="Opening your shared workspace"/>;}
export default function App(){
  const params=new URLSearchParams(location.search);
  useEffect(()=>{if(params.has('local'))uiStorage.removeItem('dh-cloud-preferred-source');},[]);
  if(sharedCloudSource())return <SharedCloudGate/>;
  if(params.has('cloud'))return <CloudMonitor/>;
  const preferred=params.has('local')?null:uiStorage.getItem('dh-cloud-preferred-source');
  if(preferred&&/^[A-Za-z0-9_-]{1,160}$/.test(preferred))return <PreferredCloudRedirect source={preferred}/>;
  return <NavigationProvider><WorkspaceApp/></NavigationProvider>;
}
