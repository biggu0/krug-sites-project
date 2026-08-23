'use client';

import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';

type Photo = { id: string; file: File; url: string };
type FitMode = 'stretch' | 'cover';
type Transform = { scale: number; x: number; y: number };

const months = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
const defaultTransform: Transform = { scale: 1, x: 0, y: 0 };

function orderName() {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
  return `calendar-${stamp}`;
}
function cleanFileName(value: string) {
  return (value.trim() || orderName()).replace(/\.pdf$/i,'').replace(/[\\/:*?"<>|]/g,'-');
}
function shuffle<T>(items: T[]) {
  const result = [...items];
  for (let i=result.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[result[i],result[j]]=[result[j],result[i]];}
  return result;
}
function makeArrangement(photos: Photo[]) {
  if (!photos.length) return [];
  const result: Photo[]=[]; let previousId='';
  while(result.length<12){let round=shuffle(photos);if(round.length>1&&round[0].id===previousId)[round[0],round[1]]=[round[1],round[0]];round=round.slice(0,12-result.length);result.push(...round);previousId=result.at(-1)?.id??'';}
  return result;
}
function openTemplateDb() {
  return new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('calendar-workshop',1);request.onupgradeneeded=()=>request.result.createObjectStore('files');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
async function saveTemplate(file: File|null) {
  const db=await openTemplateDb();
  await new Promise<void>((resolve,reject)=>{const tx=db.transaction('files','readwrite');const store=tx.objectStore('files');file?store.put({name:file.name,type:file.type,blob:file},'template'):store.delete('template');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
}
async function loadTemplate() {
  const db=await openTemplateDb();
  const record=await new Promise<{name:string;type:string;blob:Blob}|undefined>((resolve,reject)=>{const request=db.transaction('files').objectStore('files').get('template');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});db.close();
  return record?new File([record.blob],record.name,{type:record.type}):null;
}
async function optimizedJpeg(file: File,width:number,height:number,fit:FitMode,adjust:Transform){
  const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});const canvas=document.createElement('canvas');canvas.width=Math.round(width);canvas.height=Math.round(height);const context=canvas.getContext('2d',{alpha:false});if(!context)throw new Error('无法创建图像处理画布');context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);
  const base=fit==='stretch'?{w:canvas.width,h:canvas.height}:{w:bitmap.width*Math.max(canvas.width/bitmap.width,canvas.height/bitmap.height),h:bitmap.height*Math.max(canvas.width/bitmap.width,canvas.height/bitmap.height)};
  const w=base.w*adjust.scale,h=base.h*adjust.scale,x=(canvas.width-w)/2+canvas.width*adjust.x/100,y=(canvas.height-h)/2+canvas.height*adjust.y/100;context.drawImage(bitmap,x,y,w,h);bitmap.close();
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('图像压缩失败')),'image/jpeg',.9));return new Uint8Array(await blob.arrayBuffer());
}

