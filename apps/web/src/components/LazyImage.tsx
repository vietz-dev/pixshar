"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Image } from "@chakra-ui/react";

interface LazyImageProps {
  src: string;
  placeholderDataUrl: string | null;
  alt: string;
  objectFit?: "cover" | "contain";
}

export default function LazyImage({
  src,
  placeholderDataUrl,
  alt,
  objectFit = "cover",
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
    <Box ref={containerRef} position="relative" w="100%" h="100%" overflow="hidden" bg="gray.200">
      {placeholderDataUrl && (
        <Image
          src={placeholderDataUrl}
          aria-hidden="true"
          position="absolute"
          inset="0"
          w="100%"
          h="100%"
          objectFit={objectFit}
          filter="blur(20px)"
          transform="scale(1.1)"
          opacity={loaded ? 0 : 1}
          transition="opacity 0.3s ease"
          pointerEvents="none"
        />
      )}
      {shouldLoad && (
        <Image
          src={src}
          alt={alt}
          onLoad={() => setLoaded(true)}
          position="absolute"
          inset="0"
          w="100%"
          h="100%"
          objectFit={objectFit}
          opacity={loaded ? 1 : 0}
          transition="opacity 0.3s ease"
        />
      )}
    </Box>
  );
}
