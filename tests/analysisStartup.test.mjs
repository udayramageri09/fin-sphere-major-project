import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of ['window','document','navigator']) Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const {default:React,act} = await import('react');
const {createRoot} = await import('react-dom/client');
const vite = await createServer({configFile:false,appType:'custom',logLevel:'error',server:{middlewareMode:true,hmr:false,ws:false},optimizeDeps:{noDiscovery:true,include:[]},esbuild:{jsx:'automatic'},plugins:[{name:'startup-fixture',enforce:'pre',resolveId(id){if(id.endsWith('/context/FinanceContext'))return '\0finance';if(id.endsWith('/context/AuthContext'))return '\0auth';},load(id){if(id==='\0finance')return 'const transactions=[{id:1}]; export const useFinance=()=>({transactions,setCurrentView:()=>{},currentView:"plans"});';if(id==='\0auth')return 'export const useAuth=()=>({user:{id:17}});';}}]});
let requests = 0, aborted = 0;
globalThis.fetch = async (_url,init={}) => {
  requests++;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>resolve({ok:true,json:async()=>({metadata:{errors:{}},plan:{steps:[]}})}),30);
    init.signal.addEventListener('abort',()=>{clearTimeout(timer);aborted++;reject(new DOMException('Aborted','AbortError'));},{once:true});
  });
};
const root=createRoot(document.getElementById('root'));
try {
  const {default:Plans}=await vite.ssrLoadModule('/src/pages/Plans.jsx');
  await act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(Plans))));
  await act(async()=>new Promise(r=>setTimeout(r,120)));
  assert.equal(requests,2,'StrictMode must replace the aborted first request');
  assert.equal(aborted,1,'the discarded startup request is cancelled');
  assert.equal(document.querySelector('.ml-loading'),null,'spinner settles');
  assert.ok(document.querySelector('.state-card'),'analysis results are rendered');
  assert.equal(document.querySelector('#forecast-period').disabled,false,'controls recover');
  await act(async()=>root.render(null));
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn,ms,...args) => nativeSetTimeout(fn,ms===75_000 ? 5 : ms,...args);
  try {
    await act(async()=>root.render(React.createElement(Plans)));
    await act(async()=>new Promise(r=>nativeSetTimeout(r,80)));
    assert.match(document.querySelector('[role=alert]').textContent,/taking too long/,'timeout produces a recoverable error');
    assert.equal(document.querySelector('.ml-loading'),null,'timeout clears spinner');
    assert.equal(document.querySelector('#forecast-period').disabled,false,'timeout restores controls');
  } finally { globalThis.setTimeout=nativeSetTimeout; }
  console.log('Analysis startup: 8 regression checks passed (StrictMode and timeout)');
} finally {await act(async()=>root.unmount());await vite.close();dom.window.close();}
