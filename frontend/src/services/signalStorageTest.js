
import { webSqliteStore } from "@open-e2ee/signal-protocol-sdk/local/store/web-sqlite";

let storageInstance = null;

export async function initializeGrusSignalStorage() {
  if (storageInstance) {
    return storageInstance;
  }

  try {
    console.log("[GRUS E2EE] Initializing browser storage...");

    storageInstance = await webSqliteStore({
      name: "grus-e2ee-stage1-test.db",
    });

    console.log("[GRUS E2EE] Browser storage initialized.");
    console.log("[GRUS E2EE] Storage type: Encrypted SQLite / OPFS");

    return storageInstance;
  } catch (error) {
    console.error("[GRUS E2EE] Storage initialization failed:", error);
    storageInstance = null;
    throw error;
  }
}
