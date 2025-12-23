import axios from "axios";

const API_URL =
  (import.meta.env?.VITE_API_URL && import.meta.env.VITE_API_URL.trim()) ||
  "http://127.0.0.1:5000";

const api = axios.create({
  baseURL: API_URL,
  headers: { "Content-Type": "application/json" },
});

export default api;

export type SheetsConfig = {
  sheet_url: string;
  sheet_name_attendance: string; // tên sheet "điểm danh"
  sheet_name_keo: string;        // tên sheet "KẾO PYTHON"
  owner_name: string;
};

export async function getSheetsConfig(): Promise<SheetsConfig> {
  const r = await api.get("/api/sheets/config");
  return r.data;
}

export async function saveSheetsConfig(cfg: SheetsConfig): Promise<void> {
  await api.post("/api/sheets/config", cfg);
}
export async function pushAttendance(body?: {
  owner_name?: string;
  local_time?: string; // YYYY-MM-DD HH:mm:ss
}): Promise<{ ok: boolean; row?: number; error?: string; detail?: string }> {
  const r = await api.post("/api/sheets/push_attendance", body || {});
  const j = r.data ?? {};
  if (!j.ok) throw new Error(j?.detail || j?.error || "Push fail");
  return j;
}

export async function pushKeoRow(body: {
  owner_name?: string;
  local_time?: string;     // YYYY-MM-DD HH:mm:ss (click)
  appear_time?: string;    // YYYY-MM-DD HH:mm:ss (xuất hiện)
  client_name?: string;
  symbol?: string;
  do_lech?: number | string; // ĐỘ LỆCH (thay vì gap_pts)
  server_name?: string;
}): Promise<{ ok: boolean; row?: number; error?: string; detail?: string }> {
  const r = await api.post("/api/sheets/push_keo", body || {});
  const j = r.data ?? {};
  if (!j.ok) throw new Error(j?.detail || j?.error || "Push fail");
  return j;
}