"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Box, Button, chakra, Dialog, Field, Flex, Input, Portal, Text } from "@chakra-ui/react";
import UploadTray, { UploadItem, randomTint } from "./UploadTray";
import { presignedUpload } from "../lib/uploadClient";
import { api } from "@/lib/rpc";

interface UploadModalProps {
  galleryName: string;
  slug: string;
  onClose: () => void;
}

export default function UploadModal({ galleryName, slug, onClose }: UploadModalProps) {
  const t = useTranslations("upload.modal");
  const tCommon = useTranslations("common");
  const [name, setName] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<UploadItem[]>([]);
  const [showDetails, setShowDetails] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const abortRef = useRef(false);

  const nameOk = name.trim().length > 0;
  const total = queue.length;
  const active = queue.some((q) => q.status === "queued" || q.status === "uploading");
  const allDone = total > 0 && !active && !queue.some((q) => q.status === "error");

  const submitLabel =
    submitted && allDone
      ? t("uploaded")
      : total > 0
        ? t("uploadCount", { count: total })
        : t("chooseFirst");

  const fileMapRef = useRef<Map<string, File>>(new Map());

  function addFilesWithMap(fileList: FileList | null) {
    if (!fileList) return;
    const newItems: UploadItem[] = Array.from(fileList).map((f) => {
      const id = Math.random().toString(36).slice(2);
      fileMapRef.current.set(id, f);
      return {
        id,
        name: f.name,
        status: "queued" as const,
        progress: 0,
        tint: randomTint(),
      };
    });
    setQueue((prev) => [...prev, ...newItems]);
  }

  async function doUpload() {
    if (!nameOk || total === 0) return;
    abortRef.current = false;
    setSubmitted(true);

    const uploadItems = queue
      .map((it) => {
        const file = fileMapRef.current.get(it.id);
        return file ? { uid: it.id, file } : null;
      })
      .filter((x): x is { uid: string; file: File } => x !== null);

    try {
      await presignedUpload({
        items: uploadItems,
        init: (payload) => api.gallery.upload.init({ slug, ...payload }),
        complete: (photoIds) => api.gallery.upload.complete({ slug, photoIds }),
        photographerName: name.trim(),
        shouldAbort: () => abortRef.current,
        onStatus: (uid, status, progress) => {
          setQueue((prev) =>
            prev.map((q) =>
              q.id === uid
                ? {
                    ...q,
                    status,
                    progress:
                      progress ?? (status === "done" || status === "skipped" ? 100 : q.progress),
                  }
                : q,
            ),
          );
        },
      });
    } catch {
      setQueue((prev) =>
        prev.map((q) =>
          q.status === "queued" || q.status === "uploading"
            ? { ...q, status: "error" as const, progress: 0 }
            : q,
        ),
      );
    }
  }

  function handleCancel() {
    abortRef.current = true;
  }

  function handleClear() {
    setQueue([]);
    fileMapRef.current.clear();
    setSubmitted(false);
  }

  function handleRetry() {
    setQueue((prev) =>
      prev.map((q) =>
        q.status === "error" ? { ...q, status: "queued" as const, progress: 0 } : q,
      ),
    );
    setSubmitted(false);
    // Retry after state updates
    setTimeout(() => doUpload(), 0);
  }

  return (
    <Dialog.Root
      open
      placement="center"
      size="sm"
      onOpenChange={(e) => {
        if (!e.open) onClose();
      }}
    >
      <Portal>
        <Dialog.Backdrop bg="rgba(9,9,11,.5)" backdropFilter="blur(3px)" />
        <Dialog.Positioner p="24px">
          <Dialog.Content
            maxW="460px"
            bg="surface"
            borderRadius="16px"
            boxShadow="0 30px 70px -20px rgba(0,0,0,.5)"
            overflow="hidden"
          >
            <Dialog.Header pt="20px" px="22px" pb="0" justifyContent="space-between" gap="12px">
              <Box>
                <Dialog.Title fontSize="18px" fontWeight="600" letterSpacing="-.01em">
                  {t("title")}
                </Dialog.Title>
                <Dialog.Description fontSize="13.5px" color="fgMuted" mt="5px">
                  {t("subtitle", { galleryName })}
                </Dialog.Description>
              </Box>
              <Dialog.CloseTrigger
                position="static"
                display="flex"
                alignItems="center"
                justifyContent="center"
                flexShrink={0}
                w="32px"
                h="32px"
                borderRadius="control"
                bg="bg"
                color="gray.600"
                cursor="pointer"
                transition="background .15s"
                _hover={{ bg: "border" }}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body pt="18px" px="22px" pb="22px">
              <Field.Root required mb="16px">
                <Field.Label fontSize="13px" fontWeight="500">
                  {t("nameLabel")}
                  <Field.RequiredIndicator />
                </Field.Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("namePlaceholder")}
                  borderRadius="control"
                />
              </Field.Root>

              <Box
                onClick={() => fileRef.current?.click()}
                borderWidth="1.5px"
                borderStyle="dashed"
                borderColor="gray.300"
                borderRadius="11px"
                bg="gray.50"
                px="18px"
                py="24px"
                textAlign="center"
                cursor="pointer"
                transition="all .15s"
                mb="14px"
                _hover={{ borderColor: "accent", bg: "accent.subtle" }}
              >
                <chakra.input
                  type="file"
                  multiple
                  ref={fileRef}
                  onChange={(e) => addFilesWithMap(e.target.files)}
                  display="none"
                />
                <Flex
                  w="40px"
                  h="40px"
                  borderRadius="10px"
                  bg="accent.subtle"
                  color="accent"
                  align="center"
                  justify="center"
                  mx="auto"
                  mb="11px"
                >
                  <svg
                    width="19"
                    height="19"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M12 17V3m0 0L7 8m5-5 5 5" />
                    <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
                  </svg>
                </Flex>
                <Text fontSize="14px" fontWeight="500" mb="2px">
                  {t("chooseTap")}
                </Text>
                <Text fontSize="12px" color="fgSubtle">
                  {t("chooseDrag")}
                </Text>
              </Box>

              {total > 0 && (
                <UploadTray
                  queue={queue}
                  showDetails={showDetails}
                  onToggleDetails={() => setShowDetails((s) => !s)}
                  onClear={handleClear}
                  onCancel={handleCancel}
                  onRetry={handleRetry}
                  size="small"
                />
              )}

              {/* Disclaimer during active upload */}
              {active && (
                <Flex
                  align="center"
                  gap="8px"
                  mt="12px"
                  px="10px"
                  py="8px"
                  bg="accent.subtle"
                  borderRadius="control"
                  borderWidth="1px"
                  borderColor="accent.muted"
                  color="accent"
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
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4M12 8h.01" />
                  </svg>
                  <Text fontSize="12px" fontWeight="500" color="accent.800">
                    {t("staying")}
                  </Text>
                </Flex>
              )}

              {/* Button: Upload or Close */}
              {submitted && allDone ? (
                <Button
                  onClick={onClose}
                  colorPalette="green"
                  w="100%"
                  h="42px"
                  mt="14px"
                  borderRadius="9px"
                  fontSize="14px"
                  fontWeight="500"
                >
                  {tCommon("close")}
                </Button>
              ) : (
                <Button
                  onClick={doUpload}
                  disabled={!nameOk || total === 0}
                  colorPalette="accent"
                  w="100%"
                  h="42px"
                  mt="14px"
                  borderRadius="9px"
                  fontSize="14px"
                  fontWeight="500"
                >
                  {submitLabel}
                </Button>
              )}
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
