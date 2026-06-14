"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const [email, setEmail] = useState("admin@example.com");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || "Login failed");
      }

      router.push("/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: "40px 24px", background: "radial-gradient(120% 80% at 50% 0%, #fafafa 0%, #f4f4f5 100%)" }}>
      <div style={{ width: "100%", maxWidth: 380, animation: "pxRise .5s ease both" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, marginBottom: 30 }}>
          <div style={{ width: 46, height: 46, borderRadius: 13, background: "#2563eb", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 6px 20px -6px rgba(37,99,235,.6)" }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="3"></rect>
              <circle cx="8.5" cy="8.5" r="1.8"></circle>
              <path d="m21 15-4.5-4.5L7 20"></path>
            </svg>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: "-.02em" }}>Pixshar</div>
            <div style={{ fontSize: 14, color: "#71717a", marginTop: 3 }}>Sign in to your studio</div>
          </div>
        </div>
        <div style={{ background: "#fff", border: "1px solid #e4e4e7", borderRadius: 14, boxShadow: "0 1px 3px rgba(0,0,0,.05)", padding: "26px 24px" }}>
          <form onSubmit={handleSubmit}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 7 }}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{
                height: 40,
                width: "100%",
                padding: "0 12px",
                border: "1px solid #e4e4e7",
                borderRadius: 8,
                fontSize: 14,
                background: "#fff",
                outline: "none",
                color: "#09090b",
                marginBottom: 16,
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
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 7 }}>
              <label style={{ fontSize: 13, fontWeight: 500 }}>Password</label>
              <span style={{ fontSize: 12.5, color: "#2563eb", cursor: "pointer" }}>Forgot?</span>
            </div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              style={{
                height: 40,
                width: "100%",
                padding: "0 12px",
                border: "1px solid #e4e4e7",
                borderRadius: 8,
                fontSize: 14,
                background: "#fff",
                outline: "none",
                color: "#09090b",
                marginBottom: 20,
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
              <div style={{ fontSize: 12.5, color: "#dc2626", marginBottom: 12, textAlign: "center" }}>{error}</div>
            )}
            <button
              type="submit"
              disabled={loading}
              style={{
                height: 40,
                width: "100%",
                borderRadius: 8,
                border: "none",
                background: loading ? "#a8c1f0" : "#2563eb",
                color: "#fff",
                fontSize: 14,
                fontWeight: 500,
                boxShadow: "0 1px 2px rgba(0,0,0,.08)",
                transition: "background .15s",
                cursor: loading ? "not-allowed" : "pointer",
              }}
            >
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>
        <div style={{ textAlign: "center", fontSize: 12.5, color: "#a1a1aa", marginTop: 18, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="11" width="16" height="10" rx="2"></rect>
            <path d="M8 11V7a4 4 0 0 1 8 0v4"></path>
          </svg>
          Admin access only · self-hosted
        </div>
      </div>
    </div>
  );
}
