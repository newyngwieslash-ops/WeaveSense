"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { AssistantProvider } from "@/components/assistant/assistant-provider";
import { AssistantLauncher } from "@/components/assistant/assistant-launcher";
import { AssistantPanel } from "@/components/assistant/assistant-panel";

export function AppProviders({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 12_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <AssistantProvider>
        {children}
        <AssistantLauncher />
        <AssistantPanel />
      </AssistantProvider>
      <Toaster
        theme="dark"
        position="top-center"
        toastOptions={{
          style: {
            background: "#141518",
            color: "#eceef1",
            border: "1px solid #2a2d33",
          },
        }}
      />
    </QueryClientProvider>
  );
}
