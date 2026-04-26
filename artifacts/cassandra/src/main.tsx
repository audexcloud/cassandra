import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// Optional override: VITE_API_BASE only needs to be set when frontend and
// backend live on different hosts. On Vercel they share the same domain so
// `/api/*` resolves locally and no prefix is required.
const apiBase = import.meta.env.VITE_API_BASE as string | undefined;
if (apiBase) setBaseUrl(apiBase);

createRoot(document.getElementById("root")!).render(<App />);
