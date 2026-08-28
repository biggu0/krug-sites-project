import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sourceRoot=resolve(projectRoot,'node_modules/pdfjs-dist/build');
const targetRoot=resolve(projectRoot,'public/vendor/pdfjs');

mkdirSync(targetRoot,{recursive:true});
for(const fileName of ['pdf.mjs','pdf.worker.min.mjs']){
  copyFileSync(resolve(sourceRoot,fileName),resolve(targetRoot,fileName));
}