export default function Home(){
  const [template,setTemplate]=useState<File|null>(null);const [templatePages,setTemplatePages]=useState<string[]>([]);const [cover,setCover]=useState<Photo|null>(null);const [photos,setPhotos]=useState<Photo[]>([]);const [arrangement,setArrangement]=useState<Photo[]>([]);const [fitMode,setFitMode]=useState<FitMode>('cover');const [transforms,setTransforms]=useState<Record<string,Transform>>({});const [selectedPage,setSelectedPage]=useState(0);const [fileName,setFileName]=useState(orderName);const [busy,setBusy]=useState(false);const [message,setMessage]=useState('等待上传文件');const [orderKey,setOrderKey]=useState(0);const [recent,setRecent]=useState<string[]>([]);const urls=useRef<string[]>([]);
  useEffect(()=>{loadTemplate().then(file=>file&&setTemplate(file)).catch(()=>{});setRecent(JSON.parse(localStorage.getItem('calendar-recent')||'[]'));return()=>urls.current.forEach(URL.revokeObjectURL);},[]);
  useEffect(()=>{if(!template){setTemplatePages([]);return;}let cancelled=false;(async()=>{try{const pdfjs=await import('pdfjs-dist');pdfjs.GlobalWorkerOptions.workerSrc=new URL('pdfjs-dist/build/pdf.worker.min.mjs',import.meta.url).toString();const document=await pdfjs.getDocument({data:new Uint8Array(await template.arrayBuffer())}).promise;if(document.numPages!==13)throw new Error('模板必须恰好包含 13 页');const pages:string[]=[];for(let i=1;i<=13;i++){const page=await document.getPage(i),viewport=page.getViewport({scale:.55}),canvas=document.createElement('canvas'),context=canvas.getContext('2d');canvas.width=viewport.width;canvas.height=viewport.height;if(context)await page.render({canvas,canvasContext:context,viewport}).promise;pages.push(canvas.toDataURL('image/jpeg',.78));}if(!cancelled){setTemplatePages(pages);setMessage('模板已缓存，今日后续订单可直接复用');}}catch(error){if(!cancelled)setMessage(error instanceof Error?error.message:'模板预览失败');}})();return()=>{cancelled=true};},[template]);
  const addUrl=(file:File):Photo=>{const url=URL.createObjectURL(file);urls.current.push(url);return{id:`${file.name}-${file.size}-${crypto.randomUUID()}`,file,url}};
  const chooseTemplate=async(event:ChangeEvent<HTMLInputElement>)=>{const file=event.target.files?.[0]??null;setTemplate(file);await saveTemplate(file);};
  const onCover=(event:ChangeEvent<HTMLInputElement>)=>{const file=event.target.files?.[0];if(file){const photo=addUrl(file);setCover(photo);setTransforms(current=>({...current,[photo.id]:defaultTransform}));setSelectedPage(0);}};
  const onPhotos=(event:ChangeEvent<HTMLInputElement>)=>{const selected=Array.from(event.target.files??[]).map(addUrl),nextTransforms:Record<string,Transform>={};selected.forEach(photo=>nextTransforms[photo.id]=defaultTransform);setPhotos(selected);setTransforms(current=>({...current,...nextTransforms}));setArrangement(makeArrangement(selected));setMessage(selected.length?`已将 ${selected.length} 张图片排入 12 个月份`:'等待上传内页图片');};
  const selectedPhoto=selectedPage===0?cover:arrangement[selectedPage-1];const selectedTransform=selectedPhoto?transforms[selectedPhoto.id]??defaultTransform:defaultTransform;
  const updateTransform=(key:keyof Transform,value:number)=>{if(!selectedPhoto)return;setTransforms(current=>({...current,[selectedPhoto.id]:{...(current[selectedPhoto.id]??defaultTransform),[key]:value}}));};
  const resetTransform=()=>{if(selectedPhoto)setTransforms(current=>({...current,[selectedPhoto.id]:defaultTransform}));};
  const canGenerate=Boolean(template&&cover&&arrangement.length===12);const rounds=photos.length?Math.ceil(12/photos.length):0;const usage=useMemo(()=>{const counts=new Map<string,number>();arrangement.forEach(photo=>counts.set(photo.id,(counts.get(photo.id)??0)+1));return counts;},[arrangement]);
  const swap=(index:number,direction:-1|1)=>{const target=index+direction;if(target<0||target>=arrangement.length)return;setArrangement(current=>{const next=[...current];[next[index],next[target]]=[next[target],next[index]];return next;});setSelectedPage(target+1);};
  const newOrder=()=>{setCover(null);setPhotos([]);setArrangement([]);setTransforms({});setSelectedPage(0);setFileName(orderName());setMessage('新订单已建立，模板保持不变');setOrderKey(value=>value+1);};
  const clearTemplate=async()=>{setTemplate(null);setTemplatePages([]);await saveTemplate(null);setMessage('已清除缓存模板');};

  const generatePdf=async()=>{if(!template||!cover||arrangement.length!==12)return;setBusy(true);setMessage('正在优化图片并生成 300 DPI PDF…');try{const pdf=await import('pdf-lib'),outputPdf=await pdf.PDFDocument.load(await template.arrayBuffer());if(outputPdf.getPageCount()!==13)throw new Error('模板必须恰好包含 13 页');
    const coverImage=await outputPdf.embedJpg(await optimizedJpeg(cover.file,2245,2128,fitMode,transforms[cover.id]??defaultTransform)),coverPage=outputPdf.getPage(0);coverPage.drawImage(coverImage,{x:28.346,y:303.021,width:538.583,height:510.522});coverPage.drawRectangle({x:28.346,y:303.021,width:538.583,height:510.522,borderColor:pdf.rgb(1,1,1),borderWidth:2.5});
    for(let index=0;index<12;index++){const page=outputPdf.getPage(index+1),photo=arrangement[index],image=await outputPdf.embedJpg(await optimizedJpeg(photo.file,2245,1710,fitMode,transforms[photo.id]??defaultTransform));page.pushOperators(pdf.pushGraphicsState(),pdf.moveTo(28.346,813.543),pdf.lineTo(28.346,403.702),pdf.appendBezierCurve(64.712,419.938,134.255,437.163,220.365,443.668),pdf.appendBezierCurve(316.654,450.94,357.241,436.909,396.52,422.877),pdf.appendBezierCurve(436.099,408.739,474.352,394.6,566.929,402.257),pdf.lineTo(566.929,813.543),pdf.lineTo(28.346,813.543),pdf.clip(),pdf.endPath());page.drawImage(image,{x:28.346,y:402.257,width:538.583,height:411.286});page.pushOperators(pdf.popGraphicsState());page.drawLine({start:{x:28.346,y:813.543},end:{x:28.346,y:403.702},color:pdf.rgb(1,1,1),thickness:2.5});page.drawSvgPath('M 28.346 403.702 C 64.712 419.938, 134.255 437.163, 220.365 443.668 C 316.654 450.94, 357.241 436.909, 396.52 422.877 C 436.099 408.739, 474.352 394.6, 566.929 402.257',{borderColor:pdf.rgb(1,1,1),borderWidth:2.5});page.drawLine({start:{x:566.929,y:402.257},end:{x:566.929,y:813.543},color:pdf.rgb(1,1,1),thickness:2.5});page.drawLine({start:{x:566.929,y:813.543},end:{x:28.346,y:813.543},color:pdf.rgb(1,1,1),thickness:2.5});}
    const safeName=cleanFileName(fileName);outputPdf.setTitle(safeName);outputPdf.setCreator('挂历工房');const bytes=await outputPdf.save({useObjectStreams:true,addDefaultPage:false}),blob=new Blob([bytes as BlobPart],{type:'application/pdf'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=`${safeName}.pdf`;anchor.click();URL.revokeObjectURL(url);const nextRecent=[safeName,...recent.filter(item=>item!==safeName)].slice(0,6);setRecent(nextRecent);localStorage.setItem('calendar-recent',JSON.stringify(nextRecent));setMessage(`生成完成 · ${(blob.size/1024/1024).toFixed(1)} MB · 13 页`);
  }catch(error){setMessage(error instanceof Error?error.message:'生成失败，请重试');}finally{setBusy(false);}};

  const pageItems=[{label:'封面',photo:cover},...months.map((label,index)=>({label,photo:arrangement[index]}))];
  return <main><header className="topbar"><div className="brand"><span className="brand-mark">CAL</span><span>挂历工房</span></div><div className="top-actions"><button onClick={newOrder}>＋ 新订单·保留模板</button><div className="privacy"><span className="privacy-dot"/>图片仅在本机处理</div></div></header>
    <section className="hero compact"><div><p className="eyebrow">A4 · 13 页 · 300 DPI</p><h1>批量制作，<br/>每份都精准。</h1></div><div className="hero-copy"><b>当前订单</b><input value={fileName} onChange={event=>setFileName(event.target.value)} aria-label="导出文件名"/><small>导出时自动添加 .pdf</small></div></section>
    <section className="workspace"><aside className="control-panel"><div className="section-heading"><span>01</span><div><h2>订单文件</h2><p>模板会在本机自动保留</p></div></div>
      <label className={`upload-row ${template?'ready':''}`}><span className="upload-icon">PDF</span><span><b>挂历模板</b><small>{template?.name??'上传 13 页 PDF'}</small></span><em>{template?'更换':'选择'}</em><input type="file" accept="application/pdf" onChange={chooseTemplate}/></label>
      <label className={`upload-row ${cover?'ready':''}`}><span className="upload-icon image-icon">封</span><span><b>封面图片</b><small>{cover?.file.name??'单独入口，不参与随机'}</small></span><em>{cover?'更换':'选择'}</em><input key={`cover-${orderKey}`} type="file" accept="image/*" onChange={onCover}/></label>
      <label className={`upload-row ${photos.length?'ready':''}`}><span className="upload-icon image-icon">图</span><span><b>内页图片</b><small>{photos.length?`${photos.length} 张 · 最多重复 ${rounds} 轮`:'可多选，建议 1–12 张'}</small></span><em>{photos.length?'重选':'选择'}</em><input key={`inside-${orderKey}`} type="file" accept="image/*" multiple onChange={onPhotos}/></label>
      <div className="mode-field"><span><b>图片填充方式</b><small>单张仍可继续缩放和移动</small></span><div className="segmented"><button className={fitMode==='cover'?'active':''} onClick={()=>setFitMode('cover')}>裁切铺满</button><button className={fitMode==='stretch'?'active':''} onClick={()=>setFitMode('stretch')}>直接拉伸</button></div></div>
      <div className="rule-card"><b>高频生产流程</b><p>导出后点击“新订单”，只清空客户图片与调整参数，模板保留不变。</p><button onClick={clearTemplate}>清除缓存模板</button></div>
      {recent.length>0&&<div className="recent"><b>最近导出</b>{recent.map(item=><span key={item}>{item}.pdf</span>)}</div>}
    </aside>
    <section className="preview-panel"><div className="preview-head"><div className="section-heading"><span>02</span><div><h2>完整页面预览</h2><p>点击任意页，单独调整该图片</p></div></div><button className="shuffle-button" disabled={!photos.length} onClick={()=>setArrangement(makeArrangement(photos))}>↻ 重新随机</button></div>
      <div className="adjust-panel"><div><b>{pageItems[selectedPage].label}</b><small>{selectedPhoto?.file.name??'请先上传该页图片'}</small></div><label>缩放 <input type="range" min="1" max="2.5" step=".01" value={selectedTransform.scale} disabled={!selectedPhoto} onChange={e=>updateTransform('scale',Number(e.target.value))}/><output>{selectedTransform.scale.toFixed(2)}×</output></label><label>左右 <input type="range" min="-50" max="50" step="1" value={selectedTransform.x} disabled={!selectedPhoto} onChange={e=>updateTransform('x',Number(e.target.value))}/><output>{selectedTransform.x}</output></label><label>上下 <input type="range" min="-50" max="50" step="1" value={selectedTransform.y} disabled={!selectedPhoto} onChange={e=>updateTransform('y',Number(e.target.value))}/><output>{selectedTransform.y}</output></label><button onClick={resetTransform} disabled={!selectedPhoto}>重置</button></div>
      <div className="page-grid">{pageItems.map((item,index)=>{const adjust=item.photo?transforms[item.photo.id]??defaultTransform:defaultTransform;return <article className={`page-card ${selectedPage===index?'selected':''}`} key={`${item.label}-${index}`} onClick={()=>setSelectedPage(index)}><div className="a4-page">{templatePages[index]?<img className="template-page" src={templatePages[index]} alt={`${item.label}模板预览`}/>:<div className="page-skeleton"><span/><span/><span/></div>}{item.photo&&<div className={`custom-photo ${index===0?'cover-photo':'inner-photo'}`}><img src={item.photo.url} alt={`${item.label}-${item.photo.file.name}`} className={fitMode==='stretch'?'stretch':''} style={{transform:`translate(${adjust.x}%, ${adjust.y}%) scale(${adjust.scale})`}}/></div>}<span className="page-number">{String(index+1).padStart(2,'0')}</span></div><div className="page-caption"><span><b>{item.label}</b><small>{item.photo?.file.name??'待排入'}</small></span>{index>0&&item.photo&&<em>共 {usage.get(item.photo.id)} 次</em>}</div>{index>0&&<div className="move-buttons"><button disabled={index===1||!item.photo} onClick={event=>{event.stopPropagation();swap(index-1,-1)}}>←</button><button disabled={index===12||!item.photo} onClick={event=>{event.stopPropagation();swap(index-1,1)}}>→</button></div>}</article>})}</div>
    </section></section>
    <footer className="export-bar"><div><span className={`status-dot ${canGenerate?'ok':''}`}/><div><b>{message}</b><small>{canGenerate?`${cleanFileName(fileName)}.pdf`:'需要模板、封面图和至少 1 张内页图'}</small></div></div><button className="generate-button" disabled={!canGenerate||busy} onClick={generatePdf}>{busy?'生成中…':'生成 300 DPI PDF'}<span>→</span></button></footer>
  </main>;
}
