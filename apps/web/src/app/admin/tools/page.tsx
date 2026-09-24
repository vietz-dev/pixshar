"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Box, Button, Card, Flex, Heading, Progress, Text } from "@chakra-ui/react";
import type { BackfillProgress, BackfillStatus } from "@pixshar/contracts";
import { api } from "@/lib/rpc";

export default function AdminToolsPage() {
  const [status, setStatus] = useState<BackfillStatus | null>(null);
  const [progress, setProgress] = useState<BackfillProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api.admin
      .backfillStatus()
      .then(setStatus)
      .catch(() => {});
  }, []);

  async function startBackfill() {
    if (running) return;
    setRunning(true);
    setDone(false);
    setProgress(null);

    const res = await fetch("/api/admin/backfill/start", {
      method: "POST",
      credentials: "include",
    });

    if (!res.ok || !res.body) {
      setRunning(false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const line = part.replace(/^data: /, "");
        if (!line.trim()) continue;
        try {
          const p: BackfillProgress = JSON.parse(line);
          setProgress(p);
          if (p.done) {
            setDone(true);
            setRunning(false);
            setStatus({ total: p.total, missing: 0 });
          }
        } catch {
          // ignore malformed events
        }
      }
    }
    setRunning(false);
  }

  const pct =
    progress && progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0;
  const disabled = running || (status?.missing === 0 && !done);

  return (
    <Box maxW="680px" mx="auto" px="24px" py="40px">
      <Flex mb="32px" align="center" gap="16px">
        <Link href="/admin">
          <Flex as="span" align="center" gap="6px" color="fgMuted" fontSize="14px">
            ← Admin
          </Flex>
        </Link>
        <Heading as="h1" m="0" fontSize="22px" fontWeight="600">
          Tools
        </Heading>
      </Flex>

      <Card.Root bg="surface" borderWidth="1px" borderColor="border" borderRadius="card">
        <Card.Body p="24px">
          <Heading as="h2" m="0 0 8px" fontSize="16px" fontWeight="600">
            Blur-Platzhalterbilder generieren
          </Heading>
          <Text m="0 0 20px" color="fgMuted" fontSize="14px" lineHeight="1.6">
            Generiert Blur-Platzhalterbilder für alle bereits hochgeladenen Fotos, die noch keinen
            Platzhalter haben. Neue Fotos erhalten den Platzhalter automatisch beim Verarbeiten.
          </Text>

          {status && (
            <Text m="0 0 20px" fontSize="14px" color="fgMuted">
              {status.missing === 0
                ? `Alle ${status.total} Fotos haben bereits einen Platzhalter.`
                : `${status.missing} von ${status.total} Fotos fehlt noch ein Platzhalter.`}
            </Text>
          )}

          {progress && (
            <Progress.Root value={pct} colorPalette="accent" mb="20px">
              <Progress.Track h="8px" borderRadius="4px" bg="border" mb="8px">
                <Progress.Range borderRadius="4px" transition="width .3s ease" />
              </Progress.Track>
              <Text m="0" fontSize="13px" color="fgMuted">
                {progress.processed} / {progress.total} Fotos verarbeitet ({pct}%)
              </Text>
            </Progress.Root>
          )}

          {done && (
            <Text m="0 0 16px" fontSize="14px" color="accent" fontWeight="500">
              ✓ Fertig — alle Platzhalterbilder wurden generiert.
            </Text>
          )}

          <Button
            onClick={startBackfill}
            disabled={disabled}
            colorPalette="accent"
            px="18px"
            py="8px"
            h="auto"
            borderRadius="control"
            fontSize="14px"
            fontWeight="500"
            cursor={disabled ? "not-allowed" : "pointer"}
            opacity={disabled ? 0.6 : 1}
          >
            {running ? "Wird generiert…" : "Backfill starten"}
          </Button>
        </Card.Body>
      </Card.Root>
    </Box>
  );
}
