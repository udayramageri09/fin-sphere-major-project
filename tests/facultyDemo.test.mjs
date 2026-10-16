import assert from 'node:assert/strict';
import { facultyDemoData, DEMO_EMAIL, DEMO_NAME } from '../scripts/facultyDemoData.mjs';
import { seedFacultyDemo } from '../scripts/seedFacultyDemo.mjs';
import { developmentOrigins } from '../server/runtimeConfig.js';
const now=new Date('2026-10-17T06:00:00Z');
const sample=facultyDemoData(now);
assert.equal(sample.transactions.length,97);
assert.equal(new Set(sample.transactions.map(t=>t.date.slice(0,7))).size,12);
assert.ok(sample.transactions.every(t=>t.date<='2026-10-17' && ['income','expense','transfer'].includes(t.classification)));
assert.equal(new Set(sample.transactions.map(t=>t.title+'|'+t.date)).size,97);
assert.deepEqual(developmentOrigins(false),['http://localhost:5173','http://localhost:5174']);
assert.deepEqual(developmentOrigins(true),[],'production has no implicit origins');

function fixture() {
  const lists={'/transactions':[],'/goals':[],'/liabilities':[],'/holdings':[]};
  let user=null,fund={configured:false},failGoal=false;
  let requests=0;
  const response=(status,data,cookie=false)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json',...(cookie?{'set-cookie':'token=synthetic-test-token; HttpOnly'}:{})}});
  const request=async(url,init)=>{
    requests++;
    const path=new URL(url).pathname.slice(4),body=init.body?JSON.parse(init.body):null;
    assert.ok(!['DELETE'].includes(init.method));
    if(path==='/auth/register') {assert.equal(body.email,DEMO_EMAIL);assert.equal(user,null);user={id:777,email:DEMO_EMAIL,displayName:''};return response(200,{});}
    if(path==='/auth/login') return user?response(200,{user},true):response(401,{});
    assert.equal(init.headers['X-FinSphere-User'],'777');
    assert.equal(init.headers.Cookie,'token=synthetic-test-token');
    if(path==='/auth/profile'){assert.deepEqual(body,{displayName:DEMO_NAME});user={...user,...body};return response(200,{user});}
    if(path==='/emergency-fund'){if(init.method==='PUT')fund={configured:true,...body};return response(200,fund);}
    assert.ok(Object.hasOwn(lists,path),path);
    if(init.method==='POST'){
      if(path==='/goals' && failGoal){failGoal=false;return response(503,{});}
      lists[path].push({...body,id:String(lists[path].length+1)});
      return response(201,lists[path].at(-1));
    }
    assert.equal(init.method,'GET');return response(200,lists[path]);
  };
  return {lists,request,failGoal:()=>{failGoal=true;},requests:()=>requests};
}
const store=fixture();
const first=await seedFacultyDemo({request:store.request,now});
assert.equal(first.added,103);
assert.equal(first.email,DEMO_EMAIL);
store.lists['/transactions'][0].amount=99999;
const second=await seedFacultyDemo({request:store.request,now});
assert.equal(second.added,0,'repeated seeding is idempotent');
assert.equal(store.lists['/transactions'][0].amount,99999,'existing edits are preserved');
const partial=fixture();partial.failGoal();
await assert.rejects(seedFacultyDemo({request:partial.request,now}),/Demo setup stopped/);
await seedFacultyDemo({request:partial.request,now});
assert.equal(partial.lists['/transactions'].length,97,'resume does not duplicate completed writes');
const before=store.requests();
await assert.rejects(seedFacultyDemo({base:'https://external.example/api',request:store.request,now}),/restricted/);
assert.equal(store.requests(),before,'remote destinations are refused before sending credentials');
console.log('Faculty demo: dataset, authentication, account scope, repeatability, resume, local-only destinations, both dev ports passed');
