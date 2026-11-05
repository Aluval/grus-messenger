
import { useState } from "react";
import { initializeSignalClient } from "./services/signal/signalClient";

const SIGNAL_DEVICE_ID = 1;

async function calculateFingerprint(publicKey) {
  let keyBytes;

  if (publicKey instanceof Uint8Array) {
    keyBytes = publicKey;
  } else if (publicKey instanceof ArrayBuffer) {
    keyBytes = new Uint8Array(publicKey);
  } else if (ArrayBuffer.isView(publicKey)) {
    keyBytes = new Uint8Array(
      publicKey.buffer,
      publicKey.byteOffset,
      publicKey.byteLength
    );
  } else if (typeof publicKey === "string") {
    const binary = atob(publicKey);
    keyBytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0)
    );
  } else {
    throw new Error("Unsupported public key format.");
  }

  const digest = await crypto.subtle.digest("SHA-256", keyBytes);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(":")
    .toUpperCase();
}

export default function SignalTest() {
  const [status, setStatus] = useState("Not initialized");
  const [details, setDetails] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function initialize() {
    if (loading) return;

    setLoading(true);
    setError("");
    setDetails(null);
    setStatus("Initializing...");

    try {
      const token = sessionStorage.getItem("grus_token");
      const currentUser = JSON.parse(
        sessionStorage.getItem("grus_user") || "null"
      );

      const userId = String(currentUser?.id ?? "").trim();

      if (!token || !userId) {
        throw new Error("Please log in to GRUS before testing Signal.");
      }

      const client = await initializeSignalClient({
        userId,
        deviceId: SIGNAL_DEVICE_ID,
      });

      const stats = await client.getStats();
      const publicKey = await client.getIdentityPublicKey();
      const fingerprint = await calculateFingerprint(publicKey);

      setDetails({
        userId: client.userId,
        deviceId: client.deviceId,
        hasIdentityKey: stats.hasIdentityKey,
        identityFingerprint: fingerprint,
        sessionCount: stats.sessionCount,
        oneTimePreKeysCount: stats.oneTimePreKeysCount,
        syncStatus: client.syncStatus,
      });

      setStatus("Client initialized");
    } catch (err) {
      console.error("GRUS Signal initialization failed:", err);
      setStatus("Initialization failed");
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{
      maxWidth: "850px",
      margin: "60px auto",
      padding: "24px",
      fontFamily: "Arial, sans-serif",
    }}>
      <h1>GRUS Signal Protocol Test</h1>

      <p>Authenticated account identity and prekey synchronization test.</p>

      <p><strong>Status:</strong> {status}</p>
      <p><strong>Device:</strong> {SIGNAL_DEVICE_ID}</p>

      <button onClick={initialize} disabled={loading}>
        {loading ? "Initializing..." : "Initialize Signal Client"}
      </button>

      {error && (
        <pre style={{ color: "red", whiteSpace: "pre-wrap" }}>
          {error}
        </pre>
      )}

      {details && (
        <section>
          <h2>Client Information</h2>
          <pre style={{
            background: "#f1f1f1",
            color: "#111",
            padding: "16px",
            overflowX: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}>
            {JSON.stringify(details, null, 2)}
          </pre>
        </section>
      )}

      <p><a href="/">Return to GRUS</a></p>
    </main>
  );
}
