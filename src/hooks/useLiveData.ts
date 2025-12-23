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
  local_time?: string
  min_volume_server?: number
  min_volume_client?: number
}

export interface LiveData {
  live: ArbItem[]
  old: ArbItem[]
  ts: number
}

async function fetchLive(): Promise<{live:ArbItem[], ts:number}> {
  const LIVE_MAX_AGE_SEC = Number((import.meta as any).env?.VITE_LIVE_MAX_AGE_SEC || "10");
  const nowSec = Date.now() / 1000;

  try {
    const res = await api.get("/receiver", { params: { mode: "live" } });
    const rawItems: ArbItem[] = Array.isArray(res.data?.live?.data)
      ? res.data.live.data
      : [];

    const live = LIVE_MAX_AGE_SEC > 0
      ? rawItems.filter((item) => {
          const lastRaw =
            item.last_update_ts ?? item.ts ?? item.start_ts ?? 0;
          let lastSec = typeof lastRaw === "number"
            ? lastRaw
            : Number(lastRaw) || 0;
          if (lastSec > 1e11) lastSec /= 1000; // phòng ms
          if (lastSec <= 0) return false;
          return nowSec - lastSec <= LIVE_MAX_AGE_SEC;
        })
      : rawItems;

    return {
      live,
      ts: Number(res.data?.ts) || Date.now(),
    };
  } catch {
    return { live: [], ts: Date.now() };
  }
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
    refetchIntervalInBackground: true,
    staleTime: refetchMs > 0 ? refetchMs : Infinity,
    gcTime: 5 * 60 * 1000,
    structuralSharing: true,
    networkMode: 'always',
  })

  React.useEffect(() => {
    liveQ.refetch()
  }, [refetchMs, liveQ])

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