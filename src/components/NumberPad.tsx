import {useEffect,useState} from 'react';
import {Delete} from 'lucide-react';
import {Modal} from './ui';
import '../styles/numpad.css';

export default function NumberPad({title,value,decimal=false,min=0,max=10000000,onClose,onConfirm}:{title:string;value:string;decimal?:boolean;min?:number;max?:number;onClose:()=>void;onConfirm:(value:string)=>void}){
  const [text,setText]=useState(value),[replace,setReplace]=useState(true),[error,setError]=useState('');
  function key(key:string){setError('');if(key==='clear'){setText('');setReplace(false);return;}if(key==='back'){setText(previous=>previous.slice(0,-1));setReplace(false);return;}
    setText(previous=>{let next=replace?'':previous;if(key==='.'){if(!decimal)return previous;if(next.includes('.'))return next;return next?next+'.':'0.';}if(next.includes('.')&&next.split('.')[1].length>=2||next.length>=12)return next;return next==='0'?key:next+key;});setReplace(false);
  }
  function confirm(){const amount=Number(text);if(text===''||!Number.isFinite(amount)||amount<min||amount>max||!decimal&&!Number.isInteger(amount)){setError(`Enter ${decimal?'an amount':'a whole number'} from ${min} to ${max}.`);return;}onConfirm(text);}
  useEffect(()=>{const handler=(event:KeyboardEvent)=>{if(event.ctrlKey||event.metaKey||event.altKey)return;if(/^[0-9.]$/.test(event.key)){event.preventDefault();key(event.key);}else if(event.key==='Backspace'){event.preventDefault();key('back');}else if(event.key==='Enter'){event.preventDefault();confirm();}};window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);});
  return <Modal title={title} subtitle="Tap the large keys or use your keyboard." onClose={onClose}><div className="number-pad"><output aria-label={title}>{text||'0'}</output><div className="number-pad-grid">{['7','8','9','4','5','6','1','2','3',decimal?'.':'clear','0','back'].map(value=><button type="button" key={value} aria-label={value==='back'?'Backspace':value==='clear'?'Clear':value} onClick={()=>key(value)}>{value==='back'?<Delete size={24}/>:value==='clear'?'C':value}</button>)}</div>{error&&<div className="error-message" role="alert">{error}</div>}<div className="number-pad-actions"><button className="button" type="button" onClick={()=>key('clear')}>Clear</button><button className="button button-primary" type="button" onClick={confirm}>Apply</button></div></div></Modal>;
}
