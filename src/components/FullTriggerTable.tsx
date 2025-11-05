import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ArbItem } from "../hooks/useLiveData";
import { usePositions, getBrokerPositions } from "../hooks/usePositions";
import { Bell, BellOff, Calendar } from "lucide-react";
import React from "react";
import api from "../api/api";

interface Props {
  rows: ArbItem[];
  disableSound?: boolean;
  isOld?: boolean;
}

interface Toast {
  id: string;
  status: "pending" | "success" | "fail";
  msg: string;
  ts: number;
  updated: number;
}

function formatMini(
  price?: number,
  opts?: { symbol?: string; category?: string; digits?: number }
) {
  if (price == null) return { mini: "-", full: "-" };
  const full = String(price);
  const [intPartRaw, decPartRaw = ""] = full.split(".");
  const intPart = intPartRaw.replace(/\D/g, "");
  const decPart = decPartRaw.replace(/\D/g, "");
  const cat = (opts?.category || "").toLowerCase();
  const digits = opts?.digits;
  const takeFirstTwo = (s: string) =>
    s.replace(/\D/g, "").padEnd(2, "-").slice(0, 2) || "--";

  if (digits === 0) {
    const slice3 = full.slice(-3);
    return { mini: takeFirstTwo(slice3), full };
  }
  if (cat.includes("fx") || cat.includes("cross") || cat.includes("exotic")) {
    if (digits === 5 || digits === 3) {
      const numeric = intPart + decPart;
      const last3 = numeric.slice(-3);
      return { mini: takeFirstTwo(last3), full };
    }
  }
  if (cat.includes("metal")) {
    if (digits === 2) {
      const last5 = full.slice(-5);
      const nums = last5.replace(/\D/g, "");
      return { mini: takeFirstTwo(nums), full };
    }
    if (digits === 3) {
      const numeric = intPart + decPart;
      const last3 = numeric.slice(-3);
      return { mini: takeFirstTwo(last3), full };
    }
  }
  if (cat.includes("crypto")) {
    if (digits && digits > 0) {
      if (intPart.length >= 3) return { mini: intPart.slice(-3, -1), full };
    }
    const last6 = full.slice(-6);
    return { mini: takeFirstTwo(last6), full };
  }
  if (intPart.length >= 2) return { mini: intPart.slice(-2), full };
  return { mini: takeFirstTwo(full), full };
}

const MERGE_TOASTS = true;
const SOUND_ALERT = "/sounds/lechgia.mp3";
const SOUND_VOLUME = Number((import.meta as any).env?.VITE_SOUND_VOLUME || "1");

