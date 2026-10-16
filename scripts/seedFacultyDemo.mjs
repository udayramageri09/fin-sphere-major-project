import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { facultyDemoData, DEMO_EMAIL, DEMO_NAME } from './facultyDemoData.mjs';

// Uses the normal authenticated API. Never drops tables, resets data, or seeds other users.
export async function seedFacultyDemo({base='http://localhost:5000/api',password=process.env.FACULTY_DEMO_PASSWORD || 'FacultyDemo@2026!',request=fetch,now=new Date()}={}) {
  const url = new URL(base);
  if (url.protocol!=='http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password || url.pathname!=='/api' || url.search || url.hash) throw new Error('Faculty demo seeding is restricted to a local HTTP API at /api.');
  let cookie='',userId;
  const call=async(path,method='GET',body)=>{
    const res=await request(`${url.href.replace(/\/$/,'')}${path}`,{method,redirect:'error',signal:AbortSignal.timeout(15_000),headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(userId?{'X-FinSphere-User':String(userId)}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const setCookie=res.headers?.get('set-cookie');
    if(setCookie) cookie=setCookie.split(';')[0];
    const data=await res.json().catch(()=>({}));
    return {ok:res.ok,status:res.status,data};
  };
  const must=async(...args)=>{const response=await call(...args);if(!response.ok)throw new Error(`Demo setup stopped at ${args[0]} (HTTP ${response.status}). Existing records were not removed; rerun to resume.`);return response.data;};
  let login=await call('/auth/login','POST',{email:DEMO_EMAIL,password});
  let created=false;
  if(login.status===401){
    await must('/auth/register','POST',{email:DEMO_EMAIL,password});
    created=true;
    login=await call('/auth/login','POST',{email:DEMO_EMAIL,password});
  }
  if(!login.ok || login.data.user?.email!==DEMO_EMAIL || !cookie) throw new Error('Could not sign in to the dedicated faculty demo account. Check the API and FACULTY_DEMO_PASSWORD. No account was reset.');
  userId=login.data.user.id;
  if(!Number.isSafeInteger(userId) || userId<=0) throw new Error('The API did not return a valid demo account identifier.');
  if(created) await must('/auth/profile','PATCH',{displayName:DEMO_NAME});
  else if(login.data.user.displayName!==DEMO_NAME) throw new Error('The existing account does not have the faculty demo label. Refusing to seed it.');
  const sample=facultyDemoData(now);
  let added=0;
  for(const [path,items,key] of [['/transactions',sample.transactions,row=>`${row.title}|${row.date}`],['/goals',sample.goals,row=>row.title],['/liabilities',sample.liabilities,row=>row.name],['/holdings',sample.holdings,row=>row.name]]){
    const existing=await must(path);
    if(!Array.isArray(existing)) throw new Error(`Unexpected ${path} response; stopped without removing data.`);
    const seen=new Set(existing.map(key));
    for(const item of items){if(seen.has(key(item)))continue;await must(path,'POST',item);seen.add(key(item));added++;}
  }
  const fund=await must('/emergency-fund');
  if(!fund.configured) {await must('/emergency-fund','PUT',sample.emergencyFund);added++;}
  return {email:DEMO_EMAIL,added,transactionCount:sample.transactions.length};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try {
    const result=await seedFacultyDemo();
    console.log(`Faculty demo ready: ${result.email}. ${result.added} new records added.\nOpen http://localhost:5173 or http://localhost:5174 and sign in.\nPassword: ${process.env.FACULTY_DEMO_PASSWORD?'the FACULTY_DEMO_PASSWORD you supplied':'FacultyDemo@2026!'}\nAll seeded records are synthetic and labelled [Demo].`);
  } catch(error){console.error(error.message);process.exitCode=1;}
}
