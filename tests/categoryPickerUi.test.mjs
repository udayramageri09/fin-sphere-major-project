import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {createServer} from 'vite';
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/',pretendToBeVisual:true});
for(const name of ['window','document','navigator'])Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {default:React,act}=await import('react');const {createRoot}=await import('react-dom/client');
let calls=[],saved=[];
globalThis.__categoryFinance={transactions:[],loading:false,addTransaction:async row=>{saved.push(row);globalThis.__categoryFinance.transactions.push({...row,id:'saved1',userId:1});}};
const vite=await createServer({server:{middlewareMode:true},appType:'custom',logLevel:'error',plugins:[{name:'category-finance',enforce:'pre',resolveId(id){if(id.endsWith('/context/FinanceContext'))return '\0category-finance';},load(id){if(id==='\0category-finance')return 'export const useFinance=()=>globalThis.__categoryFinance;';}}]});
const container=document.getElementById('root');let root=createRoot(container),checks=0;
const check=(v,m)=>{assert.ok(v,m);checks++;};
const click=async text=>{const b=[...container.querySelectorAll('button')].find(e=>e.textContent===text);assert.ok(b,text);await act(async()=>b.click());};
const type=async(e,value)=>act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(e,value);e.dispatchEvent(new window.Event('input',{bubbles:true}));});
try{
 const {default:Picker}=await vite.ssrLoadModule('/src/components/CategoryPicker.jsx');
 function Harness(){const[value,setValue]=React.useState('Food');return React.createElement(Picker,{label:'Category',choices:['Food','Investment'],value,onChange:name=>{calls.push(name);setValue(name);}});}
 await act(async()=>root.render(React.createElement(Harness)));
 await click('+ New category');check(document.activeElement===container.querySelector('input'),'new name receives focus');
 await type(container.querySelector('input'),'  Hobbies & crafts  ');await click('Use category');
 check(calls.at(-1)==='Hobbies & crafts'&&container.querySelector('select').value==='Hobbies & crafts','trimmed custom label selected');
 await click('+ New category');await type(container.querySelector('input'),'food');await click('Use category');
 check(calls.at(-1)==='Food','case-insensitive duplicate reuses existing category');
 check([...container.querySelectorAll('option')].filter(o=>o.value.toLowerCase()==='food').length===1,'no duplicate option');
 for(const invalid of ['   ','x\u202ey','x'.repeat(61)]){await click('+ New category');await type(container.querySelector('input'),invalid);const n=calls.length;await click('Use category');check(calls.length===n&&!!container.querySelector('[role=alert]'),'invalid category rejected');await click('Cancel');}
 await click('+ New category');await type(container.querySelector('input'),'Cancelled category');await click('Cancel');
 check(![...container.querySelectorAll('option')].some(o=>o.value==='Cancelled category'),'cancel does not create');
 await act(async()=>root.unmount());root=createRoot(container);
 const {default:Transactions}=await vite.ssrLoadModule('/src/pages/Transactions.jsx');
 await act(async()=>root.render(React.createElement(Transactions)));
 await click('+ New category');await type(container.querySelector('.category-create-editor input'),'Alternative investment');await click('Use category');
 const form=[...container.querySelectorAll('form')].find(f=>f.querySelector('input[type=number]'));await type(form.querySelector('input[type=text]'),'Sample alternative asset purchase');await type(form.querySelector('input[type=number]'),'1250.50');
 await act(async()=>form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true})));
 check(saved.length===1&&saved[0].category==='Alternative investment','manual save sends the custom category through the existing transaction path');
 check(saved[0].amount===-1250.50&&saved[0].classification==='expense','custom category does not change amount or financial classification');
 await act(async()=>root.unmount());root=createRoot(container);await act(async()=>root.render(React.createElement(Transactions)));
 check([...container.querySelectorAll('.category-picker option')].some(o=>o.value==='Alternative investment'),'saved account label is available after remount');
 check(!container.textContent.includes('Unclassified'),'standalone unclassified wording removed');
 console.log(`Custom categories UI: ${checks} checks passed`);
}finally{await act(async()=>root.unmount());await vite.close();dom.window.close();delete globalThis.__categoryFinance;}