export default function FullTriggerTable({ rows, disableSound, isOld }: Props) {
  // ===== Core refs / states =====
  const positionsData = usePositions(1000);
  const stableRef = useRef<
    Record<string, { row: ArbItem; firstOrder: number; lastSeen: number }>
  >({});
  const orderRef = useRef(0);
  const prevKeysRef = useRef<Set<string>>(new Set());
  const inFlightKeyRef = useRef<Set<string>>(new Set());
  const pendingRef = useRef<Record<string, boolean>>({});
  const pendingTimeRef = useRef<Record<string, number>>({});
  const pendingMetaRef = useRef<
    Record<
      string,
      {
        action: "TRADE" | "CLOSE" | "CANCEL_PENDING";
        broker: string;
        symbolOrTicket: string;
      }
    >
  >({});
  const audioAlertRef = useRef<HTMLAudioElement | null>(null);
  const soundUnlockedRef = useRef(false);
  const pendingPlayRef = useRef(false);

  // Unique ID generator cho signal (tránh phụ thuộc format tự ráp dễ lệch với exec)
  const genSignalId = useRef<{ next: () => string }>({
    next: (() => {
      let c = 0;
      return () => `SIG_${Date.now()}_${(c++).toString(36)}`;
    })(),
  });

  const [deletedKeys, setDeletedKeys] = useState<Set<string>>(() => new Set());

  // === NEW: hidden triggers (live only) ===
  const [hiddenMap, setHiddenMap] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem("hiddenMapV1");
      if (raw) return JSON.parse(raw) || {};
    } catch {}
    return {};
  });
  const [hideTtlMins, setHideTtlMins] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem("hideTtlMins"));
      return v >= 0 ? v : 0;
    } catch {
      return 0;
    }
  });
  const [hideModalOpen, setHideModalOpen] = useState(false);

  useEffect(() => {
    localStorage.setItem("hiddenMapV1", JSON.stringify(hiddenMap));
  }, [hiddenMap]);
  useEffect(() => {
    localStorage.setItem("hideTtlMins", String(hideTtlMins));
  }, [hideTtlMins]);

  // Tự động unhide khi quá TTL
  useEffect(() => {
    if (isOld) return;
    const iv = setInterval(() => {
      if (hideTtlMins <= 0) return;
      const now = Date.now();
      setHiddenMap((m) => {
        let changed = false;
        const nm: Record<string, number> = {};
        Object.entries(m).forEach(([k, t]) => {
          if (now - t < hideTtlMins * 60000) nm[k] = t;
          else changed = true;
        });
        return changed ? nm : m;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, [hideTtlMins, isOld]);

  const isHiddenActive = (k: string) => {
    if (isOld) return false;
    const ts = hiddenMap[k];
    if (!ts) return false;
    if (hideTtlMins > 0 && Date.now() - ts >= hideTtlMins * 60000) return false;
    return true;
  };

  const hiddenRowsActive: ArbItem[] = useMemo(() => {
    if (isOld) return [];
    return rows.filter((r) =>
      isHiddenActive(`${r.server || ""}|${r.client || ""}|${r.symbol || ""}`)
    );
  }, [rows, hiddenMap, hideTtlMins, isOld]);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pendingData, setPendingData] = useState<any[]>([]);
  const [execFetchMs] = useState(1400);

  const [serverFilter, setServerFilter] = useState("ALL");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [combinedSearch, setCombinedSearch] = useState("");
  const [volServer, setVolServer] = useState<Record<string, string>>({});
  const [volClient, setVolClient] = useState<Record<string, string>>({});
  const [oldMaxAgeSec, setOldMaxAgeSec] = useState<number>(isOld ? 600 : 0);
  const [timeTick, setTimeTick] = useState(() => Date.now() / 1000);
  const [expandedBrokers, setExpandedBrokers] = useState<Set<string>>(
    new Set()
  );
  const [posModal, setPosModal] = useState<
    null | { mode: "all" } | { mode: "broker"; broker: string }
  >(null);

  // Quiet schedule (global bảng new) + mute từng hàng (có thời gian hết hạn)
  const [quietFrom, setQuietFrom] = useState<string>(
    () => localStorage.getItem("quietFrom") || ""
  );
  const [quietTo, setQuietTo] = useState<string>(
    () => localStorage.getItem("quietTo") || ""
  );
  const [quietPanelOpen, setQuietPanelOpen] = useState(false);
  const quietBtnRef = useRef<HTMLButtonElement | null>(null);
  const [quietBtnRect, setQuietBtnRect] = useState<DOMRect | null>(null);

  // rowMute: { muted: boolean; until: timestamp|null }
  const [rowMute, setRowMute] = useState<
    Record<string, { muted: boolean; until: number | null }>
  >(() => {
    try {
      // Ưu tiên format mới V2, migrate từ V1 (boolean map) nếu có
      const v2 = localStorage.getItem("rowMuteV2");
      if (v2) return JSON.parse(v2) || {};
      const v1 = localStorage.getItem("rowMuteV1");
      if (v1) {
        const old = JSON.parse(v1) || {};
        const conv: Record<string, { muted: boolean; until: number | null }> =
          {};
        Object.keys(old).forEach(
          (k) => (conv[k] = { muted: !!old[k], until: null })
        );
        return conv;
      }
    } catch {}
    return {};
  });
  const [editingRowMute, setEditingRowMute] = useState<string | null>(null);

  useEffect(
    () => localStorage.setItem("rowMuteV2", JSON.stringify(rowMute)),
    [rowMute]
  );
  useEffect(
    () => localStorage.setItem("quietFrom", quietFrom || ""),
    [quietFrom]
  );
  useEffect(() => localStorage.setItem("quietTo", quietTo || ""), [quietTo]);

  const isWithinQuiet = () => {
    if (isOld) return false;
    if (!quietFrom || !quietTo) return false;
    const parse = (s: string) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
      if (!m) return null;
      const h = +m[1],
        mm = +m[2];
      if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
      return h * 60 + mm;
    };
    const a = parse(quietFrom),
      b = parse(quietTo);
    if (a == null || b == null || a === b) return false;
    const cur = new Date().getHours() * 60 + new Date().getMinutes();
    if (a < b) return cur >= a && cur < b;
    return cur >= a || cur < b; // qua đêm
  };

  const isRowMuted = (k: string) => {
    const rec = rowMute[k];
    if (!rec) return false;
    if (rec.until && Date.now() > rec.until) return false; // đã hết hạn
    return rec.muted;
  };

  // Tự động gỡ mute khi hết hạn
  useEffect(() => {
    const iv = setInterval(() => {
      let changed = false;
      const now = Date.now();
      setRowMute((old) => {
        const copy = { ...old };
        Object.entries(old).forEach(([k, v]) => {
          if (v.muted && v.until && now > v.until) {
            copy[k] = { muted: false, until: null };
            changed = true;
          }
        });
        return changed ? copy : old;
      });
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  const nowSec = () => Date.now() / 1000;
  const keyOf = (r: ArbItem) =>
    `${r.server || ""}|${r.client || ""}|${r.symbol || ""}`;

  // ===== Toast helpers =====
  const upsertToast = (
    setToastsFn: React.Dispatch<React.SetStateAction<Toast[]>>,
    id: string,
    status: Toast["status"],
    msg: string,
    onlyUpdate = false
  ) => {
    setToastsFn((lst) => {
      const idx = lst.findIndex((t) => t.id === id);
      if (idx >= 0) {
        const clone = [...lst];
        const old = clone[idx];
        clone[idx] = { ...old, status, msg, updated: Date.now() };
        return clone;
      }
      if (onlyUpdate) return lst;
      return [...lst, { id, status, msg, ts: Date.now(), updated: Date.now() }];
    });
  };

  const makeLabel = (action: "TRADE" | "CLOSE" | "CANCEL_PENDING") =>
    action === "CLOSE"
      ? "Đóng lệnh"
      : action === "CANCEL_PENDING"
      ? "Hủy lệnh chờ"
      : "Mở lệnh";

  const playBeep = (freq = 880, durMs = 120) => {
    try {
      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(g);
      g.connect(ctx.destination);
      g.gain.value = 0.35;
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, durMs);
    } catch {}
  };

  const playSound = () => {
    if (isOld) return;
    if (isWithinQuiet()) return;
    if (disableSound) return;
    if (!soundUnlockedRef.current) {
      pendingPlayRef.current = true;
      return;
    }
    const a = audioAlertRef.current;
    if (a) {
      try {
        a.currentTime = 0;
        a.play().catch(() => playBeep(660));
      } catch {
        playBeep(660);
      }
    } else playBeep(660);
  };

  const finalizeToast = (
    id: string,
    action: "TRADE" | "CLOSE" | "CANCEL_PENDING",
    broker: string,
    symbolOrTicket: string,
    ok: boolean,
    error: string | undefined,
    setToastsFn: React.Dispatch<React.SetStateAction<Toast[]>>,
    createIfMissing = true
  ) => {
    const label = makeLabel(action);
    const msg = `${label} ${broker} ${symbolOrTicket} ${
      ok ? "THÀNH CÔNG" : "THẤT BẠI"
    }${!ok && error ? ` (${error})` : ""}`;
    upsertToast(
      setToastsFn,
      id,
      ok ? "success" : "fail",
      msg,
      MERGE_TOASTS && !createIfMissing
    );
    // âm thanh chỉ bảng new
    if (
      !isOld &&
      action !== "TRADE" &&
      action !== "CLOSE" &&
      action !== "CANCEL_PENDING"
    ) {
      playSound();
    }
  };

  const sendSignal = async (payload: any) => {
    const action: "TRADE" | "CLOSE" | "CANCEL_PENDING" =
      payload.action === "CLOSE"
        ? "CLOSE"
        : payload.action === "CANCEL_PENDING"
        ? "CANCEL_PENDING"
        : "TRADE";
    const symbol = payload.symbol != null ? String(payload.symbol) : "";
    const ticket = payload.ticket != null ? String(payload.ticket) : "";
    const symbolOrTicket = symbol || ticket;
    const id = payload.id || genSignalId.current.next();
    payload.id = id;

    if (action === "CLOSE" && !ticket)
      return { ok: false, error: "missing_ticket" };

    pendingRef.current[id] = true;
    pendingTimeRef.current[id] = Date.now();
    pendingMetaRef.current[id] = {
      action,
      broker: payload.broker,
      symbolOrTicket: symbolOrTicket,
    };

    upsertToast(
      setToasts,
      id,
      "pending",
      `${makeLabel(action)} ${payload.broker} ${symbolOrTicket}...`
    );

    try {
      const r = await api.post("/api/push_signal", payload);
      const js = r.data;
      if (!js.ok) {
        // Fail ngay tại forward -> finalize FAIL
        delete pendingRef.current[id];
        delete pendingMetaRef.current[id];
        finalizeToast(
          id,
          action,
          payload.broker,
          symbolOrTicket,
          false,
          js.error || String(r.status),
          setToasts,
          true
        );
      }
      return js;
    } catch (e: any) {
      delete pendingRef.current[id];
      delete pendingMetaRef.current[id];
      finalizeToast(
        id,
        action,
        payload.broker,
        symbolOrTicket,
        false,
        "network",
        setToasts,
        true
      );
      return { ok: false, error: "network" };
    }
  };

  // ===== Derived =====
  const displayRows = useMemo(
    () =>
      Object.values(stableRef.current)
        .sort((a, b) => a.firstOrder - b.firstOrder)
        .map((s) => s.row),
    [rows]
  );

  const servers = useMemo(() => {
    const s = new Set<string>();
    displayRows.forEach((r) => r.server && s.add(r.server));
    return Array.from(s).sort();
  }, [displayRows]);

  const categories = useMemo(() => {
    const s = new Set<string>();
    displayRows.forEach((r) => r.category && s.add(r.category));
    return Array.from(s).sort();
  }, [displayRows]);

  const filtered = useMemo(() => {
    const q = combinedSearch.trim().toLowerCase();
    const now = Date.now() / 1000;
    return displayRows.filter((r) => {
      const k = keyOf(r);
      if (deletedKeys.has(k)) return false;
      if (!isOld && isHiddenActive(k)) return false; // NEW: loại bỏ hàng đang ẩn ở live
      if (serverFilter !== "ALL" && r.server !== serverFilter) return false;
      if (categoryFilter !== "ALL" && r.category !== categoryFilter)
        return false;
      if (q) {
        const match =
          (r.symbol || "").toLowerCase().includes(q) ||
          (r.server || "").toLowerCase().includes(q) ||
          (r.client || "").toLowerCase().includes(q);
        if (!match) return false;
      }
      if (isOld) {
        const endTs = r.ended_ts || r.last_update_ts || r.ts || 0;
        if (endTs > 0 && oldMaxAgeSec > 0 && now - endTs > oldMaxAgeSec)
          return false;
      }
      return true;
    });
  }, [
    displayRows,
    serverFilter,
    categoryFilter,
    combinedSearch,
    isOld,
    oldMaxAgeSec,
    timeTick,
    deletedKeys,
    hiddenMap, // NEW
    hideTtlMins, // NEW
  ]);

  const grouped = useMemo(() => {
    const m = new Map<string, ArbItem[]>();
    filtered.forEach((r) => {
      const key = r.server || "UNKNOWN";
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(r);
    });
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  // ===== Handlers =====
  const toggleExpandBroker = (bk: string) => {
    setExpandedBrokers((s) => {
      const ns = new Set(s);
      ns.has(bk) ? ns.delete(bk) : ns.add(bk);
      return ns;
    });
  };
  const closePosModal = () => setPosModal(null);

  const onTrade = (
    side: "BUY" | "SELL",
    r: ArbItem,
    venue: "server" | "client"
  ) => {
    const k = keyOf(r);
    const vol = parseFloat(
      (venue === "server" ? volServer[k] : volClient[k]) || "0"
    );
    const broker = venue === "server" ? r.server : r.client;
    const rawSymbol =
      venue === "server" ? r.server_raw || r.symbol : r.client_raw || r.symbol;
    if (!broker || !rawSymbol || !vol) return;
    sendSignal({
      broker,
      action: "TRADE",
      symbol: rawSymbol,
      side,
      volume: vol,
      sl_points: 0,
      tp_points: 0,
      max_slippage: 30,
      comment: "WebTrade",
    });
  };

  const closeTicket = (pos: any) => {
    if (!pos || !pos.broker) return;
    const t = Math.abs(parseInt(pos.ticket, 10));
    if (!t) return;
    sendSignal({
      broker: pos.broker,
      action: "CLOSE",
      ticket: t,
      volume: 0,
      max_slippage: 30,
      comment: "WebCloseOne",
    });
  };

  const cancelPending = (pend: any) => {
    if (!pend || !pend.broker) return;
    const t = Math.abs(parseInt(pend.ticket, 10));
    if (!t) return;
    sendSignal({
      broker: pend.broker,
      action: "CANCEL_PENDING",
      ticket: t,
      symbol: pend.symbol,
      comment: "WebCancelPending",
    });
  };

  // ===== Effects =====
  // Maintain stable rows
  useEffect(() => {
    const t = nowSec();
    const currentKeys = new Set<string>();
    rows.forEach((r) => {
      const k = keyOf(r);
      currentKeys.add(k);
      const active = !!(r.trigger1 || r.trigger2);
      if (active) {
        const slot = stableRef.current[k];
        if (!slot) {
          stableRef.current[k] = {
            row: r,
            firstOrder: orderRef.current++,
            lastSeen: t,
          };
        } else {
          slot.row = r;
          slot.lastSeen = t;
        }
      } else if (stableRef.current[k]) {
        delete stableRef.current[k];
      }
    });
    Object.keys(stableRef.current).forEach((k) => {
      if (!currentKeys.has(k)) delete stableRef.current[k];
    });
  }, [rows]);

  // Fetch pending orders (global)
  useEffect(() => {
    let timer: any;
    const loop = async () => {
      try {
        const r = await api.get("/receiver/pending");
        const js = r.data;
        const flat: any[] = [];
        Object.entries(js).forEach(([bk, arr]: any) => {
          if (Array.isArray(arr))
            arr.forEach((o) => {
              if (o && typeof o === "object") {
                flat.push({ ...o, broker: o.broker || bk });
              }
            });
        });
        flat.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        setPendingData(flat);
      } catch {
      } finally {
        timer = setTimeout(loop, 3000);
      }
    };
    loop();
    return () => clearTimeout(timer);
  }, []);

  // Reset server filter if missing
  useEffect(() => {
    if (
      serverFilter !== "ALL" &&
      !displayRows.some((r) => r.server === serverFilter)
    ) {
      setServerFilter("ALL");
    }
  }, [displayRows, serverFilter]);

  // Init volume inputs
  useEffect(() => {
    const keys = filtered.map(keyOf);
    setVolServer((v) => {
      let ch = false;
      const nv = { ...v };
      keys.forEach((k) => {
        if (!(k in nv)) {
          nv[k] = "0.01";
          ch = true;
        }
      });
      return ch ? nv : v;
    });
    setVolClient((v) => {
      let ch = false;
      const nv = { ...v };
      keys.forEach((k) => {
        if (!(k in nv)) {
          nv[k] = "0.01";
          ch = true;
        }
      });
      return ch ? nv : v;
    });
  }, [filtered]);

  // New row sound (only new table)
  useEffect(() => {
    if (isOld) return;
    const cur = new Set(filtered.map(keyOf));
    const playNeeded = [...cur].some(
      (k) => !prevKeysRef.current.has(k) && !isRowMuted(k)
    );
    if (playNeeded) playSound();
    prevKeysRef.current = cur;
  }, [filtered, isOld, rowMute, quietFrom, quietTo]);

  useEffect(() => {
    let timer: any;
    const loop = async () => {
      try {
        const r = await api.get("/receiver/trade_exec");
        const js = r.data;
        const flat: any[] = [];
        Object.values(js || {}).forEach(
          (lst: any) => Array.isArray(lst) && lst.forEach((v) => flat.push(v))
        );
        flat.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        flat.forEach((rec) => {
          const act: "TRADE" | "CLOSE" | "CANCEL_PENDING" =
            rec.action === "CLOSE"
              ? "CLOSE"
              : rec.action === "CANCEL_PENDING"
              ? "CANCEL_PENDING"
              : "TRADE";
          const id = rec.id;
          const symbolStr = String(rec.symbol ?? "");
          const ticketStr = String(rec.ticket ?? "");
          const symOrTk = symbolStr || ticketStr;
          // Giống code cũ finalizeToast...
          if (id && pendingRef.current[id]) {
            finalizeToast(
              id,
              act,
              rec.broker,
              symOrTk,
              !!rec.exec_ok,
              rec.error,
              setToasts,
              true
            );
            delete pendingRef.current[id];
            delete pendingMetaRef.current[id];
            return;
          }
          for (const [pid, meta] of Object.entries(pendingMetaRef.current)) {
            if (!pendingRef.current[pid]) continue;
            if (meta.action !== act || meta.broker !== rec.broker) continue;
            if (
              meta.symbolOrTicket === symOrTk ||
              meta.symbolOrTicket === ticketStr ||
              meta.symbolOrTicket === symbolStr
            ) {
              finalizeToast(
                pid,
                act,
                rec.broker,
                symOrTk,
                !!rec.exec_ok,
                rec.error,
                setToasts,
                true
              );
              delete pendingRef.current[pid];
              delete pendingMetaRef.current[pid];
              break;
            }
          }
        });
      } catch {
      } finally {
        timer = setTimeout(loop, execFetchMs);
      }
    };
    loop();
    return () => clearTimeout(timer);
  }, [execFetchMs]);

  // Cleanup toasts
  useEffect(() => {
    const id = setInterval(() => {
      setToasts((lst) =>
        lst.filter((t) => {
          const age = Date.now() - t.updated;
          if (t.status === "pending") return age < 30000;
          return age < 6000;
        })
      );
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ESC close modal
  useEffect(() => {
    if (!posModal) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePosModal();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [posModal]);

  // Scroll lock modal + padding adjust
  useEffect(() => {
    if (!posModal) return;
    const prevOverflow = document.body.style.overflow;
    const prevPadRight = document.body.style.paddingRight;
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = "hidden";
    if (sbw > 0) document.body.style.paddingRight = sbw + "px";
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPadRight;
    };
  }, [posModal]);

  // Load audio
  useEffect(() => {
    const a = new Audio(SOUND_ALERT);
    a.preload = "auto";
    a.volume = Math.min(1, Math.max(0, SOUND_VOLUME));
    audioAlertRef.current = a;
  }, []);

  // Unlock audio
  useEffect(() => {
    const unlock = () => {
      if (soundUnlockedRef.current) return;
      try {
        const Ctx = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new Ctx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        gain.gain.value = 0.0001;
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        setTimeout(() => {
          try {
            osc.stop();
            ctx.close();
          } catch {}
        }, 30);
      } catch {}
      soundUnlockedRef.current = true;
      if (pendingPlayRef.current) {
        pendingPlayRef.current = false;
        playSound();
      }
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock, { once: false });
    window.addEventListener("keydown", unlock, { once: false });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Old age tick
  useEffect(() => {
    if (!isOld || oldMaxAgeSec <= 0) return;
    const id = setInterval(() => setTimeTick(Date.now() / 1000), 1000);
    return () => clearInterval(id);
  }, [isOld, oldMaxAgeSec]);

  useEffect(() => {
    const TIMEOUT_MS = 8000;
    const iv = setInterval(() => {
      const now = Date.now();
      Object.keys(pendingRef.current).forEach((id) => {
        if (now - (pendingTimeRef.current[id] || 0) > TIMEOUT_MS) {
          const meta = pendingMetaRef.current[id];
          if (meta) {
            finalizeToast(
              id,
              meta.action,
              meta.broker,
              meta.symbolOrTicket,
              false,
              "timeout",
              setToasts,
              true
            );
          }
          delete pendingRef.current[id];
          delete pendingMetaRef.current[id];
          inFlightKeyRef.current.delete(
            `${meta?.broker || ""}|${meta?.action || ""}|${
              meta?.symbolOrTicket || ""
            }`
          );
        }
      });
    }, 1000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    // Nếu nhiều CLOSE pending > 3s -> gợi ý kiểm tra id
    const iv = setInterval(() => {
      const now = Date.now();
      const stuck = Object.keys(pendingRef.current).some((id) => {
        const meta = pendingMetaRef.current[id];
        if (!meta) return false;
        return (
          now - (pendingTimeRef.current[id] || 0) > 3000 &&
          meta.action === "CLOSE"
        );
      });
      if (stuck) {
        // chỉ log console để dev kiểm tra
        // eslint-disable-next-line no-console
        console.warn(
          "[DEBUG] CLOSE signals waiting for trade_exec >3s – kiểm tra backend có gửi id / ticket?"
        );
      }
    }, 4000);
    return () => clearInterval(iv);
  }, []);

  const renderPositionsTable = (list: any[]) => {
    const sorted = [...list].sort(
      (a, b) =>
        (a.broker || "").localeCompare(b.broker || "") ||
        (a.symbol || "").localeCompare(b.symbol || "") ||
        (Number(a.ticket) || 0) - (Number(b.ticket) || 0)
    );
    return (
      <table className="min-w-full text-[11px]">
        <thead>
          <tr className="[&_th]:px-2 [&_th]:py-1 text-[10px] uppercase tracking-wide text-neutral-300 text-center">
            <th>Broker</th>
            <th>Ticket</th>
            <th>Symbol</th>
            <th>Side</th>
            <th>Vol</th>
            <th>Open</th>
            <th>SL</th>
            <th>TP</th>
            <th>Profit</th>
            <th>Time</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const side =
              (p.side || "").toUpperCase() ||
              (p.type == 0 ? "BUY" : p.type == 1 ? "SELL" : "");
            const cls =
              side === "BUY"
                ? "text-emerald-400"
                : side === "SELL"
                ? "text-red-400"
                : "text-neutral-300";
            const tSec = p.ts || p.open_time || p.time;
            const stableKey = `${p.broker || ""}_${
              p.ticket || p.symbol || ""
            }_${p.open_price || p.price_open || ""}`;
            return (
              <tr
                key={stableKey}
                className="border-t border-neutral-700/40 hover:bg-neutral-800/40 text-center"
              >
                <td className="px-2 py-1">{p.broker || "-"}</td>
                <td className="px-2 py-1 font-mono">{p.ticket || "-"}</td>
                <td className="px-2 py-1">{p.symbol || "-"}</td>
                <td className={`px-2 py-1 font-semibold ${cls}`}>
                  {side || "-"}
                </td>
                <td className="px-2 py-1 font-mono">
                  {p.volume ?? p.lots ?? "-"}
                </td>
                <td className="px-2 py-1 font-mono">
                  {p.open_price ?? p.price_open ?? "-"}
                </td>
                <td className="px-2 py-1 font-mono">{p.sl ?? "-"}</td>
                <td className="px-2 py-1 font-mono">{p.tp ?? "-"}</td>
                <td
                  className={`px-2 py-1 font-mono ${
                    Number(p.profit) >= 0 ? "text-emerald-400" : "text-red-400"
                  }`}
                >
                  {p.profit ?? "-"}
                </td>
                <td className="px-2 py-1 font-mono">
                  {tSec ? new Date(tSec * 1000).toLocaleTimeString() : "-"}
                </td>
                <td className="px-2 py-1">
                  <button
                    onClick={() => closeTicket(p)}
                    className="px-2 py-0.5 rounded bg-red-700/80 hover:bg-red-600 text-[10px] font-semibold"
                  >
                    Close
                  </button>
                </td>
              </tr>
            );
          })}
          {!sorted.length && (
            <tr>
              <td
                colSpan={11}
                className="px-3 py-4 text-center text-neutral-500"
              >
                Không có vị thế
              </td>
            </tr>
          )}
        </tbody>
      </table>
    );
  };

  const renderPendingTable = (list: any[]) => {
    const sorted = [...list].sort(
      (a, b) =>
        (a.broker || "").localeCompare(b.broker || "") ||
        (a.symbol || "").localeCompare(b.symbol || "") ||
        (Number(a.ticket) || 0) - (Number(b.ticket) || 0)
    );
    return (
      <table className="min-w-full text-[11px]">
        <thead>
          <tr className="[&_th]:px-2 [&_th]:py-1 text-[10px] uppercase tracking-wide text-neutral-300 text-center">
            <th>Broker</th>
            <th>Ticket</th>
            <th>Symbol</th>
            <th>Type</th>
            <th>Vol</th>
            <th>Price</th>
            <th>SL</th>
            <th>TP</th>
            <th>Time</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((p) => {
            const typ = (p.type || "").toUpperCase();
            const cls = typ.includes("BUY")
              ? "text-emerald-400"
              : typ.includes("SELL")
              ? "text-red-400"
              : "text-neutral-300";
            const tSec = p.ts || p.time;
            const k = `PEND_${p.broker || ""}_${p.ticket || ""}_${
              p.symbol || ""
            }`;
            return (
              <tr
                key={k}
                className="border-t border-neutral-700/40 hover:bg-neutral-800/40 text-center"
              >
                <td className="px-2 py-1">{p.broker || "-"}</td>
                <td className="px-2 py-1 font-mono">{p.ticket || "-"}</td>
                <td className="px-2 py-1">{p.symbol || "-"}</td>
                <td className={`px-2 py-1 font-semibold ${cls}`}>
                  {typ || "-"}
                </td>
                <td className="px-2 py-1 font-mono">
                  {p.volume ?? p.lots ?? "-"}
                </td>
                <td className="px-2 py-1 font-mono">
                  {p.price ?? p.price_open ?? "-"}
                </td>
                <td className="px-2 py-1 font-mono">{p.sl ?? "-"}</td>
                <td className="px-2 py-1 font-mono">{p.tp ?? "-"}</td>
                <td className="px-2 py-1 font-mono">
                  {tSec ? new Date(tSec * 1000).toLocaleTimeString() : "-"}
                </td>
                <td className="px-2 py-1">
                  <button
                    onClick={() => cancelPending(p)}
                    className="px-2 py-0.5 rounded bg-red-700/80 hover:bg-red-600 text-[9px] font-semibold"
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            );
          })}
          {!sorted.length && (
            <tr>
              <td
                colSpan={10}
                className="px-3 py-4 text-center text-neutral-500"
              >
                Không có lệnh chờ
              </td>
            </tr>
          )}
        </tbody>
      </table>
    );
  };

  const renderAllPositionsSummary = () => {
    // Union broker có position hoặc chỉ có pending
    const posByBroker: Record<
      string,
      ReturnType<typeof getBrokerPositions>
    > = {};
    positionsData.all.forEach((p) => {
      const bk = p.broker || "-";
      if (!posByBroker[bk]) posByBroker[bk] = [];
      posByBroker[bk].push(p);
    });
    const pendingMap: Record<string, any[]> = {};
    pendingData.forEach((p) => {
      const bk = p.broker || "-";
      (pendingMap[bk] ||= []).push(p);
    });
    const brokers = Array.from(
      new Set([...Object.keys(posByBroker), ...Object.keys(pendingMap)])
    ).sort((a, b) => a.localeCompare(b));

    if (!brokers.length)
      return (
        <div className="text-center py-6 text-neutral-500 text-sm">
          Không có vị thế
        </div>
      );

    // Tính PnL
    const profitOf = (bk: string) =>
      (posByBroker[bk] || []).reduce((a, p) => a + (Number(p.profit) || 0), 0);

    return (
      <table className="min-w-full text-[11px]">
        <thead>
          <tr className="[&_th]:px-3 [&_th]:py-2 text-[10px] uppercase tracking-wide text-neutral-300 text-center">
            <th className="text-left">Broker</th>
            <th>#Pos</th>
            <th>Profit</th>
          </tr>
        </thead>
        <tbody>
          {brokers.map((bk) => {
            const open = expandedBrokers.has(bk);
            const posList = posByBroker[bk] || [];
            const pendList = pendingMap[bk] || [];
            const pnl = profitOf(bk);
            return (
              <React.Fragment key={bk}>
                <tr className="border-t border-neutral-700/40">
                  <td className="px-3 py-2">
                    <button
                      onClick={() => toggleExpandBroker(bk)}
                      className="flex items-center gap-2 w-full text-left hover:text-white"
                    >
                      <span className="w-4 text-center">
                        {open ? "▾" : "▸"}
                      </span>
                      <span className="font-semibold">{bk}</span>
                      {!!pendList.length && (
                        <span className="ml-1 text-[9px] px-1 rounded bg-neutral-600/60 text-neutral-200">
                          {pendList.length} pending
                        </span>
                      )}
                    </button>
                  </td>
                  <td className="text-center font-mono">{posList.length}</td>
                  <td
                    className={`text-center font-mono ${
                      pnl >= 0 ? "text-emerald-400" : "text-red-400"
                    }`}
                  >
                    {pnl.toFixed(2)}
                  </td>
                </tr>
                {open && (
                  <tr>
                    <td colSpan={3} className="p-0 bg-neutral-900/50">
                      <div className="px-3 pt-3 pb-4 space-y-4">
                        <div className="text-[10px] font-semibold text-neutral-300">
                          Positions ({posList.length})
                        </div>
                        {renderPositionsTable(posList)}
                        <div className="h-px bg-neutral-700/60" />
                        <div className="text-[10px] font-semibold text-neutral-300">
                          Pending Orders ({pendList.length})
                        </div>
                        {renderPendingTable(pendList)}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    );
  };

  // ===== Modal =====
  const hiddenModalNode =
    !isOld && hideModalOpen
      ? createPortal(
          <div className="fixed inset-0 z-[998] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setHideModalOpen(false)}
            />
            <div
              className="relative w-[900px] max-w-[calc(100vw-40px)] max-h-[80vh]
                 bg-neutral-800/95 border border-neutral-600 rounded-lg shadow-xl
                 flex flex-col overflow-hidden"
            >
              <div className="flex items-center gap-3 px-4 py-2 border-b border-neutral-600/60 bg-neutral-900/70">
                <h3 className="text-sm font-semibold text-neutral-200">
                  Kèo đang ẩn ({hiddenRowsActive.length})
                </h3>
                <div className="ml-auto flex items-center gap-3 text-[11px] text-neutral-400">
                  <label className="flex items-center gap-1">
                    <span>Hiện lại(min):</span>
                    <input
                      type="number"
                      min={0}
                      value={hideTtlMins}
                      onChange={(e) =>
                        setHideTtlMins(Math.max(0, Number(e.target.value) || 0))
                      }
                      className="w-20 bg-neutral-900 border border-neutral-600 rounded px-2 py-1 text-[11px]"
                      title="Sau X phút auto hiện lại. 0 = giữ ẩn đến khi bật thủ công."
                    />
                  </label>
                  <button
                    onClick={() => {
                      setHiddenMap({});
                    }}
                    className="px-2 py-0.5 rounded bg-green-600/70 hover:bg-green-500 text-[10px] font-semibold"
                    title="Hiện tất cả ngay"
                  >
                    Hiện tất cả
                  </button>
                  <button
                    onClick={() => setHideModalOpen(false)}
                    className="px-2 py-0.5 rounded bg-neutral-600/70 hover:bg-neutral-500 text-[10px] font-semibold"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-4 scroll-thin">
                <table className="min-w-full text-[11px]">
                  <thead>
                    <tr className="[&_th]:px-2 [&_th]:py-2 text-[10px] uppercase tracking-wide text-neutral-300 text-center">
                      <th className="text-left">Client</th>
                      <th className="text-left">Server</th>
                      <th className="text-left">Symbol</th>
                      <th className="text-right">Độ lệch</th>
                      <th className="text-center">Gap</th>
                      <th className="text-center">Trigger</th>
                      <th className="text-center">Ẩn lúc</th>
                      <th className="text-center">Hành động</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hiddenRowsActive.map((r) => {
                      const k = keyOf(r);
                      const hideTs = hiddenMap[k] || 0;
                      const diff = r.trigger1
                        ? r.diff1_points_abs
                        : r.trigger2
                        ? r.diff2_points_abs
                        : undefined;
                      return (
                        <tr
                          key={k}
                          className="border-t border-neutral-700/40 hover:bg-neutral-700/30"
                        >
                          <td className="px-2 py-1">{r.client || "-"}</td>
                          <td className="px-2 py-1">{r.server || "-"}</td>
                          <td className="px-2 py-1">{r.symbol || "-"}</td>
                          <td className="px-2 py-1 text-right font-mono">
                            {diff != null ? diff.toFixed(2) : "-"}
                          </td>
                          <td className="px-2 py-1 text-center font-mono">
                            {r.gap_pts ?? "-"}
                          </td>
                          <td className="px-2 py-1 text-center">
                            {r.trigger1
                              ? "BUY"
                              : r.trigger2
                              ? "SELL"
                              : r.active
                              ? "ON"
                              : "-"}
                          </td>
                          <td className="px-2 py-1 font-mono text-center">
                            {hideTs
                              ? new Date(hideTs).toLocaleTimeString()
                              : "-"}
                          </td>
                          <td className="px-2 py-1 text-center">
                            <button
                              onClick={() =>
                                setHiddenMap((m) => {
                                  const nm = { ...m };
                                  delete nm[k];
                                  return nm;
                                })
                              }
                              className="px-2 py-0.5 rounded bg-green-600/70 hover:bg-green-500 text-[10px] font-semibold"
                            >
                              Hiện lại
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {!hiddenRowsActive.length && (
                      <tr>
                        <td
                          colSpan={8}
                          className="px-3 py-4 text-center text-neutral-500"
                        >
                          Không có kèo ẩn
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  const modalNode = posModal
    ? createPortal(
        <div className="fixed inset-0 z-[999] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={closePosModal}
          />
          <div
            className="relative w-[1400px] max-w-[calc(100vw-40px)] h-[min(86vh,900px)]
                   bg-neutral-800/95 border border-neutral-600 rounded-lg shadow-2xl
                   flex flex-col overflow-hidden"
          >
            <div className="flex items-center gap-3 px-4 py-2 border-b border-neutral-600/60 bg-neutral-900/70">
              <h3 className="text-sm font-semibold text-neutral-200">
                {posModal.mode === "all"
                  ? "All Brokers Positions"
                  : `Positions - ${posModal.broker}`}
              </h3>
              <div className="ml-auto flex items-center gap-3 text-[11px] text-neutral-400">
                <span>
                  {posModal.mode === "all"
                    ? `${positionsData.all.length} open`
                    : `${
                        getBrokerPositions(positionsData, posModal.broker)
                          .length
                      } open`}
                </span>
                {posModal.mode === "broker" && (
                  <span>
                    Pending:{" "}
                    {
                      pendingData.filter((p) => p.broker === posModal.broker)
                        .length
                    }
                  </span>
                )}
                <button
                  onClick={closePosModal}
                  className="px-2 py-0.5 rounded bg-neutral-600/60 hover:bg-neutral-500 text-neutral-100 text-xs font-semibold"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-hidden">
              <div className="h-full overflow-auto px-4 pb-4 pt-2 scroll-thin">
                {posModal.mode === "all" ? (
                  renderAllPositionsSummary()
                ) : (
                  <>
                    <div className="[&_table]:table-fixed [&_th]:whitespace-nowrap">
                      {renderPositionsTable(
                        getBrokerPositions(positionsData, posModal.broker)
                      )}
                    </div>
                    <div className="my-4 h-px bg-neutral-600/60" />
                    <h4 className="text-xs font-semibold mb-2 text-neutral-300">
                      Pending Orders (
                      {
                        pendingData.filter((p) => p.broker === posModal.broker)
                          .length
                      }
                      )
                    </h4>
                    <div className="[&_table]:table-fixed [&_th]:whitespace-nowrap">
                      {renderPendingTable(
                        pendingData.filter((p) => p.broker === posModal.broker)
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  // ===== Render main =====
  return (
    <div className="bg-neutral-800/60 rounded-md border border-neutral-700/50 backdrop-blur-sm">
      <div className="px-4 py-2 flex flex-wrap items-center gap-2 border-b border-neutral-700/60">
        <h3 className="font-semibold text-sm">
          {isOld ? "Bảng kèo cũ" : "Bảng kèo hiện tại"}
        </h3>
        <select
          className="bg-neutral-900 border border-neutral-600 rounded px-2 py-1 text-[11px]"
          value={serverFilter}
          onChange={(e) => setServerFilter(e.target.value)}
        >
          <option value="ALL">Tất cả server</option>
          {servers.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          className="bg-neutral-900 border border-neutral-600 rounded px-2 py-1 text-[11px]"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="ALL">Danh mục</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <input
          placeholder="Tìm symbol hoặc sàn..."
          className="bg-neutral-900 border border-neutral-600 rounded px-2 py-1 text-[11px] w-52"
          value={combinedSearch}
          onChange={(e) => setCombinedSearch(e.target.value)}
        />
        {isOld && (
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              className="bg-neutral-900 border border-neutral-600 rounded px-2 py-1 text-[11px] w-28"
              value={oldMaxAgeSec / 60}
              onChange={(e) => {
                const mins = Math.max(0, Number(e.target.value) || 0);
                setOldMaxAgeSec(mins * 60);
              }}
              placeholder="Giữ kèo(min): "
              title="Thời gian giữ kèo(min). 0 = không tự ẩn."
            />
          </div>
        )}
        {!isOld && (
          <>
            <div className="relative">
              <button
                ref={quietBtnRef}
                onClick={() => {
                  setQuietPanelOpen((o) => !o);
                  setQuietBtnRect(
                    quietBtnRef.current?.getBoundingClientRect() || null
                  );
                }}
                className={`px-2 py-1 rounded text-[11px] flex items-center gap-1 transition-colors ${
                  isWithinQuiet()
                    ? "bg-indigo-500 text-white shadow-sm"
                    : "bg-neutral-700 hover:bg-neutral-600 text-neutral-200"
                }`}
                title="Thiết lập khoảng giờ im lặng âm thanh"
              >
                <Calendar size={14} />
                <span>Mute</span>
                {isWithinQuiet() && (
                  <span className="text-[9px] font-semibold bg-white/20 px-1 rounded">
                    ON
                  </span>
                )}
              </button>
              {quietPanelOpen &&
                createPortal(
                  <div
                    className="fixed z-[500] w-64 p-3 rounded-md border border-neutral-600 bg-neutral-900 shadow-xl"
                    style={{
                      top: quietBtnRect?.bottom ?? 0,
                      left: quietBtnRect?.left ?? 0,
                    }}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[11px] font-semibold text-neutral-200">
                        Lịch im lặng
                      </span>
                      <button
                        onClick={() => setQuietPanelOpen(false)}
                        className="px-2 py-0.5 rounded bg-neutral-700 hover:bg-neutral-600 text-[10px]"
                      >
                        ✕
                      </button>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label className="block text-[10px] text-neutral-400 mb-1">
                          Khoảng giờ (HH:MM)
                        </label>
                        <div className="flex items-center gap-1">
                          <input
                            type="time"
                            value={quietFrom}
                            onChange={(e) => setQuietFrom(e.target.value)}
                            className="flex-1 bg-neutral-800/80 border border-indigo-500 focus:border-indigo-400 focus:outline-none rounded px-1 py-1 text-[11px] text-indigo-200"
                          />
                          <span className="text-[10px] text-neutral-400">
                            →
                          </span>
                          <input
                            type="time"
                            value={quietTo}
                            onChange={(e) => setQuietTo(e.target.value)}
                            className="flex-1 bg-neutral-800/80 border border-indigo-500 focus:border-indigo-400 focus:outline-none rounded px-1 py-1 text-[11px] text-indigo-200"
                          />
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            setQuietFrom("");
                            setQuietTo("");
                          }}
                          className="flex-1 px-2 py-1 rounded bg-red-700/70 hover:bg-red-600 text-[11px]"
                        >
                          Xóa
                        </button>
                        <button
                          onClick={() => setQuietPanelOpen(false)}
                          className="flex-1 px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-[11px]"
                        >
                          OK
                        </button>
                      </div>
                      <div className="text-[10px] text-neutral-400 leading-snug">
                        {isWithinQuiet() ? "Đang im lặng." : "Không im lặng."}
                        <br />
                        Qua đêm hỗ trợ (ví dụ 23:00 → 05:00).
                      </div>
                    </div>
                  </div>,
                  document.body
                )}
            </div>
            <button
              onClick={() => setPosModal({ mode: "all" })}
              className="px-2 py-1 rounded text-[11px] bg-neutral-700 hover:bg-neutral-600"
            >
              All Positions
            </button>
            <button
              onClick={() => setHideModalOpen(true)}
              className="px-2 py-1 rounded text-[11px] bg-neutral-700 hover:bg-neutral-600"
              title="Xem & quản lý các kèo đã ẩn"
            >
              Kèo ẩn ({hiddenRowsActive.length})
            </button>
          </>
        )}
        <span className="text-[10px] text-neutral-400 ml-auto">
          {filtered.length} rows
        </span>
      </div>
      <div className="overflow-auto max-h-[78vh] scroll-thin text-[11px]">
        <table className="min-w-full border-separate border-spacing-0">
          <thead className="sticky top-0 z-10 bg-neutral-800/95 backdrop-blur">
            <tr className="[&_th]:font-medium [&_th]:py-2 [&_th]:px-3 text-neutral-300 text-[10px] uppercase tracking-wide">
              <th className="text-left">Client</th>
              <th className="text-center">Client / One-Click</th>
              <th className="text-left">Symbol</th>
              <th className="text-right">Độ lệch</th>
              <th className="text-center">Gap Pts</th>
              {!isOld && <th className="text-center">Mark</th>}
              <th className="text-left">Server</th>
              <th className="text-center">Server / One-Click</th>
              <th className="text-center">Action</th> {/* NEW */}
            </tr>
          </thead>
          <tbody>
            {grouped.map(([, list]) => {
              const sorted = [...list].sort(
                (a, b) =>
                  (a.symbol || "").localeCompare(b.symbol || "") ||
                  (a.client || "").localeCompare(b.client || "")
              );
              return sorted.map((r) => {
                const k = keyOf(r);
                const bidServer = r.bid_server,
                  askServer = r.ask_server;
                const bidClient = r.bid_client,
                  askClient = r.ask_client;
                const t1 = !!r.trigger1,
                  t2 = !!r.trigger2;
                const diff = t1
                  ? r.diff1_points_abs
                  : t2
                  ? r.diff2_points_abs
                  : undefined;
                const gapPts = r.gap_pts;
                const cliDir: "BUY" | "SELL" | null = t1
                  ? "BUY"
                  : t2
                  ? "SELL"
                  : null;
                const fsBidServer = formatMini(bidServer, {
                  symbol: r.symbol,
                  category: r.category,
                  digits: r.digits_server,
                });
                const fsAskServer = formatMini(askServer, {
                  symbol: r.symbol,
                  category: r.category,
                  digits: r.digits_server,
                });
                const fsBidClient = formatMini(bidClient, {
                  symbol: r.symbol,
                  category: r.category,
                  digits: r.digits_client,
                });
                const fsAskClient = formatMini(askClient, {
                  symbol: r.symbol,
                  category: r.category,
                  digits: r.digits_client,
                });
                const brokerPos = getBrokerPositions(positionsData, r.server);
                const clientPos = getBrokerPositions(positionsData, r.client);
                return (
                  <tr
                    key={r._id || k}
                    className={`border-t border-neutral-700/40 ${
                      !isOld ? "bg-yellow-700/15" : "hover:bg-neutral-700/30"
                    } transition-colors`}
                  >
                    <td className="px-3 py-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{r.client || "-"}</span>
                        <button
                          title="Xem vị thế Client"
                          onClick={() =>
                            r.client &&
                            setPosModal({ mode: "broker", broker: r.client })
                          }
                          className="inline-flex items-center justify-center min-w-[26px] h-5 px-1 rounded-full text-[10px] font-semibold bg-neutral-600/70 hover:bg-neutral-500 text-neutral-100"
                        >
                          {clientPos.length}
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-center gap-2">
                        <input
                          type="number"
                          className="w-20 bg-neutral-900 border border-neutral-600 rounded px-1 py-1 text-[11px] font-medium text-center mb-1"
                          value={volClient[k] || ""}
                          onChange={(e) =>
                            setVolClient((o) => ({ ...o, [k]: e.target.value }))
                          }
                          placeholder="Vol"
                        />
                        {r.client_raw && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-neutral-700/60 text-neutral-200">
                            {r.client_raw}
                          </span>
                        )}
                        <div className="flex gap-2 mt-1">
                          <button
                            disabled={bidClient == null}
                            onClick={() => onTrade("SELL", r, "client")}
                            className={`relative flex flex-col items-center justify-center rounded-md w-20 h-14 font-semibold bg-gradient-to-br from-sky-600 via-sky-500 to-sky-400 ${
                              cliDir === "SELL" && !isOld
                                ? "outline outline-[2px] outline-yellow-400 shadow-[0_0_0_2px_rgba(250,204,21,0.35)]"
                                : "opacity-60"
                            } text-white`}
                          >
                            <span className="text-[15px] font-bold">
                              {fsBidClient.mini}
                            </span>
                            <span className="text-[10px] opacity-85 font-mono mt-0.5">
                              {fsBidClient.full}
                            </span>
                          </button>
                          <button
                            disabled={askClient == null}
                            onClick={() => onTrade("BUY", r, "client")}
                            className={`relative flex flex-col items-center justify-center rounded-md w-20 h-14 font-semibold bg-gradient-to-br from-violet-600 via-violet-500 to-fuchsia-500 ${
                              cliDir === "BUY" && !isOld
                                ? "outline outline-[2px] outline-yellow-400 shadow-[0_0_0_2px_rgba(250,204,21,0.35)]"
                                : "opacity-60"
                            } text-white`}
                          >
                            <span className="text-[15px] font-bold">
                              {fsAskClient.mini}
                            </span>
                            <span className="text-[10px] opacity-85 font-mono mt-0.5">
                              {fsAskClient.full}
                            </span>
                          </button>
                        </div>
                        <div
                          className={`w-40 py-2 rounded-md text-[11px] font-bold tracking-wide mt-1 text-center ${
                            cliDir === "BUY"
                              ? "bg-green-600/70 text-white"
                              : cliDir === "SELL"
                              ? "bg-red-600/70 text-white"
                              : "bg-neutral-700 text-neutral-400"
                          }`}
                        >
                          {cliDir || "---"}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-1">
                      <div className="flex flex-col">
                        <span className="font-medium">{r.symbol}</span>
                        {r.category && (
                          <span className="text-[9px] px-1 mt-0.5 w-fit rounded bg-sky-600/25 text-sky-300">
                            {r.category}
                          </span>
                        )}
                      </div>
                      {isOld &&
                        oldMaxAgeSec > 0 &&
                        (() => {
                          const endTs = r.ended_ts || r.last_update_ts || r.ts;
                          if (!endTs) return null;
                          const remain = Math.max(
                            0,
                            oldMaxAgeSec - (Date.now() / 1000 - endTs)
                          );
                          const hh = Math.floor(remain / 3600);
                          const mm = Math.floor((remain % 3600) / 60);
                          const ss = Math.floor(remain % 60);
                          return (
                            <span className="mt-0.5 text-[9px] font-mono px-1 rounded bg-neutral-700/60 text-neutral-300">
                              {hh > 0
                                ? `${hh}h${mm.toString().padStart(2, "0")}`
                                : `${mm}m${ss.toString().padStart(2, "0")}s`}
                            </span>
                          );
                        })()}
                    </td>
                    <td className="px-3 py-1 text-right font-mono">
                      {diff != null ? diff.toFixed(2) : "-"}
                    </td>
                    <td className="px-3 py-1 text-center">
                      <div className="px-2 py-1 rounded text-[11px] font-semibold bg-neutral-700/40 text-neutral-200 inline-block">
                        {gapPts != null ? gapPts : "-"}
                      </div>
                    </td>
                    {!isOld && (
                      <td className="px-3 py-1 text-center">
                        <div className="inline-flex items-center gap-1 relative">
                          <button
                            onClick={() =>
                              setEditingRowMute((prev) =>
                                prev === k ? null : k
                              )
                            }
                            className={`p-1 rounded transition-colors ${
                              isRowMuted(k)
                                ? "bg-red-600/50 text-red-200 hover:bg-red-600/60"
                                : "bg-neutral-600/40 text-neutral-300 hover:bg-neutral-500/50"
                            }`}
                            title={
                              isRowMuted(k)
                                ? "Đang mute - bấm để chỉnh thời gian / bật lại"
                                : "Mute âm thanh cho hàng này"
                            }
                          >
                            {isRowMuted(k) ? (
                              <BellOff size={14} />
                            ) : (
                              <Bell size={14} />
                            )}
                          </button>
                          {isRowMuted(k) && rowMute[k]?.until && (
                            <span
                              className="text-[9px] font-mono px-1 rounded bg-neutral-700/70 text-neutral-200"
                              title="Thời gian còn lại"
                            >
                              {Math.max(
                                0,
                                Math.ceil(
                                  (rowMute[k].until! - Date.now()) / 60000
                                )
                              )}
                              m
                            </span>
                          )}
                          {editingRowMute === k && (
                            <div className="absolute z-30 top-full left-0 mt-1 p-2 w-52 rounded-md border border-neutral-600 bg-neutral-900 shadow-xl text-left">
                              <div className="mb-2 flex items-center justify-between">
                                <span className="text-[10px] font-semibold text-neutral-300">
                                  Mute
                                </span>
                                <button
                                  onClick={() => setEditingRowMute(null)}
                                  className="px-1 py-0.5 rounded bg-neutral-700 hover:bg-neutral-600 text-[10px]"
                                >
                                  ✕
                                </button>
                              </div>
                              <RowMuteEditor
                                rowKey={k}
                                value={rowMute[k]}
                                onApply={(mins) => {
                                  setRowMute((o) => ({
                                    ...o,
                                    [k]: {
                                      muted: true,
                                      until:
                                        mins > 0
                                          ? Date.now() + mins * 60000
                                          : null,
                                    },
                                  }));
                                  setEditingRowMute(null);
                                }}
                                onUnmute={() => {
                                  setRowMute((o) => ({
                                    ...o,
                                    [k]: { muted: false, until: null },
                                  }));
                                  setEditingRowMute(null);
                                }}
                              />
                            </div>
                          )}
                        </div>
                      </td>
                    )}
                    <td className="px-3 py-1 font-medium">
                      <div className="flex items-center gap-2">
                        <span>{r.server || "-"}</span>
                        <button
                          title="Xem vị thế Server"
                          onClick={() =>
                            r.server &&
                            setPosModal({ mode: "broker", broker: r.server })
                          }
                          className="inline-flex items-center justify-center min-w-[26px] h-5 px-1 rounded-full text-[10px] font-semibold bg-neutral-600/70 hover:bg-neutral-500 text-neutral-100"
                        >
                          {brokerPos.length}
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-col items-center gap-2">
                        <input
                          type="number"
                          className="w-20 bg-neutral-900 border border-neutral-600 rounded px-1 py-1 text-[11px] font-medium text-center mb-1"
                          value={volServer[k] || ""}
                          onChange={(e) =>
                            setVolServer((o) => ({ ...o, [k]: e.target.value }))
                          }
                          placeholder="Vol"
                        />
                        {r.server_raw && (
                          <span className="text-[9px] px-1 py-0.5 rounded bg-neutral-700/60 text-neutral-200">
                            {r.server_raw}
                          </span>
                        )}
                        <div className="flex gap-2 mt-1">
                          <button
                            disabled={bidServer == null}
                            onClick={() => onTrade("SELL", r, "server")}
                            className={`relative flex flex-col items-center justify-center rounded-md w-20 h-14 font-semibold bg-gradient-to-br from-sky-600 via-sky-500 to-sky-400 opacity-60 text-white`}
                          >
                            <span className="text-[15px] font-bold">
                              {fsBidServer.mini}
                            </span>
                            <span className="text-[10px] opacity-85 font-mono mt-0.5">
                              {fsBidServer.full}
                            </span>
                          </button>
                          <button
                            disabled={askServer == null}
                            onClick={() => onTrade("BUY", r, "server")}
                            className={`relative flex flex-col items-center justify-center rounded-md w-20 h-14 font-semibold bg-gradient-to-br from-violet-600 via-violet-500 to-fuchsia-500 opacity-60 text-white`}
                          >
                            <span className="text-[15px] font-bold">
                              {fsAskServer.mini}
                            </span>
                            <span className="text-[10px] opacity-85 font-mono mt-0.5">
                              {fsAskServer.full}
                            </span>
                          </button>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-1 text-center">
                      {isOld ? (
                        <button
                          onClick={async () => {
                            if (!r.server || !r.client || !r.symbol) return;
                            const k = keyOf(r);
                            setDeletedKeys((s) => {
                              const ns = new Set(s);
                              ns.add(k);
                              return ns;
                            });
                            const resp = await deleteTrigger(r, true);
                            if (!resp.ok) {
                              setDeletedKeys((s) => {
                                const ns = new Set(s);
                                ns.delete(k);
                                return ns;
                              });
                            }
                          }}
                          className="px-2 py-0.5 rounded bg-red-700/70 hover:bg-red-600 text-[10px] font-semibold"
                          title="Xóa old trigger khỏi backend"
                        >
                          ✕
                        </button>
                      ) : (
                        <button
                          onClick={() => {
                            const k = keyOf(r);
                            setHiddenMap((m) => ({ ...m, [k]: Date.now() }));
                          }}
                          className="px-2 py-0.5 rounded bg-yellow-600/70 hover:bg-yellow-500 text-[10px] font-semibold"
                          title={
                            hideTtlMins > 0
                              ? `Ẩn kèo (tự hiện lại sau ${hideTtlMins} phút)`
                              : "Ẩn kèo (giữ đến khi bật lại trong 'Kèo ẩn')"
                          }
                        >
                          Ẩn kèo
                        </button>
                      )}
                    </td>
                  </tr>
                );
              });
            })}
            {!grouped.length && (
              <tr>
                <td
                  colSpan={isOld ? 9 : 10} // +1 vì thêm cột Close
                  className="px-4 py-6 text-center text-neutral-500"
                >
                  Không có trigger
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 w-72 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto px-3 py-2 rounded shadow text-[11px] font-medium border transition-opacity ${
              t.status === "pending"
                ? "bg-neutral-500/90 border-neutral-300 text-white"
                : t.status === "success"
                ? "bg-green-600/90 border-green-400 text-white"
                : "bg-red-600/90 border-red-400 text-white"
            } animate-fade-in`}
          >
            {t.msg}
          </div>
        ))}
      </div>
      {hiddenModalNode}
      {modalNode}
    </div>
  );
}

async function deleteTrigger(r: ArbItem, isOld: boolean) {
  const body: any = {
    server: r.server,
    client: r.client,
    symbol: r.symbol,
    scope: isOld ? "old" : "live",
  };
  if (isOld && r.version != null) body.version = r.version;
  try {
    const res = await api.post("/receiver/delete_trigger", body);
    return res.data;
  } catch {
    return {};
  }
}

function RowMuteEditor({
  value,
  onApply,
  onUnmute,
}: {
  rowKey: string;
  value?: { muted: boolean; until: number | null };
  onApply: (mins: number) => void;
  onUnmute: () => void;
}) {
  const [mins, setMins] = useState(
    value?.until ? Math.ceil((value.until - Date.now()) / 60000) : 0
  );
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          value={mins}
          onChange={(e) => setMins(Math.max(0, Number(e.target.value) || 0))}
          className="w-20 bg-neutral-800 border border-neutral-600 rounded px-2 py-1 text-[11px] text-center"
          placeholder="Phút"
          title="0 = mute"
        />
        <button
          onClick={() => onApply(mins)}
          className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-[11px] text-white"
        >
          Áp dụng
        </button>
      </div>
      <div className="flex gap-2">
        <button
          onClick={onUnmute}
          className="flex-1 px-2 py-1 rounded bg-green-600/70 hover:bg-green-500 text-[11px] text-white"
        >
          Bật lại
        </button>
        <button
          onClick={() => onApply(0)}
          className="flex-1 px-2 py-1 rounded bg-red-600/70 hover:bg-red-500 text-[11px] text-white"
          title="Mute không thời hạn"
        >
          Mute
        </button>
      </div>
      <p className="text-[9px] text-neutral-400 leading-snug">
        Nếu đặt phút &gt; 0 sẽ tự bật lại khi hết thời gian.
      </p>
    </div>
  );
}
