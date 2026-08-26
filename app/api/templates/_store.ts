import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { initializeAuth, requirePermission } from '../_auth';

export type PageMode='all'|'odd'|'even';
export type TemplateMetadata={
  id:string;
  name:string;
  fileName:string;
  objectKey:string;
  foregroundFileName?:string;
  foregroundObjectKey?:string;
  regions?:unknown;
  hasCover?:boolean;
  pageCount?:number;
  pageMode?:PageMode;
  duplex?:boolean;
  rotateCover?:boolean;
  rotateInner?:boolean;
  createdAt:number;
  updatedAt:number;
};

type CosConfig={secretId:string;secretKey:string;region:string;bucket:string;cdnDomain?:string};
type TemplateRow={id:string;normalized_name:string;name:string;file_name:string;object_key:string;foreground_file_name?:string|null;foreground_object_key?:string|null;regions?:string|null;has_cover?:number|null;page_count?:number|null;page_mode?:PageMode|null;duplex?:number|null;rotate_cover?:number|null;rotate_inner?:number|null;created_at:number;updated_at:number};
type TemplateDb={prepare:(sql:string)=>{bind:(...values:unknown[])=>TemplateDbStatement;run:()=>Promise<unknown>;first:<T=unknown>()=>Promise<T|undefined>;all:<T=unknown>()=>Promise<{results:T[]}>}};
type TemplateDbStatement={bind:(...values:unknown[])=>TemplateDbStatement;run:()=>Promise<unknown>;first:<T=unknown>()=>Promise<T|undefined>;all:<T=unknown>()=>Promise<{results:T[]}>};

const storageRoot=process.env.TEMPLATE_STORAGE_DIR??'./.data/templates';
const encoder=new TextEncoder();
const maxTemplateBytes=Number(process.env.TEMPLATE_MAX_BYTES??50*1024*1024);

function hex(bytes:ArrayBuffer|Uint8Array){
  return Array.from(new Uint8Array(bytes)).map(value=>value.toString(16).padStart(2,'0')).join('');
}

export async function requireTemplatePermission(request:Request){
  return requirePermission(request,'templates');
}

export function templateStorageUnavailableHint(){
  if(templateStorageProvider()==='local')return '当前模板存储是 local。本地 Node/Docker 可以使用 local；wrangler/Cloudflare Worker 运行时不能写 node:fs，请改用 TEMPLATE_STORAGE_PROVIDER=cos。';
  return '当前模板存储是 cos，请检查 COS 配置、密钥权限和路径策略。';
}

export function templateStorageProvider(){
  return (process.env.TEMPLATE_STORAGE_PROVIDER??'cos').toLowerCase();
}

