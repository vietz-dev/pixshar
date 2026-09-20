"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Box, Button, Card, Field, Flex, HStack, Input, Stack, Text } from "@chakra-ui/react";

export default function LoginPage() {
  const t = useTranslations("auth.login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || data.error || t("loginFailed"));
      }

      router.push("/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loginFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Flex
      minH="100vh"
      align="center"
      justify="center"
      px="24px"
      py="40px"
      bgImage="radial-gradient(120% 80% at 50% 0%, #fafafa 0%, {colors.bg} 100%)"
    >
      <Box w="100%" maxW="380px" animation="pxRise .5s ease both">
        <Stack align="center" gap="14px" mb="30px">
          <Flex
            w="46px"
            h="46px"
            borderRadius="13px"
            bg="accent"
            align="center"
            justify="center"
            boxShadow="0 6px 20px -6px rgba(37,99,235,.6)"
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#fff"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="3"></rect>
              <circle cx="8.5" cy="8.5" r="1.8"></circle>
              <path d="m21 15-4.5-4.5L7 20"></path>
            </svg>
          </Flex>
          <Box textAlign="center">
            <Text fontSize="22px" fontWeight="600" letterSpacing="-.02em">
              Pixshar
            </Text>
            <Text fontSize="14px" color="fgMuted" mt="3px">
              {t("subtitle")}
            </Text>
          </Box>
        </Stack>

        <Card.Root
          bg="surface"
          borderColor="border"
          borderRadius="card"
          boxShadow="0 1px 3px rgba(0,0,0,.05)"
        >
          <Card.Body px="24px" py="26px">
            <form onSubmit={handleSubmit}>
              <Stack gap="16px">
                <Field.Root>
                  <Field.Label fontSize="13px" fontWeight="500">
                    {t("emailLabel")}
                  </Field.Label>
                  <Input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    borderRadius="control"
                  />
                </Field.Root>

                <Field.Root invalid={!!error}>
                  <HStack w="100%" justify="space-between">
                    <Field.Label fontSize="13px" fontWeight="500">
                      {t("passwordLabel")}
                    </Field.Label>
                    <Text fontSize="12.5px" color="accent" cursor="pointer">
                      {t("forgotPassword")}
                    </Text>
                  </HStack>
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    borderRadius="control"
                  />
                  <Field.ErrorText fontSize="12.5px" justifyContent="center" w="100%">
                    {error}
                  </Field.ErrorText>
                </Field.Root>

                <Button
                  type="submit"
                  disabled={loading}
                  colorPalette="accent"
                  borderRadius="control"
                  boxShadow="0 1px 2px rgba(0,0,0,.08)"
                >
                  {loading ? t("signingIn") : t("signIn")}
                </Button>
              </Stack>
            </form>
          </Card.Body>
        </Card.Root>

        <HStack justify="center" gap="6px" mt="18px" fontSize="12.5px" color="fgSubtle">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="4" y="11" width="16" height="10" rx="2"></rect>
            <path d="M8 11V7a4 4 0 0 1 8 0v4"></path>
          </svg>
          {t("adminOnly")}
        </HStack>
      </Box>
    </Flex>
  );
}
