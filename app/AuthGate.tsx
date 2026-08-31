'use client';
import {createContext,FormEvent,ReactNode,useContext,useEffect,useState} from 'react';

export type Permission='customization'|'templates'|'accounts';
export type Organization={id:string;name:string;createdAt:number;updatedAt:number};
export type AuthUser={id:number;username:string;permissions:Permission[];organizations:Organization[];organizationIds:string[]};

type StatusPayload={setupRequired:boolean;user?:AuthUser|null;error?:string};
type ActionPayload={ok?:boolean;error?:string};

const AuthContext=createContext<{user:AuthUser;logout:()=>Promise<void>}|null>(null);

export function useAuth(){
  const value=useContext(AuthContext);
  if(!value)throw new Error('AuthGate missing');
  return value;
}

export default function AuthGate({children}:{children:ReactNode}){
  const [loading,setLoading]=useState(true);
  const [setupRequired,setSetupRequired]=useState(false);
  const [user,setUser]=useState<AuthUser|null>(null);
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(false);

  const refresh=async()=>{
    const response=await fetch('/api/auth/status',{cache:'no-store'});
    const data=await response.json() as StatusPayload;
    setSetupRequired(Boolean(data.setupRequired));
    setUser(data.user??null);
    setLoading(false);
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{refresh().catch(()=>{setError('无法连接登录服务');setLoading(false);});},[]);

  const submit=async(event:FormEvent<HTMLFormElement>)=>{
    event.preventDefault();
    const form=new FormData(event.currentTarget),username=String(form.get('username')??''),password=String(form.get('password')??'');
    setBusy(true);
    setError('');
    try{
      const response=await fetch(setupRequired?'/api/auth/setup':'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});
      const data=await response.json() as ActionPayload;
      if(!response.ok)throw new Error(data.error??'操作失败');
      await refresh();
    }catch(reason){
      setError(reason instanceof Error?reason.message:'操作失败');
    }finally{
      setBusy(false);
    }
  };

  const logout=async()=>{
    await fetch('/api/auth/logout',{method:'POST'});
    setUser(null);
  };

  if(loading)return <main className="auth-screen"><div className="auth-loading">正在验证登录状态…</div></main>;
  if(!user)return <main className="auth-screen">
    <section className="login-card">
      <div className="login-brand"><span>JHT</span><div><b>图片处理系统</b><small>SECURE WORKSPACE</small></div></div>
      <h1>{setupRequired?'创建管理员账号':'登录系统'}</h1>
      <p>{setupRequired?'首次使用，请创建系统管理员。密码至少10个字符。':'请输入用户名和密码后进入工作台。'}</p>
      <form onSubmit={submit}>
        <label>用户名<input name="username" autoComplete="username" minLength={3} maxLength={40} required autoFocus/></label>
        <label>密码<input name="password" type="password" autoComplete={setupRequired?'new-password':'current-password'} minLength={10} maxLength={128} required/></label>
        {error&&<div className="login-error">{error}</div>}
        <button disabled={busy}>{busy?'正在处理…':setupRequired?'创建管理员并进入':'登录'}</button>
      </form>
      <small className="privacy-note">密码经过不可逆加密处理；订单图片和模板不会上传到账号服务器。</small>
    </section>
  </main>;
  return <AuthContext.Provider value={{user,logout}}>{children}</AuthContext.Provider>;
}
