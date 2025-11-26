import React from "react";
import {
  useLiveRefetchInterval,
  setLiveRefetchInterval,
} from "../hooks/useLiveData";
export default function SetIntervalControl() {
  const valMs = useLiveRefetchInterval();
  const [tmpSec, setTmpSec] = React.useState(
    String(Math.round(valMs / 1000) || 0)
  );
  React.useEffect(() => {
    setTmpSec(String(Math.round(valMs / 1000) || 0));
  }, [valMs]);

  const apply = () => {
    const n = Number(tmpSec);
    if (Number.isFinite(n) && n >= 0) {
      setLiveRefetchInterval(Math.round(n * 1000));
    }
  };

  return (
    <div className="flex items-center gap-2 text-xs">
      <span>Refresh (sec):</span>
      <input
        type="number"
        min={0}
        step={0.5}
        className="w-24 bg-neutral-900 border border-neutral-600 rounded px-2 py-1"
        value={tmpSec}
        onChange={(e) => setTmpSec(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
        }}
      />
      <button
        className="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white"
        onClick={apply}
      >
        Apply
      </button>
      <button
        className="px-2 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white"
        onClick={() => setLiveRefetchInterval(0)}
        title="Pause polling"
      >
        Pause
      </button>
    </div>
  );
}
