import { useQuery } from '@tanstack/react-query'
import api from '../api/api'
import React from 'react'

const LS_KEY = 'live_refetch_ms'
let initialInterval = 2000
try {
  const v = Number(localStorage.getItem(LS_KEY))
  if (v > 0) initialInterval = v
} catch {}

let listeners: ((v:number)=>void)[] = []
let currentInterval = initialInterval

export function setLiveRefetchInterval(ms: number) {
  if (ms >= 0) {
    currentInterval = ms
    localStorage.setItem(LS_KEY, String(ms))
    listeners.forEach(l => l(ms))
  }
}
export function useLiveRefetchInterval(): number {
  const [v,setV] = React.useState(currentInterval)
  React.useEffect(()=>{
    const l = (nv:number)=>setV(nv)
    listeners.push(l)
    return ()=>{ listeners = listeners.filter(x=>x!==l)}
  },[])
  return v
}

export interface ArbItem {
  _id?: string
  ts?: number
  start_ts?: number
  last_update_ts?: number
  ended_ts?: number
  duration_sec?: number
  version?: number
  symbol?: string
  server?: string
  client?: string
  bid_server?: number
  ask_server?: number
  bid_client?: number
  ask_client?: number
  gap_pts?: number
  trigger1?: boolean
  trigger2?: boolean
  diff1_points_abs?: number
  diff2_points_abs?: number
  digits_server?: number
  digits_client?: number
  server_raw?: string
  client_raw?: string
  category?: string
  reason?: string
  active?: boolean 
}

export interface LiveData {
  live: ArbItem[]
  old: ArbItem[]
  ts: number
}

async function fetchLive(): Promise<{live:ArbItem[], ts:number}> {
  const r = await api.get('/receiver?mode=live')
  const live: ArbItem[] = r.data?.live?.data || []
  live.sort((a,b)=> (b.last_update_ts||b.ts||0) - (a.last_update_ts||a.ts||0))
  const norm = live.map(t => ({
    ...t,
    active: !!(t.trigger1 || t.trigger2),            // NEW
    _id: t._id || `${t.version||0}-${t.server||''}-${t.client||''}-${t.symbol||''}`
  }))
  return { live: norm, ts: r.data?.ts || Date.now()/1000 }
}

async function fetchOld(): Promise<{old:ArbItem[], ts:number}> {
  const r = await api.get('/receiver?mode=old')
  const old: ArbItem[] = r.data?.old?.data || []
  old.sort((a,b)=> (b.ended_ts||0) - (a.ended_ts||0))
  const norm = old.map(t => ({
    ...t,
    active: !!(t.trigger1 || t.trigger2),            // NEW (old thường false)
    _id: t._id || `OLD-${t.version||0}-${t.server||''}-${t.client||''}-${t.symbol||''}-${t.ended_ts||0}`
  }))
  return { old: norm, ts: r.data?.ts || Date.now()/1000 }
}

export function useLiveData() {
  const refetchMs = useLiveRefetchInterval()

  const liveQ = useQuery({
    queryKey: ['arb_live_only'],
    queryFn: fetchLive,
    refetchInterval: refetchMs > 0 ? refetchMs : false,
    staleTime: refetchMs > 0 ? refetchMs : Infinity,
    gcTime: 5*60*1000,
    structuralSharing: true
  })

  // Old triggers: refetch cố định 10s (có thể chỉnh), không phụ thuộc control
  const oldQ = useQuery({
    queryKey: ['arb_old'],
    queryFn: fetchOld,
    refetchInterval: 10000,
    staleTime: 10000,
    gcTime: 5*60*1000,
    structuralSharing: true
  })

  const combined: LiveData | undefined = (liveQ.data || oldQ.data) ? {
    live: liveQ.data?.live || [],
    old: oldQ.data?.old || [],
    ts: liveQ.data?.ts || oldQ.data?.ts || Date.now()/1000
  } : undefined

  return {
    data: combined,
    isLoading: liveQ.isLoading && oldQ.isLoading,
    error: liveQ.error || oldQ.error,
    refetchLive: liveQ.refetch,
    refetchOld: oldQ.refetch
  }
}