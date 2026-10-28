'use client';
import {useCallback,useEffect,useState} from 'react';
import {api,type AssemblyEntry} from './types';
import {ASSEMBLY_STORAGE_KEY,decodeAssemblies} from './assembly-storage';
import {namedEntries} from './assembly-workspace-state';
import type {CadPlacement} from './assembly-cad';

type SavedAssembly={id:string;projectId:string;revision:number;units:'mm';entries:AssemblyEntry[];updated:number|null};
export function useProjectAssembly(projectId:string,live:boolean){
 const [state,setState]=useState({entries:[] as AssemblyEntry[],saved:'[]',revision:0,loaded:false,saving:false,error:'',message:''});
 const [reload,setReload]=useState(0);
 useEffect(()=>{
  let active=true;
  async function load(){
   try{
    const saved=live?await api<SavedAssembly>(`/projects/${encodeURIComponent(projectId)}/assembly`,undefined,'GET',projectId):null;
    let entries=saved?.entries??[],message='';
    if(!saved?.revision){try{entries=decodeAssemblies(localStorage.getItem(ASSEMBLY_STORAGE_KEY))[projectId]??[];if(entries.length)message='Previous browser layout recovered. Save Assembly to keep it with this project.';}catch{message='The previous browser layout could not be read and has been preserved.';}}
    if(active)setState({entries:namedEntries(entries),saved:JSON.stringify(saved?.entries??[]),revision:saved?.revision??0,loaded:true,saving:false,error:'',message});
   }catch(error){if(active)setState(old=>({...old,loaded:false,error:(error as Error).message}));}
  }
  void load();return()=>{active=false;};
 },[projectId,live,reload]);
 const setEntries=useCallback((entries:AssemblyEntry[])=>setState(old=>old.saving?old:{...old,entries,error:'',message:''}),[]);
 async function save(placement:CadPlacement|null,token:string|null){
  const snapshot=state.entries;
  if(!state.loaded||state.saving||!live)return;
  if(snapshot.length&&(!placement||!token))throw new Error('Wait for the current panel positions before saving.');
  setState(old=>({...old,saving:true,error:'',message:''}));
  try{
   const rows=snapshot.map(entry=>{const row=placement!.entries.find(r=>r.id===entry.id);if(!row)throw new Error('A panel placement is missing.');return {...row,label:entry.label};});
   const result=await api<SavedAssembly>(`/projects/${encodeURIComponent(projectId)}/assembly`,{revision:state.revision,entries:rows,token},'PUT',projectId);
   setState(old=>({...old,saved:JSON.stringify(snapshot),revision:result.revision,saving:false,message:'Assembly saved to this project.'}));
  }catch(error){setState(old=>({...old,saving:false,error:(error as Error).message}));}
 }
 return {...state,dirty:JSON.stringify(state.entries)!==state.saved,setEntries,save,reload:()=>setReload(v=>v+1)};
}
