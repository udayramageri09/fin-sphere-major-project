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

 await act(async()=>root.unmount());root=createRoot(container);
 const {default:PdfImportReview}=await vite.ssrLoadModule('/src/components/PdfImportReview.jsx');
 const {buildPdfDraft}=await import('../src/utils/pdfImportReview.js');
 const initialRows=buildPdfDraft('05.03.2026 ACH DIVIDEND +120.00\n06.03.2026 UNKNOWN PAYER +90.00\n07.03.2026 CREDIT CARD PAYMENT -80.00');
 function PdfHarness(){
   const [rows,setRows]=React.useState(initialRows);
   return React.createElement(PdfImportReview,{
     draft:{rows,fileName:'sample.pdf',warnings:[],text:''}, categories:['Dividends','General'],
     onChange:(id,patch)=>setRows(old=>old.map(row=>row.id===id?{...row,...patch}:row))
   });
 }
 await act(async()=>root.render(React.createElement(PdfHarness)));
 check(container.querySelectorAll('fieldset').length===1&&!container.textContent.includes('ACH DIVIDEND'),'only uncertain rows are shown by default');
 check([...container.querySelectorAll('option')].some(option=>option.textContent==='Choose a category'),'uncertain row has a dropdown placeholder');
 check([...container.querySelectorAll('button')].find(button=>button.textContent==='Import 3 rows').disabled,'conflicting row blocks saving');
 await click('Exclude row');
 check(![...container.querySelectorAll('button')].find(button=>button.textContent==='Import 2 rows').disabled,'prefilled rows can be imported without individual or bulk confirmation');
 await click('All rows (3)');
 check(container.textContent.includes('Auto-confirmed')&&container.textContent.includes('UNKNOWN PAYER'),'all rows identifies auto-confirmed suggestions');
 check([...container.querySelectorAll('option')].some(option=>option.textContent.startsWith('Refund —')),'incoming rows explain refund classification');
 await click('Restore row');
 check([...container.querySelectorAll('button')].find(button=>button.textContent==='Import 3 rows').disabled,'restoring a conflicting row requires review again');
 console.log(`Custom categories UI: ${checks} checks passed`);
}finally{await act(async()=>root.unmount());await vite.close();dom.window.close();delete globalThis.__categoryFinance;}
