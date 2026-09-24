"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Box, Button, chakra, Flex, Heading, Spinner, Stack, Tabs, Text } from "@chakra-ui/react";
import { ORPCError } from "@orpc/client";
import type { BothVariantsPayload, Quality } from "@pixshar/contracts";
import { api } from "@/lib/rpc";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Keyed on quality + the part's membership signature so:
//  - DISPLAY part-1 and ORIGINAL part-1 never collide, and
//  - a part rebuilt with a different photo set (e.g. after a deletion) correctly
//    resets to "not downloaded", while a pure byte-rebuild keeps the green tick.
function localStorageKey(slug: string, quality: Quality, partIndex: number, sig: string): string {
  return `pixshar_dl_${slug}_${quality}_part_${partIndex}_${sig}`;
}

// Intentionally left un-migrated: `download-page.spec.ts` selects this exact
// span/svg shape (`svg polyline[points='20 6 9 17 4 12']` inside a <span>).
function CheckIcon({ done }: { done: boolean }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 22,
        height: 22,
        borderRadius: "50%",
        border: done ? "none" : "2px solid #d4d4d8",
        background: done ? "#22c55e" : "transparent",
        flexShrink: 0,
        transition: "all .2s",
      }}
    >
      {done && (
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#fff"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

export default function GalleryDownloadPage() {
  const t = useTranslations("gallery.downloadPage");
  const params = useParams();
  const router = useRouter();
  const slug = params.slug as string;

  const [payload, setPayload] = useState<BothVariantsPayload | null>(null);
  const [error, setError] = useState("");
  // Which variant tab is active. Always lands on DISPLAY (Kompakt); only an
  // explicit user click ever changes this — SSE re-applies never touch it.
  const [quality, setQuality] = useState<Quality>("DISPLAY");
  // Per-variant per-part downloaded ticks: downloaded[quality][partIndex].
  const [downloaded, setDownloaded] = useState<Record<Quality, Record<number, boolean>>>({
    DISPLAY: {},
    ORIGINAL: {},
  });
  const initialLoaded = useRef(false);

  // Load per-part download state from localStorage for both variants.
  const loadDownloadedState = useCallback(
    (data: BothVariantsPayload) => {
      const next: Record<Quality, Record<number, boolean>> = { DISPLAY: {}, ORIGINAL: {} };
      for (const q of ["DISPLAY", "ORIGINAL"] as Quality[]) {
        for (const p of data.variants[q]?.parts ?? []) {
          try {
            next[q][p.index] =
              localStorage.getItem(localStorageKey(slug, q, p.index, p.membershipSig ?? "")) ===
              "1";
          } catch {
            next[q][p.index] = false;
          }
        }
      }
      setDownloaded(next);
    },
    [slug],
  );

  const apply = useCallback(
    (data: BothVariantsPayload) => {
      setPayload(data);
      loadDownloadedState(data);
    },
    [loadDownloadedState],
  );

  // Initial fetch (handles auth redirect + first paint).
  useEffect(() => {
    api.gallery
      .download({ slug })
      .then((data) => {
        initialLoaded.current = true;
        apply(data);
      })
      .catch((err: unknown) => {
        const code = err instanceof ORPCError ? err.code : null;
        if (code === "UNAUTHORIZED" || code === "NOT_FOUND") {
          router.replace(`/gallery/${slug}`);
          return;
        }
        setError(t("loadFailed"));
      });
  }, [slug, router, t, apply]);

  // Live updates: new parts appear + rebuilt parts flip status without a reload.
  // The stream emits the full both-variants payload; we re-apply it and the
  // selected tab is preserved because `quality` is independent state.
  useEffect(() => {
    const es = new EventSource(`/api/gallery/${slug}/download/stream`, { withCredentials: true });
    es.addEventListener("download-status", (e) => {
      try {
        apply(JSON.parse((e as MessageEvent).data));
      } catch {
        // ignore malformed frame
      }
    });
    es.onerror = () => {};
    return () => es.close();
  }, [slug, apply]);

  const markDownloaded = (q: Quality, partIndex: number, sig: string) => {
    try {
      localStorage.setItem(localStorageKey(slug, q, partIndex, sig), "1");
    } catch {
      // localStorage blocked (private mode etc.) — ignore, tick just won't persist
    }
    setDownloaded((prev) => ({ ...prev, [q]: { ...prev[q], [partIndex]: true } }));
  };

  const backButton = (
    <Button
      onClick={() => router.push(`/gallery/${slug}/view`)}
      variant="outline"
      h="36px"
      px="14px"
      borderRadius="control"
      borderColor="border"
      bg="surface"
      color="fg"
      fontSize="13.5px"
      fontWeight="500"
    >
      {t("backToGallery")}
    </Button>
  );

  // ---- Render states -------------------------------------------------------

  if (error) {
    return (
      <Flex minH="100vh" direction="column" align="center" justify="center" p="24px" bg="bg">
        <Text color="danger" mb="16px">
          {error}
        </Text>
        {backButton}
      </Flex>
    );
  }

  if (!payload) {
    return (
      <Flex minH="100vh" align="center" justify="center" bg="bg">
        <Text color="fgMuted" fontSize="14px">
          …
        </Text>
      </Flex>
    );
  }

  const displayVariant = payload.variants.DISPLAY;
  const originalVariant = payload.variants.ORIGINAL;
  const active = payload.variants[quality];

  const parts = active.parts ?? [];
  const n = parts.length;

  return (
    <Box minH="100vh" bg="bg" px="16px" py="32px">
      <Box maxW="540px" mx="auto">
        {/* Back link */}
        <Button
          onClick={() => router.push(`/gallery/${slug}/view`)}
          variant="plain"
          h="auto"
          p="0"
          gap="5px"
          color="fgMuted"
          fontSize="13.5px"
          fontWeight="400"
          mb="28px"
          _hover={{ color: "fg" }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
          {t("backToGallery")}
        </Button>

        {/* Header */}
        <Heading as="h1" fontSize="22px" fontWeight="700" color="fg" m="0 0 16px">
          {t("title")}
        </Heading>

        {/* Variant toggle */}
        <Tabs.Root
          value={quality}
          onValueChange={(e) => setQuality(e.value as Quality)}
          variant="plain"
        >
          <Tabs.List
            h="auto"
            gap="6px"
            p="4px"
            borderRadius="card"
            bg="surface"
            borderWidth="1px"
            borderColor="border"
            mb="18px"
          >
            <VariantTab
              value="DISPLAY"
              active={quality === "DISPLAY"}
              testId="variant-toggle-kompakt"
              label={t("tabKompakt")}
              hint={t("tabKompaktHint")}
              building={displayVariant.building}
            />
            <VariantTab
              value="ORIGINAL"
              active={quality === "ORIGINAL"}
              testId="variant-toggle-original"
              label={t("tabOriginal")}
              hint={t("tabOriginalHint")}
              building={originalVariant.building}
            />
          </Tabs.List>
        </Tabs.Root>

        {/* Active-variant summary */}
        <Text fontSize="13.5px" color="fgMuted" m="0 0 8px">
          {active.partCount === 1
            ? t("variantSummarySingle", { size: formatBytes(active.totalSizeBytes) })
            : t("variantSummary", {
                count: active.partCount,
                size: formatBytes(active.totalSizeBytes),
              })}
        </Text>
        {n > 1 && (
          <Text fontSize="13px" color="fgMuted" m="0 0 20px" lineHeight="1.5">
            {t("instruction")}
          </Text>
        )}
        {n <= 1 && <Box mb="20px" />}

        {/* Build-in-progress banner for the ACTIVE variant */}
        {active.building && (
          <Flex
            data-testid="building-banner"
            align="center"
            gap="9px"
            fontSize="12.5px"
            color="accent"
            bg="accent.50"
            borderWidth="1px"
            borderColor="accent.200"
            borderRadius="10px"
            px="12px"
            py="10px"
            mb="20px"
          >
            <Spinner size="sm" borderWidth="2.2px" color="currentColor" flexShrink={0} />
            {t("buildingBanner")}
          </Flex>
        )}

        {/* Empty state for the active variant (no parts yet) */}
        {n === 0 && (
          <Text fontSize="13.5px" color="fgMuted" m="0 0 20px">
            {active.building ||
            active.status === "BUILDING" ||
            active.status === "QUEUED" ||
            active.status === "DEBOUNCING"
              ? t("variantBuildingEmpty")
              : t("variantNoArchive")}
          </Text>
        )}

        {/* Part list (active variant only — galleries can have 20+ parts) */}
        {n > 0 && (
          <Stack gap="12px">
            {parts.map((part) => {
              const done = !!downloaded[quality]?.[part.index];
              const sig = part.membershipSig ?? "";
              return (
                <chakra.a
                  key={part.index}
                  href={part.url ?? undefined}
                  download={part.url ? true : undefined}
                  onClick={() => part.url && markDownloaded(quality, part.index, sig)}
                  display="flex"
                  alignItems="center"
                  gap="14px"
                  px="18px"
                  py="16px"
                  borderRadius="card"
                  borderWidth="1px"
                  borderColor={done ? "green.200" : "border"}
                  bg={done ? "green.50" : "surface"}
                  textDecoration="none"
                  transition="background .15s, border-color .15s"
                  cursor={part.url ? "pointer" : "default"}
                  _hover={part.url && !done ? { bg: "gray.50" } : undefined}
                >
                  <CheckIcon done={done} />
                  <Box flex="1" minW="0">
                    <Text fontSize="14px" fontWeight="600" color="fg" mb="2px">
                      {n === 1 ? t("title") : t("partLabel", { index: part.index, total: n })}
                    </Text>
                    <Box fontSize="12.5px" color="fgMuted">
                      {t("partSize", { size: formatBytes(part.sizeBytes) })}
                      {done && (
                        <Text as="span" ml="8px" color="success" fontWeight="500">
                          · {t("downloaded")}
                        </Text>
                      )}
                      {part.rebuilding && (
                        <Text as="span" ml="8px" color="warning" fontWeight="500">
                          · {t("rebuilding")}
                        </Text>
                      )}
                    </Box>
                  </Box>
                  <Box color="fgSubtle" flexShrink={0} lineHeight="0">
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
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="7 10 12 15 17 10" />
                      <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                  </Box>
                </chakra.a>
              );
            })}
          </Stack>
        )}
      </Box>
    </Box>
  );
}

function VariantTab({
  value,
  active,
  testId,
  label,
  hint,
  building,
}: {
  value: Quality;
  active: boolean;
  testId: string;
  label: string;
  hint: string;
  building: boolean;
}) {
  return (
    <Tabs.Trigger
      value={value}
      data-testid={testId}
      flex="1"
      h="auto"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      textAlign="center"
      whiteSpace="normal"
      gap="2px"
      px="10px"
      py="8px"
      borderRadius="9px"
      bg="transparent"
      color="fg"
      transition="background .15s, color .15s"
      _selected={{ bg: "fg", color: "surface" }}
    >
      <Text
        as="span"
        fontSize="13.5px"
        fontWeight="600"
        display="inline-flex"
        alignItems="center"
        gap="6px"
      >
        {label}
        {building && (
          <Spinner
            size="xs"
            borderWidth="2.4px"
            color="currentColor"
            opacity={0.85}
            flexShrink={0}
          />
        )}
      </Text>
      <Text as="span" fontSize="11px" opacity={active ? 0.8 : 0.6}>
        {hint}
      </Text>
    </Tabs.Trigger>
  );
}
