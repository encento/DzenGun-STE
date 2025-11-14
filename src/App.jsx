import React, {
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

/* ========= helpers & protocol ========= */

const FFE0_SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb";
const FFE1_CHAR = "0000ffe1-0000-1000-8000-00805f9b34fb";

const msFmt = (ms) =>
  Number.isFinite(ms) ? (ms / 1000).toFixed(2) + " s" : "—";

const COM_ERROR_NAMES = {
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
  0x0a: "ID_OUT_OF_RANGE",
  0x0b: "DATA_EMPTY",
  0x0c: "DATA_IS_NOT_INT",
  0xff: "BUFFER_EMPTY",
};

function decodeErr(line) {
  const m = line.match(/^#ERR=([0-9A-Fa-f]+)/);
  if (!m) return null;
  const raw = m[1];
  const code =
    /^[0-9A-Fa-f]+$/.test(raw) && raw.length <= 2
      ? parseInt(raw, 16)
      : parseInt(raw, 10);
  const name = COM_ERROR_NAMES[code] ?? "UNKNOWN";
  return { code, name };
}

function recalcSplits(arr) {
  let lastTime = null;
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    if (s.isFs || s.tMs == null) {
      s.splitMs = null;
      continue;
    }
    if (lastTime == null) {
      s.splitMs = null;
    } else {
      s.splitMs = s.tMs - lastTime;
    }
    lastTime = s.tMs;
  }
}

/* ========= main component ========= */

export default function App() {
  /* ---- BLE state ---- */

  const [bleSupported] = useState(!!navigator.bluetooth);
  const [bleConnected, setBleConnected] = useState(false);
  const [bleName, setBleName] = useState("");
  const [log, setLog] = useState([]);

  const deviceRef = useRef(null);
  const serverRef = useRef(null);
  const txCharRef = useRef(null);
  const writeQRef = useRef(Promise.resolve());
  const rxBufRef = useRef("");

  const pushLog = (s) =>
    setLog((a) => [s, ...a].slice(0, 600));

  const writeLine = (text) => {
    const withTerm = text.endsWith("\r") ? text : text + "\r";
    writeQRef.current = writeQRef.current
      .then(async () => {
        const ch = txCharRef.current;
        if (!ch) throw new Error("TX not ready");
        pushLog("TX " + text);
        await ch.writeValue(
          new TextEncoder().encode(withTerm)
        );
      })
      .catch((e) =>
        pushLog("TX ERROR: " + (e?.message || String(e)))
      );
    return writeQRef.current;
  };

  /* ---- exercise state ---- */

  const [mode, setMode] = useState("fixed"); // fixed / random
  const [running, setRunning] = useState(false);
  const [exeState, setExeState] = useState(0); // 0 READY,1 BEEP_WAIT,2 STARTED
  const [shotCount, setShotCount] = useState(0);
  const [shots, setShots] = useState([]); // [{seq,tMs,splitMs,isFs}]

  const exeStateRef = useRef(0);
  const lastSnumRef = useRef(0);

  const shotsRef = useRef([]);
  const stimeQueueRef = useRef([]); // devId'ы
  const stimePendingRef = useRef(null);
  const stimeFetchedRef = useRef(new Set()); // devId'ы, для которых уже есть STIME

  const pollTimerRef = useRef(null);

  const updateShots = (updater) => {
    setShots((prev) => {
      const base = [...prev];
      const next = updater(base);
      shotsRef.current = next;
      return next;
    });
  };

  /* ---- metrics ---- */

  const nonFsShots = useMemo(
    () => shots.filter((s) => !s.isFs && s.tMs != null),
    [shots]
  );

  const firstShotMs = nonFsShots.length
    ? nonFsShots[0].tMs
    : null;
  const totalTimeMs = nonFsShots.length
    ? nonFsShots[nonFsShots.length - 1].tMs
    : null;
  const bestSplitMs =
    nonFsShots.length > 1
      ? Math.min(
          ...nonFsShots
            .slice(1)
            .map((s) => s.splitMs)
            .filter((v) => Number.isFinite(v))
        )
      : null;

  const cadenceData = useMemo(
    () =>
      shots.map((s) => ({
        seq: s.seq,
        val: s.isFs
          ? null
          : s.seq === 1
          ? s.tMs
          : s.splitMs,
      })),
    [shots]
  );

  const exeLabel = useMemo(() => {
    if (exeState === 1) return "Отсчёт";
    if (exeState === 2) return "Упражнение";
    return "Ожидание";
  }, [exeState]);

  /* ---- STIME queue processing ---- */

  function processStimeQueue() {
    if (stimePendingRef.current != null) return;
    const devId = stimeQueueRef.current.shift();
    if (devId == null) return;
    stimePendingRef.current = devId;

    writeLine(`#G_STIME=${devId}`).catch((e) => {
      pushLog(
        "STIME TX error: " + (e?.message || String(e))
      );
      stimePendingRef.current = null;
    });
  }

  /* ---- protocol line handler ---- */

  const handleProtocolLine = (line) => {
    if (!line) return;

    if (line.startsWith("#G_STATE=")) {
      const v = parseInt(line.split("=")[1], 10);
      if (Number.isFinite(v)) {
        exeStateRef.current = v;
        setExeState(v);
      }
      return;
    }

    if (line.startsWith("#G_SNUM=")) {
      const n = parseInt(line.split("=")[1], 10);
      if (!Number.isFinite(n)) return;

      setShotCount(n);

      const prev = lastSnumRef.current;
      lastSnumRef.current = n;

      // новое упражнение / сброс — просто обновляем счётчик
      if (n <= prev) return;

      const isFsNow = exeStateRef.current !== 2;

      for (let devId = prev; devId < n; devId++) {
        const seq = devId + 1;

        // создаём/обновляем слот выстрела
        updateShots((arr) => {
          while (arr.length < seq) {
            arr.push({
              seq: arr.length + 1,
              tMs: null,
              splitMs: null,
              isFs: false,
            });
          }
          const shot = arr[seq - 1];
          // помечаем FS, если произошёл до STARTED
          if (isFsNow) shot.isFs = true;
          return arr;
        });

        if (!stimeFetchedRef.current.has(devId)) {
          stimeQueueRef.current.push(devId);
        }
      }

      processStimeQueue();
      return;
    }

    if (line.startsWith("#G_STIME=")) {
      const ms = parseInt(line.split("=")[1], 10);
      if (!Number.isFinite(ms)) return;

      const devId = stimePendingRef.current;
      if (devId == null) {
        pushLog(
          "Unexpected STIME without pending id: " + ms
        );
        return;
      }

      stimePendingRef.current = null;

      if (stimeFetchedRef.current.has(devId)) {
        pushLog(
          `Duplicate STIME ignored: id=${devId}, ms=${ms}`
        );
        processStimeQueue();
        return;
      }

      stimeFetchedRef.current.add(devId);

      const seq = devId + 1;

      updateShots((arr) => {
        while (arr.length < seq) {
          arr.push({
            seq: arr.length + 1,
            tMs: null,
            splitMs: null,
            isFs: false,
          });
        }
        const shot = arr[seq - 1];

        if (shot.tMs === ms) {
          processStimeQueue();
          return arr;
        }

        shot.tMs = ms;
        recalcSplits(arr);
        return arr;
      });

      processStimeQueue();
      return;
    }

    if (line.startsWith("#ERR=")) {
      const info = decodeErr(line);
      if (info) {
        pushLog(
          `ERR ${info.name} (0x${info.code.toString(16)})`
        );
      }
      return;
    }
  };

  /* ---- RX chunk handler ---- */

  const handleRxChunk = (value) => {
    const chunk = new TextDecoder().decode(value);
    rxBufRef.current += chunk;

    for (;;) {
      const buf = rxBufRef.current;
      const iR = buf.indexOf("\r");
      const iN = buf.indexOf("\n");
      if (iR < 0 && iN < 0) break;
      const idx =
        iR >= 0 && iN >= 0
          ? Math.min(iR, iN)
          : Math.max(iR, iN);
      const line = buf.slice(0, idx).trim();
      rxBufRef.current = buf.slice(idx + 1);
      if (!line) continue;
      pushLog("RX: " + line);
      handleProtocolLine(line);
    }
  };

  /* ---- BLE connect / disconnect ---- */

  const connectBle = async () => {
    try {
      const device = await navigator.bluetooth.requestDevice(
        {
          acceptAllDevices: true,
          optionalServices: [FFE0_SERVICE],
        }
      );
      deviceRef.current = device;
      setBleName(device.name || device.id || "BLE");

      const server = await device.gatt.connect();
      serverRef.current = server;

      const svc = await server.getPrimaryService(
        FFE0_SERVICE
      );
      const ch = await svc.getCharacteristic(FFE1_CHAR);
      txCharRef.current = ch;

      if (ch.properties.notify) {
        await ch.startNotifications();
        ch.addEventListener(
          "characteristicvaluechanged",
          (e) => handleRxChunk(e.target.value)
        );
        pushLog("FFE1: notifications started");
      }

      setBleConnected(true);
      pushLog("HM-10 UART ready (FFE1)");
    } catch (e) {
      pushLog(
        "CONNECT ERROR: " + (e?.message || String(e))
      );
    }
  };

  const disconnectBle = () => {
    try {
      deviceRef.current?.gatt?.disconnect?.();
    } catch {
      /* ignore */
    }
    serverRef.current = null;
    txCharRef.current = null;
    setBleConnected(false);
    pushLog("BLE: disconnected");
  };

  /* ---- polling ---- */

  const startPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }
    pollTimerRef.current = setInterval(() => {
      if (!txCharRef.current) return;
      // основной опрос состояния и количества
      writeLine("#G_STATE").catch(() => {});
      writeLine("#G_SNUM").catch(() => {});
      // и заодно обслуживаем очередь STIME
      processStimeQueue();
    }, 250);
    pushLog("Poll: started");
  };

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
      pushLog("Poll: stopped");
    }
  };

  useEffect(() => {
    return () => {
      stopPolling();
      disconnectBle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- START / STOP / RESET ---- */

  const handleStart = async () => {
    if (!bleConnected) {
      pushLog("Start skipped: BLE not connected");
      return;
    }
    if (running) return;

    // полный сброс внутреннего состояния
    setRunning(true);
    setShots([]);
    shotsRef.current = [];
    stimeQueueRef.current = [];
    stimePendingRef.current = null;
    stimeFetchedRef.current = new Set();
    lastSnumRef.current = 0;
    setShotCount(0);
    setExeState(0);
    exeStateRef.current = 0;

    const tMin = mode === "fixed" ? 5000 : 5000;
    const tMax = mode === "fixed" ? 5000 : 10000;

    try {
      // 0) сброс устройства в STANDBY → READY
      await writeLine("#S_STB");
      await writeLine("#S_GRD");
      pushLog(
        "Device reset to STANDBY → READY before start"
      );

      // 1) параметры таймера
      await writeLine(`#S_TMAX=${tMax}`);
      await writeLine(`#S_TMIN=${tMin}`);

      // 2) старт упражнения / beep
      await writeLine("#E_STARTT");
      pushLog("BEEP sent (#E_STARTT)");
    } catch (e) {
      pushLog(
        "Start error: " + (e?.message || String(e))
      );
    }

    startPolling();
  };

  const handleStop = () => {
    if (!running) return;
    setRunning(false);
    stopPolling();
    pushLog("Stop");
    // очередь STIME уже в основном должна быть пустой,
    // т.к. мы опрашивали её во время упражнения
  };

  const handleReset = () => {
    setRunning(false);
    stopPolling();
    setShots([]);
    shotsRef.current = [];
    stimeQueueRef.current = [];
    stimePendingRef.current = null;
    stimeFetchedRef.current = new Set();
    lastSnumRef.current = 0;
    setShotCount(0);
    setExeState(0);
    exeStateRef.current = 0;
    pushLog("Reset (UI cleared)");
  };

  /* ========= UI ========= */

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-gradient-to-b from-slate-950 to-slate-900 text-slate-100 px-4 py-6">
      <div className="max-w-6xl mx-auto">
        {/* header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
            Laser Timer — MVP UI
          </h1>
          <div className="text-slate-400 text-sm">
            Web BLE / HM-10
          </div>
        </div>

        {/* controls */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          {/* mode + buttons */}
          <div className="bg-slate-800/60 rounded-2xl shadow-xl p-6 border border-slate-700">
            <h2 className="text-lg font-semibold mb-3">
              Настройки старта
            </h2>

            <div className="space-y-4">
              <div>
                <div className="text-sm text-slate-400 mb-2">
                  Режим
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setMode("fixed")}
                    className={`px-3 py-2 rounded-xl border font-semibold ${
                      mode === "fixed"
                        ? "bg-slate-100 text-black border-slate-300"
                        : "bg-transparent text-white border-slate-600 hover:border-slate-400"
                    }`}
                  >
                    Fixed 5 s
                  </button>
                  <button
                    onClick={() => setMode("random")}
                    className={`px-3 py-2 rounded-xl border font-semibold ${
                      mode === "random"
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
                  onClick={handleStart}
                  disabled={running || !bleConnected}
                  className={`px-5 py-2.5 rounded-2xl font-semibold shadow-lg transition ${
                    running || !bleConnected
                      ? "bg-slate-700 text-slate-500 cursor-not-allowed"
                      : "bg-emerald-500 text-black hover:bg-emerald-400 active:bg-emerald-600"
                  }`}
                >
                  START
                </button>

                <button
                  onClick={handleStop}
                  className="px-5 py-2.5 rounded-2xl font-semibold border border-slate-500 text-black bg-slate-100 hover:bg-slate-200 transition"
                >
                  Stop
                </button>

                <button
                  onClick={handleReset}
                  className="px-5 py-2.5 rounded-2xl font-semibold border border-slate-500 text-black bg-slate-100/80 hover:bg-slate-200 transition"
                >
                  Reset
                </button>
              </div>
            </div>
          </div>

          {/* status */}
          <div className="bg-slate-800/60 rounded-2xl shadow-xl p-6 border border-slate-700 lg:col-span-2">
            <h2 className="text-lg font-semibold mb-3">
              Статус
            </h2>

            <div className="flex flex-wrap justify-between items-center mb-4">
              <div className="flex items-center gap-1 text-sm">
                <span className="text-slate-400">
                  Состояние:
                </span>
                <span className="ml-1 font-medium text-emerald-400">
                  {exeLabel}
                </span>
              </div>
              <div className="flex items-center gap-1 text-sm">
                <span className="text-slate-400">BLE:</span>
                <span
                  className={
                    "ml-1 font-medium " +
                    (bleConnected
                      ? "text-emerald-400"
                      : "text-rose-300")
                  }
                >
                  {bleConnected
                    ? `Подключено • ${bleName}`
                    : "Отключено"}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <StatCard
                label="First Shot"
                value={
                  firstShotMs != null
                    ? msFmt(firstShotMs)
                    : "—"
                }
              />
              <StatCard
                label="# Shots"
                value={String(shotCount)}
              />
              <StatCard
                label="Total Time"
                value={
                  totalTimeMs != null
                    ? msFmt(totalTimeMs)
                    : "—"
                }
              />
            </div>
          </div>
        </div>

        {/* BLE panel */}
        <div className="bg-slate-800/60 rounded-2xl shadow-xl p-6 border border-slate-700 mb-4">
          <h2 className="text-lg font-semibold mb-3">
            BLE
          </h2>

          {!bleSupported && (
            <p className="text-red-300 mb-3">
              Web Bluetooth недоступен. Нужен Chrome / Edge
              (HTTPS или localhost).
            </p>
          )}

          <div className="flex flex-wrap gap-2 mb-3">
            <button
              type="button"
              onClick={connectBle}
              disabled={!bleSupported || bleConnected}
              className={`px-4 py-2 rounded-2xl font-semibold shadow ${
                bleConnected
                  ? "bg-slate-700 text-slate-400"
                  : "bg-emerald-500 text-black hover:bg-emerald-400"
              }`}
            >
              {bleConnected
                ? `Подключено • ${bleName}`
                : "Подключить"}
            </button>
            <button
              onClick={disconnectBle}
              disabled={!bleConnected}
              className="px-4 py-2 rounded-2xl font-semibold border border-slate-500 text-black bg-slate-100 hover:bg-slate-200"
            >
              Отключить
            </button>
          </div>

          <div className="text-xs text-slate-400">
            <div className="mb-1">Лог обмена:</div>
            <div className="h-48 overflow-auto bg-slate-900/60 border border-slate-700 rounded-lg p-2 whitespace-pre-wrap">
              {log.map((l, i) => (
                <div key={i}>{l}</div>
              ))}
            </div>
          </div>
        </div>

        {/* shots + chart */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* table */}
          <div className="lg:col-span-2 bg-slate-800/60 rounded-2xl shadow-xl p-4 md:p-6 border border-slate-700">
            <h2 className="text-lg font-semibold mb-3">
              Выстрелы
            </h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-300/80">
                  <tr>
                    <th className="text-left font-medium py-2">
                      #
                    </th>
                    <th className="text-left font-medium py-2">
                      t от beep
                    </th>
                    <th className="text-left font-medium py-2">
                      Split
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shots.map((s) => (
                    <tr
                      key={s.seq}
                      className="border-t border-slate-700/60"
                    >
                      <td className="py-2 tabular-nums">
                        {s.seq}
                      </td>
                      <td className="py-2 tabular-nums">
                        {s.isFs
                          ? "FS"
                          : msFmt(s.tMs)}
                      </td>
                      <td className="py-2 tabular-nums">
                        {s.isFs
                          ? "—"
                          : s.splitMs != null
                          ? msFmt(s.splitMs)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                  {shots.length === 0 && (
                    <tr>
                      <td
                        colSpan="3"
                        className="py-6 text-center text-slate-400"
                      >
                        Нажми START — устройство подаст beep и
                        начнётся опрос.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* chart */}
          <div className="bg-slate-800/60 rounded-2xl shadow-xl p-4 md:p-6 border border-slate-700">
            <h2 className="text-lg font-semibold mb-3">
              График темпа
            </h2>
            <div className="h-64">
              <ResponsiveContainer
                width="100%"
                height="100%"
              >
                <LineChart
                  data={cadenceData}
                  margin={{
                    top: 10,
                    right: 20,
                    left: 0,
                    bottom: 10,
                  }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#334155"
                  />
                  <XAxis
                    dataKey="seq"
                    stroke="#94a3b8"
                    tick={{ fill: "#94a3b8" }}
                  />
                  <YAxis
                    stroke="#94a3b8"
                    tick={{ fill: "#94a3b8" }}
                    tickFormatter={(v) =>
                      `${(v / 1000).toFixed(2)}s`
                    }
                  />
                  <Tooltip
                    formatter={(v) =>
                      msFmt(Number(v))
                    }
                    labelFormatter={(l) => `#${l}`}
                    contentStyle={{
                      background: "#0f172a",
                      border: "1px solid #334155",
                      color: "#e2e8f0",
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="val"
                    name="First Shot / Split"
                    dot
                    stroke="#22c55e"
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="text-xs text-slate-400 mt-2">
              Первый выстрел — First Shot (от beep), остальные —
              Split. FS — выстрел до beep.
            </div>
          </div>
        </div>

        {/* footer version */}
        <div className="mt-6 text-xs text-slate-500">
          Тестовая сборка v 0.9803 от 14.11.2025
        </div>
      </div>
    </div>
  );
}

/* small card */

function StatCard({ label, value }) {
  return (
    <div className="bg-slate-900/60 border border-slate-700 rounded-xl p-3">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-lg font-semibold tabular-nums">
        {value}
      </div>
    </div>
  );
}
