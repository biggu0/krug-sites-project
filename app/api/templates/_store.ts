import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { requirePermission } from '../_auth';

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

type TemplateIndex={templates:TemplateMetadata[]};
type CosConfig={secretId:string;secretKey:string;region:string;bucket:string;cdnDomain?:string};

const storageRoot=process.env.TEMPLATE_STORAGE_DIR??'./.data/templates';
const localIndexPath=path.join(storageRoot,'templates.json');
const encoder=new TextEncoder();

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

async function readIndex():Promise<TemplateIndex>{
  try{
    const content=templateStorageProvider()==='cos'?await cosGet('templates.json'):await readFile(localIndexPath);
    return JSON.parse(content.toString('utf8')) as TemplateIndex;
  }catch(error){
    if(templateStorageProvider()==='cos'&&!isMissingCosIndex(error))throw error;
    return{templates:[]};
  }
}

function isMissingCosIndex(error:unknown){
  const value=error as {statusCode?:number;code?:string;error?:{Code?:string};message?:string};
  return value.statusCode===404||value.code==='NoSuchKey'||value.error?.Code==='NoSuchKey'||/NoSuchKey|not exist|specified key does not exist/i.test(value.message??'');
}

async function writeIndex(index:TemplateIndex){
  const body=Buffer.from(JSON.stringify(index,null,2));
  if(templateStorageProvider()==='cos'){
    await cosPut('templates.json',body,'application/json');
    return;
  }
  try{
    await mkdir(storageRoot,{recursive:true});
    await writeFile(localIndexPath,body);
  }catch(error){
    throw localStorageError(error,`本地模板索引写入失败：${localIndexPath}`);
  }
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
  const index=await readIndex();
  return index.templates.sort((a,b)=>b.updatedAt-a.updatedAt);
}

export async function getTemplate(id:string){
  const index=await readIndex();
  return index.templates.find(template=>template.id===id);
}

export async function readTemplateFile(id:string,kind:'file'|'foreground'){
  const template=await getTemplate(id);
  if(!template)throw new Error('模板不存在');
  const key=kind==='foreground'?template.foregroundObjectKey:template.objectKey;
  if(!key)throw new Error('模板文件不存在');
  return readObject(key);
}

export async function createTemplate(input:{name:string;file:File;metadata?:Partial<TemplateMetadata>;foregroundFile?:File}){
  const now=Date.now(),id=newTemplateId(),fileName=pdfFileName(input.file.name||input.name),objectKey=`${id}/${fileName}`;
  await writeObject(objectKey,input.file);

  let foregroundFileName: string|undefined;
  let foregroundObjectKey: string|undefined;
  if(input.foregroundFile){
    foregroundFileName=pdfFileName(input.foregroundFile.name||`${input.name}-foreground.pdf`);
    foregroundObjectKey=`${id}/${foregroundFileName}`;
    await writeObject(foregroundObjectKey,input.foregroundFile);
  }

  const index=await readIndex();
  const template:TemplateMetadata={
    id,
    name:cleanName(input.name||fileName.replace(/\.pdf$/i,'')),
    fileName,
    objectKey,
    foregroundFileName,
    foregroundObjectKey,
    regions:input.metadata?.regions,
    hasCover:input.metadata?.hasCover,
    pageCount:input.metadata?.pageCount,
    pageMode:input.metadata?.pageMode,
    duplex:input.metadata?.duplex,
    rotateCover:input.metadata?.rotateCover,
    rotateInner:input.metadata?.rotateInner,
    createdAt:now,
    updatedAt:now
  };
  index.templates.push(template);
  await writeIndex(index);
  return template;
}

export async function updateTemplate(id:string,patch:Partial<TemplateMetadata>){
  const index=await readIndex(),template=index.templates.find(item=>item.id===id);
  if(!template)throw new Error('模板不存在');
  Object.assign(template,{
    name:patch.name===undefined?template.name:cleanName(patch.name),
    regions:patch.regions===undefined?template.regions:patch.regions,
    hasCover:patch.hasCover===undefined?template.hasCover:patch.hasCover,
    pageCount:patch.pageCount===undefined?template.pageCount:patch.pageCount,
    pageMode:patch.pageMode===undefined?template.pageMode:patch.pageMode,
    duplex:patch.duplex===undefined?template.duplex:patch.duplex,
    rotateCover:patch.rotateCover===undefined?template.rotateCover:patch.rotateCover,
    rotateInner:patch.rotateInner===undefined?template.rotateInner:patch.rotateInner,
    updatedAt:Date.now()
  });
  await writeIndex(index);
  return template;
}

export async function updateTemplateForeground(id:string,file:File){
  const index=await readIndex(),template=index.templates.find(item=>item.id===id);
  if(!template)throw new Error('模板不存在');
  const foregroundFileName=pdfFileName(file.name||`${template.name}-foreground.pdf`),foregroundObjectKey=`${id}/${foregroundFileName}`;
  if(template.foregroundObjectKey&&template.foregroundObjectKey!==foregroundObjectKey)await deleteObjectIfExists(template.foregroundObjectKey);
  await writeObject(foregroundObjectKey,file);
  template.foregroundFileName=foregroundFileName;
  template.foregroundObjectKey=foregroundObjectKey;
  template.updatedAt=Date.now();
  await writeIndex(index);
  return template;
}

export async function deleteTemplate(id:string){
  const index=await readIndex(),template=index.templates.find(item=>item.id===id);
  if(!template)throw new Error('模板不存在');
  await deleteTemplateObjects(template);
  await writeIndex({templates:index.templates.filter(item=>item.id!==id)});
}

export function publicTemplate(template:TemplateMetadata){
  return{
    ...template,
    storageProvider:templateStorageProvider(),
    storageUrl:templateStorageProvider()==='cos'?cosPublicUrl(template.objectKey):undefined,
    fileUrl:`/api/templates/${template.id}/file`,
    foregroundUrl:template.foregroundObjectKey?`/api/templates/${template.id}/foreground`:undefined
  };
}

function cosPublicUrl(relativeKey:string){
  if(templateStorageProvider()!=='cos')return undefined;
  const config=cosConfig(),base=config.cdnDomain?`https://${config.cdnDomain.replace(/^https?:\/\//,'').replace(/\/+$/,'')}`:`https://${config.bucket}.cos.${config.region}.myqcloud.com`;
  return `${base}/${objectKey(relativeKey).split('/').map(encodeURIComponent).join('/')}`;
}
