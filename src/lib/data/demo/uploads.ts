import path from "node:path";

/** Where demo mode stores uploads. FINDMAXXING_DEMO_UPLOAD_DIR points scripted runs (e2e) at a scratch folder. */
export const UPLOAD_DIR = process.env.FINDMAXXING_DEMO_UPLOAD_DIR || path.join(process.cwd(), ".data", "uploads");
