"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Box, Button, Field, Flex, Heading, Input, Text } from "@chakra-ui/react";
import { ORPCError } from "@orpc/client";
import type { GalleryInfo } from "@pixshar/contracts";
import { api } from "@/lib/rpc";

export default function GalleryGatePage() {
  const t = useTranslations("gallery.gate");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [event, setEvent] = useState<GalleryInfo | null>(null);
  const [loadingEvent, setLoadingEvent] = useState(true);
  const router = useRouter();
  const params = useParams();
  const slug = params.slug as string;

  useEffect(() => {
    // Check if already unlocked — if so, skip straight to the view.
    api.gallery
      .get({ slug })
      .then(() => router.push(`/gallery/${slug}/view`))
      .catch(() =>
        // Not unlocked: show the gate, with the public event info on it.
        api.gallery
          .info({ slug })
          .then(setEvent)
          .catch(() => {})
          .finally(() => setLoadingEvent(false)),
      );
  }, [slug, router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      await api.gallery.unlock({ slug, password });
      router.push(`/gallery/${slug}/view`);
    } catch (err) {
      const code = err instanceof ORPCError ? err.code : null;
      setError(
        code === "UNAUTHORIZED"
          ? t("invalidPassword")
          : code === "TOO_MANY_REQUESTS"
            ? t("tooManyAttempts")
            : t("unlockFailed"),
      );
    } finally {
      setLoading(false);
    }
  }

  if (loadingEvent) {
    return (
      <Flex minH="100vh" align="center" justify="center" color="fgSubtle">
        <span>…</span>
      </Flex>
    );
  }

  return (
    <Flex
      minH="100vh"
      position="relative"
      align="center"
      justify="center"
      px="24px"
      py="40px"
      bgImage="cover"
    >
      <Box
        position="absolute"
        inset="0"
        bgImage="linear-gradient(180deg,rgba(15,15,18,.32) 0%,rgba(15,15,18,.55) 100%)"
      />
      <Box
        position="relative"
        w="100%"
        maxW="400px"
        textAlign="center"
        animation="pxRise .55s ease both"
      >
        <Text
          fontSize="12px"
          letterSpacing=".22em"
          textTransform="uppercase"
          color="rgba(255,255,255,.82)"
          fontWeight="500"
          mb="14px"
        >
          {t("privateGallery")}
        </Text>
        <Heading
          as="h1"
          fontFamily="serif"
          fontWeight="300"
          fontSize="46px"
          lineHeight="1.08"
          color="white"
          m="0 0 12px"
          letterSpacing="-.01em"
          textShadow="0 2px 20px rgba(0,0,0,.25)"
        >
          {event?.name || t("galleryFallback")}
        </Heading>
        <Text fontSize="14px" color="rgba(255,255,255,.85)" mb="30px">
          {event?.description || t("descriptionFallback")}
        </Text>
        <Box
          bg="rgba(255,255,255,.97)"
          backdropFilter="blur(8px)"
          borderRadius="16px"
          boxShadow="0 20px 50px -18px rgba(0,0,0,.5)"
          px="22px"
          py="24px"
          textAlign="left"
        >
          <Flex
            align="center"
            justify="center"
            gap="8px"
            fontSize="13.5px"
            fontWeight="500"
            color="gray.600"
            mb="16px"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="4" y="11" width="16" height="10" rx="2"></rect>
              <path d="M8 11V7a4 4 0 0 1 8 0v4"></path>
            </svg>
            {t("isPrivate")}
          </Flex>
          <form onSubmit={handleSubmit}>
            <Field.Root invalid={!!error}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("passwordPlaceholder")}
                h="42px"
                px="14px"
                borderRadius="9px"
                fontSize="14.5px"
                textAlign="center"
                letterSpacing=".04em"
              />
              <Field.ErrorText fontSize="12.5px" justifyContent="center" w="100%" mt="6px" mb="8px">
                {error}
              </Field.ErrorText>
            </Field.Root>
            <Button
              type="submit"
              disabled={loading}
              colorPalette="accent"
              w="100%"
              h="42px"
              mt="14px"
              borderRadius="9px"
              fontSize="14.5px"
              fontWeight="500"
              boxShadow="0 1px 2px rgba(0,0,0,.08)"
            >
              {loading ? t("unlocking") : t("unlock")}
            </Button>
          </form>
        </Box>
        <Flex
          align="center"
          justify="center"
          gap="6px"
          mt="22px"
          fontSize="12px"
          color="rgba(255,255,255,.7)"
        >
          <Box w="13px" h="13px" borderRadius="4px" bg="rgba(255,255,255,.85)" />
          {t("poweredBy")}
        </Flex>
      </Box>
    </Flex>
  );
}
