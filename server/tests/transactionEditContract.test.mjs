import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
const normalization=source.slice(source.indexOf('const MAX_TITLE_LENGTH ='),source.indexOf('// Runs importer candidates'));
const route=source.slice(source.indexOf("app.put('/api/transactions/:id'"),source.indexOf('// ── Goals'));
let registered, writes=[], result={id:'t',userId:7,amount:-12.34}, failure=null;
const authenticate=()=>{}, limiter=()=>{};
new Function('app','authenticate','categoryEditLimiter','updateTransactionByUserAndId','respondDbError',normalization+`\nconst MAX_CATEGORY_LENGTH=60;\n`+route)({put(...args){registered=args;}},authenticate,limiter,async(...args)=>{writes.push(args);if(failure)throw failure;return result;},res=>res.status(500).json({error:'Could not save the transaction'}));
const fields={title:'Expense',amount:'12.34',date:'2026-10-05',type:'expense',category:'Craft',classification:'expense'};
async function call(body){writes=[];const res={code:200,status(code){this.code=code;return this;},json(json){this.body=json;return this;}};await registered.at(-1)({body,user:{id:7},params:{id:'t'}},res);return res;}
test('full edit registers authentication and rate limiting',()=>{assert.equal(registered[1],authenticate);assert.equal(registered[2],limiter);});
test('full edit refuses malformed bodies, unknown keys and ownership fields before writing',async()=>{
 for(const body of [null,[],{},'x',{...fields,userId:9},{...fields,id:'x'},{...fields,createdAt:'x'}]){assert.equal((await call(body)).code,400);assert.equal(writes.length,0);}
});
test('full edit uses existing monetary, date and classification validation',async()=>{
 for(const change of [{amount:0},{amount:'1e3'},{amount:Infinity},{amount:100000001},{date:'2026-02-30'},{title:''},{classification:'income'},{category:'x'.repeat(61)},{category:'bad\nlabel'}]){assert.equal((await call({...fields,...change})).code,400);assert.equal(writes.length,0);}
});
test('full edit stamps verified owner, normalizes direction and returns saved row',async()=>{
 assert.equal((await call(fields)).code,200);assert.equal(writes[0][0],7);assert.equal(writes[0][1],'t');assert.equal(writes[0][2].amount,-12.34);
 await call({...fields,type:'income',classification:'refund'});assert.equal(writes[0][2].amount,12.34);assert.equal(writes[0][2].classification,'refund');
});
test('missing rows and database failures return errors',async()=>{result=null;assert.equal((await call(fields)).code,404);failure=Error('database');assert.equal((await call(fields)).code,500);failure=null;});
const dbSource=fs.readFileSync(new URL('../db/index.js',import.meta.url),'utf8');
const fn=dbSource.slice(dbSource.indexOf('export async function updateTransactionByUserAndId')).replace('export ','');
test('database update scopes both lookup and write to owner and serializes with imports',async()=>{
 const calls=[];let released=false;
 const client={async query(sql,args){calls.push({sql,args});return {rows:sql.startsWith('UPDATE')?[{id:'t'}]:[]};},release(){released=true;}};
 const update=new Function('pool','TX_COLUMNS','toTransaction',fn+';return updateTransactionByUserAndId;')({connect:async()=>client},'id',row=>row);
 assert.deepEqual(await update(7,'t',{...fields,amount:-12.34}),{id:'t'});
 assert.equal(calls[0].sql,'BEGIN');assert.match(calls[2].sql,/pg_advisory_xact_lock/);assert.deepEqual(calls[2].args,['finsphere:import:7']);
 assert.match(calls[3].sql,/WHERE user_id=\$1 AND id=\$2/);assert.match(calls[3].sql,/AND user_id=\$1/);assert.match(calls[3].sql,/ORDER BY seq DESC LIMIT 1/);
 assert.deepEqual(calls[3].args,[7,'t','Expense',-12.34,'2026-10-05','expense','Craft','expense']);assert.equal(calls[4].sql,'COMMIT');assert.equal(released,true);
});
test('database update rolls back and releases on failure',async()=>{
 const calls=[];let released=false;
 const client={async query(sql){calls.push(sql);if(sql.startsWith('UPDATE'))throw Error('failed');return {rows:[]};},release(){released=true;}};
 const update=new Function('pool','TX_COLUMNS','toTransaction',fn+';return updateTransactionByUserAndId;')({connect:async()=>client},'id',r=>r);
 await assert.rejects(update(7,'t',fields),/failed/);assert.equal(calls.at(-1),'ROLLBACK');assert.equal(released,true);
});
