"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Box, Button, Flex, Heading, HStack, Text } from "@chakra-ui/react";
import { FilterChip, FilterChipCount } from "../../../../components/ui/filter-chip";
import PhotoGrid from "../../../../components/PhotoGrid";
import Lightbox from "../../../../components/Lightbox";
import UploadModal from "../../../../components/UploadModal";
import DownloadButton from "../../../../components/DownloadButton";
import type { GalleryData, GalleryPhoto, PhotoNewEvent } from "@pixshar/contracts";
import { api } from "@/lib/rpc";

export default function GalleryViewPage() {
  const t = useTranslations("gallery.view");
  const tCommon = useTranslations("common");
  const params = useParams();
  const slug = params.slug as string;
  const [gallery, setGallery] = useState<GalleryData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [layout, setLayout] = useState<"masonry" | "uniform">("masonry");
  const [isMobile, setIsMobile] = useState(false);
  const [lbIndex, setLbIndex] = useState(0);
  const [lbOpen, setLbOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [activePhotographer, setActivePhotographer] = useState<string | null>(null);

  const CACHE_TTL = 30 * 60 * 1000;
  const cacheKey = `gallery_cache_${slug}`;

  const fetchGallery = useCallback(() => {
    try {
      const raw = sessionStorage.getItem(cacheKey);
      if (raw) {
        const { data, ts } = JSON.parse(raw) as { data: GalleryData; ts: number };
        if (Date.now() - ts < CACHE_TTL) {
          setGallery(data);
          setLoading(false);
          return;
        }
      }
    } catch {
      // ignore sessionStorage errors
    }

    api.gallery
      .get({ slug })
      .then((data) => {
        setGallery(data);
        setLoading(false);
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ data, ts: Date.now() }));
        } catch {
          // ignore sessionStorage quota errors
        }
      })
      .catch(() => {
        setError(t("loadFailed"));
        setLoading(false);
      });
  }, [slug, t, cacheKey]);

  useEffect(() => {
    fetchGallery();
  }, [fetchGallery]);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  // Live feed: new photos (from any guest's upload) appear without a refresh.
  const galleryLoaded = !!gallery;
  useEffect(() => {
    if (!galleryLoaded) return;
    const es = new EventSource(`/api/gallery/${slug}/photos/stream`, { withCredentials: true });
    es.addEventListener("photo-new", (e) => {
      const p = JSON.parse(e.data) as PhotoNewEvent;
      setGallery((prev) => {
        if (!prev || prev.photos.some((x) => x.id === p.id)) return prev;
        const photo: GalleryPhoto = {
          id: p.id,
          photographerName: p.photographerName,
          thumbUrl: p.thumbUrl,
          displayUrl: p.displayUrl,
          status: "PROCESSED",
          placeholderDataUrl: p.placeholderDataUrl ?? null,
        };
        const updated = { ...prev, photos: [photo, ...prev.photos] };
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify({ data: updated, ts: Date.now() }));
        } catch {
          // ignore
        }
        return updated;
      });
    });
    es.onerror = () => {};
    return () => es.close();
  }, [slug, galleryLoaded]);

  const processedPhotos = useMemo(
    () => (gallery?.photos ?? []).filter((p) => p.status === "PROCESSED"),
    [gallery],
  );

  const photographers = useMemo(() => {
    const names = new Set<string>();
    for (const p of processedPhotos) {
      if (p.photographerName) names.add(p.photographerName);
    }
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  }, [processedPhotos]);

  const photographerCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of processedPhotos) {
      if (p.photographerName) m.set(p.photographerName, (m.get(p.photographerName) ?? 0) + 1);
    }
    return m;
  }, [processedPhotos]);

  const filteredPhotos = useMemo(
    () =>
      activePhotographer
        ? processedPhotos.filter((p) => p.photographerName === activePhotographer)
        : processedPhotos,
    [processedPhotos, activePhotographer],
  );

  if (loading) {
    return (
      <Flex minH="100vh" align="center" justify="center" color="fgSubtle">
        {tCommon("loading")}
      </Flex>
    );
  }
  if (error) {
    return (
      <Flex minH="100vh" align="center" justify="center" color="danger">
        {error}
      </Flex>
    );
  }
  if (!gallery) return null;

  const photoCountLabel = activePhotographer
    ? t("photoCountFiltered", { filtered: filteredPhotos.length, total: processedPhotos.length })
    : t("photoCount", { count: processedPhotos.length });

  const layoutItems = [
    { key: "masonry" as const, label: t("masonry") },
    { key: "uniform" as const, label: t("grid") },
  ];

  return (
    <Box minH="100vh" bg="surface" animation="pxFade .35s ease both">
      {/* Hero */}
      <Flex position="relative" h="300px" bgImage="cover" align="flex-end">
        <Box
          position="absolute"
          inset="0"
          bgImage="linear-gradient(180deg,rgba(15,15,18,.05) 0%,rgba(15,15,18,.5) 100%)"
        />
        <Flex
          position="relative"
          w="100%"
          maxW="1100px"
          mx="auto"
          px="28px"
          pb="26px"
          justify="space-between"
          align="flex-end"
          gap="16px"
          wrap="wrap"
        >
          <Box>
            <Text
              fontSize="11.5px"
              letterSpacing=".2em"
              textTransform="uppercase"
              color="rgba(255,255,255,.85)"
              fontWeight="500"
              mb="9px"
            >
              {t("eventLabel")}
            </Text>
            <Heading
              as="h1"
              fontFamily="serif"
              fontWeight="300"
              fontSize="40px"
              lineHeight="1.06"
              color="white"
              m="0"
              letterSpacing="-.01em"
              textShadow="0 2px 18px rgba(0,0,0,.3)"
            >
              {gallery.name}
            </Heading>
            <Text fontSize="13.5px" color="rgba(255,255,255,.85)" mt="13px">
              {gallery.description || t("descriptionFallback")} · {photoCountLabel}
            </Text>
          </Box>
          <Button
            onClick={() => setUploadModalOpen(true)}
            variant="plain"
            h="40px"
            px="16px"
            gap="7px"
            borderRadius="9px"
            bg="surface"
            color="fg"
            fontSize="13.5px"
            fontWeight="500"
            boxShadow="0 4px 14px -4px rgba(0,0,0,.3)"
            transition="transform .15s"
            _hover={{ transform: "translateY(-1px)", bg: "surface" }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 17V3m0 0L7 8m5-5 5 5"></path>
              <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"></path>
            </svg>
            {t("uploadButton")}
          </Button>
        </Flex>
      </Flex>

      {/* Sticky toolbar */}
      <Box
        position="sticky"
        top="0"
        zIndex={9}
        bg="rgba(255,255,255,.9)"
        backdropFilter="blur(10px)"
        borderBottomWidth="1px"
        borderBottomColor="border"
        px="28px"
        py="11px"
      >
        {/* Row 1: count + controls */}
        <Flex align="center" justify="space-between" gap="14px" wrap="wrap">
          <Text fontSize="13.5px" color="gray.600" fontWeight="500">
            {photoCountLabel}
          </Text>
          <HStack gap="10px">
            <DownloadButton slug={slug} />
            {!isMobile && (
              <HStack gap="7px">
                <Text fontSize="12.5px" color="fgSubtle">
                  {t("layout")}
                </Text>
                <HStack
                  gap="3px"
                  bg="bg"
                  borderWidth="1px"
                  borderColor="border"
                  borderRadius="9px"
                  p="3px"
                >
                  {layoutItems.map((l) => {
                    const active = layout === l.key;
                    return (
                      <Button
                        key={l.key}
                        onClick={() => setLayout(l.key)}
                        variant="plain"
                        h="28px"
                        px="11px"
                        gap="6px"
                        borderRadius="7px"
                        fontSize="12.5px"
                        fontWeight="500"
                        bg={active ? "surface" : "transparent"}
                        color={active ? "fg" : "fgMuted"}
                        boxShadow={active ? "0 1px 2px rgba(0,0,0,.1)" : "none"}
                        transition="all .15s"
                        _hover={{ color: "fg" }}
                      >
                        {l.label}
                      </Button>
                    );
                  })}
                </HStack>
              </HStack>
            )}
          </HStack>
        </Flex>

        {/* Row 2: photographer filter chips */}
        {photographers.length > 0 && (
          <Flex
            gap="6px"
            wrap="wrap"
            pt="9px"
            mt="9px"
            borderTopWidth="1px"
            borderTopColor="gray.100"
          >
            <FilterChip
              active={activePhotographer === null}
              onClick={() => setActivePhotographer(null)}
            >
              {t("filterAll")}
              <FilterChipCount>{processedPhotos.length}</FilterChipCount>
            </FilterChip>
            {photographers.map((name) => {
              const active = activePhotographer === name;
              return (
                <FilterChip
                  key={name}
                  active={active}
                  onClick={() => setActivePhotographer(active ? null : name)}
                >
                  {name}
                  <FilterChipCount>{photographerCounts.get(name)}</FilterChipCount>
                </FilterChip>
              );
            })}
          </Flex>
        )}
      </Box>

      {/* Photos */}
      <Box maxW="1100px" mx="auto" px="24px" pt="20px" pb="44px">
        <PhotoGrid
          photos={filteredPhotos.map((p) => ({
            id: p.id,
            thumbUrl: p.thumbUrl,
            displayUrl: p.displayUrl,
            photographerName: p.photographerName,
            status: p.status,
            placeholderDataUrl: p.placeholderDataUrl,
          }))}
          layout={isMobile ? "uniform" : layout}
          onPhotoClick={(_, i) => {
            setLbIndex(i);
            setLbOpen(true);
          }}
        />
      </Box>

      {/* Lightbox */}
      {lbOpen && (
        <Lightbox
          photos={filteredPhotos.map((p) => ({
            id: p.id,
            url: p.displayUrl,
            photographerName: p.photographerName,
            placeholderDataUrl: p.placeholderDataUrl ?? null,
          }))}
          index={lbIndex}
          onClose={() => setLbOpen(false)}
          onNext={() => setLbIndex((i) => (i + 1) % filteredPhotos.length)}
          onPrev={() => setLbIndex((i) => (i - 1 + filteredPhotos.length) % filteredPhotos.length)}
          onDownload={async (photoId) => {
            const { url } = await api.gallery.photoDownload({ slug, photoId });
            return url;
          }}
        />
      )}

      {/* Upload modal */}
      {uploadModalOpen && (
        <UploadModal
          galleryName={gallery.name}
          slug={slug}
          onClose={() => {
            setUploadModalOpen(false);
            fetchGallery();
          }}
        />
      )}
    </Box>
  );
}
