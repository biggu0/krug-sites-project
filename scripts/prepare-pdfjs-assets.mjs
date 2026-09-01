import {copyFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(projectRoot, 'node_modules/pdfjs-dist/build');
const targetRoot = resolve(projectRoot, 'public/vendor/pdfjs');

mkdirSync(targetRoot, {recursive: true});
for (const fileName of ['pdf.mjs', 'pdf.worker.min.mjs']) {
  copyFileSync(resolve(sourceRoot, fileName), resolve(targetRoot, fileName));
}

writeFileSync(
  resolve(targetRoot, 'pdf.worker.compat.mjs'),
  `const prototype=Map.prototype;
if(typeof prototype.getOrInsert!=="function")Object.defineProperty(prototype,"getOrInsert",{value:function(key,value){if(this.has(key))return this.get(key);this.set(key,value);return value;},configurable:true,writable:true});
if(typeof prototype.getOrInsertComputed!=="function")Object.defineProperty(prototype,"getOrInsertComputed",{value:function(key,callback){if(this.has(key))return this.get(key);const value=callback(key);this.set(key,value);return value;},configurable:true,writable:true});
await import("./pdf.worker.min.mjs?v=6.2.108");
`
);
