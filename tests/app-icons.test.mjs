import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { AppIconCache, appIconKey, validatePngIcon, MAX_ICON_BATCH, MAX_ICON_DATA_URL_LENGTH } from '../src/appIcons.ts';
function crc32(data) {
 let result=0xffffffff;
 for(const byte of data){result^=byte;for(let bit=0;bit<8;bit++)result=(result>>>1)^((result&1)?0xedb88320:0);}
 return (result^0xffffffff)>>>0;
}
function png(size=64,color=0){
 const chunk=(name,data)=>{const type=Buffer.from(name);const length=Buffer.alloc(4);length.writeUInt32BE(data.length);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([type,data])));return Buffer.concat([length,type,data,crc]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
 const pixels=Buffer.alloc(size*(size*4+1));pixels[1]=color;pixels[4]=255;
 return 'data:image/png;base64,'+Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
const icon=png();
const source=index=>({path:`C:\\Apps\\app-${index}.exe`});
const reply=(requests,value=icon)=>Object.fromEntries(requests.map(request=>[request.id,value]));
test('icon keys follow Windows identity and include shortcut location',()=>{
 assert.equal(appIconKey({path:'C:/Apps/QQ.exe'}),appIconKey({path:'c:\\apps\\qq.EXE'}));
 assert.equal(appIconKey({path:String.raw`\\?\C:\Apps\QQ.exe`}),appIconKey({path:'C:\\Apps\\QQ.exe'}));
 assert.notEqual(appIconKey({path:'C:\\Apps\\QQ.exe',iconShortcut:'C:\\Links\\QQ.lnk'}),appIconKey({path:'C:\\Apps\\QQ.exe'}));
 assert.notEqual(appIconKey(source(1)),appIconKey(source(2)));
});
test('only bounded 64px PNG data URLs enter the display cache',()=>{
 assert.equal(validatePngIcon(icon),icon);
 for(const value of [null,'https://example.com/icon.png','data:image/svg+xml,<svg/>',icon.replace('image/png','image/jpeg'),icon+' ',png(32),'data:image/png;base64,'+'A'.repeat(MAX_ICON_DATA_URL_LENGTH)])assert.equal(validatePngIcon(value),null);
});
test('the cache stays lazy until an application is requested',async()=>{
 let calls=0;const cache=new AppIconCache(async requests=>{calls++;return reply(requests);});
 const unsubscribe=cache.subscribe(appIconKey(source(1)),()=>{});await cache.flush();assert.equal(calls,0);unsubscribe();
});
test('requests share batches capped at 32 and deduplicate Windows paths',async()=>{
 const batches=[];const cache=new AppIconCache(async requests=>{batches.push(requests);return reply(requests);});
 for(let index=0;index<77;index++){cache.request(source(index));cache.request({path:source(index).path.toUpperCase()});}await cache.flush();
 assert.equal(MAX_ICON_BATCH,32);assert.deepEqual(batches.map(batch=>batch.length),[32,32,13]);
 assert.equal(new Set(batches.flat().map(request=>request.id)).size,77);assert.equal(cache.get(appIconKey(source(76))),icon);
});
test('missing icons are cached until explicit refresh',async()=>{
 let calls=0;const cache=new AppIconCache(async requests=>{calls++;return reply(requests,null);});
 cache.request(source(1));await cache.flush();cache.request(source(1));await cache.flush();assert.equal(calls,1);assert.equal(cache.get(appIconKey(source(1))),null);
 cache.reset();cache.request(source(1));await cache.flush();assert.equal(calls,2);
});
test('a failed batch does not block remaining applications',async()=>{
 let calls=0;const cache=new AppIconCache(async requests=>{if(++calls===1)throw Error('extract failed');return reply(requests);});
 for(let index=0;index<35;index++)cache.request(source(index));await cache.flush();assert.equal(calls,2);
 assert.equal(cache.get(appIconKey(source(0))),null);assert.equal(cache.get(appIconKey(source(34))),icon);
});
test('refresh clears native cache even with no visible applications',async()=>{
 const calls=[];const cache=new AppIconCache(async(requests,refresh)=>{calls.push({requests,refresh});return reply(requests);});
 cache.reset();await cache.flush();assert.deepEqual(calls,[{requests:[],refresh:true}]);
});
test('late results never replace the refreshed generation',async()=>{
 let completeOld,firstRequests,calls=0;const fresh=png(64,200);const observed=[];
 const cache=new AppIconCache(async requests=>{if(++calls===1){firstRequests=requests;return await new Promise(resolve=>{completeOld=resolve;});}return reply(requests,fresh);});
 cache.subscribe(appIconKey(source(1)),()=>observed.push(cache.get(appIconKey(source(1)))));
 cache.request(source(1));const pending=cache.flush();cache.reset();cache.request(source(1));completeOld(reply(firstRequests));await pending;
 assert.equal(cache.get(appIconKey(source(1))),fresh);assert.equal(observed.includes(icon),false);assert.equal(calls,2);
});
test('changed shortcut hints are separate without mutating selections',async()=>{
 const requests=[];const entry={...source(1),id:'user-app',name:'User name',processes:['QQ.exe'],warnings:[],source:'manual',running:false};const before=JSON.stringify(entry);
 const cache=new AppIconCache(async batch=>{requests.push(...batch);return reply(batch);});cache.request(entry);cache.request({...entry,iconShortcut:'C:\\Links\\Custom.lnk'});await cache.flush();
 assert.equal(requests.length,2);assert.equal(requests[1].shortcutPath,'C:\\Links\\Custom.lnk');assert.equal(JSON.stringify(entry),before);
 assert.equal('name' in requests[0],false);assert.equal('processes' in requests[0],false);
});
test('malformed responses fall back and notify subscribers',async()=>{
 let notifications=0;const cache=new AppIconCache(async requests=>reply(requests,'data:image/svg+xml,<svg/>'));
 const unsubscribe=cache.subscribe(appIconKey(source(1)),()=>notifications++);cache.request(source(1));await cache.flush();
 assert.equal(cache.get(appIconKey(source(1))),null);assert.equal(notifications,1);unsubscribe();cache.reset();await cache.flush();assert.equal(notifications,1);
});
test('display cache bounds memory independently of app entries',async()=>{
 const cache=new AppIconCache(async requests=>reply(requests),2);cache.request(source(1));cache.request(source(2));cache.request(source(3));await cache.flush();
 assert.equal(cache.get(appIconKey(source(1))),undefined);assert.equal(cache.get(appIconKey(source(2))),icon);assert.equal(cache.get(appIconKey(source(3))),icon);
});
