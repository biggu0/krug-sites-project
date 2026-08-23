'use client';

import { MouseEvent, useState } from 'react';

export type Point={x:number;y:number};
export type Region={x:number;y:number;width:number;height:number;curve:number;points?:Point[]};
export type TemplateRegions={cover:Region;inner:Region};

type Props={pages:string[];value:TemplateRegions;onSave:(value:TemplateRegions)=>void;onClose:()=>void};

export default function TemplateEditor({pages,value,onSave,onClose}:Props){
  const [mode,setMode]=useState<'cover'|'inner'>('cover');
  const [regions,setRegions]=useState(value);
  const region=regions[mode],points=region.points??[];
  const addPoint=(event:MouseEvent<HTMLDivElement>)=>{const rect=event.currentTarget.getBoundingClientRect(),point={x:(event.clientX-rect.left)/rect.width*100,y:(event.clientY-rect.top)/rect.height*100};setRegions(current=>({...current,[mode]:{...current[mode],points:[...(current[mode].points??[]),point]}}));};
  const updatePoints=(next:Point[])=>setRegions(current=>({...current,[mode]:{...current[mode],points:next}}));
  const polygon=points.map(point=>`${point.x},${point.y}`).join(' ');
  return <div className="editor-backdrop"><section className="template-editor"><header><div><b>描绘自由定制区域</b><span>沿白色边界依次点选，系统会自动闭合轮廓</span></div><button onClick={onClose}>×</button></header><div className="editor-tabs"><button className={mode==='cover'?'active':''} onClick={()=>setMode('cover')}>封面区域</button><button className={mode==='inner'?'active':''} onClick={()=>setMode('inner')}>内页区域</button></div><div className="editor-body"><div className="draw-stage polygon-stage" onClick={addPoint}><img src={pages[mode==='cover'?0:1]} alt="模板页面" draggable={false}/><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polygon points={polygon} className="mask-polygon"/>{points.map((point,index)=><circle key={index} cx={point.x} cy={point.y} r=".7" className="mask-point"/>)}</svg></div><aside><b>自由轮廓</b><p>已设置 {points.length} 个边界点</p><p>从左上角开始，顺时针沿白色区域内侧逐点点击。弧线位置增加点数，形状会更准确。</p><div className="point-actions"><button disabled={!points.length} onClick={()=>updatePoints(points.slice(0,-1))}>撤销一点</button><button disabled={!points.length} onClick={()=>updatePoints([])}>重新描绘</button></div><p className="editor-tip">轮廓应略微进入白色边界内部。图片会在轮廓处被裁掉，因此不会盖住白色区域，也不会漏出旧图片。</p></aside></div><footer><button onClick={onClose}>取消</button><button className="save-region" disabled={points.length<3} onClick={()=>onSave(regions)}>保存自由轮廓</button></footer></section></div>;
}
