"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  Box,
  Button,
  Card,
  Field,
  Flex,
  Group,
  Heading,
  Input,
  InputAddon,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";

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
    <Box minH="100vh" bg="gray.50" animation="pxFade .35s ease both">
      <Box maxW="620px" mx="auto" px="28px" pt="30px" pb="48px">
        <Button
          onClick={() => router.push("/admin")}
          variant="plain"
          h="auto"
          p="0"
          mb="20px"
          gap="6px"
          fontSize="13.5px"
          fontWeight="400"
          color="fgMuted"
          transition="color .15s"
          _hover={{ color: "fg" }}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="m15 18-6-6 6-6"></path>
          </svg>
          {t("backToEvents")}
        </Button>
        <Heading as="h1" fontSize="25px" fontWeight="600" letterSpacing="-.025em" m="0 0 5px">
          {t("title")}
        </Heading>
        <Text fontSize="14.5px" color="fgMuted" m="0 0 26px">
          {t("subtitle")}
        </Text>
        <Card.Root
          bg="surface"
          borderWidth="1px"
          borderColor="border"
          borderRadius="14px"
          boxShadow="0 1px 3px rgba(0,0,0,.05)"
        >
          <Card.Body px="24px" py="26px">
            <form onSubmit={handleSubmit}>
              <Stack gap="18px">
                <Field.Root required>
                  <Field.Label fontSize="13.5px" fontWeight="500" mb="7px">
                    {t("nameLabel")}
                  </Field.Label>
                  <Input
                    value={name}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder={t("namePlaceholder")}
                    h="40px"
                    fontSize="14px"
                    borderRadius="control"
                  />
                </Field.Root>

                <Field.Root required>
                  <Field.Label fontSize="13.5px" fontWeight="500" mb="7px">
                    {t("shareLinkLabel")}
                  </Field.Label>
                  <Group attached w="100%">
                    <InputAddon
                      px="11px"
                      bg="bg"
                      color="fgMuted"
                      fontSize="13px"
                      fontFamily="mono"
                      borderRadius="control"
                    >
                      pixshar.app/gallery/
                    </InputAddon>
                    <Input
                      value={slug}
                      onChange={(e) => handleSlugChange(e.target.value)}
                      placeholder={t("slugPlaceholder")}
                      pattern="[a-z0-9-]+"
                      h="40px"
                      fontSize="13px"
                      fontFamily="mono"
                      borderRadius="control"
                    />
                  </Group>
                  <Field.HelperText fontSize="12.5px" color="fgSubtle" mt="6px">
                    {t("slugHint")}
                  </Field.HelperText>
                </Field.Root>

                <Field.Root>
                  <Field.Label fontSize="13.5px" fontWeight="500" mb="7px">
                    {t("descriptionLabel")}{" "}
                    <Text as="span" color="fgSubtle" fontWeight="400">
                      {t("optional")}
                    </Text>
                  </Field.Label>
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t("descriptionPlaceholder")}
                    minH="74px"
                    resize="vertical"
                    fontSize="14px"
                    lineHeight="1.5"
                    borderRadius="control"
                  />
                </Field.Root>

                <Field.Root required invalid={!!error}>
                  <Field.Label fontSize="13.5px" fontWeight="500" mb="7px">
                    {t("passwordLabel")}
                  </Field.Label>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t("passwordPlaceholder")}
                    h="40px"
                    fontSize="14px"
                    fontFamily="mono"
                    borderRadius="control"
                  />
                  <Field.ErrorText fontSize="13px" mt="12px">
                    {error}
                  </Field.ErrorText>
                </Field.Root>
              </Stack>
            </form>
          </Card.Body>
        </Card.Root>
        <Flex justify="flex-end" gap="10px" mt="20px">
          <Button
            onClick={() => router.push("/admin")}
            variant="outline"
            h="40px"
            px="16px"
            borderRadius="control"
            bg="surface"
            borderColor="border"
            color="fg"
            fontSize="14px"
            fontWeight="500"
            transition="background .15s"
            _hover={{ bg: "bg" }}
          >
            {t("cancelButton")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={loading}
            colorPalette="accent"
            h="40px"
            px="18px"
            borderRadius="control"
            fontSize="14px"
            fontWeight="500"
            boxShadow="0 1px 2px rgba(0,0,0,.08)"
          >
            {loading ? t("creating") : t("createButton")}
          </Button>
        </Flex>
      </Box>
    </Box>
  );
}
