import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { ApiError } from "@/lib/api";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Polling berhenti sendiri saat tab browser tidak terlihat (sama seperti cek document.hidden di UI lama).
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Toaster theme="system" position="top-center" richColors closeButton />
    </QueryClientProvider>
  </StrictMode>,
);
