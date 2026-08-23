'use client';

import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';

type Photo = { id: string; file: File; url: string };
type FitMode = 'stretch' | 'cover';

const months = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];

function shuffle<T>(items: T[]) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function makeArrangement(photos: Photo[]) {
  if (!photos.length) return [];
  const result: Photo[] = [];
  let previousId = '';
  while (result.length < 12) {
    let round = shuffle(photos);
    if (round.length > 1 && round[0].id === previousId) [round[0], round[1]] = [round[1], round[0]];
    round = round.slice(0, 12 - result.length);
    result.push(...round);
    previousId = result.at(-1)?.id ?? '';
  }
  return result;
}

async function optimizedJpeg(file: File, width: number, height: number, fit: FitMode) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width); canvas.height = Math.round(height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('无法创建图像处理画布');
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  if (fit === 'stretch') context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  else {
    const scale = Math.max(canvas.width / bitmap.width, canvas.height / bitmap.height);
    const w = bitmap.width * scale, h = bitmap.height * scale;
    context.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }
  bitmap.close();
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
    value => value ? resolve(value) : reject(new Error('图像压缩失败')), 'image/jpeg', .9,
  ));
  return new Uint8Array(await blob.arrayBuffer());
}

export default function Home() {
  const [template, setTemplate] = useState<File | null>(null);
  const [cover, setCover] = useState<Photo | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [arrangement, setArrangement] = useState<Photo[]>([]);
  const [fitMode, setFitMode] = useState<FitMode>('cover');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('等待上传文件');
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach(URL.revokeObjectURL), []);

  const addUrl = (file: File): Photo => {
    const url = URL.createObjectURL(file); urls.current.push(url);
    return { id: `${file.name}-${file.size}-${crypto.randomUUID()}`, file, url };
  };
  const onCover = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (file) setCover(addUrl(file));
  };
  const onPhotos = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []).map(addUrl);
    setPhotos(selected); setArrangement(makeArrangement(selected));
    setMessage(selected.length ? `已将 ${selected.length} 张图片排入 12 个月份` : '等待上传内页图片');
  };
  const canGenerate = Boolean(template && cover && arrangement.length === 12);
  const rounds = photos.length ? Math.ceil(12 / photos.length) : 0;
  const usage = useMemo(() => {
    const counts = new Map<string, number>();
    arrangement.forEach(photo => counts.set(photo.id, (counts.get(photo.id) ?? 0) + 1));
    return counts;
  }, [arrangement]);

  const swap = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= arrangement.length) return;
    setArrangement(current => { const next = [...current]; [next[index], next[target]] = [next[target], next[index]]; return next; });
  };

  const generatePdf = async () => {
    if (!template || !cover || arrangement.length !== 12) return;
    setBusy(true); setMessage('正在优化图片并生成 300 DPI PDF…');
    try {
      const pdf = await import('pdf-lib');
      const outputPdf = await pdf.PDFDocument.load(await template.arrayBuffer());
      if (outputPdf.getPageCount() !== 13) throw new Error('模板必须恰好包含 13 页');

      const coverImage = await outputPdf.embedJpg(await optimizedJpeg(cover.file, 2245, 2128, fitMode));
      const coverPage = outputPdf.getPage(0);
      coverPage.drawImage(coverImage, { x:28.346, y:303.021, width:538.583, height:510.522 });
      coverPage.drawRectangle({ x:28.346, y:303.021, width:538.583, height:510.522, borderColor:pdf.rgb(1,1,1), borderWidth:2.5 });

      for (let index = 0; index < 12; index++) {
        const page = outputPdf.getPage(index + 1);
        const image = await outputPdf.embedJpg(await optimizedJpeg(arrangement[index].file, 2245, 1710, fitMode));
        page.pushOperators(
          pdf.pushGraphicsState(), pdf.moveTo(28.346,813.543), pdf.lineTo(28.346,403.702),
          pdf.appendBezierCurve(64.712,419.938,134.255,437.163,220.365,443.668),
          pdf.appendBezierCurve(316.654,450.94,357.241,436.909,396.52,422.877),
          pdf.appendBezierCurve(436.099,408.739,474.352,394.6,566.929,402.257),
          pdf.lineTo(566.929,813.543), pdf.lineTo(28.346,813.543), pdf.clip(), pdf.endPath(),
        );
        page.drawImage(image, { x:28.346, y:402.257, width:538.583, height:411.286 });
        page.pushOperators(pdf.popGraphicsState());
        page.drawLine({ start:{x:28.346,y:813.543}, end:{x:28.346,y:403.702}, color:pdf.rgb(1,1,1), thickness:2.5 });
        page.drawSvgPath('M 28.346 403.702 C 64.712 419.938, 134.255 437.163, 220.365 443.668 C 316.654 450.94, 357.241 436.909, 396.52 422.877 C 436.099 408.739, 474.352 394.6, 566.929 402.257', { borderColor:pdf.rgb(1,1,1), borderWidth:2.5 });
        page.drawLine({ start:{x:566.929,y:402.257}, end:{x:566.929,y:813.543}, color:pdf.rgb(1,1,1), thickness:2.5 });
        page.drawLine({ start:{x:566.929,y:813.543}, end:{x:28.346,y:813.543}, color:pdf.rgb(1,1,1), thickness:2.5 });
      }
      outputPdf.setTitle('客户定制挂历'); outputPdf.setCreator('挂历工房');
      const bytes = await outputPdf.save({ useObjectStreams:true, addDefaultPage:false });
      const blob = new Blob([bytes as BlobPart], { type:'application/pdf' });
      const url = URL.createObjectURL(blob), anchor = document.createElement('a');
      anchor.href = url; anchor.download = `calendar-${new Date().toISOString().slice(0,10)}.pdf`; anchor.click(); URL.revokeObjectURL(url);
      setMessage(`生成完成 · ${(blob.size/1024/1024).toFixed(1)} MB · 13 页`);
    } catch (error) { setMessage(error instanceof Error ? error.message : '生成失败，请重试'); }
    finally { setBusy(false); }
  };

  return <main>
    <header className="topbar"><div className="brand"><span className="brand-mark">CAL</span><span>挂历工房</span></div><div className="privacy"><span className="privacy-dot" />图片仅在本机处理</div></header>
    <section className="hero"><div><p className="eyebrow">A4 · 13 页 · 300 DPI</p><h1>从照片到加工文件，<br />一次排好。</h1><p className="hero-copy">封面单独设置，内页按“全部用完再重复”的规则随机排列。</p></div><div className="hero-meta"><strong>01</strong><span>上传</span><strong>02</strong><span>排版</span><strong>03</strong><span>导出</span></div></section>
    <section className="workspace">
      <aside className="control-panel"><div className="section-heading"><span>01</span><div><h2>准备文件</h2><p>选择模板和客户照片</p></div></div>
        <label className={`upload-row ${template?'ready':''}`}><span className="upload-icon">PDF</span><span><b>挂历模板</b><small>{template?.name ?? '上传 13 页 PDF'}</small></span><em>{template?'已选择':'选择'}</em><input type="file" accept="application/pdf" onChange={e=>setTemplate(e.target.files?.[0]??null)} /></label>
        <label className={`upload-row ${cover?'ready':''}`}><span className="upload-icon image-icon">封</span><span><b>封面图片</b><small>{cover?.file.name ?? '单独入口，不参与随机'}</small></span><em>{cover?'更换':'选择'}</em><input type="file" accept="image/*" onChange={onCover} /></label>
        <label className={`upload-row ${photos.length?'ready':''}`}><span className="upload-icon image-icon">图</span><span><b>内页图片</b><small>{photos.length?`${photos.length} 张 · 最多重复 ${rounds} 轮`:'可多选，建议 1–12 张'}</small></span><em>{photos.length?'重选':'选择'}</em><input type="file" accept="image/*" multiple onChange={onPhotos} /></label>
        <div className="mode-field"><span><b>图片填充方式</b><small>适用于封面和全部内页</small></span><div className="segmented"><button className={fitMode==='cover'?'active':''} onClick={()=>setFitMode('cover')}>裁切铺满</button><button className={fitMode==='stretch'?'active':''} onClick={()=>setFitMode('stretch')}>直接拉伸</button></div></div>
        <div className="rule-card"><b>随机规则</b><p>每一轮会用完所有图片后再开始重复，并尽量避免相邻月份重复。</p></div>
      </aside>
      <section className="preview-panel"><div className="preview-head"><div className="section-heading"><span>02</span><div><h2>内页排列</h2><p>{photos.length?`12 页 · ${photos.length} 张原图`:'上传后自动生成排列'}</p></div></div><button className="shuffle-button" disabled={!photos.length} onClick={()=>setArrangement(makeArrangement(photos))}>↻ 重新随机</button></div>
        <div className="month-grid">{months.map((month,index)=>{const photo=arrangement[index]; return <article className={`month-card ${photo?'filled':''}`} key={month}><div className="photo-window">{photo?<img src={photo.url} alt={`${month} - ${photo.file.name}`} className={fitMode==='stretch'?'stretch':''}/>:<span>{String(index+1).padStart(2,'0')}</span>}{photo&&<div className="curve-mask"/>}</div><div className="month-info"><div><b>{month}</b><small>{photo?.file.name??'待排入'}</small></div>{photo&&<span className="usage">共 {usage.get(photo.id)} 次</span>}</div><div className="move-buttons"><button disabled={index===0||!photo} onClick={()=>swap(index,-1)} aria-label={`${month}向前移`}>←</button><button disabled={index===11||!photo} onClick={()=>swap(index,1)} aria-label={`${month}向后移`}>→</button></div></article>})}</div>
      </section>
    </section>
    <footer className="export-bar"><div><span className={`status-dot ${canGenerate?'ok':''}`}/><div><b>{message}</b><small>{canGenerate?'所有文件已就绪':'需要模板、封面图和至少 1 张内页图'}</small></div></div><button className="generate-button" disabled={!canGenerate||busy} onClick={generatePdf}>{busy?'生成中…':'生成 300 DPI PDF'}<span>→</span></button></footer>
  </main>;
}
