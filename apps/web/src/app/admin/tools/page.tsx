"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface BackfillStatus {
  total: number;
  missing: number;
}

interface BackfillProgress {
  total: number;
  processed: number;
  done?: boolean;
}

export default function AdminToolsPage() {
  const [status, setStatus] = useState<BackfillStatus | null>(null);
  const [progress, setProgress] = useState<BackfillProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/admin/backfill/status", { credentials: "include" })
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => {});
  }, []);

  async function startBackfill() {
    if (running) return;
    setRunning(true);
    setDone(false);
    setProgress(null);

    const res = await fetch("/api/admin/backfill/start", {
      method: "POST",
      credentials: "include",
    });

    if (!res.ok || !res.body) {
      setRunning(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.replace(/^data: /, "");
        if (!line.trim()) continue;
        try {
          const p: BackfillProgress = JSON.parse(line);
          setProgress(p);
          if (p.done) {
            setDone(true);
            setRunning(false);
            setStatus({ total: p.total, missing: 0 });
          }
        } catch {
          // ignore malformed events
        }
      }
    }
    setRunning(false);
  }

  const pct =
    progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;

  return (
    <div style={{ maxWidth: 680, margin: "0 auto", padding: "40px 24px" }}>
      <div style={{ marginBottom: 32, display: "flex", alignItems: "center", gap: 16 }}>
        <Link
          href="/admin"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            color: "var(--text-muted)",
            textDecoration: "none",
            fontSize: 14,
          }}
        >
          ← Admin
        </Link>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Tools</h1>
      </div>

      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 24,
        }}
      >
        <h2 style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 600 }}>
          Blur-Platzhalterbilder generieren
        </h2>
        <p
          style={{ margin: "0 0 20px", color: "var(--text-muted)", fontSize: 14, lineHeight: 1.6 }}
        >
          Generiert Blur-Platzhalterbilder für alle bereits hochgeladenen Fotos, die noch keinen
          Platzhalter haben. Neue Fotos erhalten den Platzhalter automatisch beim Verarbeiten.
        </p>

        {status && (
          <p style={{ margin: "0 0 20px", fontSize: 14, color: "var(--text-muted)" }}>
            {status.missing === 0
              ? `Alle ${status.total} Fotos haben bereits einen Platzhalter.`
              : `${status.missing} von ${status.total} Fotos fehlt noch ein Platzhalter.`}
          </p>
        )}

        {progress && (
          <div style={{ marginBottom: 20 }}>
            <div
              style={{
                height: 8,
                background: "var(--border)",
                borderRadius: 4,
                overflow: "hidden",
                marginBottom: 8,
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${pct}%`,
                  background: "var(--accent)",
                  borderRadius: 4,
                  transition: "width 0.3s ease",
                }}
              />
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>
              {progress.processed} / {progress.total} Fotos verarbeitet ({pct}%)
            </p>
          </div>
        )}

        {done && (
          <p style={{ margin: "0 0 16px", fontSize: 14, color: "var(--accent)", fontWeight: 500 }}>
            ✓ Fertig — alle Platzhalterbilder wurden generiert.
          </p>
        )}

        <button
          onClick={startBackfill}
          disabled={running || (status?.missing === 0 && !done)}
          style={{
            padding: "8px 18px",
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            borderRadius: "var(--radius)",
            cursor: running || (status?.missing === 0 && !done) ? "not-allowed" : "pointer",
            opacity: running || (status?.missing === 0 && !done) ? 0.6 : 1,
            fontSize: 14,
            fontWeight: 500,
          }}
        >
          {running ? "Wird generiert…" : "Backfill starten"}
        </button>
      </div>
    </div>
  );
}
