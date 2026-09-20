"use client";

import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@/components/theme";

export function Provider({ children }: { children: React.ReactNode }) {
  return <ChakraProvider value={system}>{children}</ChakraProvider>;
}
