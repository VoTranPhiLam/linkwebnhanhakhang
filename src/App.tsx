import { useLiveData } from "./hooks/useLiveData";
import "./index.scss";
import SetIntervalControl from "./components/SetInterval";
import FullTriggerTable from "./components/FullTriggerTable";
import { useState } from "react";

export default function App() {
  const { data, isLoading, error } = useLiveData();
  const [dashboardTitle, setDashboardTitle] = useState<string>(() => {
    return localStorage.getItem("dashboardTitle") || "Receiver Dashboard";
  });
  const [customSound, setCustomSound] = useState<string | null>(() => {
    return localStorage.getItem("customSound") || null;
  });
  return (
    <div className="mx-auto max-w-[1900px] p-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
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
                  if (result) {
                    localStorage.setItem("customSound", result);
                  }
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
    </div>
  );
}