function cleanName(value:string){
  return value.replace(/[\\/:*?"<>|]/g,'-').trim()||'template';
}

function normalizedName(value:string){
  return cleanName(value).replace(/\.pdf$/i,'').trim().toLowerCase();
}

function pdfFileName(value:string){
  const name=cleanName(value);
  return /\.pdf$/i.test(name)?name:`${name}.pdf`;
}

function newTemplateId(){
  return `tpl_${Date.now().toString(36)}_${crypto.randomUUID().slice(0,8)}`;
}

function objectPrefix(){
  const base=process.env.TENCENT_COS_BASE_PATH??process.env.COS_PREFIX??'uploads/';
  const envPrefix=process.env.TENCENT_COS_ENV_PREFIX??process.env.COS_ENV_PREFIX??'';
  const projectPrefix=process.env.TENCENT_COS_PROJECT_PREFIX??process.env.COS_PROJECT_PREFIX??'calendar';
  const segments=[projectPrefix,envPrefix,base].map(part=>part.trim().replace(/^\/+|\/+$/g,'')).filter(Boolean);
  return segments.join('/').replace(/\/?$/,'/');
}

function objectKey(relativeKey:string){
  return `${objectPrefix()}${relativeKey.replace(/^\/+/,'')}`;
}

function dbValue<T>(value:T|undefined){
  return value===undefined?null:value;
}

async function templateDb():Promise<TemplateDb>{
  const db=await initializeAuth() as unknown as TemplateDb;
  await db.prepare('CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, normalized_name TEXT NOT NULL UNIQUE, name TEXT NOT NULL, file_name TEXT NOT NULL, object_key TEXT NOT NULL, foreground_file_name TEXT, foreground_object_key TEXT, regions TEXT, has_cover INTEGER, page_count INTEGER, page_mode TEXT, duplex INTEGER, rotate_cover INTEGER, rotate_inner INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS templates_updated_idx ON templates(updated_at)').run();
  return db;
}

function rowToTemplate(row:TemplateRow):TemplateMetadata{
  return{
    id:row.id,
    name:row.name,
    fileName:row.file_name,
    objectKey:row.object_key,
    foregroundFileName:row.foreground_file_name??undefined,
    foregroundObjectKey:row.foreground_object_key??undefined,
    regions:row.regions?JSON.parse(row.regions):undefined,
    hasCover:row.has_cover===null||row.has_cover===undefined?undefined:Boolean(row.has_cover),
    pageCount:row.page_count??undefined,
    pageMode:row.page_mode??undefined,
    duplex:row.duplex===null||row.duplex===undefined?undefined:Boolean(row.duplex),
    rotateCover:row.rotate_cover===null||row.rotate_cover===undefined?undefined:Boolean(row.rotate_cover),
    rotateInner:row.rotate_inner===null||row.rotate_inner===undefined?undefined:Boolean(row.rotate_inner),
    createdAt:row.created_at,
    updatedAt:row.updated_at
  };
}

function booleanValue(value:unknown){
  return typeof value==='boolean'?value:undefined;
}

function pageModeValue(value:unknown):PageMode|undefined{
  return value==='all'||value==='odd'||value==='even'?value:undefined;
}

function assertRegionPoint(value:unknown){
  const point=value as {x?:unknown;y?:unknown;inX?:unknown;inY?:unknown;outX?:unknown;outY?:unknown};
  for(const key of ['x','y','inX','inY','outX','outY'] as const){
    if(point[key]!==undefined&&(typeof point[key]!=='number'||!Number.isFinite(point[key])))throw new Error('模板区域坐标格式不正确');
  }
}

function cleanRegions(value:unknown){
  if(value===undefined)return undefined;
  const regions=value as {cover?:{points?:unknown[]};inner?:{points?:unknown[]}};
  if(!regions||typeof regions!=='object')throw new Error('模板区域参数格式不正确');
  for(const key of ['cover','inner'] as const){
    const region=regions[key];
    if(!region||typeof region!=='object'||!Array.isArray(region.points)||region.points.length<3)throw new Error(`${key==='cover'?'封面':'内页'}定制区域至少需要3个坐标点`);
    region.points.forEach(assertRegionPoint);
  }
  return value;
}

async function pdfPageCount(file:File){
  const bytes=new Uint8Array(await file.arrayBuffer());
  const header=new TextDecoder().decode(bytes.slice(0,5));
  if(header!=='%PDF-')throw new Error('上传文件不是有效 PDF');
  const pdf=await import('pdf-lib');
  return pdf.PDFDocument.load(bytes).then(document=>document.getPageCount());
}

async function validatePdfFile(file:File,kind:'template'|'foreground'){
  if(file.size<=0)throw new Error('PDF 文件为空');
  if(file.size>maxTemplateBytes)throw new Error(`PDF 文件不能超过 ${Math.round(maxTemplateBytes/1024/1024)}MB`);
  if(!/\.pdf$/i.test(file.name))throw new Error('模板文件扩展名必须是 .pdf');
  if(file.type&&file.type!=='application/pdf')throw new Error('模板文件 MIME 类型必须是 application/pdf');
  const pageCount=await pdfPageCount(file);
  if(kind==='template'&&![12,13,24,25].includes(pageCount))throw new Error(`模板必须是12、13、24或25页，实际为 ${pageCount} 页`);
  return pageCount;
}

function cleanMetadata(metadata:Partial<TemplateMetadata>,actualPageCount:number){
  const pageCount=metadata.pageCount===undefined?actualPageCount:Number(metadata.pageCount);
  if(pageCount!==actualPageCount)throw new Error(`模板参数页数 ${pageCount} 与 PDF 实际页数 ${actualPageCount} 不一致`);
  if(![12,13,24,25].includes(pageCount))throw new Error(`模板页数不受支持：${pageCount}`);
  const duplex=booleanValue(metadata.duplex)??[24,25].includes(pageCount),pageMode=pageModeValue(metadata.pageMode)??(duplex?'odd':'all');
  if(duplex&&pageMode==='all')throw new Error('双面印刷必须选择仅奇数页或仅偶数页插图');
  if(duplex&&![24,25].includes(pageCount))throw new Error('双面印刷模板必须是24页或25页');
  if(!duplex&&![12,13].includes(pageCount))throw new Error('单面印刷模板必须是12页或13页');
  return{
    regions:cleanRegions(metadata.regions),
    hasCover:booleanValue(metadata.hasCover)??true,
    pageCount,
    pageMode,
    duplex,
    rotateCover:booleanValue(metadata.rotateCover)??false,
    rotateInner:booleanValue(metadata.rotateInner)??false
  };
}

function cosConfig():CosConfig{
  const secretId=process.env.TENCENT_COS_SECRET_ID??process.env.COS_SECRET_ID??'';
  const secretKey=process.env.TENCENT_COS_SECRET_KEY??process.env.COS_SECRET_KEY??'';
  const region=process.env.TENCENT_COS_REGION??process.env.COS_REGION??'';
  const bucket=process.env.TENCENT_COS_BUCKET??process.env.COS_BUCKET??'';
  const cdnDomain=process.env.TENCENT_COS_CDN_DOMAIN??process.env.COS_CDN_DOMAIN;
  if(!secretId||!secretKey||!region||!bucket)throw new Error('COS 配置不完整，请检查 TENCENT_COS_SECRET_ID、TENCENT_COS_SECRET_KEY、TENCENT_COS_REGION、TENCENT_COS_BUCKET');
  return{secretId,secretKey,region,bucket,cdnDomain};
}

async function cosClient(config:CosConfig){
  const host=`${config.bucket}.cos.${config.region}.myqcloud.com`;
  return{host,origin:`https://${host}`};
}

function encodeCosPath(key:string){
  return `/${key.split('/').map(part=>encodeURIComponent(part)).join('/')}`;
}

function cosSignPath(key:string){
  return `/${key.replace(/^\/+/,'')}`;
}

function encodeQueryValue(value:string){
  return encodeURIComponent(value).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function sha1Hex(value:string){
  const hash=await crypto.subtle.digest('SHA-1',encoder.encode(value));
  return hex(hash);
}

async function hmacSha1Hex(key:string|ArrayBuffer,data:string){
  const rawKey=typeof key==='string'?encoder.encode(key):key;
  const cryptoKey=await crypto.subtle.importKey('raw',rawKey,{name:'HMAC',hash:'SHA-1'},false,['sign']);
  return hex(await crypto.subtle.sign('HMAC',cryptoKey,encoder.encode(data)));
}

async function cosAuthorization(config:CosConfig,input:{method:string;path:string;query?:Record<string,string>;host:string}){
  const now=Math.floor(Date.now()/1000),keyTime=`${now};${now+600}`;
  const queryEntries=Object.entries(input.query??{}).map(([key,value])=>[key.toLowerCase(),value] as const).sort(([a],[b])=>a.localeCompare(b));
  const queryString=queryEntries.map(([key,value])=>`${encodeQueryValue(key)}=${encodeQueryValue(value)}`).join('&');
  const queryList=queryEntries.map(([key])=>encodeQueryValue(key)).join(';');
  const headerString=`host=${input.host.toLowerCase()}`;
  const formatString=`${input.method.toLowerCase()}\n${input.path}\n${queryString}\n${headerString}\n`;
  const signKey=await hmacSha1Hex(config.secretKey,keyTime);
  const stringToSign=`sha1\n${keyTime}\n${await sha1Hex(formatString)}\n`;
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${config.secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    'q-header-list=host',
    `q-url-param-list=${queryList}`,
    `q-signature=${await hmacSha1Hex(signKey,stringToSign)}`
  ].join('&');
}

async function cosFetch(relativeKey:string,init:{method:string;body?:BodyInit;contentType?:string;query?:Record<string,string>}){
  const config=cosConfig(),client=await cosClient(config),key=objectKey(relativeKey),pathName=encodeCosPath(key),signPath=cosSignPath(key);
  const queryString=Object.entries(init.query??{}).map(([key,value])=>`${encodeQueryValue(key)}=${encodeQueryValue(value)}`).join('&');
  const url=`${client.origin}${pathName}${queryString?`?${queryString}`:''}`;
  const headers=new Headers({Authorization:await cosAuthorization(config,{method:init.method,path:signPath,query:init.query,host:client.host})});
  if(init.contentType)headers.set('Content-Type',init.contentType);
  const response=await fetch(url,{method:init.method,headers,body:init.body});
  if(!response.ok)throw await cosResponseError(response,`${init.method} ${key}`);
  return response;
}

async function cosBucketFetch(init:{method:string;query?:Record<string,string>}){
  const config=cosConfig(),client=await cosClient(config),pathName='/';
  const queryString=Object.entries(init.query??{}).map(([key,value])=>`${encodeQueryValue(key)}=${encodeQueryValue(value)}`).join('&');
  const url=`${client.origin}/${queryString?`?${queryString}`:''}`;
  const headers=new Headers({Authorization:await cosAuthorization(config,{method:init.method,path:pathName,query:init.query,host:client.host})});
  const response=await fetch(url,{method:init.method,headers});
  if(!response.ok)throw await cosResponseError(response,`${init.method} bucket`);
  return response;
}

async function cosResponseError(response:Response,context:string){
  const message=await response.text().catch(()=>response.statusText);
  const code=message.match(/<Code>([^<]+)<\/Code>/)?.[1];
  return storageError({message,code,statusCode:response.status},`COS 请求失败：${context}`);
}

async function cosPut(relativeKey:string,body:Buffer,contentType:string){
  await cosFetch(relativeKey,{method:'PUT',body,contentType});
}

async function cosGet(relativeKey:string){
  const response=await cosFetch(relativeKey,{method:'GET'});
  return Buffer.from(await response.arrayBuffer());
}

async function cosDelete(relativeKey:string){
  await cosFetch(relativeKey,{method:'DELETE'});
}

async function cosDeletePrefix(relativePrefix:string){
  const prefix=objectKey(relativePrefix).replace(/\/?$/,'/');
  const response=await cosBucketFetch({method:'GET',query:{prefix,'max-keys':'1000'}});
  const xml=await response.text();
  const keys=Array.from(xml.matchAll(/<Key>(.*?)<\/Key>/g),match=>decodeXml(match[1]));
  await Promise.all(keys.map(key=>cosFetch(key.replace(objectPrefix(),''),{method:'DELETE'}).catch(()=>undefined)));
}

function decodeXml(value:string){
  return value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}

function storageError(error:unknown,context:string){
  const value=error as {message?:string;code?:string;statusCode?:number;error?:{Code?:string;Message?:string}};
  const code=value.code??value.error?.Code;
  const message=value.message??value.error?.Message??String(error);
  if(/operation not permitted|AccessDenied|403/i.test(`${code} ${message} ${value.statusCode??''}`)){
    return new Error(`${context}。COS 密钥或存储桶策略没有权限，请确认允许 PutObject/GetObject/DeleteObject，并确认路径前缀在允许范围内。原始错误：${message}`);
  }
  return new Error(`${context}。原始错误：${message}`);
}

function localStorageError(error:unknown,context:string){
  const message=error instanceof Error?error.message:String(error);
  if(/operation not permitted|EACCES|EROFS|EPERM/i.test(message)){
    return new Error(`${context}。${templateStorageUnavailableHint()} 原始错误：${message}`);
  }
  return new Error(`${context}。原始错误：${message}`);
}

function localPath(relativeKey:string){
  return path.join(storageRoot,relativeKey);
}

async function writeObject(relativeKey:string,file:File){
  const body=Buffer.from(await file.arrayBuffer());
  if(templateStorageProvider()==='cos'){
    await cosPut(relativeKey,body,file.type||'application/pdf');
    return;
  }
  const target=localPath(relativeKey);
  try{
    await mkdir(path.dirname(target),{recursive:true});
    await writeFile(target,body);
  }catch(error){
    throw localStorageError(error,`本地模板文件写入失败：${target}`);
  }
}

async function readObject(relativeKey:string){
  return templateStorageProvider()==='cos'?cosGet(relativeKey):readFile(localPath(relativeKey));
}

async function deleteObjectIfExists(relativeKey:string){
  if(templateStorageProvider()==='cos'){
    await cosDelete(relativeKey).catch(()=>undefined);
    return;
  }
  await rm(localPath(relativeKey),{force:true});
}

async function deleteTemplateObjects(template:TemplateMetadata){
  if(templateStorageProvider()==='cos'){
    await Promise.all([
      cosDelete(template.objectKey),
      template.foregroundObjectKey?cosDelete(template.foregroundObjectKey):Promise.resolve(),
      cosDeletePrefix(template.id)
    ].map(task=>task.catch(()=>undefined)));
    return;
  }
  await rm(path.join(storageRoot,template.id),{recursive:true,force:true});
}

export async function listTemplates(){
  const db=await templateDb(),rows=await db.prepare('SELECT * FROM templates ORDER BY updated_at DESC').all<TemplateRow>();
  return rows.results.map(rowToTemplate);
}

export async function getTemplate(id:string){
  const db=await templateDb(),row=await db.prepare('SELECT * FROM templates WHERE id=?').bind(id).first<TemplateRow>();
  return row?rowToTemplate(row):undefined;
}

export async function readTemplateFile(id:string,kind:'file'|'foreground'){
  const template=await getTemplate(id);
  if(!template)throw new Error('模板不存在');
  const key=kind==='foreground'?template.foregroundObjectKey:template.objectKey;
  if(!key)throw new Error('模板文件不存在');
  return readObject(key);
}

export async function createTemplate(input:{name:string;file:File;metadata?:Partial<TemplateMetadata>;foregroundFile?:File}){
  const actualPageCount=await validatePdfFile(input.file,'template'),metadata=cleanMetadata(input.metadata??{},actualPageCount);
  const now=Date.now(),id=newTemplateId(),name=cleanName(input.name||input.file.name.replace(/\.pdf$/i,'')),normalized=normalizedName(name),fileName=pdfFileName(input.file.name||name),objectKey=`${id}/${fileName}`,db=await templateDb();
  if(await db.prepare('SELECT id FROM templates WHERE normalized_name=? AND id<>?').bind(normalized,id).first())throw new Error(`模板名称“${name.replace(/\.pdf$/i,'')}”已存在，请使用其他名称`);
  await writeObject(objectKey,input.file);

  let foregroundFileName: string|undefined;
  let foregroundObjectKey: string|undefined;
  if(input.foregroundFile){
    const foregroundPageCount=await validatePdfFile(input.foregroundFile,'foreground');
    if(foregroundPageCount!==actualPageCount)throw new Error(`前景保护层页数 ${foregroundPageCount} 与背景模板 ${actualPageCount} 不一致`);
    foregroundFileName=pdfFileName(input.foregroundFile.name||`${input.name}-foreground.pdf`);
    foregroundObjectKey=`${id}/${foregroundFileName}`;
    await writeObject(foregroundObjectKey,input.foregroundFile);
  }

  const template:TemplateMetadata={
    id,
    name,
    fileName,
    objectKey,
    foregroundFileName,
    foregroundObjectKey,
    regions:metadata.regions,
    hasCover:metadata.hasCover,
    pageCount:metadata.pageCount,
    pageMode:metadata.pageMode,
    duplex:metadata.duplex,
    rotateCover:metadata.rotateCover,
    rotateInner:metadata.rotateInner,
    createdAt:now,
    updatedAt:now
  };
  try{
    await db.prepare('INSERT INTO templates(id,normalized_name,name,file_name,object_key,foreground_file_name,foreground_object_key,regions,has_cover,page_count,page_mode,duplex,rotate_cover,rotate_inner,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(
      id,normalized,name,fileName,objectKey,dbValue(foregroundFileName),dbValue(foregroundObjectKey),dbValue(metadata.regions?JSON.stringify(metadata.regions):undefined),metadata.hasCover?1:0,metadata.pageCount,metadata.pageMode,metadata.duplex?1:0,metadata.rotateCover?1:0,metadata.rotateInner?1:0,now,now
    ).run();
  }catch(error){
    await deleteTemplateObjects(template).catch(()=>undefined);
    if(/UNIQUE|unique/i.test(error instanceof Error?error.message:String(error)))throw new Error(`模板名称“${name.replace(/\.pdf$/i,'')}”已存在，请使用其他名称`);
    throw error;
  }
  return template;
}

export async function updateTemplate(id:string,patch:Partial<TemplateMetadata>){
  const db=await templateDb(),template=await getTemplate(id);
  if(!template)throw new Error('模板不存在');
  const name=patch.name===undefined?template.name:cleanName(patch.name),normalized=normalizedName(name);
  if(await db.prepare('SELECT id FROM templates WHERE normalized_name=? AND id<>?').bind(normalized,id).first())throw new Error(`模板名称“${name.replace(/\.pdf$/i,'')}”已存在，请使用其他名称`);
  const pageCount=patch.pageCount===undefined?template.pageCount:Number(patch.pageCount);
  if(!pageCount||![12,13,24,25].includes(pageCount))throw new Error(`模板页数不受支持：${pageCount}`);
  const metadata=cleanMetadata({
    regions:patch.regions===undefined?template.regions:patch.regions,
    hasCover:patch.hasCover===undefined?template.hasCover:patch.hasCover,
    pageCount,
    pageMode:patch.pageMode===undefined?template.pageMode:patch.pageMode,
    duplex:patch.duplex===undefined?template.duplex:patch.duplex,
    rotateCover:patch.rotateCover===undefined?template.rotateCover:patch.rotateCover,
    rotateInner:patch.rotateInner===undefined?template.rotateInner:patch.rotateInner
  },pageCount);
  const updatedAt=Date.now();
  Object.assign(template,{
    name,
    regions:metadata.regions,
    hasCover:metadata.hasCover,
    pageCount:metadata.pageCount,
    pageMode:metadata.pageMode,
    duplex:metadata.duplex,
    rotateCover:metadata.rotateCover,
    rotateInner:metadata.rotateInner,
    updatedAt
  });
  await db.prepare('UPDATE templates SET normalized_name=?, name=?, regions=?, has_cover=?, page_count=?, page_mode=?, duplex=?, rotate_cover=?, rotate_inner=?, foreground_file_name=?, foreground_object_key=?, updated_at=? WHERE id=?').bind(
    normalized,name,dbValue(metadata.regions?JSON.stringify(metadata.regions):undefined),metadata.hasCover?1:0,metadata.pageCount,metadata.pageMode,metadata.duplex?1:0,metadata.rotateCover?1:0,metadata.rotateInner?1:0,dbValue(template.foregroundFileName),dbValue(template.foregroundObjectKey),updatedAt,id
  ).run();
  return template;
}

export async function updateTemplateForeground(id:string,file:File){
  const db=await templateDb(),template=await getTemplate(id);
  if(!template)throw new Error('模板不存在');
  const pageCount=await validatePdfFile(file,'foreground');
  if(template.pageCount&&pageCount!==template.pageCount)throw new Error(`前景保护层页数 ${pageCount} 与背景模板 ${template.pageCount} 不一致`);
  const foregroundFileName=pdfFileName(file.name||`${template.name}-foreground.pdf`),foregroundObjectKey=`${id}/${foregroundFileName}`;
  if(template.foregroundObjectKey&&template.foregroundObjectKey!==foregroundObjectKey)await deleteObjectIfExists(template.foregroundObjectKey);
  await writeObject(foregroundObjectKey,file);
  template.foregroundFileName=foregroundFileName;
  template.foregroundObjectKey=foregroundObjectKey;
  template.updatedAt=Date.now();
  await db.prepare('UPDATE templates SET foreground_file_name=?, foreground_object_key=?, updated_at=? WHERE id=?').bind(foregroundFileName,foregroundObjectKey,template.updatedAt,id).run();
  return template;
}

export async function deleteTemplate(id:string){
  const db=await templateDb(),template=await getTemplate(id);
  if(!template)throw new Error('模板不存在');
  await deleteTemplateObjects(template);
  await db.prepare('DELETE FROM templates WHERE id=?').bind(id).run();
}

export function publicTemplate(template:TemplateMetadata){
  return{
    id:template.id,
    name:template.name,
    fileName:template.fileName,
    foregroundFileName:template.foregroundFileName,
    regions:template.regions,
    hasCover:template.hasCover,
    pageCount:template.pageCount,
    pageMode:template.pageMode,
    duplex:template.duplex,
    rotateCover:template.rotateCover,
    rotateInner:template.rotateInner,
    createdAt:template.createdAt,
    updatedAt:template.updatedAt,
    storageProvider:templateStorageProvider(),
    fileUrl:`/api/templates/${template.id}/file`,
    foregroundUrl:template.foregroundObjectKey?`/api/templates/${template.id}/foreground`:undefined
  };
}
