'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
// Strict whole-document validation; selected array items are released after the
// synchronous callback. Skipped candidates never become an object graph.
function streamJsonObjectArrays(filePath,{keys,onItem,expectedSha256,expectedBytes,allowNonArrays=false,chunkBytes=64*1024,maxItemChars=16*1024*1024,maxBytes=2*1024**3,maxDepth=256}={}){
 const fail=(code,message)=>{const e=new Error(message);e.code=code;throw e;};
 if(!Array.isArray(keys)||keys.some(k=>typeof k!=='string')||typeof onItem!=='function'||![chunkBytes,maxItemChars,maxBytes,maxDepth].every(n=>Number.isSafeInteger(n)&&n>0)||chunkBytes>1024**2||maxItemChars>32*1024**2)fail('STREAM_JSON_OPTIONS_INVALID','Invalid streaming array options');
 const selected=new Set(keys),seen=new Set(),admittedFields=new Set(),counts=Object.fromEntries(keys.map(k=>[k,0])),stack=[],hash=crypto.createHash('sha256'),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
 let rootDone=false,mode='',isKey=false,escape=false,unicodeLeft=0,fragments=[],scalarChars=0,bytes=0,offset=0,itemStart=null,position=0,retainScalar=false;
 const invalid=message=>fail('FILE_JSON_INVALID','Invalid JSON: '+message);
 const before=fs.lstatSync(filePath),same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
 if(!before.isFile()||before.isSymbolicLink())fail('GENERATION_FILE_UNSAFE','JSON input must be a plain file');
 if(before.size>maxBytes)fail('STREAM_JSON_FILE_LIMIT','JSON file exceeds bounded size');
 if(expectedBytes!==undefined&&before.size!==expectedBytes)fail('FILE_SIZE_MISMATCH','JSON file size mismatch');
 const checkItem=()=>{if(itemStart!==null&&position-itemStart>maxItemChars)fail('STREAM_JSON_ITEM_LIMIT','JSON array item exceeds memory admission bound');};
 const append=text=>{if(!retainScalar)return;scalarChars+=text.length;if(scalarChars>maxItemChars)fail('STREAM_JSON_ITEM_LIMIT','JSON scalar exceeds memory admission bound');if(text)fragments.push(text);};
 const accept=value=>{const parent=stack.at(-1);if(!parent){rootDone=true;return;}if(!['value','valueOrEnd','valueRequired'].includes(parent.state))invalid('Unexpected completed value');
  if(parent.selected){checkItem();onItem(parent.selected,value,counts[parent.selected]++);itemStart=null;}
  else if(parent.keep){if(parent.array)parent.value.push(value);else Object.defineProperty(parent.value,parent.key,{value,enumerable:true,writable:true,configurable:true});}
  parent.key=null;parent.state='commaOrEnd';};
 const finishScalar=()=>{const text=fragments.join('');let value;if(mode==='atom'&&!/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(text))invalid('Invalid scalar');if(retainScalar){try{value=JSON.parse(text);}catch{invalid('Invalid scalar');}}
  if(isKey){const frame=stack.at(-1);frame.key=value;frame.state='colon';}else accept(value);fragments=[];scalarChars=0;mode='';};
 const push=array=>{const parent=stack.at(-1),top=stack.length===1&&selected.has(parent.key)&&array;if(top){if(seen.has(parent.key))invalid('Duplicate ledger array');seen.add(parent.key);}const keep=Boolean(parent?.keep||parent?.selected);stack.push({array,keep,selected:top?parent.key:null,value:keep?(array?[]:{}):undefined,key:null,state:array?'valueOrEnd':'keyOrEnd'});if(stack.length>maxDepth)fail('STREAM_JSON_DEPTH_LIMIT','JSON depth exceeds admission bound');};
 const close=()=>{const frame=stack.pop();accept(frame.value);};
 const consume=text=>{let i=0,fragmentStart=mode?0:-1;while(i<text.length){position=offset+i;checkItem();const c=text[i];
   if(mode==='string'){
    if(unicodeLeft){if(!/[a-fA-F0-9]/.test(c))invalid('Invalid Unicode escape');unicodeLeft--;i++;continue;}
    if(escape){escape=false;if(c==='u')unicodeLeft=4;else if(!'"\\/bfnrt'.includes(c))invalid('Invalid string escape');i++;continue;}
    const special=/["\\\x00-\x1f]/g;special.lastIndex=i;const found=special.exec(text);if(!found){i=text.length;continue;}i=found.index;if(text[i]==='\\'){escape=true;i++;continue;}if(text[i]!=='"')invalid('Unescaped control character');append(text.slice(fragmentStart,++i));position=offset+i;finishScalar();fragmentStart=-1;continue;
   }
   if(mode==='atom'){const end=/[\x20\t\r\n,\]}]/g;end.lastIndex=i;const found=end.exec(text);if(!found){i=text.length;continue;}i=found.index;append(text.slice(fragmentStart,i));position=offset+i;finishScalar();fragmentStart=-1;continue;}
   if(/[\x20\t\r\n]/.test(c)){const nonspace=/[^\x20\t\r\n]/g;nonspace.lastIndex=i;const found=nonspace.exec(text);i=found?found.index:text.length;continue;}
   if(rootDone)invalid('Trailing content');const frame=stack.at(-1);
   if(!frame&&c!=='{')invalid('Root must be an object');
   if(frame?.state==='keyOrEnd'||frame?.state==='keyRequired'){if(c==='}'&&frame.state==='keyOrEnd'){position=offset+ ++i;close();continue;}if(c!=='"')invalid('Expected object key');mode='string';isKey=true;retainScalar=stack.length===1||frame.keep;fragmentStart=i++;continue;}
   if(frame?.state==='colon'){if(c!==':')invalid('Expected colon');frame.state='value';i++;continue;}
   if(frame?.state==='commaOrEnd'){if(c===(frame.array?']':'}')){position=offset+ ++i;close();continue;}if(c!==',')invalid('Expected comma or end');frame.state=frame.array?'valueRequired':'keyRequired';i++;continue;}
   if(frame?.state==='valueOrEnd'&&c===']'){position=offset+ ++i;close();continue;}
   if(frame?.selected&&itemStart===null)itemStart=offset+i;
   if(stack.length===1&&selected.has(frame.key)){if(admittedFields.has(frame.key))invalid('Duplicate ledger field');admittedFields.add(frame.key);if(c!=='['&&!allowNonArrays)invalid('Selected ledger field must be an array');}
   if(c==='{'||c==='['){push(c==='[');i++;continue;}
   isKey=false;retainScalar=Boolean(frame?.keep||frame?.selected);
   if(c==='"'){mode='string';fragmentStart=i++;continue;}
   if(c==='-'||/[0-9tfn]/.test(c)){mode='atom';retainScalar=true;fragmentStart=i++;continue;}
   invalid('Expected value');
  }if(mode)append(text.slice(fragmentStart));position=offset+text.length;checkItem();offset+=text.length;};
 const fd=fs.openSync(filePath,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
 try{const opened=fs.fstatSync(fd);if(!same(before,opened)||!opened.isFile())fail('GENERATION_FILE_CHANGED','JSON changed before open');const buffer=Buffer.allocUnsafe(chunkBytes);let n;
  while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){bytes+=n;if(bytes>before.size)fail('GENERATION_FILE_CHANGED','JSON grew while reading');const part=buffer.subarray(0,n);hash.update(part);let text;try{text=decoder.decode(part,{stream:true});}catch{invalid('Invalid UTF-8');}consume(text);}
  let tail;try{tail=decoder.decode();}catch{invalid('Incomplete UTF-8');}consume(tail);if(mode==='atom')finishScalar();if(mode||!rootDone||stack.length)invalid('Incomplete document');const after=fs.fstatSync(fd),current=fs.lstatSync(filePath);if(bytes!==before.size||!same(opened,after)||current.isSymbolicLink()||!same(opened,current))fail('GENERATION_FILE_CHANGED','JSON changed while reading');const sha256=hash.digest('hex');if(expectedSha256!==undefined&&expectedSha256!==sha256)fail('FILE_HASH_MISMATCH','JSON hash mismatch');return{bytes,sha256,counts,fields:[...seen]};
 }finally{fs.closeSync(fd);}
}
module.exports={streamJsonObjectArrays};
