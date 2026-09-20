"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge, Box, Button, Card, Flex, Grid, Heading, Text } from "@chakra-ui/react";

interface EventItem {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  _count: { photos: number };
}

/** Event status → Chakra colorPalette. Also consumed by the event detail page. */
export const EVENT_STATUS_PALETTE: Record<string, string> = {
  READY: "green",
  PROCESSING: "orange",
};

/** 12 decorative cover gradients, declared in theme.ts, picked by list index. */
const COVER_COUNT = 12;

export default function AdminPage() {
  const t = useTranslations("admin");
  const tCommon = useTranslations("common");
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    fetch("/api/events", { credentials: "include" })
      .then((res) => {
        if (res.status === 401) {
          router.push("/auth/login");
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (data) setEvents(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [router]);

  function statusLabel(st: string) {
    return st === "READY" ? t("events.status.ready") : t("events.status.processing");
  }

  function formatDate(d: string) {
    const date = new Date(d);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  const processingCount = events.filter((e) => e.status === "PROCESSING").length;
  const eventCountLabel = t("events.eventCount", {
    count: events.length,
    processing: processingCount,
  });

  if (loading) {
    return (
      <Flex minH="100vh" bg="surface" align="center" justify="center" color="fgSubtle">
        {tCommon("loading")}
      </Flex>
    );
  }

  return (
    <Box minH="100vh" bg="surface" animation="pxFade .35s ease both">
      {/* Sticky header */}
      <Flex
        position="sticky"
        top="0"
        zIndex="10"
        bg="rgba(255,255,255,.86)"
        backdropFilter="blur(10px)"
        borderBottomWidth="1px"
        borderColor="border"
        px="28px"
        py="14px"
        align="center"
        justify="space-between"
        gap="16px"
      >
        <Flex align="center" gap="10px">
          <Flex
            w="26px"
            h="26px"
            borderRadius="control"
            bg="accent"
            color="accent.contrast"
            align="center"
            justify="center"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="3"></rect>
              <circle cx="8.5" cy="8.5" r="1.8"></circle>
              <path d="m21 15-4.5-4.5L7 20"></path>
            </svg>
          </Flex>
          <Text fontSize="16px" fontWeight="600" letterSpacing="-.01em">
            Pixshar
          </Text>
        </Flex>
        <Flex align="center" gap="14px">
          <Text fontSize="13px" color="fgMuted">
            {t("header.adminStudio")}
          </Text>
          <Flex
            w="32px"
            h="32px"
            borderRadius="50%"
            bg="fg"
            color="surface"
            align="center"
            justify="center"
            fontSize="13px"
            fontWeight="600"
          >
            A
          </Flex>
        </Flex>
      </Flex>

      <Box maxW="1040px" mx="auto" px="28px" pt="34px" pb="48px">
        <Flex justify="space-between" align="flex-end" gap="16px" wrap="wrap" mb="26px">
          <Box>
            <Heading as="h1" fontSize="27px" fontWeight="600" letterSpacing="-.025em" m="0">
              {t("events.title")}
            </Heading>
            <Text fontSize="14.5px" color="fgMuted" mt="6px">
              {eventCountLabel}
            </Text>
          </Box>
          <Flex gap="10px" align="center">
            <Link href="/admin/tools">
              <Button
                variant="outline"
                h="40px"
                px="10px"
                fontSize="13px"
                fontWeight="400"
                color="fgMuted"
                bg="surface"
                borderColor="border"
                borderRadius="control"
                _hover={{ bg: "bg" }}
              >
                Tools
              </Button>
            </Link>
            <Link href="/admin/events/new">
              <Button
                colorPalette="accent"
                h="40px"
                px="16px"
                gap="7px"
                borderRadius="control"
                fontSize="14px"
                fontWeight="500"
                boxShadow="0 1px 2px rgba(0,0,0,.08)"
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                >
                  <path d="M12 5v14M5 12h14"></path>
                </svg>
                {t("events.newEvent")}
              </Button>
            </Link>
          </Flex>
        </Flex>

        <Grid templateColumns="repeat(auto-fill, minmax(280px, 1fr))" gap="20px">
          {events.map((ev, i) => (
            <Card.Root
              key={ev.id}
              bg="surface"
              borderWidth="1px"
              borderColor="border"
              borderRadius="14px"
              overflow="hidden"
              cursor="pointer"
              transition="box-shadow .2s, transform .2s, border-color .2s"
              _hover={{
                boxShadow: "0 14px 34px -16px rgba(0,0,0,.22)",
                transform: "translateY(-3px)",
                borderColor: "gray.300",
              }}
              onClick={() => router.push(`/admin/events/${ev.id}`)}
            >
              <Box
                aspectRatio="16/10"
                bgImage={`eventCover.${(i % COVER_COUNT) + 1}`}
                position="relative"
              >
                <Badge
                  position="absolute"
                  top="11px"
                  right="11px"
                  colorPalette={EVENT_STATUS_PALETTE[ev.status] ?? "gray"}
                  variant="subtle"
                  h="24px"
                  px="10px"
                  gap="5px"
                  borderRadius="pill"
                  fontSize="11.5px"
                  fontWeight="500"
                  backdropFilter="blur(6px)"
                >
                  <Box w="6px" h="6px" borderRadius="50%" bg="colorPalette.solid" />
                  {statusLabel(ev.status)}
                </Badge>
              </Box>
              <Card.Body px="16px" pt="15px" pb="16px">
                <Text fontSize="16px" fontWeight="600" letterSpacing="-.01em" mb="3px">
                  {ev.name}
                </Text>
                <Text fontSize="13px" color="fgMuted">
                  {t("events.eventDate", { date: formatDate(ev.createdAt) })}
                </Text>
                <Flex
                  align="center"
                  justify="space-between"
                  mt="14px"
                  pt="13px"
                  borderTopWidth="1px"
                  borderColor="bg"
                >
                  <Flex as="span" align="center" gap="6px" fontSize="13px" color="gray.600">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="3"></rect>
                      <circle cx="8.5" cy="8.5" r="1.8"></circle>
                      <path d="m21 15-4.5-4.5L7 20"></path>
                    </svg>
                    {t("events.photos", { count: ev._count.photos })}
                  </Flex>
                  <Flex
                    as="span"
                    align="center"
                    gap="4px"
                    fontSize="13px"
                    fontWeight="500"
                    color="accent"
                    cursor="pointer"
                    _hover={{ textDecoration: "underline" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/gallery/${ev.slug}`);
                    }}
                  >
                    {t("events.viewGallery")}
                    <svg
                      width="13"
                      height="13"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                    >
                      <path d="M7 17 17 7M9 7h8v8"></path>
                    </svg>
                  </Flex>
                </Flex>
              </Card.Body>
            </Card.Root>
          ))}
        </Grid>

        {events.length === 0 && (
          <Box textAlign="center" px="20px" py="60px" color="fgSubtle" fontSize="14px">
            {t("events.noEvents")}
          </Box>
        )}
      </Box>
    </Box>
  );
}
