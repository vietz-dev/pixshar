"use client";

import { useEffect, useRef, useState } from "react";

interface LazyImageProps {
  src: string;
  placeholderDataUrl: string | null;
  alt: string;
  objectFit?: "cover" | "contain";
  style?: React.CSSProperties;
}

export default function LazyImage({
  src,
  placeholderDataUrl,
  alt,
  objectFit = "cover",
  style,
}: LazyImageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "#e4e4e7",
        ...style,
      }}
    >
      {placeholderDataUrl && (
        <img
          src={placeholderDataUrl}
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit,
            filter: "blur(20px)",
            transform: "scale(1.1)",
            opacity: loaded ? 0 : 1,
            transition: "opacity 0.3s ease",
            pointerEvents: "none",
          }}
        />
      )}
      {shouldLoad && (
        <img
          src={src}
          alt={alt}
          onLoad={() => setLoaded(true)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit,
            opacity: loaded ? 1 : 0,
            transition: "opacity 0.3s ease",
          }}
        />
      )}
    </div>
  );
}
