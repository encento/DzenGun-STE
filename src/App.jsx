import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";

/* ========= утилиты ========= */

const msFmt = (ms) =>
  Number.isFinite(ms) ? (ms / 1000).toFixed(2) + " s" : "—";

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/* ========= BLE HM-10 (FFE0 / FFE1) ========= */

const FFE0_SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb";
const FFE1_CHAR = "0000ffe1-0000-1000-8000-00805f9b34fb";

function useBleHm10() {
  const [supported] = useState(!!navigator.bluetooth);
  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [log, setLog] = useState([]);

  const deviceRef = useRef(null);
  const serverRef = useRef(null);
  const chRef = useRef(null);
  const writeQ = useRef(Promise.resolve());
  const rxBufRef = useRef("");
  const rxLinesRef = useRef([]);

  const pushLog = useCallback((s) => {
    setLog((prev) => [s, ...prev].slice(0, 400));
  }, []);

  const onRxChunk = useCallback(
    (dv) => {
      const chunk = new TextDecoder().decode(dv);
      rxBufRef.current += chunk;

      for (;;) {
        const idxR = rxBufRef.current.indexOf("\r");
        const idxN = rxBufRef.current.indexOf("\n");
        if (idxR < 0 && idxN < 0) break;
        const idx =
          idxR >= 0 && idxN >= 0 ? Math.min(idxR, idxN) : Math.max(idxR, idxN);
        const line = rxBufRef.current.slice(0, idx).trim();
        rxBufRef.current = rxBufRef.current.slice(idx + 1);
        if (line) {
          rxLinesRef.current.push(line);
          pushLog("RX: " + line);
        }
      }
    },
    [pushLog]
  );

  const writeLine = useCallback(
    async (cmd) => {
      const text = cmd.endsWith("\r") ? cmd : cmd + "\r";
      writeQ.current = writeQ.current
        .then(async () => {
          const ch = chRef.current;
          if (!ch) throw new Error("TX char not ready");
          pushLog("TX " + cmd.replace(/\r/g, "\\r"));
          const data = new TextEncoder().encode(text);
          await ch.writeValue(data);
        })
        .catch((e) => {
          pushLog("TX ERROR: " + (e?.message || e));
        });

      return writeQ.current;
    },
    [pushLog]
  );

  const waitForLine = useCallback(
    async (startsWith, timeoutMs = 1500) => {
      const start = Date.now();
      for (;;) {
        const idx = rxLinesRef.current.findIndex((ln) =>
          ln.startsWith(startsWith)
        );
        if (idx >= 0) {
          const [line] = rxLinesRef.current.splice(idx, 1);
          return line;
        }
        if (Date.now() - start > timeoutMs) {
          throw new Error("timeout");
        }
        await sleep(50);
      }
    },
    []
  );

  const connectClick = useCallback(async () => {
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
      const ch = await svc.getCharacteristic(FFE1_CHAR);
      chRef.current = ch;

      if (ch.properties.notify) {
        await ch.startNotifications();
        ch.addEventListener("characteristicvaluechanged", (e) =>
          onRxChunk(e.target.value)
        );
        pushLog("FFE1: notifications started");
      } else {
        pushLog("FFE1: notify not supported; write-only");
      }

      setConnected(true);
      pushLog("HM-10 UART ready (FFE1)");
    } catch (e) {
      pushLog("CONNECT ERROR: " + (e?.message || e));
    }
  }, [onRxChunk, pushLog]);

  const disconnect = useCallback(() => {
    try {
      deviceRef.current?.gatt?.disconnect?.();
    } catch (_) {}
    serverRef.current = null;
    chRef.current = null;
    setConnected(false);
    pushLog("BLE: disconnected");
  }, [pushLog]);

  /* ===== обёртки протокола ===== */

  const getState = useCallback(async () => {
    await writeLine("#G_STATE");
    const line = await waitForLine("#G_STATE=", 2000);
    const m = line.match(/^#G_STATE\s*=\s*(\d+)/);
    const val = m ? parseInt(m[1], 10) : NaN;
    if (!Number.isFinite(val)) throw new Error("Bad G_STATE");
    return val; // 0 READY, 1 BEEP_WAITING, 2 STARTED
  }, [waitForLine, writeLine]);

  const getShotCount = useCallback(async () => {
    await writeLine("#G_SNUM");
    const line = await waitForLine("#G_SNUM=", 2500);
    const m = line.match(/^#G_SNUM\s*=\s*(\d+)/);
    const val = m ? parseInt(m[1], 10) : NaN;
    if (!Number.isFinite(val)) throw new Error("Bad G_SNUM");
    return val;
  }, [waitForLine, writeLine]);

  const getShotTime = useCallback(
    async (devId) => {
      await writeLine(`#G_STIME=${devId}`);
      const line = await waitForLine("#G_STIME=", 2500);
      const m = line.match(/^#G_STIME\s*=\s*(\d+)/);
      const val = m ? parseInt(m[1], 10) : NaN;
      if (!Number.isFinite(val)) throw new Error("Bad G_STIME");
      return val; // мс от Beep
    },
    [waitForLine, writeLine]
  );

  const setTMin = useCallback(
    async (ms) => {
      await writeLine(`#S_TMIN=${ms | 0}`);
    },
    [writeLine]
  );

  const setTMax = useCallback(
    async (ms) => {
      await writeLine(`#S_TMAX=${ms | 0}`);
    },
    [writeLine]
  );

  const startDevice = useCallback(async () => {
    await writeLine("#E_STARTT");
  }, [writeLine]);

  const clearExercise = useCallback(async () => {
    // будущая команда прошивки — пока просто шлём, игнорируем ошибки
    try {
      await writeLine("#E_CLR");
    } catch (e) {
      pushLog("E_CLR not supported yet: " + (e?.message || e));
    }
  }, [writeLine, pushLog]);

  return {
    supported,
    connected,
    deviceName,
    log,
    connectClick,
    disconnect,
    writeLine,
    getState,
    getShotCount,
    getShotTime,
    setTMin,
    setTMax,
    startDevice,
    clearExercise,
    pushLog,
  };
}

/* ========= App ========= */

export default function App() {
  const ble = useBleHm10();

  const [modeUi, setModeUi] = useState("fixed"); // fixed | random

  const [devState, setDevState] = useState(0); // 0 READY,1 WAIT,2 STARTED

  const [shots, setShots] = useState([]); // [{uiId, ms, split, fs}]
  const [running, setRunning] = useState(false);
  const [beepSent, setBeepSent] = useState(false);

  const runningRef = useRef(false);
  const pollingRef = useRef(false);
  const sessionBaseRef = useRef(0);

  const shotsMapRef = useRef(new Map());

  /* ====== метрики / график ====== */

  // 1-й выстрел — t от beep, остальные — split; FS не рисуем
  const chartData = useMemo(
    () =>
      shots.map((s) => {
        if (s.fs) return { seq: s.uiId, value: null };
        if (s.uiId === 1) {
          return { seq: s.uiId, value: s.ms };
        }
        return { seq: s.uiId, value: s.split };
      }),
    [shots]
  );

  const firstShotMs = useMemo(
    () =>
      shots.length
        ? shots[0].fs
          ? null
          : shots[0].ms
        : null,
    [shots]
  );

  const bestSplit = useMemo(() => {
    const arr = shots.filter((s) => !s.fs && s.uiId > 1 && s.split != null);
    if (!arr.length) return null;
    return Math.min(...arr.map((s) => s.split));
  }, [shots]);

  const totalTime = useMemo(() => {
    const arr = shots.filter((s) => !s.fs);
    if (!arr.length) return null;
    const last = arr[arr.length - 1];
    return last.ms;
  }, [shots]);

  /* ===== вспомогательные функции над выстрелами ===== */

  const resetSessionState = useCallback(() => {
    shotsMapRef.current.clear();
    setShots([]);
    setBeepSent(false);
  }, []);

  const recalcSplits = useCallback(() => {
    const arr = Array.from(shotsMapRef.current.values()).sort(
      (a, b) => a.uiId - b.uiId
    );
    let prevNonFs = null;
    for (const s of arr) {
      if (s.fs) {
        s.split = null;
        continue;
      }
      if (!prevNonFs) {
        s.split = null;
        prevNonFs = s;
      } else {
        s.split = s.ms - prevNonFs.ms;
        prevNonFs = s;
      }
    }
    setShots(arr);
  }, []);

  const addShotMs = useCallback(
    (uiId, ms, fs) => {
      const existing = shotsMapRef.current.get(uiId);
      if (existing) {
        if (existing.ms === ms && existing.fs === fs) return;
        existing.ms = ms;
        if (fs != null) existing.fs = fs;
      } else {
        shotsMapRef.current.set(uiId, { uiId, ms, split: null, fs: !!fs });
      }
      recalcSplits();
    },
    [recalcSplits]
  );

  const reserveFsShot = useCallback(
    (uiId) => {
      if (!shotsMapRef.current.has(uiId)) {
        shotsMapRef.current.set(uiId, { uiId, ms: null, split: null, fs: true });
      } else {
        const s = shotsMapRef.current.get(uiId);
        s.fs = true;
      }
      recalcSplits();
    },
    [recalcSplits]
  );

  /* ===== ожидание BEEP и фальстарты ===== */

  const waitUntilBeepAndCollectFS = useCallback(async () => {
    let baseline = 0;
    try {
      for (let i = 0; i < 3; i++) {
        try {
          baseline = await ble.getShotCount();
          break;
        } catch (eInner) {
          if (i === 2) throw eInner;
          await sleep(200);
        }
      }
      ble.pushLog(`FS: baseline SNUM before beep = ${baseline}`);
    } catch (e) {
      ble.pushLog("FS baseline SNUM read error: " + (e?.message || e));
      baseline = 0;
    }

    let lastSnum = baseline;

    for (;;) {
      const state = await ble.getState();
      setDevState(state);

      if (state === 2) {
        ble.pushLog("STATE=STARTED (2) — начинаем основной опрос");
        return true;
      }

      let snum = 0;
      try {
        snum = await ble.getShotCount();
      } catch (e) {
        ble.pushLog("FS SNUM read error: " + (e?.message || e));
        await sleep(200);
        continue;
      }

      if (snum > lastSnum) {
        for (let devId = lastSnum; devId < snum; devId++) {
          const uiId = devId - baseline + 1;
          reserveFsShot(uiId);
        }
        lastSnum = snum;
      }

      await sleep(200);
    }
  }, [ble, reserveFsShot]);

  /* ===== основной поллинг после STARTED ===== */

  const pollOnce = useCallback(
    async () => {
      const state = await ble.getState();
      setDevState(state);
      if (state !== 2) return;

      const devSnum = await ble.getShotCount();
      const base = sessionBaseRef.current || 0;

      const sessionCount = Math.max(0, devSnum - base);
      ble.pushLog(
        `POLL: devSNUM=${devSnum}, base=${base}, sessionCount=${sessionCount}`
      );

      if (sessionCount <= 0) return;

      for (let uiId = 1; uiId <= sessionCount; uiId++) {
        const existing = shotsMapRef.current.get(uiId);
        if (existing && existing.ms != null) continue;

        const devId = base + (uiId - 1);

        try {
          const ms = await ble.getShotTime(devId);
          addShotMs(uiId, ms, existing?.fs ?? false);
        } catch (e) {
          ble.pushLog(
            `Poll STIME error for uiId=${uiId}, devId=${devId}: ${
              e?.message || e
            }`
          );
        }
      }
    },
    [addShotMs, ble]
  );

  const startPolling = useCallback(async () => {
    if (pollingRef.current) return;
    pollingRef.current = true;
    ble.pushLog("Poll: started");

    while (runningRef.current && pollingRef.current && ble.connected) {
      try {
        await pollOnce();
      } catch (e) {
        ble.pushLog("Poll error: " + (e?.message || e));
      }
      await sleep(250);
    }

    ble.pushLog("Poll: stopped");
    pollingRef.current = false;
  }, [ble, pollOnce]);

  /* ===== старт сессии ===== */

  const startSession = useCallback(async () => {
    if (runningRef.current) return;
    if (!ble.connected) {
      ble.pushLog("Start skipped: BLE not connected");
      return;
    }

    runningRef.current = true;
    setRunning(true);
    resetSessionState();
    setDevState(0);

    // будущий хард-reset упражнения на железке
    try {
      await ble.clearExercise();
    } catch (e) {
      ble.pushLog("E_CLR error (ignored for now): " + (e?.message || e));
    }

    try {
      let base = 0;
      try {
        for (let i = 0; i < 3; i++) {
          try {
            base = await ble.getShotCount();
            break;
          } catch (eInner) {
            if (i === 2) throw eInner;
            await sleep(200);
          }
        }
        sessionBaseRef.current = base;
        ble.pushLog(`Session baseline SNUM = ${base}`);
      } catch (e) {
        sessionBaseRef.current = 0;
        ble.pushLog(
          "Session baseline SNUM read error: " + (e?.message || e)
        );
      }

      // таймер
      if (modeUi === "fixed") {
        await ble.setTMin(5000);
        await ble.setTMax(5000);
      } else {
        await ble.setTMin(5000);
        await ble.setTMax(10000);
      }

      await ble.startDevice();
      ble.pushLog("BEEP sent (#E_STARTT)");
      setBeepSent(true);

      const ok = await waitUntilBeepAndCollectFS();
      if (!ok) throw new Error("waitUntilBeepAndCollectFS returned false");

      startPolling();
    } catch (e) {
      ble.pushLog("Start error: " + (e?.message || e));
      runningRef.current = false;
      setRunning(false);
    }
  }, [
    ble,
    modeUi,
    resetSessionState,
    startPolling,
    waitUntilBeepAndCollectFS,
  ]);

  /* ===== стоп сессии ===== */

  const stopSession = useCallback(async () => {
    runningRef.current = false;
    pollingRef.current = false;
    setRunning(false);
    ble.pushLog("Stop");
  }, [ble]);

  /* ===== клавиатура (dev) ===== */

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        // dev-хук, сейчас не используем
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ===== текст статуса ===== */

  const devStateText = useMemo(() => {
    if (devState === 0) return "Готов";
    if (devState === 1) return "Отсчёт";
    if (devState === 2) return "Упражнение";
    return "Неизвестно";
  }, [devState]);

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100 px-4 py-6">
      <div className="max-w-6xl mx-auto">
        {/* шапка */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
              Laser Gun Timer
            </h1>
            <div className="text-xs text-slate-400 mt-1">
              BLE HM-10 · протокол LG · v0.9805
            </div>
          </div>
          <div className="text-slate-400 text-sm">
            {ble.supported
              ? `BLE: ${ble.connected ? "подключено" : "нет соединения"}`
              : "Web Bluetooth недоступен"}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Панель управления */}
          <div className="bg-slate-800/60 rounded-2xl shadow-xl p-6 border border-slate-700">
            <h2 className="text-lg font-semibold mb-3">Настройки старта</h2>
            <div className="space-y-4">
              <div>
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
                  disabled={running || !ble.connected}
                  className={`px-5 py-2.5 rounded-2xl font-semibold shadow-lg transition ${
                    running || !ble.connected
                      ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                      : "bg-emerald-500 text-black hover:bg-emerald-400 active:bg-emerald-600"
                  }`}
                >
                  START
                </button>

                <button
                  onClick={stopSession}
                  className="px-5 py-2.5 rounded-2xl font-semibold border border-slate-500 text-black bg-slate-100 hover:bg-slate-200 transition"
                >
                  Stop
                </button>
              </div>
            </div>
          </div>

          {/* Статус */}
          <div className="bg-slate-800/60 rounded-2xl shadow-xl p-6 border border-slate-700">
            <h2 className="text-lg font-semibold mb-3">Статус</h2>
            <div className="space-y-2 text-sm">
              <Row k="Состояние" v={devStateText} ok={devState === 2} />
              <Row
                k="Beep отправлен"
                v={beepSent ? "Да" : "Нет"}
                ok={beepSent}
              />
              <Row
                k="Устройство"
                v={
                  ble.connected
                    ? ble.deviceName || "Подключено"
                    : "Не подключено"
                }
                ok={ble.connected}
              />
            </div>

            <div className="grid grid-cols-4 gap-3 mt-4 text-sm">
              <StatCard
                label="First Shot"
                value={firstShotMs != null ? msFmt(firstShotMs) : "—"}
              />
              <StatCard label="# Shots" value={String(shots.length)} />
              <StatCard
                label="Best Split"
                value={bestSplit != null ? msFmt(bestSplit) : "—"}
              />
              <StatCard
                label="Total Time"
                value={totalTime != null ? msFmt(totalTime) : "—"}
              />
            </div>
          </div>

          {/* BLE панель + лог */}
          <div className="bg-slate-800/60 rounded-2xl shadow-xl p-6 border border-slate-700">
            <h2 className="text-lg font-semibold mb-3">BLE устройство</h2>

            {!ble.supported && (
              <p className="text-red-300 mb-3">
                Web Bluetooth недоступен. Нужен Chrome/Edge (HTTPS или
                localhost).
              </p>
            )}

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
                Подключить
              </button>
              <button
                onClick={ble.disconnect}
                disabled={!ble.connected}
                className="px-4 py-2 rounded-2xl font-semibold border border-slate-500 text-black bg-slate-100 hover:bg-slate-200"
              >
                Отключить
              </button>
            </div>

            <div className="text-xs text-slate-400">
              <div className="mb-1">Лог обмена:</div>
              <div className="h-40 overflow-auto bg-slate-900/60 border border-slate-700 rounded-lg p-2 whitespace-pre-wrap">
                {ble.log.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Таблица + график */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4">
          <div className="lg:col-span-2 bg-slate-800/60 rounded-2xl shadow-xl p-4 md:p-6 border border-slate-700">
            <h2 className="text-lg font-semibold mb-3">Выстрелы</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-300/80">
                  <tr>
                    <th className="text-left font-medium py-2">#</th>
                    <th className="text-left font-medium py-2">
                      t от beep / FS
                    </th>
                    <th className="text-left font-medium py-2">Split</th>
                  </tr>
                </thead>
                <tbody>
                  {shots.map((s) => (
                    <tr
                      key={s.uiId}
                      className="border-t border-slate-700/60"
                    >
                      <td className="py-2 tabular-nums">{s.uiId}</td>
                      <td className="py-2 tabular-nums">
                        {s.fs
                          ? "FS"
                          : s.ms != null
                          ? msFmt(s.ms)
                          : "—"}
                      </td>
                      <td className="py-2 tabular-nums">
                        {s.fs
                          ? "—"
                          : s.split != null
                          ? msFmt(s.split)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                  {shots.length === 0 && (
                    <tr>
                      <td
                        colSpan={3}
                        className="py-6 text-center text-slate-400"
                      >
                        Нет выстрелов — нажми START, дождись Beep и стреляй.
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
                <LineChart
                  data={chartData}
                  margin={{ top: 10, right: 20, left: 0, bottom: 10 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis
                    dataKey="seq"
                    stroke="#94a3b8"
                    tick={{ fill: "#94a3b8" }}
                  />
                  <YAxis
                    stroke="#94a3b8"
                    tick={{ fill: "#94a3b8" }}
                    tickFormatter={(v) => `${(v / 1000).toFixed(2)}s`}
                  />
                  <Tooltip
                    formatter={(v) => msFmt(Number(v))}
                    labelFormatter={(l) => `#${l}`}
                    contentStyle={{
                      background: "#0f172a",
                      border: "1px solid #334155",
                      color: "#e2e8f0",
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    name="Tempo"
                    dot
                    stroke="#22c55e"
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="text-xs text-slate-400 mt-2">
              Первый выстрел — First Shot (от beep), остальные — Split. FS —
              выстрел до beep (в график не попадает).
            </div>
          </div>
        </div>

        {/* футер с версией */}
        <div className="mt-6 text-center text-xs text-slate-500">
          Version · v0.9806
        </div>
      </div>
    </div>
  );
}

/* ===== мелкие компоненты ===== */

function Row({ k, v, ok }) {
  return (
    <div className="flex items-center justify-between">
      <div className="text-slate-400 text-sm">{k}</div>
      <div
        className={`text-sm font-medium ${
          ok ? "text-emerald-400" : "text-slate-300"
        }`}
      >
        {v}
      </div>
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
