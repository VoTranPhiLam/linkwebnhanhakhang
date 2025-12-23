import { useEffect, useState } from "react";
import {
  getSheetsConfig,
  saveSheetsConfig,
  type SheetsConfig,
  pushAttendance,
} from "./api/api";
import { useLiveData } from "./hooks/useLiveData";
import "./index.scss";
import SetIntervalControl from "./components/SetInterval";
import FullTriggerTable from "./components/FullTriggerTable";

export default function App() {
  const { data, isLoading, error } = useLiveData();
  const [dashboardTitle, setDashboardTitle] = useState<string>(() => {
    return localStorage.getItem("dashboardTitle") || "Nhánh a Khang";
  });
  const [customSound, setCustomSound] = useState<string | null>(() => {
    return localStorage.getItem("customSound") || null;
  });

  // Config rút gọn: chỉ link, tên sheet + chọn tên người
  const [cfg, setCfg] = useState<SheetsConfig>({
    sheet_url: "",
    sheet_name_attendance: "điểm danh",
    sheet_name_keo: "KÊO PYTHON",
    owner_name: "Phát",
  });
  const [cfgLoading, setCfgLoading] = useState(false);
  const [cfgMsg, setCfgMsg] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);

  // Popup cấu hình
  const [showConfig, setShowConfig] = useState(false);
  const [tempUrl, setTempUrl] = useState("");
  const [tempSheetAttendance, setTempSheetAttendance] = useState("điểm danh");
  const [tempSheetKeo, setTempSheetKeo] = useState("KÊO PYTHON");
  const [tempOwner, setTempOwner] = useState("Phát");

  useEffect(() => {
    setCfgLoading(true);
    getSheetsConfig()
      .then((c) => {
        setCfg({
          sheet_url: c.sheet_url || "",
          sheet_name_attendance: c.sheet_name_attendance || "điểm danh",
          sheet_name_keo: c.sheet_name_keo || "KÊO PYTHON",
          owner_name: c.owner_name || "Phát",
        });
        setTempUrl(c.sheet_url || "");
        setTempSheetAttendance(c.sheet_name_attendance || "điểm danh");
        setTempSheetKeo(c.sheet_name_keo || "KÊO PYTHON");
        setTempOwner(c.owner_name || "Phát");
      })
      .catch(() => {})
      .finally(() => setCfgLoading(false));
  }, []);

  const openConfig = () => {
    setTempUrl(cfg.sheet_url || "");
    setTempSheetAttendance(cfg.sheet_name_attendance || "điểm danh");
    setTempSheetKeo(cfg.sheet_name_keo || "KÊO PYTHON");
    setTempOwner(cfg.owner_name || "A");
    setCfgMsg(null);
    setShowConfig(true);
  };

  const saveConfigPopup = async () => {
    const att = (tempSheetAttendance || "").trim().toUpperCase();
    const keo = (tempSheetKeo || "").trim().toUpperCase();
    const nextCfg: SheetsConfig = {
      sheet_url: (tempUrl || "").trim(),
      sheet_name_attendance: att || "ĐIỂM DANH",
      sheet_name_keo: keo || "KÊO PYTHON",
      owner_name: (tempOwner || "").trim(),
    };
    try {
      await saveSheetsConfig(nextCfg);
      setCfg(nextCfg);
      setTempSheetAttendance(nextCfg.sheet_name_attendance);
      setTempSheetKeo(nextCfg.sheet_name_keo);
      setCfgMsg(`Đã lưu cấu hình thành công`);
      setTimeout(() => setCfgMsg(null), 3000);
    } catch (e: any) {
      setCfgMsg(e?.message || "Lỗi lưu cấu hình");
    }
  };

  const onPush = async () => {
    // CHỈ push sheet "điểm danh"
    setPushing(true);
    setCfgMsg(null);
    try {
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const localTimeClick = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
        d.getDate()
      )} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

      const res = await pushAttendance({
        owner_name: (tempOwner || "").trim(),
        local_time: localTimeClick,
      });
      if (!res.ok) throw new Error(res.error || res.detail || "Push fail");
      setCfgMsg("Đẩy data thành công");
    } catch (e: any) {
      setCfgMsg(e?.message || "Lỗi push");
    } finally {
      setPushing(false);
      setTimeout(() => setCfgMsg(null), 3000);
    }
  };

  return (
    <div className="mx-auto max-w-[1900px] p-4 space-y-6">
      {/* Thanh control: cùng một hàng */}
      <div className="flex items-center justify-between flex-wrap gap-3 bg-neutral-800/40 p-3 rounded-lg">
        <div className="flex items-center gap-3">
          <input
            type="text"
            spellCheck={false}
            value={dashboardTitle}
            onChange={(e) => {
              setDashboardTitle(e.target.value);
              localStorage.setItem("dashboardTitle", e.target.value);
            }}
            className="px-3 py-2 rounded-md text-lg font-semibold text-amber-200 bg-neutral-800/80 focus:outline-none focus:ring-2 focus:ring-amber-400/60 shadow"
          />
          {/* Sound */}
          <label className="px-3 py-2 text-xs rounded-md bg-indigo-600 hover:bg-indigo-500 cursor-pointer text-white shadow">
            Sound
            <input
              type="file"
              accept="audio/mpeg"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => {
                  const result =
                    typeof reader.result === "string" ? reader.result : null;
                  setCustomSound(result);
                  if (result) localStorage.setItem("customSound", result);
                };
                reader.readAsDataURL(file);
              }}
            />
          </label>
          {customSound && (
            <button
              onClick={() => {
                localStorage.removeItem("customSound");
                setCustomSound(null);
              }}
              className="px-3 py-2 text-xs rounded-md bg-red-600 hover:bg-red-500 text-white shadow"
            >
              Clear
            </button>
          )}
          {/* Cấu hình cùng row */}
          <button
            onClick={openConfig}
            className="px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-sm"
          >
            Cấu hình Google Sheet
          </button>
          {cfgLoading && (
            <span className="text-xs text-neutral-400">Đang tải config...</span>
          )}
          {/* XÓA hiển thị cfgMsg ngoài giao diện chính */}
          {/* (không render cfgMsg ở đây nữa) */}
        </div>
        <SetIntervalControl />
      </div>

      {isLoading && <div className="text-neutral-400 text-xs">Loading...</div>}
      {error && <div className="text-red-400 text-xs">Load lỗi</div>}
      {data && (
        <>
          <div>
            <h3 className="text-sm font-semibold mb-2 text-neutral-200">
              Bảng kèo hiện tại
            </h3>
            <FullTriggerTable
              rows={data.live}
              disableSound={false}
              soundUrl={customSound || undefined}
            />
          </div>
          <div>
            <h3 className="text-sm font-semibold mb-2 mt-6 text-neutral-200">
              Bảng kèo cũ
            </h3>
            <FullTriggerTable rows={data.old} disableSound={true} isOld />
          </div>
        </>
      )}

      {/* Popup cấu hình: có Push ở đây và hiển thị trạng thái tại chỗ */}
      {showConfig && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="relative bg-neutral-900 rounded-lg p-4 w-full max-w-lg shadow-lg border border-neutral-700">
            {/* Nút X góc phải */}
            <button
              onClick={() => {
                setShowConfig(false);
                setCfgMsg(null);
              }}
              className="absolute top-2 right-2 inline-flex items-center justify-center w-8 h-8 rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-200"
              aria-label="Close"
              title="Đóng"
            >
              ×
            </button>

            {/* Header popup */}
            <h4 className="text-sm font-semibold text-neutral-200 mb-3 pr-10">
              Cấu hình Google Sheet
            </h4>

            <div className="space-y-3">
              <input
                className="px-3 py-2 rounded-md bg-neutral-800 text-neutral-200 w-full"
                placeholder="Google Sheet URL"
                value={tempUrl}
                onChange={(e) => setTempUrl(e.target.value)}
              />
              <input
                className="px-3 py-2 rounded-md bg-neutral-800 text-neutral-200 w-full"
                placeholder="Tên sheet điểm danh"
                value={tempSheetAttendance}
                onChange={(e) => setTempSheetAttendance(e.target.value)}
              />
              <input
                className="px-3 py-2 rounded-md bg-neutral-800 text-neutral-200 w-full"
                placeholder="Tên sheet KÊO PYTHON"
                value={tempSheetKeo}
                onChange={(e) => setTempSheetKeo(e.target.value)}
              />
              <select
                className="px-3 py-2 rounded-md bg-neutral-800 text-neutral-200 w-full"
                value={tempOwner}
                onChange={(e) => setTempOwner(e.target.value)}
              >
                {["Lâm", "Khang", "Phát", "Phi", "Tâm", "Tuấn"].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              {cfgMsg && (
                <div className="text-xs px-2 py-1 rounded bg-neutral-800 text-neutral-300">
                  {cfgMsg}
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 mt-4">
              <button
                onClick={saveConfigPopup}
                className="px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-sm"
              >
                Lưu cấu hình
              </button>
              <button
                onClick={onPush}
                disabled={
                  pushing ||
                  !tempUrl.trim() ||
                  !tempSheetAttendance.trim() ||
                  !tempSheetKeo.trim() ||
                  !tempOwner.trim()
                }
                className="px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-500 text-white text-sm disabled:opacity-60"
              >
                {pushing ? "Đang đẩy dữ liệu..." : "Đẩy data"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
