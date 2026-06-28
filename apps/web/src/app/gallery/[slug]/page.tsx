"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";

interface GalleryEvent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
}

export default function GalleryGatePage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [event, setEvent] = useState<GalleryEvent | null>(null);
  const [loadingEvent, setLoadingEvent] = useState(true);
  const router = useRouter();
  const params = useParams();
  const slug = params.slug as string;

  useEffect(() => {
    // Check if already unlocked — if so, skip straight to the view.
    fetch(`/api/gallery/${slug}`, { credentials: "include" })
      .then((res) => {
        if (res.ok) {
          router.push(`/gallery/${slug}/view`);
          return;
        }
        // Fetch public event info separately so the gate page can show the event name.
        fetch(`/api/gallery/${slug}/info`)
          .then((r) => r.json())
          .then((data) => {
            if (data && data.id) setEvent(data);
          })
          .catch(() => {})
          .finally(() => setLoadingEvent(false));
      })
      .catch(() => setLoadingEvent(false));
  }, [slug, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch(`/api/gallery/${slug}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Invalid password");
      }

      router.push(`/gallery/${slug}/view`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlock");
    } finally {
      setLoading(false);
    }
  }

  const coverGradient = "linear-gradient(150deg,#3a4a6b 0%,#7c91b8 100%)";

  if (loadingEvent) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#a1a1aa" }}>
        Loading...
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "40px 24px",
        background: coverGradient,
      }}
    >
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg,rgba(15,15,18,.32) 0%,rgba(15,15,18,.55) 100%)" }} />
      <div style={{ position: "relative", width: "100%", maxWidth: 400, textAlign: "center", animation: "pxRise .55s ease both" }}>
        <div style={{ fontSize: 12, letterSpacing: ".22em", textTransform: "uppercase", color: "rgba(255,255,255,.82)", fontWeight: 500, marginBottom: 14 }}>
          Private Gallery
        </div>
        <h1 style={{ fontFamily: "'Newsreader', serif", fontWeight: 300, fontSize: 46, lineHeight: 1.08, color: "#fff", margin: "0 0 12px", letterSpacing: "-.01em", textShadow: "0 2px 20px rgba(0,0,0,.25)" }}>
          {event?.name || "Gallery"}
        </h1>
        <div style={{ fontSize: 14, color: "rgba(255,255,255,.85)", marginBottom: 30 }}>
          {event?.description || "A private photo collection"}
        </div>
        <div style={{ background: "rgba(255,255,255,.97)", backdropFilter: "blur(8px)", borderRadius: 16, boxShadow: "0 20px 50px -18px rgba(0,0,0,.5)", padding: "24px 22px", textAlign: "left" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "center", fontSize: 13.5, fontWeight: 500, color: "#52525b", marginBottom: 16 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="4" y="11" width="16" height="10" rx="2"></rect>
              <path d="M8 11V7a4 4 0 0 1 8 0v4"></path>
            </svg>
            This gallery is private
          </div>
          <form onSubmit={handleSubmit}>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              style={{
                height: 42,
                width: "100%",
                boxSizing: "border-box",
                padding: "0 14px",
                border: "1px solid #e4e4e7",
                borderRadius: 9,
                fontSize: 14.5,
                background: "#fff",
                outline: "none",
                textAlign: "center",
                letterSpacing: ".04em",
                marginBottom: 6,
                transition: "border-color .15s, box-shadow .15s",
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = "#2563eb";
                e.currentTarget.style.boxShadow = "0 0 0 3px rgba(37,99,235,.16)";
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = "#e4e4e7";
                e.currentTarget.style.boxShadow = "none";
              }}
            />
            {error && (
              <div style={{ fontSize: 12.5, color: "#dc2626", textAlign: "center", marginBottom: 8 }}>
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              style={{
                height: 42,
                width: "100%",
                borderRadius: 9,
                border: "none",
                background: loading ? "#a8c1f0" : "#2563eb",
                color: "#fff",
                fontSize: 14.5,
                fontWeight: 500,
                marginTop: 8,
                boxShadow: "0 1px 2px rgba(0,0,0,.08)",
                transition: "background .15s",
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              {loading ? "Unlocking..." : "Unlock gallery"}
            </button>
          </form>
        </div>
        <div style={{ marginTop: 22, fontSize: 12, color: "rgba(255,255,255,.7)", display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <div style={{ width: 13, height: 13, borderRadius: 4, background: "rgba(255,255,255,.85)" }} />
          Powered by Pixshar
        </div>
      </div>
    </div>
  );
}
