import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageBinaryChannel } from '../src/extensions/image-binary.mjs';
import { imageOperation } from '../src/extensions/image-codec.mjs';
function fixture() {
 const files=new Map([['/cache',{mode:0o040700,size:0}]]);let reads=0;
 const FS={lstat(path){if(!files.has(path))throw new Error('ENOENT');return files.get(path)},mkdir(path){files.set(path,{mode:0o040700,size:0})},
 writeFile(path,bytes){files.set(path,{mode:0o100600,size:bytes.length,bytes:Uint8Array.from(bytes)})},readFile(path){reads++;return files.get(path).bytes.slice()}};
 return {FS,files,get reads(){return reads}};
}
test('binary image channel uses only bounded regular guest-cache files',()=>{
 const f=fixture(),channel=createImageBinaryChannel(f.FS,()=> 'test-123');
 const path=channel.write(new Uint8ClampedArray([1,2,3,255]));
 assert.equal(path,'/cache/image-codec/js-image-test-123.bin');
 assert.deepEqual(channel.read(path),new Uint8Array([1,2,3,255]));
 assert.throws(()=>channel.write(new Uint8Array([1])),/collision/);
 assert.throws(()=>channel.read(path,3),/Invalid/);
 for(const path of ['/data/js-image-test.bin','/cache/image-codec/../data/file','/cache/image-codec/foo.bin','https://site.test/image','/cache/image-codec/js-image-..bin'])assert.throws(()=>channel.read(path),/path/);
});
test('binary image channel refuses symlinks and oversize files before reading',()=>{
 const f=fixture(),channel=createImageBinaryChannel(f.FS);
 for(const [path,mode,size] of [['/cache/image-codec/jvm-image-link.bin',0o120777,4],['/cache/image-codec/jvm-image-big.bin',0o100600,32*1024*1024+1]]){
  f.files.set(path,{mode,size});assert.throws(()=>channel.read(path),/Invalid/);
 }
 assert.equal(f.reads,0);
 f.files.set('/cache/image-codec',{mode:0o120777});assert.throws(()=>channel.read('/cache/image-codec/jvm-image-link.bin'),/symlink/);
 f.files.set('/cache',{mode:0o120777});assert.throws(()=>createImageBinaryChannel(f.FS),/directory/);
});
test('binary image bounds preflight avoids base64 and browser allocation; missing channel fails closed',async()=>{
 const f=fixture(),channel=createImageBinaryChannel(f.FS);
 const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4zwBEIAikwQAAScgJ94C76UsAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
 const path=channel.write(png),request={action:'decode',binary:true,bodyFile:path,boundsOnly:true};
 assert.deepEqual(await imageOperation(request,{binary:channel}),{width:2,height:2,mime:'image/png'});
 await assert.rejects(imageOperation(request),/unavailable/);
});
test('binary codec output is a buffer descriptor, not RGBA base64 in JSON',async()=>{
 const oldBitmap=globalThis.createImageBitmap,oldCanvas=globalThis.OffscreenCanvas;
 const f=fixture();let id=0;const channel=createImageBinaryChannel(f.FS,()=> 'test-'+(++id));
 globalThis.createImageBitmap=async()=>({width:2,height:2,close(){}});
 globalThis.OffscreenCanvas=class{getContext(){return{drawImage(){},getImageData(){return{data:new Uint8ClampedArray(16).fill(255)}},createImageData(){return{data:new Uint8ClampedArray(16)}},putImageData(){}}}async convertToBlob(){return new Blob([new Uint8Array([1,2,3])],{type:'image/png'})}};
 try{
  const png=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4zwBEIAikwQAAScgJ94C76UsAAAAASUVORK5CYII='),c=>c.charCodeAt(0));
  const decoded=await imageOperation({action:'decode',binary:true,bodyFile:channel.write(png)},{binary:channel});
  assert.equal(decoded.body,undefined);assert.equal(decoded.byteLength,16);assert.equal(channel.read(decoded.bodyFile).length,16);
  const encoded=await imageOperation({action:'encode',binary:true,bodyFile:decoded.bodyFile,width:2,height:2,mime:'image/png',quality:90},{binary:channel});
  assert.equal(encoded.body,undefined);assert.equal(encoded.byteLength,3);assert.deepEqual(channel.read(encoded.bodyFile),new Uint8Array([1,2,3]));
 }finally{if(oldBitmap===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=oldBitmap;if(oldCanvas===undefined)delete globalThis.OffscreenCanvas;else globalThis.OffscreenCanvas=oldCanvas}
});
