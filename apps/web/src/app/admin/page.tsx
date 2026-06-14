"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface EventItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  _count: { photos: number };
}

const GRADS = [
  "radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 46%),linear-gradient(150deg,#f6dcab 0%,#c8843f 100%)",
  "radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,.35) 0%,rgba(255,255,255,0) 46%),linear-gradient(150deg,#3a4a6b 0%,#7c91b8 100%)",
  "radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 46%),linear-gradient(150deg,#f3dada 0%,#d18f8f 100%)",
  "radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 46%),linear-gradient(150deg,#cfe0cd 0%,#6e8f68 100%)",
  "radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 46%),linear-gradient(150deg,#d9dbde 0%,#878d95 100%)",
  "radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 46%),linear-gradient(150deg,#f8d6c2 0%,#df8763 100%)",
  "radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 46%),linear-gradient(150deg,#e0d9ee 0%,#9989c2 100%)",
  "radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 46%),linear-gradient(150deg,#ece1cd 0%,#c0a673 100%)",
  "radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 46%),linear-gradient(150deg,#cfe5e2 0%,#6ba39b 100%)",
  "radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 46%),linear-gradient(150deg,#e4cdd9 0%,#a76f8b 100%)",
  "radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,.45) 0%,rgba(255,255,255,0) 46%),linear-gradient(150deg,#cccdcf 0%,#5a5d65 100%)",
  "radial-gradient(120% 90% at 28% 16%,rgba(255,255,255,.5) 0%,rgba(255,255,255,0) 46%),linear-gradient(150deg,#f4e9d4 0%,#d7be8c 100%)",
];

function statusMeta(st: string) {
  return st === "READY"
    ? { statusLabel: "Ready", statusBg: "rgba(220,252,231,.92)", statusColor: "#16a34a" }
    : { statusLabel: "Processing", statusBg: "rgba(254,243,199,.92)", statusColor: "#d97706" };
}

function formatDate(d: string) {
  const date = new Date(d);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function AdminPage() {
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/events", { credentials: "include" })
      .then((res) => {
        if (res.status === 401) {
          router.push("/auth/login");
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (data) setEvents(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [router]);

  const eventCountLabel = `${events.length} ${events.length === 1 ? "event" : "events"} · ${events.filter((e) => e.status === "PROCESSING").length} processing`;

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", color: "#a1a1aa" }}>
        Loading...
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#fff", animation: "pxFade .35s ease both" }}>
      {/* Sticky header */}
      <div style={{ position: "sticky", top: 0, zIndex: 10, background: "rgba(255,255,255,.86)", backdropFilter: "blur(10px)", borderBottom: "1px solid #ececee", padding: "14px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 26, height: 26, borderRadius: 8, background: "#2563eb", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="3"></rect>
              <circle cx="8.5" cy="8.5" r="1.8"></circle>
              <path d="m21 15-4.5-4.5L7 20"></path>
            </svg>
          </div>
          <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-.01em" }}>Pixshar</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 13, color: "#71717a" }}>Admin Studio</span>
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#18181b", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600 }}>
            A
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1040, margin: "0 auto", padding: "34px 28px 48px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap", marginBottom: 26 }}>
          <div>
            <h1 style={{ fontSize: 27, fontWeight: 600, letterSpacing: "-.025em", margin: 0 }}>Events</h1>
            <p style={{ fontSize: 14.5, color: "#71717a", margin: "6px 0 0" }}>{eventCountLabel}</p>
          </div>
          <Link href="/admin/events/new">
            <button
              style={{
                height: 40,
                padding: "0 16px",
                borderRadius: 8,
                border: "none",
                background: "#2563eb",
                color: "#fff",
                fontSize: 14,
                fontWeight: 500,
                display: "inline-flex",
                alignItems: "center",
                gap: 7,
                boxShadow: "0 1px 2px rgba(0,0,0,.08)",
                transition: "background .15s",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#1d4ed8"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "#2563eb"; }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14"></path>
              </svg>
              New event
            </button>
          </Link>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 20 }}>
          {events.map((ev, i) => {
            const meta = statusMeta(ev.status);
            return (
              <div
                key={ev.id}
                style={{
                  background: "#fff",
                  border: "1px solid #e4e4e7",
                  borderRadius: 14,
                  overflow: "hidden",
                  cursor: "pointer",
                  transition: "box-shadow .2s, transform .2s, border-color .2s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.boxShadow = "0 14px 34px -16px rgba(0,0,0,.22)";
                  e.currentTarget.style.transform = "translateY(-3px)";
                  e.currentTarget.style.borderColor = "#d4d4d8";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.boxShadow = "";
                  e.currentTarget.style.transform = "";
                  e.currentTarget.style.borderColor = "#e4e4e7";
                }}
                onClick={() => router.push(`/admin/events/${ev.id}`)}
              >
                <div style={{ aspectRatio: "16/10", background: GRADS[i % GRADS.length], position: "relative" }}>
                  <div style={{
                    position: "absolute", top: 11, right: 11, height: 24, padding: "0 10px", borderRadius: 999,
                    display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 500,
                    background: meta.statusBg, color: meta.statusColor, backdropFilter: "blur(6px)",
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: meta.statusColor }}></span>
                    {meta.statusLabel}
                  </div>
                </div>
                <div style={{ padding: "15px 16px 16px" }}>
                  <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-.01em", marginBottom: 3 }}>{ev.name}</div>
                  <div style={{ fontSize: 13, color: "#71717a" }}>
                    Event · {formatDate(ev.createdAt)}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, paddingTop: 13, borderTop: "1px solid #f4f4f5" }}>
                    <span style={{ fontSize: 13, color: "#52525b", display: "inline-flex", alignItems: "center", gap: 6 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="3" y="3" width="18" height="18" rx="3"></rect>
                        <circle cx="8.5" cy="8.5" r="1.8"></circle>
                        <path d="m21 15-4.5-4.5L7 20"></path>
                      </svg>
                      {ev._count.photos} photos
                    </span>
                    <span
                      onClick={(e) => { e.stopPropagation(); router.push(`/gallery/${ev.slug}`); }}
                      style={{ fontSize: 13, fontWeight: 500, color: "#2563eb", display: "inline-flex", alignItems: "center", gap: 4, cursor: "pointer" }}
                      onMouseEnter={(e) => { e.currentTarget.style.textDecoration = "underline"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.textDecoration = "none"; }}
                    >
                      View gallery
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                        <path d="M7 17 17 7M9 7h8v8"></path>
                      </svg>
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {events.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "#a1a1aa", fontSize: 14 }}>
            No events yet — create your first one above.
          </div>
        )}
      </div>
    </div>
  );
}
