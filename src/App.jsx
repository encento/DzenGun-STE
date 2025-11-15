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

/* ===== utils ===== */

const msFmt = (ms) =>
  Number.isFinite(ms) ? (ms / 1000).toFixed(2) + " s" : "—";

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

/* ===== BLE constants ===== */

const FFE0_SERVICE = "0000ffe0-0000-1000-8000-00805f9b34fb";
const FFE1_CHAR = "0000ffe1-0000-1000-8000-00805f9b34fb";

/* ===== BLE hook (HM-10 UART) ===== */

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
  const pendingRef = useRef(null); // ожидаем ответ на команду

  const pushLog = useCallback((s) => {
    setLog((a) => [s, ...a].slice(0, 400));
  }, []);

  const writeLine = useCallback(
    async (text) => {
      const withTerm = text.endsWith("\r") ? text : text + "\r";

      writeQ.current = writeQ.current
        .then(async () => {
          const ch = txrxRef.current;
          if (!ch) {
            pushLog("TX ERROR: TX not ready");
            throw new Error("TX not ready");
          }
          pushLog("TX " + withTerm.replace(/\r/g, ""));
          await ch.writeValue(new TextEncoder().encode(withTerm));
        })
        .catch((e) => {
          pushLog("TX ERROR: " + (e?.message || e));
        });

      return writeQ.current;
    },
    [pushLog]
  );

  const resolvePending = useCallback(
    (payload) => {
      const p = pendingRef.current;
      if (!p) return;
      pendingRef.current = null;
      clearTimeout(p.to);
      try {
        p.resolve(payload);
      } catch (e) {
        pushLog("Pending resolve error: " + (e?.message || e));
      }
    },
    [pushLog]
  );

  const onRxLine = useCallback(
    (raw) => {
      const line = raw.trim();
      if (!line) return;
      pushLog("RX: " + line);

      const pend = pendingRef.current;
      if (!pend) return;

      const { expectKey } = pend;

      // Ошибка
      if (line.startsWith("#ERR=")) {
        const codeHex = line.slice(6);
        resolvePending({
          ok: false,
          raw: line,
          errCode: codeHex,
        });
        return;
      }

      // Совпадение по ключу
      if (!expectKey || line.startsWith(`#${expectKey}`)) {
        resolvePending({ ok: true, raw: line });
      }
    },
    [pushLog, resolvePending]
  );

  const onRxChunk = useCallback(
    (dv) => {
      const chunk = new TextDecoder().decode(dv);
      rxBuf.current += chunk;

      for (;;) {
        const iR = rxBuf.current.indexOf("\r");
        const iN = rxBuf.current.indexOf("\n");
        if (iR < 0 && iN < 0) break;
        const sep =
          iR >= 0 && iN >= 0 ? Math.min(iR, iN) : Math.max(iR, iN);
        const line = rxBuf.current.slice(0, sep);
        rxBuf.current = rxBuf.current.slice(sep + 1);
        if (line.trim()) onRxLine(line);
      }
    },
    [onRxLine]
  );

  const connectClick = useCallback(
    async (ev) => {
      ev?.preventDefault?.();
      ev?.stopPropagation?.();

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
        txrxRef.current = ch;

        if (ch.properties.notify) {
          await ch.startNotifications();
          ch.addEventListener("characteristicvaluechanged", (e) =>
            onRxChunk(e.target.value)
          );
          pushLog("FFE1: notifications started");
        } else {
          pushLog("FFE1: notify not supported");
        }

        setConnected(true);
        pushLog("HM-10 UART ready (FFE1)");
      } catch (e) {
        pushLog("CONNECT ERROR: " + (e?.message || e));
      }
    },
    [onRxChunk, pushLog]
  );

  const disconnect = useCallback(() => {
    try {
      deviceRef.current?.gatt?.disconnect?.();
    } catch {}
    serverRef.current = null;
    txrxRef.current = null;
    setConnected(false);
    pushLog("BLE: disconnected");
  }, [pushLog]);

  // Универсальная команда: отправили → ждём один ответ
  const sendAndWait = useCallback(
    (cmd, expectKey, timeoutMs = 600) => {
      return new Promise((resolve) => {
        if (!txrxRef.current) {
          pushLog("TX ERROR: no TX characteristic");
          resolve({ ok: false, noTx: true });
          return;
        }

        if (pendingRef.current) {
          // теоретически не должно происходить, но на всякий случай
          pushLog("WARN: previous command still pending, overwriting");
          clearTimeout(pendingRef.current.to);
          pendingRef.current = null;
        }

        const token = {
          expectKey,
          resolve,
          to: setTimeout(() => {
            if (pendingRef.current === token) {
              pendingRef.current = null;
              pushLog("Poll error: timeout on " + cmd);
              resolve({ ok: false, timeout: true });
            }
          }, timeoutMs),
        };

        pendingRef.current = token;
        // Протокол: на провод уходит строка "#CMD\r"
        writeLine("#" + cmd).catch(() => {});
      });
    },
    [writeLine, pushLog]
  );

  useEffect(() => {
    return () => {
      try {
        deviceRef.current?.gatt?.disconnect?.();
      } catch {}
      pendingRef.current && clearTimeout(pendingRef.current.to);
    };
  }, []);

  return {
    supported,
    connected,
    deviceName,
    log,
    connectClick,
    disconnect,
    sendAndWait,
    pushLog,
  };
}

