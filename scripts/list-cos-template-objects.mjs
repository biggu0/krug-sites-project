import crypto from 'node:crypto';

function required(name,...fallbacks){
  const value=[name,...fallbacks].map(key=>process.env[key]).find(Boolean);
  if(!value)throw new Error(`缺少环境变量 ${name}`);
  return value;
}

function encode(value){
  return encodeURIComponent(value).replace(/[!'()*]/g,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key,value){
  return crypto.createHmac('sha1',key).update(value).digest('hex');
}

function sha1(value){
  return crypto.createHash('sha1').update(value).digest('hex');
}

function decodeXml(value=''){
  return value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
}

function xmlValue(xml,name){
  return decodeXml(xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1]??'');
}

function authorization({secretId,secretKey,host,query}){
  const now=Math.floor(Date.now()/1000),keyTime=`${now};${now+600}`;
  const entries=Object.entries(query).map(([key,value])=>[key.toLowerCase(),String(value)]).sort(([a],[b])=>a.localeCompare(b));
  const queryString=entries.map(([key,value])=>`${encode(key)}=${encode(value)}`).join('&');
  const queryList=entries.map(([key])=>encode(key)).join(';');
  const formatString=`get\n/\n${queryString}\nhost=${host.toLowerCase()}\n`;
  const signKey=hmac(secretKey,keyTime),stringToSign=`sha1\n${keyTime}\n${sha1(formatString)}\n`;
  return ['q-sign-algorithm=sha1',`q-ak=${secretId}`,`q-sign-time=${keyTime}`,`q-key-time=${keyTime}`,'q-header-list=host',`q-url-param-list=${queryList}`,`q-signature=${hmac(signKey,stringToSign)}`].join('&');
}

async function listPage(config,marker=''){
  const query={prefix:config.prefix,'max-keys':'1000'};
  if(marker)query.marker=marker;
  const queryString=Object.entries(query).map(([key,value])=>`${encode(key)}=${encode(value)}`).join('&');
  const response=await fetch(`https://${config.host}/?${queryString}`,{headers:{Authorization:authorization({...config,query})}});
  const xml=await response.text();
  if(!response.ok)throw new Error(`COS 列表读取失败 (${response.status})：${xmlValue(xml,'Message')||xmlValue(xml,'Code')||response.statusText}`);
  const objects=Array.from(xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g),match=>({
    key:xmlValue(match[1],'Key'),
    size:Number(xmlValue(match[1],'Size')||0),
    lastModified:xmlValue(match[1],'LastModified')
  }));
  return{objects,truncated:xmlValue(xml,'IsTruncated').toLowerCase()==='true',nextMarker:xmlValue(xml,'NextMarker')||objects.at(-1)?.key||''};
}

const secretId=required('TENCENT_COS_SECRET_ID','COS_SECRET_ID');
const secretKey=required('TENCENT_COS_SECRET_KEY','COS_SECRET_KEY');
const region=required('TENCENT_COS_REGION','COS_REGION');
const bucket=required('TENCENT_COS_BUCKET','COS_BUCKET');
const base=(process.env.TENCENT_COS_BASE_PATH??process.env.COS_PREFIX??'uploads/').replace(/^\/+|\/+$/g,'');
const environment=(process.env.TENCENT_COS_ENV_PREFIX??process.env.COS_ENV_PREFIX??'prod').replace(/^\/+|\/+$/g,'');
const project=(process.env.TENCENT_COS_PROJECT_PREFIX??process.env.COS_PROJECT_PREFIX??'calendar').replace(/^\/+|\/+$/g,'');
const prefix=[project,environment,base].filter(Boolean).join('/').replace(/\/?$/,'/');
const config={secretId,secretKey,host:`${bucket}.cos.${region}.myqcloud.com`,prefix};

const objects=[];
let marker='';
do{
  const page=await listPage(config,marker);
  objects.push(...page.objects);
  marker=page.truncated?page.nextMarker:'';
}while(marker);

const groups=new Map();
for(const object of objects){
  const relative=object.key.startsWith(prefix)?object.key.slice(prefix.length):object.key;
  const [templateId,...parts]=relative.split('/');
  if(!/^tpl_/i.test(templateId)||!parts.length)continue;
  const files=groups.get(templateId)??[];
  files.push({...object,key:relative,fileName:parts.join('/')});
  groups.set(templateId,files);
}

const templates=[...groups].map(([id,files])=>({id,files:files.sort((a,b)=>a.key.localeCompare(b.key))})).sort((a,b)=>a.id.localeCompare(b.id));
console.log(`COS 前缀：${prefix}`);
console.log(`对象总数：${objects.length}；模板目录：${templates.length}`);
for(const template of templates){
  console.log(`\n${template.id}`);
  for(const file of template.files)console.log(`  ${file.fileName}  ${file.size} bytes  ${file.lastModified}`);
}

