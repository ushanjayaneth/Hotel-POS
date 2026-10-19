import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import type {Page} from '../../shared/types';

const pages:Page[]=['pos','overview','orders','sales-history','held-bills','products','tables','kitchen','inventory','production','purchases','customers','team','finance','reports','settings'];
type Route={page:Page;orderId:string|null};
type AppHistory={app:'demo-hotel';kind:'guard'|'route'|'layer';route:Route;layerId?:string};
type BackLayer={id:string;close:()=>unknown};
interface Navigation {route:Route;navigate:(page:Page,orderId?:string|null,replace?:boolean)=>void;back:()=>void;registerLayer:(key:string,close:()=>unknown)=>()=>void}
const NavigationContext=createContext<Navigation|null>(null);
const initialRoute=():Route=>({page:pages.includes(location.hash.slice(1) as Page)?location.hash.slice(1) as Page:'pos',orderId:null});
const sameRoute=(a:Route,b:Route)=>a.page===b.page&&a.orderId===b.orderId;
const url=(route:Route)=>`${location.pathname}${location.search}#${route.page}`;
const isHistory=(value:unknown):value is AppHistory=>!!value&&typeof value==='object'&&(value as AppHistory).app==='demo-hotel'&&pages.includes((value as AppHistory).route?.page);

export function NavigationProvider({children}:{children:ReactNode}){
  const [route,setRoute]=useState<Route>(()=>isHistory(history.state)?history.state.route:initialRoute());
  const routeRef=useRef(route);const layers=useRef<BackLayer[]>([]);const initialized=useRef(false);
  const update=useCallback((next:Route)=>{routeRef.current=next;setRoute(next);},[]);
  useEffect(()=>{
    if(!initialized.current){
      initialized.current=true;
      if(!isHistory(history.state)){history.replaceState({app:'demo-hotel',kind:'guard',route:routeRef.current} satisfies AppHistory,'',url(routeRef.current));history.pushState({app:'demo-hotel',kind:'route',route:routeRef.current} satisfies AppHistory,'',url(routeRef.current));}
      else history.replaceState({app:'demo-hotel',kind:'route',route:routeRef.current} satisfies AppHistory,'',url(routeRef.current));
    }
    const pop=(event:PopStateEvent)=>{
      const target=event.state;
      const top=layers.current.pop();
      if(top){
        const result=top.close();
        if(result===false){layers.current.push(top);history.pushState({app:'demo-hotel',kind:'layer',route:routeRef.current,layerId:top.id} satisfies AppHistory,'',url(routeRef.current));return;}
        if(isHistory(target)&&target.kind==='layer'&&!layers.current.some(layer=>layer.id===target.layerId))history.replaceState({app:'demo-hotel',kind:'route',route:routeRef.current} satisfies AppHistory,'',url(routeRef.current));
        if(isHistory(target)&&target.kind!=='guard')update(target.route);
        else history.pushState({app:'demo-hotel',kind:'route',route:routeRef.current} satisfies AppHistory,'',url(routeRef.current));
        return;
      }
      if(!isHistory(target)||target.kind==='guard'){
        history.pushState({app:'demo-hotel',kind:'route',route:routeRef.current} satisfies AppHistory,'',url(routeRef.current));
        window.dispatchEvent(new CustomEvent('workspace-root-back'));
        return;
      }
      if(target.kind==='layer'||sameRoute(routeRef.current,target.route)){history.back();return;}
      update(target.route);
    };
    const hash=()=>{const page=location.hash.slice(1) as Page;if(pages.includes(page)&&page!==routeRef.current.page){const next={page,orderId:null};history.replaceState({app:'demo-hotel',kind:'route',route:next} satisfies AppHistory,'',url(next));update(next);}};
    window.addEventListener('popstate',pop);window.addEventListener('hashchange',hash);
    return()=>{window.removeEventListener('popstate',pop);window.removeEventListener('hashchange',hash);};
  },[update]);
  const navigate=useCallback((page:Page,orderId:string|null=null,replace=false)=>{
    const next={page,orderId};const hadLayers=layers.current.length>0;const closing=layers.current.splice(0).reverse();closing.forEach(layer=>layer.close());
    if(sameRoute(routeRef.current,next)){if(hadLayers)history.replaceState({app:'demo-hotel',kind:'route',route:next} satisfies AppHistory,'',url(next));return;}
    const state:AppHistory={app:'demo-hotel',kind:'route',route:next};
    if(replace||hadLayers)history.replaceState(state,'',url(next));else history.pushState(state,'',url(next));update(next);window.scrollTo({top:0,behavior:'instant'});
  },[update]);
  const registerLayer=useCallback((key:string,close:()=>unknown)=>{
    const id=`${key}-${Date.now()}-${Math.random().toString(36).slice(2)}`;layers.current.push({id,close});history.pushState({app:'demo-hotel',kind:'layer',route:routeRef.current,layerId:id} satisfies AppHistory,'',url(routeRef.current));
    return()=>{const found=layers.current.findIndex(layer=>layer.id===id);if(found<0)return;layers.current.splice(found,1);if(isHistory(history.state)&&history.state.layerId===id)history.replaceState({app:'demo-hotel',kind:'route',route:routeRef.current} satisfies AppHistory,'',url(routeRef.current));};
  },[]);
  const back=useCallback(()=>history.back(),[]);
  return <NavigationContext.Provider value={{route,navigate,back,registerLayer}}>{children}</NavigationContext.Provider>;
}
export function useNavigation(){const navigation=useContext(NavigationContext);if(!navigation)throw new Error('Navigation provider is unavailable.');return navigation;}
export function useBackLayer(open:boolean,onClose:()=>unknown,key:string){const navigation=useContext(NavigationContext);const close=useRef(onClose);close.current=onClose;useEffect(()=>{if(!open||!navigation)return;return navigation.registerLayer(key,()=>close.current());},[open,key,navigation?.registerLayer]);}
