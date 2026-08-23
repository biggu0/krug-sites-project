'use client';

import { PointerEvent, useRef, useState } from 'react';

export type Region={x:number;y:number;width:number;height:number;curve:number};
export type TemplateRegions={cover:Region;inner:Region};

type Props={pages:string[];value:TemplateRegions;onSave:(value:TemplateRegions)=>void;onClose:()=>void};

export default function TemplateEditor({pages,value,onSave,onClose}:Props){
  const [mode,setMode]=useState<'cover'|'inner'>('cover');
  const [regions,setRegions]=useState(value);
  const stage=useRef<HTMLDivElement>(null);
  const start=useRef<{x:number;y:number}|null>(null);
  const region=regions[mode];
  const point=(event:PointerEvent)=>{const rect=stage.current!.getBoundingClientRect();return{x:Math.max(0,Math.min(100,(event.clientX-rect.left)/rect.width*100)),y:Math.max(0,Math.min(100,(event.clientY-rect.top)/rect.height*100))};};
  const begin=(event:PointerEvent)=>{event.currentTarget.setPointerCapture(event.pointerId);start.current=point(event);};
  const move=(event:PointerEvent)=>{if(!start.current)return;const end=point(event),origin=start.current,next={...region,x:Math.min(origin.x,end.x),y:Math.min(origin.y,end.y),width:Math.abs(end.x-origin.x),height:Math.abs(end.y-origin.y)};setRegions(current=>({...current,[mode]:next}));};
  const end=()=>{start.current=null;};
  const curve=Math.max(-15,Math.min(15,region.curve));
  const edge=curve>=0?100-curve:100,center=curve>=0?100:100+curve;
  const clip=mode==='inner'?`polygon(0 0,100% 0,100% ${edge}%,75% ${(edge+center)/2}%,50% ${center}%,25% ${(edge+center)/2}%,0 ${edge}%)`:'none';
  return <div className="editor-backdrop"><section className="template-editor"><header><div><b>绘制定制区域</b><span>在页面上按住鼠标拖出需要被图片完全覆盖的范围</span></div><button onClick={onClose}>×</button></header><div className="editor-tabs"><button className={mode==='cover'?'active':''} onClick={()=>setMode('cover')}>封面区域</button><button className={mode==='inner'?'active':''} onClick={()=>setMode('inner')}>内页区域</button></div><div className="editor-body"><div className="draw-stage" ref={stage} onPointerDown={begin} onPointerMove={move} onPointerUp={end}><img src={pages[mode==='cover'?0:1]} alt="模板页面" draggable={false}/><div className="draw-region" style={{left:`${region.x}%`,top:`${region.y}%`,width:`${region.width}%`,height:`${region.height}%`,clipPath:clip}}><span>图片覆盖区</span></div></div><aside><b>区域参数</b><p>左 {region.x.toFixed(1)}% · 上 {region.y.toFixed(1)}%</p><p>宽 {region.width.toFixed(1)}% · 高 {region.height.toFixed(1)}%</p>{mode==='inner'&&<label><span>底边弧度 <output>{region.curve.toFixed(1)}%</output></span><input type="range" min="-15" max="15" step=".5" value={region.curve} onChange={event=>setRegions(current=>({...current,inner:{...current.inner,curve:Number(event.target.value)}}))}/><small>正数中间向下，负数中间向上</small></label>}<p className="editor-tip">画框时请稍微覆盖到白色边界外侧，可避免导出后漏出细小空白。</p></aside></div><footer><button onClick={onClose}>取消</button><button className="save-region" disabled={!region.width||!region.height} onClick={()=>onSave(regions)}>保存区域</button></footer></section></div>;
}
