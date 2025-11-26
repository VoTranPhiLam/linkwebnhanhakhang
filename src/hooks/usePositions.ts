import React from 'react'
import api from '../api/api'

export interface PositionItem {
  broker?: string
  ticket?: number | string
  symbol?: string
  side?: string
  volume?: number
  open_price?: number
  price_open?: number   // fallback key
  sl?: number
  tp?: number
  profit?: number
  swap?: number
  commission?: number
  ts?: number
  [k: string]: any
}

interface PositionsData {
  byBroker: Record<string, PositionItem[]>
  all: PositionItem[]
  ts: number
}

async function fetchPositions(): Promise<PositionsData> {
  const [rMap, rAll] = await Promise.all([
    api.get("/receiver/positions").then(r => r.data).catch(() => ({})),
    api.get("/receiver/positions_all").then(r => r.data).catch(() => ({ data: [] })),
  ]);
  const rawMap = (rMap && typeof rMap==='object') ? rMap : {}
  const byBroker: Record<string, PositionItem[]> = {}
  Object.entries(rawMap).forEach(([bk, v]: [string, any])=>{
    if (Array.isArray(v)) byBroker[bk] = v
    else if (v && typeof v === 'object') byBroker[bk] = Object.values(v)
    else byBroker[bk] = []
  })
  return {
    byBroker,
    all: Array.isArray(rAll?.data) ? rAll.data : [],
    ts: Date.now()
  }
}

export function usePositions(intervalMs = 1000) {
  const [data, setData] = React.useState<PositionsData>({ byBroker:{}, all:[], ts: Date.now() })
  React.useEffect(()=>{
    let stop = false
    const run = async () => {
      try {
        const d = await fetchPositions()
        if(!stop) setData(d)
      } catch {}
      if(!stop) setTimeout(run, intervalMs)
    }
    run()
    return ()=>{ stop = true }
  }, [intervalMs])
  return data
}

export function getBrokerPositions(data: PositionsData, broker?: string): PositionItem[] {
    if (!broker) return []
    return data.byBroker[broker] || []
  }