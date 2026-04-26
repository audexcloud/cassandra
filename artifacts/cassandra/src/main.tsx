import { createRoot } from "react-dom/client";
import { setBaseUrl } from "@workspace/api-client-react";
import App from "./App";
import "./index.css";

// In production (Vercel), VITE_API_BASE points to the Railway backend.
// In dev / Replit the API runs on the same host, so no prefix is needed.
const apiBase = import.meta.env.VITE_API_BASE as string | undefined;
if (apiBase) setBaseUrl(apiBase);

createRoot(document.getElementById("root")!).render(<App />);
