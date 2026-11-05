
import { useState } from "react";
import { initializeSignalClient } from "./services/signal/signalClient";

import {
  openLinkedDeviceStagingStoreForVerification,
  closeLinkedDeviceStagingStore,
} from "./services/signal/signalDeviceTransfer";

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
    throw new Error(
      `Unsupported public key format: ${typeof publicKey}`
    );
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    keyBytes
  );

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
  const [deviceId, setDeviceId] = useState(1);

 
async function initialize() {
  setLoading(true);
  setError("");
  setDetails(null);
  setStatus("Initializing...");

  let staging = null;
  let clientStarted = false;

  try {
    const token = sessionStorage.getItem("grus_token");

    const currentUser = JSON.parse(
      sessionStorage.getItem("grus_user") || "null"
    );

    const userId = String(currentUser?.id ?? "").trim();

    if (!token || !userId) {
      throw new Error("Please log in to GRUS before testing Signal.");
    }

    if (deviceId === 2) {
  staging = await openLinkedDeviceStagingStoreForVerification({
    userId,
    deviceId,
  });

  try {
    const identity = await staging.store.getIdentityKey("aci");

    const registrationId =
      await staging.store.getLocalRegistrationId("aci");

    console.log("[GRUS DEVICE 2 READ-ONLY CHECK]", {
      database: staging.options.name,
      storeIdentity: staging.store.storeIdentity,
      identityResult: identity === null ? "NULL" : "OBJECT",
      hasDhPublicKey: !!identity?.dhKey?.publicKey,
      hasDhPrivateKey: !!identity?.dhKey?.privateKey,
      hasSigningPublicKey: !!identity?.signingKey?.publicKey,
      hasSigningPrivateKey: !!identity?.signingKey?.privateKey,
      hasRegistrationId: Number.isInteger(registrationId),
    });
  } finally {
    await closeLinkedDeviceStagingStore(staging);
    staging = null;
  }

  setStatus("Device 2 storage inspection completed");
  return;
}


    const client = await initializeSignalClient({
      userId,
      deviceId,
      existingStorage: staging?.store ?? null,
    });

    clientStarted = true;

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

    setStatus("Client initialized successfully");
  } catch (err) {
    console.error("GRUS Signal initialization failed:", err);
    setStatus("Initialization failed");
    setError(err.message || String(err));

    if (!clientStarted && staging) {
      await closeLinkedDeviceStagingStore(staging).catch(console.error);
    }
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

      <p>
        <strong>Status:</strong> {status}
      </p>

            <p>
        <strong>Status:</strong> {status}
      </p>

      {/* ADD DEVICE SELECTOR HERE */}
      <div style={{ margin: "20px 0" }}>
        <label htmlFor="signal-device">
          <strong>Select Signal Device:</strong>
        </label>

        <select
          id="signal-device"
          value={deviceId}
          onChange={(event) => setDeviceId(Number(event.target.value))}
          disabled={loading}
          style={{ marginLeft: "12px", padding: "8px" }}
        >
          <option value={1}>Device 1 (Primary)</option>
          <option value={2}>Device 2 (Linked)</option>
        </select>
      </div>

      <button
        onClick={initialize}
        disabled={loading}
        style={{
          padding: "12px 20px",
          cursor: loading ? "wait" : "pointer",
        }}
      >
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

      <p>
        <a href="/">Return to GRUS</a>
      </p>
    </main>
  );
}