/* ===== App ===== */

export default function App() {
  const ble = useBleHm10();

  const [mode, setMode] = useState("fixed"); // fixed | random

  const [running, setRunning] = useState(false);
  const [shots, setShots] = useState([]); // {seq, ms, split}
  const [deviceState, setDeviceState] = useState(0); // 0/1/2 из G_STATE

  const pollRunningRef = useRef(false);
  const nextShotIdRef = useRef(0); // сколько уже запросили STIME

  // ===== метрики =====

  const firstShotMs = useMemo(
    () => (shots[0] ? shots[0].ms : null),
    [shots]
  );
  const totalTimeMs = useMemo(
    () => (shots.length ? shots[shots.length - 1].ms : null),
    [shots]
  );
  const splits = useMemo(
    () => shots.map((s) => s.split ?? 0),
    [shots]
  );

// Для графика: точка #1 = First Shot (абсолютное время от beep),
// остальные точки = Split между выстрелами
const chartData = useMemo(() => {
  if (!shots.length) return [];
  return shots.map((s, idx) => ({
    seq: s.seq,
    value: idx === 0 ? s.ms : s.split, // 1-й выстрел — ms, дальше — split
  }));
}, [shots]);


  // ===== опрос =====

  const pollLoop = useCallback(async () => {
    ble.pushLog("Poll: started");
    while (pollRunningRef.current && ble.connected) {
      try {
        // 1) узнаём состояние
        const st = await ble.sendAndWait("G_STATE", "G_STATE", 600);
        if (!pollRunningRef.current) break;

        if (st.ok && st.raw?.startsWith("#G_STATE=")) {
          const val = parseInt(st.raw.split("=")[1], 10);
          if (Number.isFinite(val)) setDeviceState(val);
        }

        // Пока не STARTED — просто ждём
        if (!st.ok || !st.raw?.startsWith("#G_STATE=2")) {
          await new Promise((r) => setTimeout(r, 150));
          continue;
        }

        // 2) узнаём количество выстрелов
        const sn = await ble.sendAndWait("G_SNUM", "G_SNUM", 600);
        if (!pollRunningRef.current) break;

        if (!sn.ok || !sn.raw?.startsWith("#G_SNUM=")) {
          await new Promise((r) => setTimeout(r, 150));
          continue;
        }

        const devSnum = parseInt(sn.raw.split("=")[1], 10);
        if (!Number.isFinite(devSnum) || devSnum <= 0) {
          await new Promise((r) => setTimeout(r, 150));
          continue;
        }

        // 3) для новых выстрелов запрашиваем STIME по одному
        while (
          pollRunningRef.current &&
          nextShotIdRef.current < devSnum
        ) {
          const devId = nextShotIdRef.current; // 0..N-1
          const uiSeq = devId + 1;

          const stimeRes = await ble.sendAndWait(
            `G_STIME=${devId}`,
            "G_STIME",
            800
          );
          if (!stimeRes.ok || !stimeRes.raw?.startsWith("#G_STIME=")) {
            // ошибка — лог не ломаем, просто выходим из внутреннего цикла
            break;
          }

          const ms = parseInt(stimeRes.raw.split("=")[1], 10);
          if (!Number.isFinite(ms)) {
            break;
          }

          setShots((prev) => {
            // защита от дубля
            if (prev.some((p) => p.seq === uiSeq)) return prev;

            const prevShot = prev[prev.length - 1];
            const split =
              prevShot && Number.isFinite(prevShot.ms)
                ? ms - prevShot.ms
                : null;

            return [
              ...prev,
              {
                seq: uiSeq,
                ms,
                split,
              },
            ];
          });

          nextShotIdRef.current += 1;
        }

        await new Promise((r) => setTimeout(r, 150));
      } catch (e) {
        ble.pushLog("Poll error: " + (e?.message || e));
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    ble.pushLog("Poll: stopped");
  }, [ble]);

  // ===== управление =====

  const startSession = useCallback(async () => {
    if (!ble.connected) {
      ble.pushLog("Start skipped: BLE not connected");
      return;
    }
    if (running) return;

    setRunning(true);
    setShots([]);
    nextShotIdRef.current = 0;
    setDeviceState(0);

    try {
      // Настройка таймера на устройстве
      const tMin = 5000;
      const tMax = mode === "fixed" ? 5000 : 10000;

      await ble.sendAndWait(`S_TMIN=${tMin}`, "S_TMIN", 600);
      await ble.sendAndWait(`S_TMAX=${tMax}`, "S_TMAX", 600);

      const startRes = await ble.sendAndWait(
        "E_STARTT",
        "E_STARTT",
        800
      );
      if (!startRes.ok) {
        ble.pushLog("Start error: no E_STARTT ack");
      } else {
        ble.pushLog("BEEP sent (#E_STARTT)");
      }

      // запускаем опрос
      pollRunningRef.current = true;
      pollLoop();
    } catch (e) {
      ble.pushLog("Start error: " + (e?.message || e));
      setRunning(false);
      pollRunningRef.current = false;
    }
  }, [ble, mode, pollLoop, running]);

  const stopSession = useCallback(() => {
    pollRunningRef.current = false;
    setRunning(false);
    ble.pushLog("Stop");
  }, [ble]);

  // ===== unmount cleanup =====
  useEffect(
    () => () => {
      pollRunningRef.current = false;
    },
    []
  );

  // ===== helpers =====

  const stateLabel = useMemo(() => {
    switch (deviceState) {
      case 0:
        return "Готов";
      case 1:
        return "Отсчёт";
      case 2:
        return "Упражнение";
      default:
        return "—";
    }
  }, [deviceState]);

  return (
    <div className="min-h-screen w-full overflow-x-hidden bg-slate-950 text-slate-100 px-4 py-6">
      <div className="max-w-6xl mx-auto space-y-4">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-2">
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
            DzenGun STE
          </h1>
          <div className="text-sm text-slate-400">
            BLE:{" "}
            <span
              className={
                ble.connected ? "text-emerald-400" : "text-rose-400"
              }
            >
              {ble.connected
                ? `Подключено • ${ble.deviceName || "HM-10"}`
                : "Не подключено"}
            </span>
          </div>
        </header>

        {/* верхняя панель */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Настройки */}
          <div className="bg-slate-900/70 border border-slate-700 rounded-2xl p-4 space-y-4">
            <h2 className="text-lg font-semibold mb-1">Настройки</h2>

            <div>
              <div className="text-sm text-slate-400 mb-2">Режим</div>
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

            <div className="flex flex-wrap gap-3 pt-2">
              <button
                onClick={startSession}
                disabled={!ble.connected || running}
                className={`px-5 py-2.5 rounded-2xl font-semibold shadow-lg transition ${
                  !ble.connected || running
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

          {/* Статус */}
          <div className="bg-slate-900/70 border border-slate-700 rounded-2xl p-4 space-y-3">
            <h2 className="text-lg font-semibold mb-1">Статус</h2>
            <div className="flex justify-between text-sm">
              <span className="text-slate-400">Состояние:</span>
              <span className="font-medium">
                {stateLabel}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-3 mt-2">
              <StatCard
                label="First Shot"
                value={
                  firstShotMs != null ? msFmt(firstShotMs) : "—"
                }
              />
              <StatCard
                label="# Shots"
                value={String(shots.length)}
              />
              <StatCard
                label="Total Time"
                value={
                  totalTimeMs != null ? msFmt(totalTimeMs) : "—"
                }
              />
            </div>
          </div>

          {/* BLE */}
          <div className="bg-slate-900/70 border border-slate-700 rounded-2xl p-4 space-y-3">
            <h2 className="text-lg font-semibold mb-1">BLE</h2>

            {!ble.supported && (
              <p className="text-xs text-rose-300 mb-2">
                Web Bluetooth недоступен. Нужен Chrome/Edge (HTTPS или
                localhost).
              </p>
            )}

            <div className="flex flex-wrap gap-2 mb-2">
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
              <div className="h-40 overflow-auto bg-slate-950/80 border border-slate-700 rounded-lg p-2 whitespace-pre-wrap">
                {ble.log.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Выстрелы + график */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2 bg-slate-900/70 border border-slate-700 rounded-2xl p-4">
            <h2 className="text-lg font-semibold mb-3">Выстрелы</h2>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-slate-300/80">
                  <tr>
                    <th className="text-left font-medium py-2">#</th>
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
                      className="border-t border-slate-800"
                    >
                      <td className="py-1.5 tabular-nums">
                        {s.seq}
                      </td>
                      <td className="py-1.5 tabular-nums">
                        {msFmt(s.ms)}
                      </td>
                      <td className="py-1.5 tabular-nums">
                        {s.split != null ? msFmt(s.split) : "—"}
                      </td>
                    </tr>
                  ))}
                  {shots.length === 0 && (
                    <tr>
                      <td
                        colSpan={3}
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

          <div className="bg-slate-900/70 border border-slate-700 rounded-2xl p-4">
            <h2 className="text-lg font-semibold mb-3">
              График темпа
            </h2>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={chartData}
                  margin={{ top: 10, right: 20, left: 0, bottom: 10 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="#1f2933"
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
  formatter={(v) => msFmt(Number(v))}
  labelFormatter={(l) => `#${l}`}
  contentStyle={{
    background: "#020617",
    border: "1px solid #1e293b",
    color: "#e2e8f0",
  }}
/>

                 <Line
  type="monotone"
  dataKey="value"
  name="Tempo"
  dot
  stroke="#22c55e"
/>

                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-2 text-xs text-slate-400">
              Первый выстрел — без Split, далее сплиты между
              соседними выстрелами.
            </div>
          </div>
        </div>

        <div className="mt-4 text-xs text-slate-500">
                   Build v0.9809 - APK ready
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3">
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-lg font-semibold tabular-nums">
        {value}
      </div>
    </div>
  );
}
