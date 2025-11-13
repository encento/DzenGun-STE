import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";

/* ========= utils ========= */
const msFmt = (ms) => (Number.isFinite(ms) ? (ms / 1000).toFixed(2) + " s" : "—");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========= LG error codes ========= */
const LG_ERR = {
  0x00: "OK",
  0x01: "ERROR",
  0x02: "BUSY",
  0x03: "TIMEOUT",
  0x04: "BUFF_OVERFLOW",
  0x05: "PACKET_ERROR",
  0x06: "CMD_ERROR",
  0x07: "CRC_ERROR",
  0x08: "DATA_SIZE_ERROR",
  0x09: "UNSUPPORTED_PROTOCOL",
  0x0A: "ID_OUT_OF_RANGE",
  0x0B: "DATA_EMPTY",
  0x0C: "DATA_IS_NOT_INT",
  0xFF: "BUFFER_EMPTY",
};
function parseLgErr(line) {
  const m = line.match(/#ERR\s*=\s*([0-9A-Fa-fx]+)/);
  if (!m) return null;
  const raw = m[1];
  const isHex = /^0x/i.test(raw) || /[A-Fa-f]/.test(raw);
  const codeDec = isHex ? parseInt(raw.replace(/^0x/i, ""), 16) : parseInt(raw, 10);
  const name = LG_ERR[codeDec] || "UNKNOWN";
  return { codeDec, name, raw };
}
const isRetryableLgErr = (codeDec) =>
  codeDec === 0x02 || codeDec === 0x03 || codeDec === 0x0B; // BUSY/TIMEOUT/DATA_EMPTY

/* ========= BLE HM-10 ========= */
const FFE0_SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb";
const FFE1_CHAR = "0000ffe1-0000-1000-8000-00805f9b34fb";

function useBleHm10() {
  const [supported] = useState(!!navigator.bluetooth);
  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [log, setLog] = useState([]);

  const deviceRef = useRef(null);
  const serverRef = useRef(null);
  const txrxRef = useRef(null);
  const writeQ = useRef(Promise.resolve());

  const rxBuf = useRef("");
  const rxLinesRef = useRef([]);
  const waitersRef = useRef([]);

  const pushLog = useCallback((s) => setLog((a) => [s, ...a].slice(0, 1200)), []);

  const writeLine = useCallback(async (text) => {
    const withTerm = text.endsWith("\r") ? text : text + "\r";
    writeQ.current = writeQ.current
      .then(async () => {
        const ch = txrxRef.current;
        if (!ch) throw new Error("TX not ready");
        pushLog("TX " + text);
        await ch.writeValue(new TextEncoder().encode(withTerm));
      })
      .catch((e) => pushLog("TX ERROR: " + (e?.message || e)));
    return writeQ.current;
  }, [pushLog]);

  const onRxLine = useCallback((line) => {
    rxLinesRef.current.push(line);
    waitersRef.current = waitersRef.current.filter((w) => {
      if (w.deadline && Date.now() > w.deadline) {
        w.reject(new Error("timeout"));
        return false;
      }
      if (w.test(line)) {
        w.resolve(line);
        return false;
      }
      return true;
    });
  }, []);

  const onRxChunk = useCallback(
    (dv) => {
      const chunk = new TextDecoder().decode(dv);
      rxBuf.current += chunk;
      for (;;) {
        const iR = rxBuf.current.indexOf("\r");
        const iN = rxBuf.current.indexOf("\n");
        if (iR < 0 && iN < 0) break;
        const sep = iR >= 0 && iN >= 0 ? Math.min(iR, iN) : Math.max(iR, iN);
        const line = rxBuf.current.slice(0, sep).trim();
        rxBuf.current = rxBuf.current.slice(sep + 1);
        if (line) {
          pushLog("RX: " + line);
          onRxLine(line);
        }
      }
    },
    [pushLog, onRxLine]
  );

  const waitForLine = useCallback((predicate, timeoutMs = 1200) => {
    return new Promise((resolve, reject) => {
      for (let i = rxLinesRef.current.length - 1; i >= 0; i--) {
        const ln = rxLinesRef.current[i];
        if (predicate(ln)) return resolve(ln);
      }
      const deadline = timeoutMs ? Date.now() + timeoutMs : 0;
      waitersRef.current.push({ test: predicate, resolve, reject, deadline });
      if (timeoutMs) {
        setTimeout(() => {
          waitersRef.current = waitersRef.current.filter((w) => {
            if (w.deadline && Date.now() > w.deadline) {
              w.reject(new Error("timeout"));
              return false;
            }
            return true;
          });
        }, timeoutMs + 40);
      }
    });
  }, []);

  // команды таймера и состояния
  const setTMin = useCallback(async (ms) => { await writeLine(`#S_TMIN=${ms | 0}`); }, [writeLine]);
  const setTMax = useCallback(async (ms) => { await writeLine(`#S_TMAX=${ms | 0}`); }, [writeLine]);

  const startDevice = useCallback(async () => {
    await writeLine(`#E_STARTT`);
    try { await waitForLine((ln) => /E_STARTT/i.test(ln) && /OK/i.test(ln), 800); } catch {}
  }, [writeLine, waitForLine]);

  const toStandby = useCallback(async () => { await writeLine(`#S_STB`); }, [writeLine]);
  const toReady   = useCallback(async () => { await writeLine(`#S_GRD`); }, [writeLine]);

  const getShotCount = useCallback(async () => {
    await writeLine(`#G_SNUM`);
    const line = await waitForLine((ln) => /(SNUM|#G_SNUM)\s*=\s*\d+/i.test(ln), 1500);
    const m = line.match(/=\s*(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }, [writeLine, waitForLine]);

  // uiId: 1..SNUM → devId: 0..SNUM-1
  const getShotTimeById = useCallback(async (uiId) => {
    const devId = uiId - 1;
    if (devId < 0) return { id: uiId, ms: null, err: 0x06 };
    await writeLine(`#G_STIME=${devId}`);
    const line = await waitForLine((ln) => /(#ERR|STIME|#G_STIME)\s*=/.test(ln), 1500);

    const parsedErr = parseLgErr(line);
    if (parsedErr) {
      const { codeDec, name } = parsedErr;
      pushLog(`ERR ${name} (0x${codeDec.toString(16).toUpperCase()}) on STIME uiId=${uiId} (devId=${devId})`);
      return { id: uiId, ms: null, err: codeDec };
    }
    const m = line.match(/(?:STIME|#G_STIME)\s*=\s*(\d+)/i) || line.match(/(\d+)/);
    const ms = m ? parseInt(m[1], 10) : null;
    return { id: uiId, ms, err: null };
  }, [writeLine, waitForLine, pushLog]);

  const getState = useCallback(async () => {
    await writeLine(`#G_STATE`);
    const line = await waitForLine((ln) => /(G_STATE|#G_STATE)\s*=\s*\d+/i.test(ln), 1200);
    const m = line.match(/=\s*(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }, [writeLine, waitForLine]);

  const connectClick = useCallback(async (ev) => {
    ev?.preventDefault?.(); ev?.stopPropagation?.();
    try {
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [FFE0_SERVICE, "generic_access", "generic_attribute"],
      });
      deviceRef.current = device;
      setDeviceName(device.name || device.id || "BLE device");
      pushLog("Chooser: device selected");

      const server = await device.gatt.connect();
      serverRef.current = server;
      pushLog("GATT: connected");

      const svc = await server.getPrimaryService(FFE0_SERVICE);
      const ch  = await svc.getCharacteristic(FFE1_CHAR);
      txrxRef.current = ch;

      if (ch.properties.notify) {
        await ch.startNotifications();
        ch.addEventListener("characteristicvaluechanged", (e) => onRxChunk(e.target.value));
        pushLog("FFE1: notifications started");
      } else {
        pushLog("FFE1: notify not supported");
      }

      setConnected(true);
      pushLog("HM-10 UART ready (FFE1)");
    } catch (e) {
      pushLog("CONNECT ERROR: " + (e?.message || e));
    }
  }, [onRxChunk, pushLog]);

  const disconnect = useCallback(() => {
    try { deviceRef.current?.gatt?.disconnect?.(); } catch {}
    serverRef.current = null;
    txrxRef.current = null;
    setConnected(false);
    pushLog("BLE: disconnected");
  }, [pushLog]);

  return {
    supported, connected, deviceName, log,
    connectClick, disconnect,
    setTMin, setTMax, startDevice, toStandby, toReady,
    getShotCount, getShotTimeById, getState,
    pushLog,
  };
}

/* ========= UI ========= */
export default function App() {
  const [modeUi, setModeUi] = useState("fixed");
  const [running, setRunning] = useState(false);
  const [shots, setShots] = useState([]);
  const [devState, setDevState] = useState(0); // 0 READY, 1 BEEP_WAITING, 2 STARTED

  const ble = useBleHm10();

  // Поллинг/состояние
  const pollerRef = useRef(null);
  const pollBusyRef = useRef(false);
  const pollSessionRef = useRef(0);

  // Карта id -> ms (null = бронь), фальстарты
  const shotsMapRef = useRef(new Map());
  const fsSetRef = useRef(new Set());

  // SNUM кеш
  const snumCacheRef = useRef({ value: 0, ts: 0 });

  // Повтор дочитки забронированных слотов
  const pendingRef = useRef(new Map()); // id -> tries

  // настройки
  const TICK_MS = 500;
  const SNUM_COOLDOWN = 400;
  const RETRY_PAUSE = 120;
  const MAX_FILL_RETRIES = 3;

  // helpers
  const stateText = useMemo(
    () => (devState === 0 ? "Ожидание" : devState === 1 ? "Отсчёт" : devState === 2 ? "Упражнение" : "—"),
    [devState]
  );

  const hasMsValue = useCallback((ms) => {
    for (const v of shotsMapRef.current.values()) if (v === ms) return true;
    return false;
  }, []);

  const rebuildShotsFromMap = useCallback(() => {
    const ids = Array.from(shotsMapRef.current.keys()).sort((a, b) => a - b);
    const arr = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const curMs = shotsMapRef.current.get(id); // может быть null
      const prevId = i > 0 ? ids[i - 1] : null;
      const prevMs = prevId != null ? shotsMapRef.current.get(prevId) : null;

      // сплит между каждой соседней парой; null если одного из значений нет
      const split = curMs != null && prevMs != null ? curMs - prevMs : null;

      arr.push({
        id,
        seq: i + 1,
        deltaFromBeep: curMs ?? null,
        split,
        fs: fsSetRef.current.has(id),
      });
    }
    setShots(arr);
  }, []);

  const reserveSlot = useCallback(
    (id, asFalseStart = false) => {
      if (!shotsMapRef.current.has(id)) {
        shotsMapRef.current.set(id, null);
        if (asFalseStart) fsSetRef.current.add(id);
        pendingRef.current.set(id, 0);
        rebuildShotsFromMap();
        ble.pushLog?.(`Reserve slot for id=${id}${asFalseStart ? " [FS]" : ""}`);
      } else if (asFalseStart) {
        fsSetRef.current.add(id);
        rebuildShotsFromMap();
      }
    },
    [ble, rebuildShotsFromMap]
  );

  const fillSlot = useCallback(
    (id, ms) => {
      if (ms == null) return;
      if (hasMsValue(ms)) {
        ble.pushLog?.(`Duplicate STIME ignored: id=${id}, ms=${ms}`);
        return;
      }
      shotsMapRef.current.set(id, ms);
      pendingRef.current.delete(id);
      rebuildShotsFromMap();
    },
    [ble, hasMsValue, rebuildShotsFromMap]
  );

  const firstShotMs = useMemo(() => shots[0]?.deltaFromBeep ?? null, [shots]);
  const totalTimeMs = useMemo(
    () => (shots.length ? shots[shots.length - 1].deltaFromBeep : null),
    [shots]
  );
  const chartData = useMemo(
    () =>
      shots.map((s) => ({
        seq: s.seq,
        tempo: s.seq === 1 ? s.deltaFromBeep : s.split, // <- 1-я точка = first shot, дальше = split
      })),
    [shots]
  );
  

  useEffect(() => () => clearInterval(pollerRef.current), []);

  const findNextPendingId = useCallback((snum) => {
    for (let id = 1; id <= snum; id++) {
      if (!shotsMapRef.current.has(id)) return id;
      if (shotsMapRef.current.get(id) == null) return id;
    }
    return null;
  }, []);

  // Ждём state==2 (Started). Пока 0/1 — собираем фальстарты.
  const waitUntilBeepAndCollectFS = useCallback(async () => {
    for (;;) {
      const state = await ble.getState(); // 0 READY, 1 BEEP_WAITING, 2 STARTED
      setDevState(state);
      if (state === 2) {
        ble.pushLog("STATE=STARTED (2) — начинаем основной опрос");
        return true;
      }
      const snum = await ble.getShotCount();
      for (let uiId = 1; uiId <= snum; uiId++) reserveSlot(uiId, true);
      await sleep(200);
    }
  }, [ble, reserveSlot]);

  const startPollingShots = useCallback(async () => {
    if (!ble.connected) {
      ble.pushLog("Poll: BLE not connected");
      return;
    }
    clearInterval(pollerRef.current);

    pollSessionRef.current += 1;
    const mySession = pollSessionRef.current;

    shotsMapRef.current.clear();
    fsSetRef.current.clear();
    pendingRef.current.clear();
    snumCacheRef.current = { value: 0, ts: 0 };
    setShots([]);

    await waitUntilBeepAndCollectFS();

    pollerRef.current = setInterval(async () => {
      if (pollSessionRef.current !== mySession) return;
      if (pollBusyRef.current) return;

      pollBusyRef.current = true;
      try {
        const state = await ble.getState();
        setDevState(state);

        const now = Date.now();
        if (now - snumCacheRef.current.ts >= SNUM_COOLDOWN) {
          const s = await ble.getShotCount();
          snumCacheRef.current = { value: s, ts: now };
        }
        const snum = snumCacheRef.current.value;
        if (snum <= 0) return;

        const nextId = findNextPendingId(snum);
        if (!nextId) return;

        let { ms, err } = await ble.getShotTimeById(nextId);

        if (ms != null) {
          fillSlot(nextId, ms);
          return;
        }

        if (!shotsMapRef.current.has(nextId)) reserveSlot(nextId);

        const tries = (pendingRef.current.get(nextId) || 0) + 1;
        pendingRef.current.set(nextId, tries);

        if (err != null && isRetryableLgErr(err) && tries < MAX_FILL_RETRIES) {
          ble.pushLog(`Retry STIME id=${nextId} (${tries}/${MAX_FILL_RETRIES})`);
          await sleep(RETRY_PAUSE);
          const again = await ble.getShotTimeById(nextId);
          if (again.ms != null) {
            fillSlot(nextId, again.ms);
            return;
          }
        }

        if (tries >= MAX_FILL_RETRIES) {
          ble.pushLog(`Give up STIME id=${nextId} after ${tries} tries`);
        }
      } catch (e) {
        ble.pushLog("Poll error: " + (e?.message || e));
      } finally {
        pollBusyRef.current = false;
      }
    }, TICK_MS);

    ble.pushLog("Poll: started");
  }, [ble, fillSlot, findNextPendingId, waitUntilBeepAndCollectFS, reserveSlot]);

  const stopPollingShots = useCallback(() => {
    clearInterval(pollerRef.current);
    pollerRef.current = null;
    pollBusyRef.current = false;
    pollSessionRef.current += 1;
    ble.pushLog("Poll: stopped");
  }, [ble]);

  // Управление
  const startSession = async () => {
    if (running) return;
    if (!ble.connected) {
      ble.pushLog("Start skipped: BLE not connected");
      return;
    }
    setRunning(true);

    shotsMapRef.current.clear();
    fsSetRef.current.clear();
    pendingRef.current.clear();
    snumCacheRef.current = { value: 0, ts: 0 };
    setShots([]);
    setDevState(0);

    try {
      if (modeUi === "fixed") {
        await ble.setTMin(5000);
        await ble.setTMax(5000);
      } else {
        await ble.setTMin(5000);
        await ble.setTMax(10000);
      }
      ble.pushLog("BEEP sent (#E_STARTT)");
      await ble.startDevice();
      await sleep(120);
      await startPollingShots();
    } catch (e) {
      ble.pushLog("Start error: " + (e?.message || e));
    }
  };

  const stopOnly = async () => {
    setRunning(false);
    stopPollingShots();
  };

  const resetAll = async () => {
    await stopOnly();
    shotsMapRef.current.clear();
    fsSetRef.current.clear();
    pendingRef.current.clear();
    setShots([]);
    setDevState(0);
    try {
      await ble.toStandby();
      await ble.toReady();
      ble.pushLog("Device SNUM reset via #S_STB→#S_GRD");
    } catch (e) {
      ble.pushLog("Device reset error: " + (e?.message || e));
    }
  };

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100 px-4 py-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
            DzenGun STE
          </h1>
          <div className="text-slate-400 text-sm">
            Supreme Training Experience
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Настройки старта */}
          <div className="bg-slate-800/60 rounded-2xl shadow-xl p-6 border border-slate-700">
            <h2 className="text-lg font-semibold mb-3">Настройки старта</h2>
            <div className="mb-4">
              <div className="text-sm text-slate-400 mb-2">Режим таймера</div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setModeUi("fixed")}
                  className={`px-3 py-2 rounded-xl border font-semibold ${
                    modeUi === "fixed"
                      ? "bg-slate-100 text-black border-slate-300"
                      : "bg-transparent text-white border-slate-600 hover:border-slate-400"
                  }`}
                >
                  Fixed 5 s
                </button>
                <button
                  onClick={() => setModeUi("random")}
                  className={`px-3 py-2 rounded-xl border font-semibold ${
                    modeUi === "random"
                      ? "bg-slate-100 text-black border-slate-300"
                      : "bg-transparent text-white border-slate-600 hover:border-slate-400"
                  }`}
                >
                  Random 5–10 s
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <button
                onClick={startSession}
                disabled={running}
                className={`px-5 py-2.5 rounded-2xl font-semibold shadow-lg transition ${
                  running
                    ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                    : "bg-emerald-500 text-black hover:bg-emerald-400 active:bg-emerald-600"
                }`}
              >
                START
              </button>

              <button
                onClick={stopOnly}
                className="px-5 py-2.5 rounded-2xl font-semibold border border-slate-500 text-black bg-slate-100 hover:bg-slate-200 transition"
              >
                Stop
              </button>

              <button
                onClick={resetAll}
                className="px-5 py-2.5 rounded-2xl font-semibold border border-slate-500 text-black bg-slate-100 hover:bg-slate-200 transition"
              >
                Reset
              </button>
            </div>
          </div>

          {/* Статус + BLE */}
          <div className="bg-slate-800/60 rounded-2xl shadow-xl p-6 border border-slate-700">
            <h2 className="text-lg font-semibold mb-3">Статус</h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2 flex items-center justify-between">
                <Row k="Состояние" v={running ? stateText : "Ожидание"} ok={running} />
                <Row
                  k="BLE"
                  v={ble.connected ? `Подключено • ${ble.deviceName || ""}` : "Отключено"}
                  ok={ble.connected}
                />
              </div>

              <div className="col-span-2 grid grid-cols-3 gap-3 mt-2">
                <StatCard label="First Shot" value={firstShotMs != null ? msFmt(firstShotMs) : "—"} />
                <StatCard label="# Shots" value={String(shots.length)} />
                <StatCard label="Total Time" value={totalTimeMs != null ? msFmt(totalTimeMs) : "—"} />
              </div>

              <div className="col-span-2">
                <div className="flex flex-wrap gap-2 mb-3">
                  <button
                    type="button"
                    onClick={ble.connectClick}
                    disabled={!ble.supported || ble.connected}
                    className={`px-4 py-2 rounded-2xl font-semibold shadow ${
                      ble.connected
                        ? "bg-slate-700 text-slate-400"
                        : "bg-emerald-500 text-black hover:bg-emerald-400"
                    }`}
                  >
                    {ble.connected ? "Подключено" : "Подключить"}
                    {ble.deviceName ? ` • ${ble.deviceName}` : ""}
                  </button>

                  <button
                    type="button"
                    onClick={ble.disconnect}
                    disabled={!ble.connected}
                    className="px-4 py-2 rounded-2xl font-semibold border border-slate-500 text-black bg-slate-100 hover:bg-slate-200"
                  >
                    Отключить
                  </button>
                </div>

                <div className="text-xs text-slate-400">
                  <div className="mb-1">Лог обмена:</div>
                  <div className="h-56 overflow-auto bg-slate-900/60 border border-slate-700 rounded-lg p-2 whitespace-pre-wrap">
                    {ble.log.map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Таблица и график */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
          <div className="lg:col-span-2 bg-slate-800/60 rounded-2xl shadow-xl p-4 md:p-6 border border-slate-700">
            <h2 className="text-lg font-semibold mb-3">Выстрелы</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-300/80">
                  <tr>
                    <th className="text-left font-medium py-2">#</th>
                    <th className="text-left font-medium py-2">t от beep</th>
                    <th className="text-left font-medium py-2">Split</th>
                  </tr>
                </thead>
                <tbody>
                  {shots.map((s) => (
                    <tr key={s.id} className="border-t border-slate-700/60">
                      <td className="py-2 tabular-nums">{s.seq}</td>
                      <td className="py-2 tabular-nums">
                        {s.fs ? "FS" : msFmt(s.deltaFromBeep)}
                      </td>
                      <td className="py-2 tabular-nums">
                        {s.split != null ? msFmt(s.split) : "—"}
                      </td>
                    </tr>
                  ))}
                  {shots.length === 0 && (
                    <tr>
                      <td colSpan="3" className="py-6 text-center text-slate-400">
                        Нажми START — устройство подаст beep и начнётся опрос.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-slate-800/60 rounded-2xl shadow-xl p-4 md:p-6 border border-slate-700">
            <h2 className="text-lg font-semibold mb-3">График темпа</h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="seq" stroke="#94a3b8" tick={{ fill: "#94a3b8" }} />
                  <YAxis stroke="#94a3b8" tick={{ fill: "#94a3b8" }}
                         tickFormatter={(v) => `${(v / 1000).toFixed(2)}s`} />
                 <Tooltip
  formatter={(v, _name, ctx) => {
    const seq = ctx?.payload?.seq;
    const label = seq === 1 ? "First Shot" : "Split";
    return [msFmt(Number(v)), label];
  }}
  labelFormatter={(l) => `#${l}`}
  contentStyle={{ background: "#0f172a", border: "1px solid #334155", color: "#e2e8f0" }}
/>
<Line type="monotone" dataKey="tempo" name="Tempo" dot stroke="#22c55e" />

                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="text-xs text-slate-400 mt-2">
              График строится до подачи сигнала Stop. Чтобы увидеть результаты - остановите упражнение.
            </div>
          </div>
        </div>

        <div className="mt-6 text-xs text-slate-500">
         Тестовая сборка v 0.98 от 13.11.2025
        </div>
      </div>
    </div>
  );
}

/* ========= small UI bits ========= */
function Row({ k, v, ok }) {
  return (
    <div className="flex items-center gap-2">
  <div className="text-slate-400 text-sm">{k}:</div>
  <div className={`text-sm font-medium ${ok ? "text-emerald-400" : "text-slate-300"}`}>{v}</div>
</div>

  );
}
function StatCard({ label, value }) {
  return (
    <div className="bg-slate-900/60 border border-slate-700 rounded-xl p-3">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
