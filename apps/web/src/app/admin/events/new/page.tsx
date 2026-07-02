"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export default function NewEventPage() {
  const t = useTranslations("admin.newEvent");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  function handleNameChange(value: string) {
    setName(value);
    if (!slugEdited) {
      setSlug(slugify(value));
    }
  }

  function handleSlugChange(value: string) {
    setSlug(slugify(value));
    setSlugEdited(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, slug, description, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || t("createFailed"));
      }

      const event = await res.json();
      router.push(`/admin/events/${event.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("createFailed"));
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#fafafa", animation: "pxFade .35s ease both" }}>
      <div style={{ maxWidth: 620, margin: "0 auto", padding: "30px 28px 48px" }}>
        <button
          onClick={() => router.push("/admin")}
          style={{ background: "none", border: "none", color: "#71717a", fontSize: 13.5, display: "inline-flex", alignItems: "center", gap: 6, padding: 0, marginBottom: 20, cursor: "pointer", transition: "color .15s" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#09090b"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "#71717a"; }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m15 18-6-6 6-6"></path>
          </svg>
          {t("backToEvents")}
        </button>
        <h1 style={{ fontSize: 25, fontWeight: 600, letterSpacing: "-.025em", margin: "0 0 5px" }}>{t("title")}</h1>
        <p style={{ fontSize: 14.5, color: "#71717a", margin: "0 0 26px" }}>{t("subtitle")}</p>
        <div style={{ background: "#fff", border: "1px solid #e4e4e7", borderRadius: 14, boxShadow: "0 1px 3px rgba(0,0,0,.05)", padding: "26px 24px" }}>
          <form onSubmit={handleSubmit}>
            <label style={{ display: "block", fontSize: 13.5, fontWeight: 500, marginBottom: 7 }}>{t("nameLabel")}</label>
            <input
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder={t("namePlaceholder")}
              required
              style={{
                height: 40,
                width: "100%",
                padding: "0 12px",
                border: "1px solid #e4e4e7",
                borderRadius: 8,
                fontSize: 14,
                background: "#fff",
                outline: "none",
                marginBottom: 18,
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

            <label style={{ display: "block", fontSize: 13.5, fontWeight: 500, marginBottom: 7 }}>{t("shareLinkLabel")}</label>
            <div
              style={{
                display: "flex",
                alignItems: "stretch",
                border: "1px solid #e4e4e7",
                borderRadius: 8,
                overflow: "hidden",
                marginBottom: 6,
                background: "#fff",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", padding: "0 11px", background: "#f4f4f5", color: "#71717a", fontSize: 13, fontFamily: "'Geist Mono', monospace", borderRight: "1px solid #e4e4e7" }}>
                pixshar.app/gallery/
              </span>
              <input
                value={slug}
                onChange={(e) => handleSlugChange(e.target.value)}
                placeholder={t("slugPlaceholder")}
                required
                pattern="[a-z0-9-]+"
                style={{ flex: 1, height: 40, padding: "0 12px", border: "none", fontSize: 13, background: "#fff", outline: "none", fontFamily: "'Geist Mono', monospace", color: "#09090b" }}
              />
            </div>
            <p style={{ fontSize: 12.5, color: "#a1a1aa", margin: "0 0 18px" }}>{t("slugHint")}</p>

            <label style={{ display: "block", fontSize: 13.5, fontWeight: 500, marginBottom: 7 }}>
              {t("descriptionLabel")} <span style={{ color: "#a1a1aa", fontWeight: 400 }}>{t("optional")}</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              style={{
                width: "100%",
                minHeight: 74,
                padding: "10px 12px",
                border: "1px solid #e4e4e7",
                borderRadius: 8,
                fontSize: 14,
                background: "#fff",
                outline: "none",
                resize: "vertical",
                marginBottom: 18,
                lineHeight: 1.5,
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

            <label style={{ display: "block", fontSize: 13.5, fontWeight: 500, marginBottom: 7 }}>{t("passwordLabel")}</label>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("passwordPlaceholder")}
              required
              style={{
                height: 40,
                width: "100%",
                padding: "0 12px",
                border: "1px solid #e4e4e7",
                borderRadius: 8,
                fontSize: 14,
                background: "#fff",
                outline: "none",
                fontFamily: "'Geist Mono', monospace",
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

            {error && <p style={{ color: "#dc2626", fontSize: 13, marginTop: 12 }}>{error}</p>}
          </form>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 20 }}>
          <button
            onClick={() => router.push("/admin")}
            style={{
              height: 40,
              padding: "0 16px",
              borderRadius: 8,
              border: "1px solid #e4e4e7",
              background: "#fff",
              color: "#18181b",
              fontSize: 14,
              fontWeight: 500,
              transition: "background .15s",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = "#f4f4f5"; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = "#fff"; }}
          >
            {t("cancelButton")}
          </button>
          <button
            onClick={handleSubmit}
            disabled={loading}
            style={{
              height: 40,
              padding: "0 18px",
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
            {loading ? t("creating") : t("createButton")}
          </button>
        </div>
      </div>
    </div>
  );
}
