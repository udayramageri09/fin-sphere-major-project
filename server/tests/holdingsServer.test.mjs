// Real API + PostgreSQL isolation, persistence, validation, zero values and idempotent schema.
// Creates only finsphere_holdings_<pid>; never connects to the faculty demo database.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serverDir = path.join(repo, 'server');
const require = createRequire(path.join(serverDir,'package.json'));
const {Client} = require('pg');
const dotenv = require('dotenv');
const baseUrl = process.env.DATABASE_URL ?? dotenv.parse(fs.readFileSync(path.join(serverDir,'.env'))).DATABASE_URL;
const urlFor = db => { const u=new URL(baseUrl); u.pathname='/'+db; return u.toString(); };
const db = `finsphere_holdings_${process.pid}`;
assert.match(db,/^finsphere_holdings_\d+$/);
const admin = new Client({connectionString:urlFor('postgres')});
await admin.connect();
await admin.query(`CREATE DATABASE ${db}`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'finsphere-holdings-'));
// No env file, legacy datasets, profile images, or uploads copied into this isolated app.
for(const entry of fs.readdirSync(serverDir)) if(entry.endsWith('.js') || entry==='package.json') fs.copyFileSync(path.join(serverDir,entry),path.join(dir,entry));
fs.cpSync(path.join(serverDir,'db'),path.join(dir,'db'),{recursive:true});
fs.symlinkSync(path.join(serverDir,'node_modules'),path.join(dir,'node_modules'),'junction');
const port=5198, base=`http://localhost:${port}/api`;
let child, vite, logs='', direct;
const env={...process.env,DATABASE_URL:urlFor(db),DATABASE_SSL:'false',PORT:String(port),JWT_SECRET:'h'.repeat(40),GROQ_API_KEY:'',PASSWORD_RESET_DELIVERY:'',RESEND_API_KEY:'',PASSWORD_RESET_FROM:'',PASSWORD_RESET_URL:'',CORS_ORIGINS:'http://localhost:5298'};
for(const k of ['NODE_ENV','TRUST_PROXY','FINSPHERE_TEST_UPLOAD_LIMIT']) delete env[k];
async function start() {
 child=spawn(process.execPath,['server.js'],{cwd:dir,env,stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>logs+=d); child.stderr.on('data',d=>logs+=d);
 for(let i=0;i<80;i++){try{await fetch(base+'/auth/verify');return;}catch{await sleep(250);}}
 throw new Error(logs);
}
async function stop(p) { if(p && p.exitCode===null){p.kill();await new Promise(r=>p.once('exit',r));} }
const call=async(cookie,method,p,body)=>{
 const r=await fetch(base+p,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const text=await r.text(); return {status:r.status,data:text?JSON.parse(text):null,cookie:r.headers.get('set-cookie')?.split(';')[0]};
};
let checks=0;
const check=(value,message)=>{assert.ok(value,message);checks++;};
try {
 await start();
 const account=async tag=>{const body={email:`holdings-${tag}@example.com`,password:'Holdings-test-pass-123!'};check((await call(null,'POST','/auth/register',body)).status===200,'register');return (await call(null,'POST','/auth/login',body)).cookie;};
 const a=await account('a'),b=await account('b');
 check(!!a&&!!b,'sessions issued');
 check((await call(null,'GET','/holdings')).status===401,'anonymous read rejected');
 check((await call(null,'POST','/holdings',{})).status===401,'anonymous write rejected');
 check((await call('token=forged','GET','/holdings')).status===401,'forged session rejected');
 check((await call(a,'GET','/holdings')).data.length===0,'new account empty');
 const holding={name:'Test index fund',assetClass:'Mutual funds',investedPaise:1000050,currentPaise:1200075,valuedOn:new Date().toISOString().slice(0,10)};
 let r=await call(a,'POST','/holdings',holding);check(r.status===201,'created');const id=r.data.id;
 check(r.data.investedPaise===1000050&&r.data.currentPaise===1200075,'paise preserved');
 check((await call(b,'GET','/holdings')).data.length===0,'other account empty');
 check((await call(b,'PUT',`/holdings/${id}`,holding)).status===404,'cross-owner update rejected');
 check((await call(b,'DELETE',`/holdings/${id}`)).status===404,'cross-owner delete rejected');
 check((await call(a,'PUT','/holdings/not-an-id',holding)).status===404,'invalid id safely rejected');
 for(const field of [null,[],{}, {...holding,ownerId:3},{...holding,name:''},{...holding,name:'a\nb'},{...holding,name:'x'.repeat(101)},{...holding,assetClass:'Made up'},{...holding,currentPaise:-1},{...holding,currentPaise:1.1},{...holding,currentPaise:'500'},{...holding,investedPaise:1e12+1},{...holding,valuedOn:'2026-02-30'},{...holding,valuedOn:'2099-01-01'},{...holding,valuedOn:'0000-01-01'}]) {
   check((await call(a,'POST','/holdings',field)).status===400,'bad create rejected');
   check((await call(a,'PUT',`/holdings/${id}`,field)).status===400,'bad update rejected');
 }
 check((await call(a,'GET','/holdings')).data.length===1,'invalid requests did not insert');
 r=await call(a,'PUT',`/holdings/${id}`,{...holding,currentPaise:0});check(r.status===200&&r.data.currentPaise===0,'zero is real value');
 direct=new Client({connectionString:urlFor(db)});await direct.connect();
 await direct.query(fs.readFileSync(path.join(serverDir,'db/schema.sql'),'utf8'));
 check((await call(a,'GET','/holdings')).data[0].currentPaise===0,'schema reapplication preserves records');
 await stop(child);await start();
 check((await call(a,'GET','/holdings')).data[0].name===holding.name,'restart persists holdings');
 check((await call(a,'DELETE',`/holdings/${id}`)).status===204,'owner deletes');
 check((await call(a,'DELETE',`/holdings/${id}`)).status===404,'repeat delete missing');
 check((await call(a,'GET','/holdings')).data.length===0,'delete persists');
 console.log(`Holdings API: ${checks} checks passed (${db}).`);
 if(process.argv.includes('--browser')) {
   const today=new Date(); const date=(m,d)=>new Date(today.getFullYear(),today.getMonth()-m,d).toLocaleDateString('en-CA');
   for(let m=0;m<6;m++) for(const [title,amount,category,classification] of [['Payroll',60000,'Salary','income'],['Groceries',-6000-m*200,'Food','expense'],['Rent',-14000,'Bills','expense'],['Train',-1500-m*100,'Travel','expense'],['Shopping',-2300-m*80,'Shopping','expense']]) {
    await call(a,'POST','/transactions',{title,amount,category,classification,date:date(m,1),type:amount<0?'expense':'income'});
   }
   vite=spawn(process.execPath,[path.join(repo,'node_modules/vite/bin/vite.js'),'--host','localhost','--port','5298','--strictPort'],{cwd:repo,env:{...env,VITE_API_URL:base},stdio:['ignore','pipe','pipe']});
   vite.stdout.on('data',d=>process.stdout.write(d));vite.stderr.on('data',d=>process.stderr.write(d));
   console.log('Browser fixture ready: http://localhost:5298; synthetic user holdings-a@example.com / Holdings-test-pass-123!');
   console.log('Send a newline to finish browser verification and drop the isolated database.');
   await new Promise(r=>process.stdin.once('data',r));
 }
} finally {
 await stop(vite);await stop(child);if(direct)await direct.end();
 await admin.query(`DROP DATABASE ${db} WITH (FORCE)`);await admin.end();
 // Junction and temp copy contain only disposable test files; leave to OS temp cleanup.
 console.log('Isolated holdings database dropped.');
}
