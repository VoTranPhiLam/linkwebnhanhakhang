import { useLiveData } from './hooks/useLiveData'
import './index.scss'
import SetIntervalControl from './components/SetInterval'
import FullTriggerTable from './components/FullTriggerTable'

export default function App() {
  const { data, isLoading, error } = useLiveData()
  return (
    <div className="mx-auto max-w-[1900px] p-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-bold">Receiver Dashboard</h2>
        <SetIntervalControl />
      </div>
      {isLoading && <div className="text-neutral-400 text-xs">Loading...</div>}
      {error && <div className="text-red-400 text-xs">Load lỗi</div>}
      {data && (
        <>
          <div>
            <h3 className="text-sm font-semibold mb-2 text-neutral-200">Bảng kèo hiện tại</h3>
            <FullTriggerTable rows={data.live} disableSound={false} />
          </div>
          <div>
            <h3 className="text-sm font-semibold mb-2 mt-6 text-neutral-200">Bảng kèo cũ</h3>
            <FullTriggerTable rows={data.old} disableSound={true} isOld />
          </div>
        </>
      )}
    </div>
  )
}