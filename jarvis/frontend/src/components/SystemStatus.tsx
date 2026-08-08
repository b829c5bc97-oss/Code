import { useEffect, useState } from "react";
import { getSystemInfo } from "../services/api";
import type { SystemInfo } from "../types";

const POLL_MS = 5000;

function Meter({ label, percent }: { label: string; percent: number }) {
  return (
    <div className="meter">
      <div className="meter__labels">
        <span>{label}</span>
        <span>{Math.round(percent)}%</span>
      </div>
      <div className="meter__track">
        <div className="meter__fill" style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
    </div>
  );
}

export function SystemStatus({ enabled }: { enabled: boolean }) {
  const [info, setInfo] = useState<SystemInfo | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    async function poll() {
      try {
        const data = await getSystemInfo();
        if (!cancelled) setInfo(data);
      } catch {
        if (!cancelled) setInfo(null);
      }
    }

    poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [enabled]);

  if (!enabled || !info) return null;

  return (
    <section className="panel system-status">
      <h2 className="panel__title">System</h2>
      <div className="system-status__body">
        <Meter label="CPU" percent={info.cpu_percent} />
        <Meter label="Memory" percent={info.memory_percent} />
        <Meter label="Disk" percent={info.disk_percent} />
        {info.battery && <Meter label="Battery" percent={info.battery.percent} />}
        <p className="system-status__network">
          Network: <span className={info.network_up ? "ok-text" : "warn-text"}>{info.network_up ? "up" : "down"}</span>
        </p>
      </div>
    </section>
  );
}
