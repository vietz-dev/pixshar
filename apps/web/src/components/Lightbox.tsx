"use client";

import { useEffect, useCallback, useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { Box, Button, chakra, Dialog, Flex, HStack, Image, Portal, Text } from "@chakra-ui/react";

interface LightboxPhoto {
  id: string;
  url: string;
  photographerName: string | null;
  name?: string;
  placeholderDataUrl?: string | null;
}

interface LightboxProps {
  photos: LightboxPhoto[];
  index: number;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
  onDownload?: (photoId: string) => Promise<string>;
  onDelete?: (photoId: string) => void;
}

/** Shared chrome for the translucent controls floating over the image. */
const overlayControl = {
  bg: "rgba(255,255,255,.1)",
  color: "white",
  _hover: { bg: "rgba(255,255,255,.2)" },
} as const;

export default function Lightbox({
  photos,
  index,
  onClose,
  onNext,
  onPrev,
  onDownload,
  onDelete,
}: LightboxProps) {
  const t = useTranslations("lightbox");
  const tCommon = useTranslations("common");
  const photo = photos[index];
  const counter = `${index + 1} / ${photos.length}`;
  const [downloading, setDownloading] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const touchStartX = useRef<number | null>(null);

  useEffect(() => {
    setImgLoaded(false);
  }, [index]);
  const swipeHandled = useRef(false);

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
    swipeHandled.current = false;
  }

  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const delta = e.changedTouches[0].clientX - touchStartX.current;
    if (Math.abs(delta) > 50) {
      swipeHandled.current = true;
      if (delta < 0) onNext();
      else onPrev();
    }
    touchStartX.current = null;
  }

  // Escape is handled by Dialog.Root; arrows stay on window so they work
  // regardless of which control inside the dialog holds focus.
  const handleKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") onNext();
      else if (e.key === "ArrowLeft") onPrev();
    },
    [onNext, onPrev],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [handleKey]);

  async function handleDownload() {
    if (!onDownload || !photo) return;
    setDownloading(true);
    try {
      const url = await onDownload(photo.id);
      // S3 presigned URL sends Content-Disposition: attachment;
      // opening in a new tab triggers a download without leaving the page.
      window.open(url, "_blank");
    } catch {
      // ignore
    } finally {
      setDownloading(false);
    }
  }

  if (!photo) return null;

  return (
    <Dialog.Root
      open
      size="full"
      motionPreset="none"
      aria-label={t("photoAlt")}
      onOpenChange={(e) => {
        if (!e.open) onClose();
      }}
    >
      <Portal>
        <Dialog.Backdrop bg="rgba(9,9,11,.92)" backdropFilter="blur(6px)" />
        <Dialog.Positioner>
          <Dialog.Content
            onClick={() => {
              if (!swipeHandled.current) onClose();
            }}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            bg="transparent"
            boxShadow="none"
            borderRadius="0"
            h="100dvh"
            alignItems="center"
            justifyContent="center"
          >
            {/* Top bar */}
            <Flex
              position="absolute"
              top="22px"
              left="0"
              right="0"
              align="center"
              justify="space-between"
              px="24px"
              color="gray.200"
            >
              <Text fontSize="13.5px" fontFamily="mono" color="fgSubtle">
                {counter}
              </Text>
              <HStack gap="10px">
                {onDownload && (
                  <Button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDownload();
                    }}
                    disabled={downloading}
                    variant="plain"
                    h="38px"
                    px="14px"
                    borderRadius="control"
                    borderWidth="1px"
                    borderColor="rgba(255,255,255,.15)"
                    fontSize="13.5px"
                    fontWeight="500"
                    gap="6px"
                    {...overlayControl}
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
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                      <polyline points="7 10 12 15 17 10"></polyline>
                      <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    {downloading ? t("downloading") : t("download")}
                  </Button>
                )}
                {onDelete && (
                  <Button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(photo.id);
                    }}
                    variant="plain"
                    h="38px"
                    px="14px"
                    borderRadius="control"
                    borderWidth="1px"
                    borderColor="rgba(255,255,255,.15)"
                    fontSize="13.5px"
                    fontWeight="500"
                    gap="6px"
                    {...overlayControl}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                    >
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    </svg>
                    {tCommon("delete")}
                  </Button>
                )}
                <Dialog.CloseTrigger
                  position="static"
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  w="38px"
                  h="38px"
                  borderRadius="50%"
                  cursor="pointer"
                  {...overlayControl}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                  >
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </Dialog.CloseTrigger>
              </HStack>
            </Flex>

            {/* Prev */}
            <chakra.button
              onClick={(e) => {
                e.stopPropagation();
                onPrev();
              }}
              position="absolute"
              left="18px"
              w="44px"
              h="44px"
              borderRadius="50%"
              display="flex"
              alignItems="center"
              justifyContent="center"
              cursor="pointer"
              transition="background .15s"
              zIndex={2}
              {...overlayControl}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="m15 18-6-6 6-6" />
              </svg>
            </chakra.button>

            {/* Image */}
            <Box
              onClick={(e) => e.stopPropagation()}
              maxW="min(88vw, 1180px)"
              maxH="80vh"
              borderRadius="control"
              boxShadow="0 30px 80px -20px rgba(0,0,0,.7)"
              animationName="scale-in, fade-in"
              animationDuration="moderate"
              animationTimingFunction="cubic-bezier(.2,.7,.3,1)"
              position="relative"
              overflow="hidden"
              bg="fg"
            >
              {photo.url ? (
                <Box position="relative" maxW="min(88vw, 1180px)" maxH="80vh">
                  {photo.placeholderDataUrl && !imgLoaded && (
                    <Image
                      src={photo.placeholderDataUrl}
                      aria-hidden="true"
                      position="absolute"
                      inset="0"
                      w="100%"
                      h="100%"
                      objectFit="contain"
                      filter="blur(20px)"
                      transform="scale(1.05)"
                      pointerEvents="none"
                    />
                  )}
                  <Image
                    src={photo.url}
                    alt={photo.photographerName || t("photoAlt")}
                    onLoad={() => setImgLoaded(true)}
                    maxW="min(88vw, 1180px)"
                    maxH="80vh"
                    objectFit="contain"
                    display="block"
                    opacity={imgLoaded ? 1 : 0}
                    transition="opacity 0.3s ease"
                  />
                </Box>
              ) : (
                <Flex
                  maxW="min(88vw, 1180px)"
                  maxH="80vh"
                  minW="400px"
                  minH="300px"
                  align="center"
                  justify="center"
                  color="gray.600"
                >
                  <svg
                    width="48"
                    height="48"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <circle cx="8.5" cy="8.5" r="1.5" />
                    <path d="m21 15-5-5L5 21" />
                  </svg>
                </Flex>
              )}
              <Flex
                position="absolute"
                left="0"
                right="0"
                bottom="0"
                p="16px"
                bgImage="linear-gradient(0deg,rgba(0,0,0,.4),transparent)"
                align="center"
                gap="8px"
              >
                <Flex
                  w="24px"
                  h="24px"
                  borderRadius="50%"
                  bg="rgba(255,255,255,.25)"
                  align="center"
                  justify="center"
                  fontSize="11px"
                  fontWeight="600"
                  color="white"
                >
                  {(photo.photographerName || tCommon("anonymous")).charAt(0).toUpperCase()}
                </Flex>
                <Text fontSize="13px" color="rgba(255,255,255,.92)">
                  {photo.photographerName || tCommon("anonymous")}
                </Text>
              </Flex>
            </Box>

            {/* Next */}
            <chakra.button
              onClick={(e) => {
                e.stopPropagation();
                onNext();
              }}
              position="absolute"
              right="18px"
              w="44px"
              h="44px"
              borderRadius="50%"
              display="flex"
              alignItems="center"
              justifyContent="center"
              cursor="pointer"
              transition="background .15s"
              zIndex={2}
              {...overlayControl}
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
            </chakra.button>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
