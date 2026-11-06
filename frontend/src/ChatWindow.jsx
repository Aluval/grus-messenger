
import "./ChatWindow.css";
import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { apiRequest, API_URL } from "./services/api";
import { connectSocket } from "./services/socket";

import {
  importPublicKey,
  deriveConversationKey,
  encryptMessage,
  decryptMessage,
  encryptImage,
  decryptImage,
  getIdentityFingerprint,
} from "./services/crypto";

const DB_NAME = "grus_identity";
const STORE_NAME = "identities";

const GRUS_EMOJIS = [
  "😀", "😃", "😄", "😁", "😂", "🤣",
  "😊", "😍", "🥰", "😘", "😎", "🤔",
  "😢", "😭", "😡", "🥳", "🤗", "❤️",
  "💕", "💖", "👍", "👎", "👏", "🙏",
  "🔥", "✨", "🎉", "💯", "🚀", "🌹",
  "☀️", "🌙", "⭐", "💫", "🤝", "💜",
];


// Get a calendar date in Indian Standard Time.
function getISTDateKey(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

// Display Today, Yesterday, or a calendar date.
function getDateSeparatorLabel(value) {
  const messageDate = getISTDateKey(value);

  if (!messageDate) return "Unknown date";

  const today = getISTDateKey(new Date());

  const [year, month, day] = today.split("-").map(Number);
  const yesterdayDate = new Date(
    Date.UTC(year, month - 1, day - 1)
  );

  const yesterday = getISTDateKey(yesterdayDate);

  if (messageDate === today) return "Today";
  if (messageDate === yesterday) return "Yesterday";

  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

// Display message time in IST.
function formatMessageTime(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}


// Load the existing identity. Never generate a replacement here.
function getLocalIdentity(userId) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "userId" });
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        reject(new Error("GRUS identity storage is unavailable."));
        return;
      }

      const transaction = db.transaction(STORE_NAME, "readonly");

const identityRequest = transaction
  .objectStore(STORE_NAME)
  .get(String(userId));

identityRequest.onsuccess = () => {
  const identity = identityRequest.result || null;
  db.close();
  resolve(identity);
};

identityRequest.onerror = () => {
  const error = identityRequest.error;
  db.close();
  reject(error);
};
    };

    request.onerror = () => reject(request.error);
  });
}

// Convert the server's Base64 public key into an ArrayBuffer.
function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

// Add or update a message without losing locally decrypted text.
function mergeMessage(previous, incoming) {
  const map = new Map(
    previous.map((message) => [String(message.id), message])
  );

  const id = String(incoming.id);
  const existing = map.get(id);

  map.set(id, {
    ...existing,
    ...incoming,
    decrypted_content:
      incoming.decrypted_content ?? existing?.decrypted_content,
  });

  return Array.from(map.values()).sort(
    (a, b) =>
      new Date(a.created_at).getTime() -
      new Date(b.created_at).getTime()
  );
}


function EncryptedImage({
  attachment,
  conversationId,
  conversationKey,
  token,
}) {
  const [showViewer, setShowViewer] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [imageError, setImageError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";

    async function loadImage() {
      try {
        setImageError("");
        setImageUrl("");

        if (!attachment?.gridfs_id || !conversationKey) {
          throw new Error("Image attachment information unavailable.");
        }

        const response = await fetch(
          `${API_URL}/api/messages/${conversationId}/attachments/${attachment.gridfs_id}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) {
          throw new Error("Unable to download encrypted image.");
        }

        const ciphertext = await response.arrayBuffer();

        const decryptedBytes = await decryptImage(
          {
            version: attachment.version,
            algorithm: attachment.algorithm,
            iv: attachment.iv,
            ciphertext,
          },
          conversationKey,
          String(conversationId)
        );

        const blob = new Blob([decryptedBytes], {
          type: attachment.content_type || "image/jpeg",
        });

        objectUrl = URL.createObjectURL(blob);

        if (!cancelled) {
          setImageUrl(objectUrl);
        }
      } catch (error) {
        if (!cancelled) {
          setImageError(error.message || "Image could not be decrypted.");
        }
      }
    }

    loadImage();

    return () => {
      cancelled = true;

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [attachment, conversationId, conversationKey, token]);

  if (imageError) {
    return (
      <div style={{ color: "#ffaaaa", fontSize: "12px" }}>
        {imageError}
      </div>
    );
  }

  if (!imageUrl) {
    return (
      <div style={{ color: "#c7beff", fontSize: "12px" }}>
        Loading encrypted image...
      </div>
    );
  }

  const extension =
    attachment.content_type === "image/png"
      ? "png"
      : attachment.content_type === "image/webp"
        ? "webp"
        : "jpg";

  
return (
  <>
    <div style={{ marginTop: "5px" }}>
      <img
        src={imageUrl}
        alt="Encrypted chat attachment"
        onClick={() => setShowViewer(true)}
        style={{
  display: "block",
  maxWidth: "100%",
  maxHeight: "300px",
  width: "auto",
  height: "auto",
  objectFit: "contain",
  borderRadius: "10px",
  cursor: "zoom-in",
  boxSizing: "border-box",
}}
      />

      <button
        type="button"
        onClick={() => {
          const link = document.createElement("a");
          link.href = imageUrl;
          link.download = `GRUS-image.${extension}`;
          link.click();
        }}
        style={{
          marginTop: "8px",
          color: "#c7beff",
          background: "transparent",
          border: "none",
          cursor: "pointer",
        }}
      >
        ↓ Download Image
      </button>
    </div>

    {showViewer && (
      <div
        onClick={() => setShowViewer(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 99999,
          background: "rgba(0,0,0,0.94)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "50px",
        }}
      >
        <button
          type="button"
          onClick={() => setShowViewer(false)}
          style={{
            position: "absolute",
            top: "20px",
            right: "25px",
            background: "#252438",
            color: "white",
            border: "none",
            borderRadius: "50%",
            width: "42px",
            height: "42px",
            fontSize: "25px",
            cursor: "pointer",
          }}
        >
          ×
        </button>

        <img
          src={imageUrl}
          alt="Full-size GRUS image"
          onClick={(event) => event.stopPropagation()}
          style={{
            maxWidth: "95%",
            maxHeight: "90vh",
            objectFit: "contain",
            borderRadius: "8px",
          }}
        />
      </div>
    )}
  </>
);
}


export default function ChatWindow({
  token,
  user,
  conversation,
  person,
  onBack,
  presence,
}) {
  const [messages, setMessages] = useState([]);
  const [messageMenuId, setMessageMenuId] = useState(null);
  const [deletingMessageId, setDeletingMessageId] = useState(null);
  const [selectedMessageIds, setSelectedMessageIds] = useState(
  () => new Set()
);
  const [selectionMode, setSelectionMode] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [showConversationMenu, setShowConversationMenu] = useState(false);
const [showClearConfirm, setShowClearConfirm] = useState(false);
const selectedMessages = messages.filter((message) =>
  selectedMessageIds.has(String(message.id))
);

const canDeleteSelectedForEveryone =
  selectedMessages.length > 0 &&
  selectedMessages.every(
    (message) =>
      String(message.sender_id) === String(user.id) &&
      message.deleted_for_everyone !== true
  );
const [peerAvatarUrl, setPeerAvatarUrl] = useState("");
const [showProfileImage, setShowProfileImage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [content, setContent] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [selectedImage, setSelectedImage] = useState(null);
  const [selectedImagePreview, setSelectedImagePreview] = useState("");
  const [dragActive, setDragActive] = useState(false);

  const imageInputRef = useRef(null);
  const [encryptionReady, setEncryptionReady] = useState(false);
  const [fingerprints, setFingerprints] = useState(null);
  const [showFingerprints, setShowFingerprints] = useState(false);
  const [identityVerified, setIdentityVerified] = useState(false);
  const [fingerprintConfirmation, setFingerprintConfirmation] = useState("");
  const [qrStatus, setQrStatus] = useState("");
  const [qrProcessing, setQrProcessing] = useState(false);
  const qrFileInputRef = useRef(null);
  const [peerKeyChanged, setPeerKeyChanged] = useState(false);
  const [encryptionStatus, setEncryptionStatus] = useState(
    "Preparing encrypted conversation..."
  );

  const bottomRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const messageInputRef = useRef(null);
  const conversationKeyRef = useRef(null);
  const sendingLockRef = useRef(false);


  useEffect(() => {
  if (!selectedImage) {
    setSelectedImagePreview("");
    return;
  }

  const previewUrl = URL.createObjectURL(selectedImage);
  setSelectedImagePreview(previewUrl);

  return () => {
    URL.revokeObjectURL(previewUrl);
  };
}, [selectedImage]);

  useEffect(() => {
  let active = true;
  let objectUrl = "";

  async function loadPeerPicture() {
    setPeerAvatarUrl("");
    setShowProfileImage(false);

    if (!person?.id || !token) return;

    try {
      const response = await fetch(
        `${API_URL}/api/users/profile-picture/${person.id}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      // 404 or 403 means no picture is available to this viewer.
      if (!response.ok) return;

      const blob = await response.blob();

      if (!active) return;

      objectUrl = URL.createObjectURL(blob);
      setPeerAvatarUrl(objectUrl);
    } catch (err) {
      console.error("Contact profile picture loading failed:", err);
    }
  }

  loadPeerPicture();

  return () => {
    active = false;

    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  };
}, [person?.id, token]);

  useEffect(() => {
  console.log("[GRUS STATE] Message count:", messages.length);

  console.log(
    "[GRUS STATE] First message:",
    messages[0]?.created_at
  );

  console.log(
    "[GRUS STATE] Last message:",
    messages[messages.length - 1]?.created_at
  );
}, [messages]);

  useEffect(() => {
    let active = true;
    let socket = null;

    conversationKeyRef.current = null;
    setEncryptionReady(false);
    setFingerprints(null);
    setShowFingerprints(false); 
    setPeerKeyChanged(false);
    setIdentityVerified(false); 
    setLoading(true);
    setMessages([]);
    setError("");
    setEncryptionStatus("Preparing encrypted conversation...");



    async function decryptIncomingMessage(message, key) {
      const status =
        message.encryption_status || message.status || "";

      // Image attachments use their own encrypted payload in GridFS.
      // Do not process them as encrypted text messages.
      if (message.attachment) {
        return {
          ...message,
          message_type: "image",
          decrypted_content: "",
          decryption_failed: false,
        };
      }

      // Preserve old messages, but clearly identify them as plaintext.
      if (
        status === "legacy_plaintext" ||
        status === "development_plaintext" ||
        (!message.encrypted_payload && message.content)
      ) {
        return {
          ...message,
          encryption_status:
            status || "legacy_plaintext",
          decrypted_content: message.content,
        };
      }

      if (!message.encrypted_payload) {
        return {
          ...message,
          decrypted_content: "[Message payload unavailable]",
          decryption_failed: true,
        };
      }

      try {
        const decrypted = await decryptMessage(
          message.encrypted_payload,
          key,
          String(conversation.id)
        );

        return {
          ...message,
          encryption_status: "encrypted",
          decrypted_content: decrypted,
          decryption_failed: false,
        };
      } catch {
        return {
          ...message,
          decrypted_content: "[Unable to decrypt this message]",
          decryption_failed: true,
        };
      }
    }

    
    // Mark an incoming message as read.
    async function markMessageAsRead(message) {
      if (
        !active ||
        String(message.sender_id) === String(user.id) ||
        message.delivery_status === "read"
      ) {
        return;
      }

      try {
        const result = await apiRequest(
          `/api/messages/${conversation.id}/${message.id}/read`,
          {
            method: "POST",
            token,
          }
        );

        console.log("GRUS READ RECEIPT RESPONSE:", result);

        if (!active) return;

        setMessages((previous) =>
          previous.map((item) =>
            String(item.id) === String(message.id)
              ? {
                  ...item,
                  delivery_status: result.delivery_status,
                  delivered_at: result.delivered_at,
                  read_at: result.read_at,
                }
              : item
          )
        );
      } catch (err) {
        console.error("Read acknowledgement failed:", err);
      }
    }


    async function initializeChat() {
      try {
        if (!user?.id || !person?.id || !conversation?.id) {
          throw new Error("Conversation or user information is missing.");
        }

        // 1. Load this user's existing private identity.
        const identity = await getLocalIdentity(user.id);

        if (
          !identity?.privateKey ||
          !identity?.publicKey ||
          identity.recoverySetupPending
        ) {
          throw new Error(
            "Your GRUS identity is not ready on this device. Complete identity recovery first."
          );
        }

        
        // 2. Verify this device's identity against the server backup.
        const ownBackupResponse = await apiRequest(
          `/api/auth/recovery/public-key/${encodeURIComponent(user.id)}`,
          { token }
        );

        if (
          !ownBackupResponse?.public_key ||
          typeof ownBackupResponse.public_key !== "string"
        ) {
          throw new Error(
            "Your server identity is missing. Encrypted chat has been blocked."
          );
        }

        const localPublicKeyData = await crypto.subtle.exportKey(
          "spki",
          identity.publicKey
        );

        const localPublicKeyBase64 = btoa(
          Array.from(new Uint8Array(localPublicKeyData))
            .map((byte) => String.fromCharCode(byte))
            .join("")
        );

        if (localPublicKeyBase64 !== ownBackupResponse.public_key) {
          throw new Error(
            "Your local identity does not match the registered GRUS identity. Chat encryption has been blocked. Do not generate a replacement identity."
          );
        }

        console.log("GRUS IDENTITY VERIFICATION: PASSED");

        // 2. Generate your own identity fingerprint.
const ownFingerprint = await getIdentityFingerprint(
  identity.publicKey
);

// 3. Retrieve the recipient's public key.
const peerResponse = await apiRequest(
  `/api/auth/recovery/public-key/${encodeURIComponent(person.id)}`,
  { token }
);

if (!peerResponse.public_key) {
  throw new Error(
    "The recipient has not configured a GRUS encryption identity."
  );
}

// 4. Import recipient's public key.
const peerPublicKey = await importPublicKey(
  base64ToArrayBuffer(peerResponse.public_key)
);

// 5. Generate recipient's fingerprint.
const peerFingerprint = await getIdentityFingerprint(
  peerPublicKey
);

// Store fingerprints.
if (active) {
  setFingerprints({
    own: ownFingerprint,
    peer: peerFingerprint,
  });
}

console.log("GRUS OWN FINGERPRINT:", ownFingerprint);
console.log("GRUS PEER FINGERPRINT:", peerFingerprint);

const storageKey =
  `grus_verified_${user.id}_${person.id}`;

const savedFingerprint = localStorage.getItem(storageKey);

const currentFingerprint = peerFingerprint
  .replace(/\s/g, "")
  .toUpperCase();

const keyChanged =
  Boolean(savedFingerprint) &&
  savedFingerprint !== currentFingerprint;

if (active) {
  setPeerKeyChanged(keyChanged);

  setIdentityVerified(
    Boolean(savedFingerprint) &&
    savedFingerprint === currentFingerprint
  );
}

// SECURITY: Do not initialize messaging with a changed identity.
if (keyChanged) {
  if (active) {
    setEncryptionReady(false);
    setEncryptionStatus("Identity change detected");
    setError(
      "Contact encryption identity changed. Messaging is paused until you independently verify the new fingerprint."
    );
  }

  return;
}

// 6. Derive the shared conversation key.
const conversationKey = await deriveConversationKey(
  identity.privateKey,
  peerPublicKey,
  String(conversation.id)
);

if (!active) return;

conversationKeyRef.current = conversationKey;
        // 5. Load and decrypt existing message history.
        const history = await apiRequest(
          `/api/messages/${conversation.id}`,
          { token }
        );

        const decryptedHistory = await Promise.all(
          (history.messages || []).map((message) =>
            decryptIncomingMessage(message, conversationKey)
          )
        );

        console.log("[GRUS HISTORY] API messages:", history.messages?.length);
console.log("[GRUS HISTORY] Decrypted messages:", decryptedHistory.length);
console.log(
  "[GRUS HISTORY] First and last:",
  decryptedHistory[0]?.created_at,
  decryptedHistory.at(-1)?.created_at
);
console.log(
  "[GRUS HISTORY] Failed decryptions:",
  decryptedHistory.filter((m) => m.decryption_failed).length
);

        if (!active) return;

        setMessages((previous) => {
          let combined = [...previous];

          for (const message of decryptedHistory) {
            combined = mergeMessage(combined, message);
          }

          return combined;
        });

        // Mark previously received messages as read.
        for (const message of decryptedHistory) {
          if (String(message.sender_id) !== String(user.id)) {
            await markMessageAsRead(message);
          }
        }

        // 6. Connect Socket.IO after the encryption key is ready.
        socket = connectSocket(token);

        socket.on("connect", () => {
          socket.emit("join_conversation", {
            conversation_id: conversation.id,
          });
        });

        socket.on("joined_conversation", () => {
          if (active) {
            setEncryptionStatus(
              "Encrypted conversation ready"
            );
          }
        });

        socket.on("new_message", async (incoming) => {
  if (
    !active ||
    String(incoming.conversation_id) !== String(conversation.id)
  ) {
    return;
  }

  const decrypted = await decryptIncomingMessage(
    incoming,
    conversationKey
  );

  if (!active) return;

  setMessages((previous) =>
    mergeMessage(previous, decrypted)
  );

  // Acknowledge messages received from the other person.
    if (String(incoming.sender_id) !== String(user.id)) {
    try {
      await apiRequest(
        `/api/messages/${conversation.id}/${incoming.id}/delivered`,
        {
          method: "POST",
          token,
        }
      );

      // The recipient is currently viewing this conversation.
      await markMessageAsRead(decrypted);

    } catch (err) {
      console.error("Message acknowledgement failed:", err);
    }
  }
});


socket.on("message_delivered", (data) => {
  if (
    !active ||
    String(data.conversation_id) !== String(conversation.id)
  ) {
    return;
  }

  setMessages((previous) =>
    previous.map((message) =>
      String(message.id) === String(data.message_id)
        ? {
            ...message,
            delivery_status: data.delivery_status,
            delivered_at: data.delivered_at,
          }
        : message
    )
  );
});

       
socket.on("message_read", (data) => {
  if (
    !active ||
    String(data.conversation_id) !== String(conversation.id)
  ) {
    return;
  }

  setMessages((previous) =>
    previous.map((message) =>
      String(message.id) === String(data.message_id)
        ? {
            ...message,
            delivery_status: "read",
            delivered_at: data.delivered_at,
            read_at: data.read_at,
          }
        : message
    )
  );
});

socket.on("message_deleted", (data) => {
  if (
    !active ||
    String(data.conversation_id) !== String(conversation.id)
  ) {
    return;
  }

  setMessages((previous) =>
    previous.map((message) =>
      String(message.id) === String(data.message_id)
        ? {
            ...message,
            deleted_for_everyone: data.delete_for === "everyone",
            deleted_by: data.deleted_by,
            deleted_at: data.deleted_at || new Date().toISOString(),
            decrypted_content: undefined,
            encrypted_payload: undefined,
            content: undefined,
            decryption_failed: false,
          }
        : message
    )
  );

  setMessageMenuId(null);
});


        socket.on("error_message", (data) => {
          if (active) setError(data.error);
        });

        socket.on("connect_error", (err) => {
          if (active) {
            setError("Connection error: " + err.message);
          }
        });

        socket.on("disconnect", () => {
          if (active) {
            setEncryptionStatus(
              "Encrypted conversation · disconnected"
            );
          }
        });



        if (active) {
          setEncryptionReady(true);
          setEncryptionStatus(
            "Encrypted conversation ready"
          );
        }
      } catch (err) {
        if (active) {
          setError(
            err.message || "Unable to initialize encrypted chat."
          );
          setEncryptionStatus("Encryption unavailable");
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    initializeChat();

    return () => {
      active = false;
      conversationKeyRef.current = null;

      if (socket) {
        socket.disconnect();
      }
    };
  }, [token, user?.id, person?.id, conversation?.id]);

  useEffect(() => {
  const container = messagesContainerRef.current;

  if (!container) return;

  container.scrollTo({
    top: container.scrollHeight,
    behavior: "smooth",
  });
}, [messages]);

  function verifyContactIdentity() {
  if (!fingerprints || !person?.id || !user?.id) return;

  const entered = fingerprintConfirmation
    .replace(/\s/g, "")
    .toUpperCase();

  const expected = fingerprints.peer
    .replace(/\s/g, "")
    .toUpperCase();

  if (entered !== expected) {
    setError("Fingerprint mismatch. Contact identity not verified.");
    return;
  }

  const storageKey =
    `grus_verified_${user.id}_${person.id}`;

  localStorage.setItem(storageKey, expected);

  setIdentityVerified(true);
  setFingerprintConfirmation("");
  setShowFingerprints(false);
  setPeerKeyChanged(false);
  setError("");

  console.log("GRUS CONTACT IDENTITY: VERIFIED");
}

async function downloadMyIdentityQR() {
  try {
    if (!fingerprints?.own || !user?.username) {
      setQrStatus("Your identity fingerprint is not ready.");
      return;
    }

    const payload = {
      format: "GRUS_IDENTITY_QR",
      version: 1,
      username: user.username,
      fingerprint: fingerprints.own.replace(/\s/g, "").toUpperCase(),
    };

    const qrDataUrl = await QRCode.toDataURL(
      JSON.stringify(payload),
      {
        errorCorrectionLevel: "H",
        width: 400,
        margin: 4,
      }
    );

    const link = document.createElement("a");
    link.href = qrDataUrl;
    link.download = `GRUS-${user.username}-identity.png`;
    link.click();

    setQrStatus("Your identity QR was downloaded.");
  } catch (err) {
    console.error("QR generation failed:", err);
    setQrStatus("Unable to generate your identity QR.");
  }
}

async function verifyContactQR(event) {
  const file = event.target.files?.[0];

  if (!file) return;

  setQrStatus("");
  setQrProcessing(true);

  try {
    if (!file.type.startsWith("image/")) {
      throw new Error("Please upload a QR image.");
    }

    if (file.size > 5 * 1024 * 1024) {
      throw new Error("QR image must be smaller than 5 MB.");
    }

    const bitmap = await createImageBitmap(file);

    try {
      const maxDimension = 2000;
      const scale = Math.min(
        1,
        maxDimension / Math.max(bitmap.width, bitmap.height)
      );

      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);

      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Unable to read the uploaded image.");
      }

      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

      const imageData = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height
      );

      const decoded = jsQR(
        imageData.data,
        imageData.width,
        imageData.height
      );

      if (!decoded?.data) {
        throw new Error("No readable GRUS QR code found.");
      }

      let payload;

      try {
        payload = JSON.parse(decoded.data);
      } catch {
        throw new Error("Invalid QR data format.");
      }

      if (
        payload?.format !== "GRUS_IDENTITY_QR" ||
        payload?.version !== 1 ||
        typeof payload.username !== "string" ||
        typeof payload.fingerprint !== "string"
      ) {
        throw new Error("This is not a supported GRUS identity QR.");
      }

      if (
        payload.username !== person?.username ||
        !fingerprints?.peer
      ) {
        throw new Error("QR username does not match this contact.");
      }

      const scannedFingerprint = payload.fingerprint
        .replace(/\s/g, "")
        .toUpperCase();

      const expectedFingerprint = fingerprints.peer
        .replace(/\s/g, "")
        .toUpperCase();

      if (
        !/^[A-F0-9]{64}$/.test(scannedFingerprint) ||
        scannedFingerprint !== expectedFingerprint
      ) {
        throw new Error("QR fingerprint mismatch. Identity not verified.");
      }

      const storageKey = `grus_verified_${user.id}_${person.id}`;

      localStorage.setItem(storageKey, expectedFingerprint);

      setIdentityVerified(true);
      setPeerKeyChanged(false);
      setFingerprintConfirmation("");
      setError("");
      setQrStatus("✓ Contact QR verified. Fingerprints match.");

      console.log("GRUS QR IDENTITY VERIFICATION: PASSED");
    } finally {
      bitmap.close();
    }
  } catch (err) {
    setQrStatus(err.message || "QR verification failed.");
  } finally {
    setQrProcessing(false);
    event.target.value = "";
  }
}

useEffect(() => {
  if (!user?.id || !person?.id || !fingerprints?.peer) {
    return;
  }

  const storageKey = `grus_verified_${user.id}_${person.id}`;

  const savedFingerprint = localStorage.getItem(storageKey);

  const currentFingerprint = fingerprints.peer
    .replace(/\s/g, "")
    .toUpperCase();

  const isVerified = savedFingerprint === currentFingerprint;

  setIdentityVerified(isVerified);

  if (isVerified) {
    setPeerKeyChanged(false);
    setQrStatus("✓ Contact QR verified. Fingerprints match.");
  } else {
    setQrStatus("");
  }
}, [user?.id, person?.id, fingerprints?.peer]);
  
async function handleSend(event) {
  event.preventDefault();

  if (sendingLockRef.current) return;

  const text = content.trim();
  const image = selectedImage;
  const conversationKey = conversationKeyRef.current;

  if ((!text && !image) || sending) return;

  if (!encryptionReady || !conversationKey) {
    setError("Encrypted conversation is not ready.");
    return;
  }

  sendingLockRef.current = true;
  setSending(true);
  setError("");

  try {
    // Send encrypted text first, if provided.
    if (text) {
      const encryptedPayload = await encryptMessage(
        text,
        conversationKey,
        String(conversation.id)
      );

      const result = await apiRequest(
        `/api/messages/${conversation.id}`,
        {
          method: "POST",
          token,
          body: {
            encrypted_payload: encryptedPayload,
          },
        }
      );

      if (result.data) {
        setMessages((previous) =>
          mergeMessage(previous, {
            ...result.data,
            encryption_status: "encrypted",
            decrypted_content: text,
            decryption_failed: false,
          })
        );
      }

      setContent("");
    }

    // Send encrypted image as a separate message.
    if (image) {
      const encryptedImage = await encryptImage(
        image,
        conversationKey,
        String(conversation.id)
      );

      const formData = new FormData();

      formData.append(
        "image",
        new Blob([encryptedImage.ciphertext], {
          type: "application/octet-stream",
        }),
        "encrypted-image.bin"
      );

      formData.append("iv", encryptedImage.iv);
      formData.append("content_type", encryptedImage.originalType);
      formData.append(
        "original_size",
        String(encryptedImage.originalSize)
      );

      const result = await apiRequest(
        `/api/messages/${conversation.id}/attachments`,
        {
          method: "POST",
          token,
          body: formData,
        }
      );

      if (result.data) {
        setMessages((previous) =>
          mergeMessage(previous, {
            ...result.data,
            message_type: "image",
            encryption_status: "encrypted_attachment_received",
          })
        );
      }

      setSelectedImage(null);
    }

    requestAnimationFrame(() => {
      messageInputRef.current?.focus();
    });
  } catch (err) {
    setError(err.message || "Message could not be sent.");
  } finally {
    sendingLockRef.current = false;
    setSending(false);
  }
}

function insertEmoji(emoji) {
  setContent((previous) => previous + emoji);
  messageInputRef.current?.focus();
}

function handleImageSelection(file) {
  if (!file) return;

  if (!file.type.startsWith("image/")) {
    setError("Please select an image file.");
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    setError("Image must be smaller than 5 MB.");
  return;
}

  setError("");
  setSelectedImage(file);
}

  

function handleImageDrop(event) {
  event.preventDefault();
  setDragActive(false);

  const file = event.dataTransfer.files?.[0];

  handleImageSelection(file);
}

async function handleBulkDelete(deleteFor) {
  if (selectedMessageIds.size === 0) return;

  if (deletingMessageId) return;

  const confirmed = window.confirm(
    deleteFor === "everyone"
      ? `Delete ${selectedMessageIds.size} selected messages for everyone?`
      : `Delete ${selectedMessageIds.size} selected messages for you?`
  );

  if (!confirmed) return;

  setDeletingMessageId("bulk");
  setError("");

  const ids = Array.from(selectedMessageIds);

  try {
    await apiRequest(
      `/api/messages/${conversation.id}/bulk`,
      {
        method: "DELETE",
        token,
        body: {
          delete_for: deleteFor,
          select_all: false,
          message_ids: ids,
        },
      }
    );

    if (deleteFor === "me") {
      setMessages((previous) =>
        previous.filter(
          (message) => !ids.includes(String(message.id))
        )
      );
    } else {
      setMessages((previous) =>
        previous.map((message) =>
          ids.includes(String(message.id))
            ? {
                ...message,
                deleted_for_everyone: true,
                deleted_by: String(user.id),
                decrypted_content: undefined,
                encrypted_payload: undefined,
                content: undefined,
                attachment: undefined,
                decryption_failed: false,
              }
            : message
        )
      );
    }

    setSelectedMessageIds(new Set());
    setSelectionMode(false);
    setShowBulkDeleteConfirm(false);
  } catch (err) {
    setError(err.message || "Bulk deletion failed.");
  } finally {
    setDeletingMessageId(null);
  }
}
 
async function handleClearConversation() {
  if (deletingMessageId) return;

  setDeletingMessageId("clear");
  setError("");

  try {
    await apiRequest(
      `/api/messages/${conversation.id}/clear`,
      {
        method: "DELETE",
        token,
      }
    );

    setMessages([]);
    setSelectedMessageIds(new Set());
    setSelectionMode(false);
    setShowClearConfirm(false);
    setShowConversationMenu(false);
  } catch (err) {
    setError(err.message || "Unable to clear conversation.");
  } finally {
    setDeletingMessageId(null);
  }
}

async function handleDeleteMessage(message, deleteFor) {
  if (deletingMessageId) return;

  const actionText =
    deleteFor === "everyone"
      ? "Delete this message for everyone"
      : "Delete this message only for you";

  if (!window.confirm(`Are you sure you want to ${actionText}?`)) {
    return;
  }

  setDeletingMessageId(String(message.id));
  setError("");

  try {
    await apiRequest(
      `/api/messages/${conversation.id}/${message.id}`,
      {
        method: "DELETE",
        token,
        body: {
          delete_for: deleteFor,
        },
      }
    );

    if (deleteFor === "everyone") {
  setMessages((previous) =>
    previous.map((item) =>
      String(item.id) === String(message.id)
        ? {
            ...item,
            deleted_for_everyone: true,
            deleted_by: String(user.id),
            decrypted_content: undefined,
            encrypted_payload: undefined,
            content: undefined,
            decryption_failed: false,
          }
        : item
    )
  );
} else {
  setMessages((previous) =>
    previous.filter(
      (item) => String(item.id) !== String(message.id)
    )
  );
}

    setMessageMenuId(null);
  } catch (err) {
    setError(err.message || "Unable to delete message.");
  } finally {
    setDeletingMessageId(null);
  }
}


  function renderMessage(message, index) {
    const own =
      String(message.sender_id) === String(user.id);

    const status =
      message.encryption_status || message.status || "";

    const isPlaintext =
      status === "legacy_plaintext" ||
      status === "development_plaintext";

    const isDeleted = message.deleted_for_everyone === true;

const displayText = isDeleted
  ? String(message.deleted_by) === String(user.id)
    ? "You deleted this message"
    : `This message was deleted by ${person?.username || "the sender"}`
  : message.decrypted_content ??
    (isPlaintext
      ? message.content
      : "[Message could not be decrypted]");

    return (
  <div
    key={message.id || index}
    style={{
      display: "flex",
      justifyContent: own ? "flex-end" : "flex-start",
      alignItems: "center",
      gap: "8px",
    }}
  >
    {selectionMode && (
  <input
    type="checkbox"
    aria-label="Select message"
    checked={selectedMessageIds.has(String(message.id))}
    onChange={(event) => {
      const messageId = String(message.id);

      setSelectedMessageIds((previous) => {
        const next = new Set(previous);

        if (event.target.checked) {
          next.add(messageId);
        } else {
          next.delete(messageId);
        }

        return next;
      });
    }}
    style={{
      width: "17px",
      height: "17px",
      cursor: "pointer",
      accentColor: "#8069ff",
      flexShrink: 0,
    }}
  />
)}

<div
  style={{
    ...styles.bubble,
    minWidth: 0,
    maxWidth: "75%",
    boxSizing: "border-box",
    overflow: "hidden",
    background: own ? "#5542b8" : "#252438",
    borderBottomRightRadius: own ? "4px" : "14px",
    borderBottomLeftRadius: own ? "14px" : "4px",
  }}
>
          <div
  style={{
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: "12px",
  }}
>
  <div style={{ flex: 1, overflowWrap: "anywhere" }}>
  {message.attachment && !isDeleted ? (
    <EncryptedImage
      attachment={message.attachment}
      conversationId={conversation.id}
      conversationKey={conversationKeyRef.current}
      token={token}
    />
  ) : (
    displayText
  )}
</div>
</div>

{messageMenuId === String(message.id) && (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      gap: "7px",
      marginTop: "9px",
      padding: "9px",
      background: "#171625",
      borderRadius: "8px",
    }}
  >
    <button
  type="button"
  onClick={() => {
    setSelectionMode(true);
    setSelectedMessageIds(new Set([String(message.id)]));
    setMessageMenuId(null);
  }}
  style={styles.copyFingerprintButton}
>
  Select
</button>
    <button
      type="button"
      disabled={Boolean(deletingMessageId)}
      onClick={() => handleDeleteMessage(message, "me")}
      style={styles.copyFingerprintButton}
    >
      Delete for me
    </button>

    {own && (
      <button
        type="button"
        disabled={Boolean(deletingMessageId)}
        onClick={() => handleDeleteMessage(message, "everyone")}
        style={{
          ...styles.copyFingerprintButton,
          background: "#a33d55",
        }}
      >
        Delete for everyone
      </button>
    )}
  </div>
)}

<div
  style={{
    display: "flex",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: "5px",
    marginTop: "5px",
  }}
>
  <span style={styles.messageTime}>
    {formatMessageTime(message.created_at)}
  </span>

  {!isDeleted && (
    <span
      title={
        message.delivery_status === "read"
          ? "Read"
        : message.delivery_status === "delivered"
          ? "Delivered"
          : "Sent"
    }
    style={{
      color:
        message.delivery_status === "read"
          ? "#38a9ff"
          : message.delivery_status === "delivered"
            ? "#c7c2df"
            : "#c7c2df",
      fontSize: "13px",
      fontWeight: "bold",
    }}
  >
    {message.delivery_status === "sent"
      ? "✓"
      : "✓✓"}
  </span>
)}

</div>

          {!isDeleted && (
  <div style={styles.messageStatus}>
    {isPlaintext
      ? status === "development_plaintext"
        ? "Development plaintext — NOT E2EE"
        : "Legacy plaintext — NOT E2EE"
      : message.decryption_failed
        ? "Decryption failed"
        : identityVerified
          ? "Encrypted · contact identity verified"
          : "Encrypted · recipient identity not independently verified"}
  </div>
)}
        </div>
      </div>
    );
  }

  return (
    <section className="grus-chat-page" style={styles.page}>
      <header style={styles.header}>
  <button style={styles.backButton} onClick={onBack}>
    ←
  </button>

  <button
  type="button"
  onClick={() => {
    if (peerAvatarUrl) setShowProfileImage(true);
  }}
  title={peerAvatarUrl ? "View profile picture" : "Profile picture unavailable"}
  style={{
    ...styles.avatar,
    padding: 0,
    border: "2px solid #6855d6",
    overflow: "hidden",
    cursor: peerAvatarUrl ? "pointer" : "default",
  }}
>
  {peerAvatarUrl ? (
    <img
      src={peerAvatarUrl}
      alt={`${person?.username || "Contact"} profile`}
      style={{
        width: "100%",
        height: "100%",
        objectFit: "cover",
        borderRadius: "50%",
      }}
    />
  ) : (
    (person?.username || "?").charAt(0).toUpperCase()
  )}
</button>

  <div>
    <div style={{ color: "#fff", fontWeight: 600 }}>
      {person?.username || "Conversation"}
    </div>

    <button
  type="button"
  onClick={() => setShowFingerprints((previous) => !previous)}
  style={styles.fingerprintButton}
  disabled={!fingerprints}
>
  {showFingerprints
    ? "Hide Identity"
    : identityVerified
      ? "View Identity"
      : "Verify Identity"}
</button>
    <div
      style={{
        color: presence?.is_online ? "#65d6a0" : "#aaa6bd",
        fontSize: "12px",
        marginTop: "4px",
      }}
    >
      {presence?.is_online === true
        ? "● Online"
        : presence?.last_seen
          ? `Last seen ${new Intl.DateTimeFormat("en-IN", {
              timeZone: "Asia/Kolkata",
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            }).format(new Date(presence.last_seen))}`
          : "● Offline"}
    </div>
        </div>

  <div style={{ position: "relative", marginLeft: "auto" }}>
    <button
      type="button"
      title="Conversation options"
      onClick={() => {
        setShowConversationMenu((previous) => !previous);
        setShowSelectionMenu(false);
      }}
      style={{
        background: "transparent",
        border: "none",
        color: "#c7beff",
        fontSize: "26px",
        cursor: "pointer",
        padding: "8px 12px",
      }}
    >
      ⋮
    </button>

    {showConversationMenu && (
      <div
        style={{
          position: "absolute",
          top: "42px",
          right: 0,
          zIndex: 100,
          minWidth: "190px",
          padding: "8px",
          background: "#252438",
          border: "1px solid rgba(255,255,255,0.12)",
          borderRadius: "10px",
          boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
          display: "flex",
          flexDirection: "column",
          gap: "6px",
        }}
      >
        {!selectionMode ? (
          <>
            <button
              type="button"
              style={styles.copyFingerprintButton}
              onClick={() => {
                setSelectionMode(true);
                setSelectedMessageIds(new Set());
                setShowConversationMenu(false);
              }}
            >
              Select messages
            </button>

            <button
              type="button"
              style={styles.copyFingerprintButton}
              onClick={() => {
                setShowClearConfirm(true);
                setShowConversationMenu(false);
              }}
            >
              Clear Conversation
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              style={styles.copyFingerprintButton}
              onClick={() => {
                setSelectedMessageIds(
                  new Set(messages.map((message) => String(message.id)))
                );
                setShowConversationMenu(false);
              }}
            >
              Select All
            </button>

            <button
  type="button"
  disabled={selectedMessageIds.size === 0}
  onClick={() => {
    setShowBulkDeleteConfirm(true);
    setShowConversationMenu(false);
  }}
  style={{
    ...styles.copyFingerprintButton,
    background: "#a33d55",
    opacity: selectedMessageIds.size === 0 ? 0.5 : 1,
  }}
>
  Delete ({selectedMessageIds.size})
</button>

            <button
              type="button"
              style={styles.copyFingerprintButton}
              onClick={() => {
                setSelectionMode(false);
                setSelectedMessageIds(new Set());
                setShowConversationMenu(false);
              }}
            >
              Cancel Selection
            </button>
          </>
        )}
      </div>
    )}
  </div>
</header>

   {showProfileImage && peerAvatarUrl && (
  <div
    onClick={() => setShowProfileImage(false)}
    style={{
      position: "fixed",
      inset: 0,
      zIndex: 9999,
      background: "rgba(0,0,0,0.85)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "20px",
    }}
  >
    <div
      onClick={(event) => event.stopPropagation()}
      style={{
        position: "relative",
        maxWidth: "90vw",
        maxHeight: "85vh",
      }}
    >
      <button
        type="button"
        onClick={() => setShowProfileImage(false)}
        style={{
          position: "absolute",
          top: "-14px",
          right: "-14px",
          width: "36px",
          height: "36px",
          borderRadius: "50%",
          border: "none",
          background: "#6855d6",
          color: "#fff",
          fontSize: "22px",
          cursor: "pointer",
        }}
      >
        ×
      </button>

      <img
        src={peerAvatarUrl}
        alt={`${person?.username || "Contact"} profile picture`}
        style={{
          display: "block",
          maxWidth: "85vw",
          maxHeight: "80vh",
          objectFit: "contain",
          borderRadius: "12px",
        }}
      />

      <p style={{ color: "#fff", textAlign: "center" }}>
        {person?.username}
      </p>
    </div>
  </div>
)}


      {peerKeyChanged && (
  <div
    style={{
      padding: "14px",
      background: "#492b20",
      color: "#ffbd8a",
      borderBottom: "1px solid #a45b36",
      fontSize: "13px",
      lineHeight: 1.6,
    }}
  >
    <strong>⚠ Encryption Identity Changed</strong>

    <div>
      The public key for {person?.username} has changed.
      Previous identity verification is no longer valid.
      Verify the new fingerprint through a trusted
      independent channel before trusting this contact.
    </div>
  </div>
)}

    {showFingerprints && fingerprints && (
  <div
    style={{
      ...styles.fingerprintPanel,
      maxHeight: "55vh",
      overflowY: "auto",
      overflowX: "hidden",
      WebkitOverflowScrolling: "touch",
    }}
  >

    {/* How GRUS Protects Your Conversations */}
<details
  style={{
    ...styles.fingerprintCard,
    marginTop: "12px",
    cursor: "pointer",
  }}
>
  <summary
    style={{
      color: "#ffffff",
      fontWeight: "600",
      fontSize: "14px",
      cursor: "pointer",
    }}
  >
    🔒 How GRUS Protects Your Conversations
  </summary>

  <p style={{ color: "#aaa6bd", fontSize: "12px", lineHeight: 1.6 }}>
    Your privacy. Your keys. Your conversations.
  </p>

  <div style={{ display: "grid", gap: "12px" }}>
    <div>
      <strong>🔐 AES-256-GCM</strong>
      <p style={{ color: "#aaa6bd", fontSize: "12px" }}>
        Encrypts message content and image attachments before transmission.
      </p>
    </div>

    <div>
      <strong>🔑 ECDH P-256</strong>
      <p style={{ color: "#aaa6bd", fontSize: "12px" }}>
        Establishes shared cryptographic keys between users.
      </p>
    </div>

    <div>
      <strong>🛡️ HKDF-SHA-256</strong>
      <p style={{ color: "#aaa6bd", fontSize: "12px" }}>
        Derives encryption keys from shared secret material.
      </p>
    </div>

    <div>
      <strong>🆔 Identity Fingerprints</strong>
      <p style={{ color: "#aaa6bd", fontSize: "12px" }}>
        Help compare and identify contact public-key identities.
      </p>
    </div>

    <div>
      <strong>📱 QR Identity Verification</strong>
      <p style={{ color: "#aaa6bd", fontSize: "12px" }}>
        Allows you to verify a contact by comparing identity fingerprints.
      </p>
    </div>

    <div>
      <strong>⚠️ Identity Change Detection</strong>
      <p style={{ color: "#aaa6bd", fontSize: "12px" }}>
        Alerts you when a contact's public key changes.
      </p>
    </div>
  </div>
</details>

    
    <h3 style={{ margin: "0 0 14px", color: "#fff" }}>
      <strong>GRUS Encryption 🔒</strong>
    </h3>
    <h3 style={{ margin: "0 0 12px", color: "#fff" }}>
      <strong>GRUS Identity Fingerprints</strong>
    </h3>

    {/* Your identity */}
    <div style={styles.fingerprintCard}>
      <strong>Your Identity</strong>

      <code style={styles.fingerprintValue}>
        {fingerprints.own}
      </code>

      <button
        type="button"
        style={styles.copyFingerprintButton}
        onClick={() => {
          navigator.clipboard.writeText(fingerprints.own);
        }}
      >
        Copy Your Fingerprint
      </button>
    </div>

    {/* Contact identity */}
    <div style={styles.fingerprintCard}>
      <strong>{person?.username || "Contact"}'s Identity</strong>

      <code style={styles.fingerprintValue}>
        {fingerprints.peer}
      </code>

      <button
        type="button"
        style={styles.copyFingerprintButton}
        onClick={() => {
          navigator.clipboard.writeText(fingerprints.peer);
        }}
      >
        Copy Contact Fingerprint
      </button>
    </div>

    {/* Fingerprint warning */}
    <div style={styles.fingerprintWarning}>
      {identityVerified
        ? "✓ Contact fingerprint matches the locally trusted identity."
        : "Not independently verified. Compare fingerprints through a trusted external channel."}
    </div>

    {/* Contact verification */}
    <div style={styles.fingerprintCard}>
      <strong>Contact Verification</strong>

      {identityVerified ? (
        <div style={{ color: "#65d6a0" }}>
          ✓ Identity independently verified
        </div>
      ) : (
        <>
          <input
            value={fingerprintConfirmation}
            onChange={(event) =>
              setFingerprintConfirmation(event.target.value)
            }
            placeholder="Enter the contact's fingerprint"
            style={styles.input}
          />

          <button
            type="button"
            style={styles.copyFingerprintButton}
            onClick={verifyContactIdentity}
          >
            Confirm Fingerprint
          </button>
        </>
      )}
    </div>

{/* QR Identity Verification */}
<div style={styles.fingerprintCard}>
  <strong>QR Identity Verification</strong>

  <p style={{ color: "#aaa6bd", fontSize: "12px", lineHeight: 1.6 }}>
    Download your identity QR or upload your contact's QR image
    to compare identity fingerprints.
  </p>

  <button
    type="button"
    style={styles.copyFingerprintButton}
    onClick={downloadMyIdentityQR}
    disabled={!fingerprints?.own}
  >
    Download My Identity QR
  </button>

  <input
    ref={qrFileInputRef}
    type="file"
    accept="image/*"
    onChange={verifyContactQR}
    style={{ display: "none" }}
  />

  {qrStatus.startsWith("✓ Contact QR verified") ? (
    <div
      style={{
        color: "#65d6a0",
        fontSize: "13px",
        fontWeight: "600",
        marginTop: "10px",
      }}
    >
      ✓ Contact QR verified
    </div>
  ) : (
    <button
      type="button"
      style={styles.copyFingerprintButton}
      onClick={() => qrFileInputRef.current?.click()}
      disabled={!fingerprints?.peer || qrProcessing}
    >
      {qrProcessing ? "Checking QR..." : "Upload Contact QR"}
    </button>
  )}

  {qrStatus && (
    <div
      style={{
        color: qrStatus.startsWith("✓") ? "#65d6a0" : "#ffc66d",
        fontSize: "12px",
        lineHeight: 1.6,
        overflowWrap: "anywhere",
        marginTop: "8px",
      }}
    >
      {qrStatus}
    </div>
  )}

  <div
    style={{
      color: qrStatus.startsWith("✓ Contact QR verified")
        ? "#65d6a0"
        : "#ffc66d",
      fontSize: "12px",
      marginTop: "10px",
    }}
  >
    {qrStatus.startsWith("✓ Contact QR verified")
      ? "✓ Identity independently verified"
      : "Not independently verified"}
  </div>
</div>

  </div>
)}

     
 

      <div style={styles.notice}>
        
        {encryptionReady
          ? "End-to-end encryption keeps your conversations private and secure"
          : "Establishing a secure connection. Please wait."}
      </div>

      <div
  className="grus-chat-messages"
  style={{
    ...styles.messageArea,
    position: "relative",
    border: dragActive
      ? "2px dashed #8069ff"
      : "2px solid transparent",
  }}
  onDragOver={(event) => {
    event.preventDefault();
    setDragActive(true);
  }}
  onDragLeave={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setDragActive(false);
    }
  }}
  onDrop={handleImageDrop}
>
  {dragActive && (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 5,
        background: "rgba(104,85,214,0.18)",
        display: "grid",
        placeItems: "center",
        color: "#fff",
        fontWeight: "bold",
        pointerEvents: "none",
      }}
    >
      Drop your image here
    </div>
  )}
        {loading && (
          <p style={styles.info}>
            Establishing a secure connection...
          </p>
        )}

        {!loading && messages.length === 0 && (
          <div style={styles.empty}>
            <h2 style={{ color: "#fff" }}>No messages yet</h2>
            <p>Your conversation history will appear here.</p>
          </div>
        )}

      {selectionMode && (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "12px",
      gap: "10px",
      background: "#252438",
      borderRadius: "10px",
      margin: "10px",
    }}
  >
    <strong>{selectedMessageIds.size} selected</strong>

    <button
      type="button"
      onClick={() => {
        setSelectedMessageIds(
          new Set(messages.map((message) => String(message.id)))
        );
      }}
    >
      Select All
    </button>

    <button
      type="button"
      onClick={() => {
        setSelectionMode(false);
        setSelectedMessageIds(new Set());
      }}
    >
      Cancel
    </button>
  </div>
)}

        {messages.map((message, index) => {

  const currentDate = getISTDateKey(message.created_at);

  const previousDate =
    index > 0
      ? getISTDateKey(messages[index - 1].created_at)
      : null;

  const showDateSeparator =
    index === 0 || currentDate !== previousDate;

  return (
    <div key={message.id || index}>
      {showDateSeparator && (
        <div style={styles.dateSeparator}>
          <span>
            {getDateSeparatorLabel(message.created_at)}
          </span>
        </div>
      )}

      {renderMessage(message, index)}
    </div>
  );
})}

        <div ref={bottomRef} />
      </div>

      {showEmojiPicker && (
  <div
    style={{
      display: "grid",
      gridTemplateColumns: "repeat(6, 1fr)",
      gap: "8px",
      padding: "12px",
      background: "#252438",
      borderTop: "1px solid rgba(255,255,255,0.1)",
    }}
  >
    {GRUS_EMOJIS.map((emoji) => (
      <button
        key={emoji}
        type="button"
        onClick={() => insertEmoji(emoji)}
        style={{
          border: "none",
          background: "transparent",
          fontSize: "24px",
          cursor: "pointer",
          padding: "5px",
        }}
      >
        {emoji}
      </button>
    ))}
  </div>
)}

      {error && (
        <p style={styles.error}>
          {error}
        </p>
      )}

      {showClearConfirm && (
  <div
    role="presentation"
    onClick={() => {
      if (!deletingMessageId) setShowClearConfirm(false);
    }}
    style={{
      position: "fixed",
      inset: 0,
      zIndex: 1100,
      background: "rgba(0,0,0,0.78)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "16px",
    }}
  >
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="clear-conversation-title"
      onClick={(event) => event.stopPropagation()}
      style={{
        width: "100%",
        maxWidth: "380px",
        boxSizing: "border-box",
        padding: "24px",
        background: "#252438",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: "16px",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
      }}
    >
      <h3 id="clear-conversation-title" style={{ margin: 0 }}>
        Clear Conversation?
      </h3>

      <p style={{ color: "#c7beff", lineHeight: 1.6, margin: 0 }}>
        This will remove your conversation history from your account.
        The other person's conversation will remain unchanged.
      </p>

      <button
        type="button"
        disabled={Boolean(deletingMessageId)}
        onClick={handleClearConversation}
        style={{
          ...styles.copyFingerprintButton,
          background: "#a33d55",
          opacity: deletingMessageId ? 0.6 : 1,
        }}
      >
        {deletingMessageId === "clear"
          ? "Clearing..."
          : "Clear Conversation"}
      </button>

      <button
        type="button"
        disabled={Boolean(deletingMessageId)}
        onClick={() => setShowClearConfirm(false)}
        style={styles.copyFingerprintButton}
      >
        Cancel
      </button>
    </div>
  </div>
)}

      {showBulkDeleteConfirm && (
  <div
    style={{
      position: "absolute",
      inset: 0,
      zIndex: 1000,
      background: "rgba(0,0,0,0.75)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "20px",
    }}
  >
    <div
      style={{
        width: "100%",
        maxWidth: "340px",
        padding: "22px",
        background: "#252438",
        borderRadius: "14px",
        color: "#fff",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
      }}
    >
      <h3>Delete selected messages</h3>

      <p>
        {selectedMessageIds.size} messages selected.
        Choose how you want to delete them.
      </p>

      <button
        type="button"
        disabled={Boolean(deletingMessageId)}
        onClick={() => handleBulkDelete("me")}
        style={styles.copyFingerprintButton}
      >
        Delete for me
      </button>

      {canDeleteSelectedForEveryone && (
  <button
    type="button"
    disabled={Boolean(deletingMessageId)}
    onClick={() => handleBulkDelete("everyone")}
    style={{
      ...styles.copyFingerprintButton,
      background: "#a33d55",
    }}
  >
    Delete for everyone
  </button>
)}

      <button
        type="button"
        disabled={Boolean(deletingMessageId)}
        onClick={() => setShowBulkDeleteConfirm(false)}
        style={styles.copyFingerprintButton}
      >
        Cancel
      </button>
    </div>
  </div>
)}

      <form
  className="grus-chat-composer"
  style={{
    ...styles.composer,
    flexWrap: "wrap",
    border: dragActive
      ? "2px dashed #8069ff"
      : "2px solid transparent",
    background: dragActive
      ? "rgba(104, 85, 214, 0.12)"
      : "transparent",
    borderRadius: "12px",
    transition: "border 0.15s ease",
  }}
  onSubmit={handleSend}
  onDragOver={(event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  }}
  onDragLeave={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setDragActive(false);
    }
  }}
  onDrop={handleImageDrop}
>

        <input
  ref={imageInputRef}
  type="file"
  accept="image/*"
  hidden
  onChange={(event) => {
    handleImageSelection(event.target.files?.[0]);
    event.target.value = "";
  }}
/>

<button
  type="button"
  title="Attach image"
  onClick={() => imageInputRef.current?.click()}
  style={styles.attachmentButton}
>
  📥
</button>

<button
  type="button"
  title="Choose emoji"
  onClick={() => setShowEmojiPicker((previous) => !previous)}
  style={styles.attachmentButton}
>
  😊
</button>

{selectedImage && (
  <div
    className="grus-chat-image-preview"
    style={{
      padding: "12px",
      background: "#252438",
      color: "#fff",
      display: "flex",
      alignItems: "center",
      gap: "12px",
      borderTop: "1px solid #45425e",
    }}
  >
    {selectedImagePreview && (
      <img
        src={selectedImagePreview}
        alt="Selected image preview"
        style={{
          width: "100px",
          height: "85px",
          objectFit: "cover",
          borderRadius: "10px",
          flexShrink: 0,
        }}
      />
    )}

    <div style={{ flex: 1, minWidth: 0 }}>
      <div
        style={{
          fontSize: "13px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {selectedImage.name}
      </div>

      <div style={{ color: "#65d6a0", fontSize: "11px", marginTop: "6px" }}>
        🔒 Ready to encrypt and send
      </div>

      <div style={{ color: "#aaa6bd", fontSize: "11px", marginTop: "4px" }}>
        {(selectedImage.size / (1024 * 1024)).toFixed(2)} MB
      </div>
    </div>

    <button
      type="button"
      onClick={() => setSelectedImage(null)}
      style={{
        border: "none",
        background: "#403044",
        color: "#ff8585",
        padding: "8px",
        borderRadius: "8px",
        cursor: "pointer",
      }}
    >
      ✕ Remove
    </button>
  </div>
)}

  <input
    ref={messageInputRef}
    style={styles.input}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={
            encryptionReady
              ? "Type an encrypted message..."
              : "Establishing a secure connection..."
          }
          maxLength={5000}
          disabled={sending || !encryptionReady}
        />

        <button
  style={{
    ...styles.button,
    opacity:
      sending ||
      (!content.trim() && !selectedImage) ||
      !encryptionReady
        ? 0.6
        : 1,
  }}
  type="submit"
  disabled={
    sending ||
    (!content.trim() && !selectedImage) ||
    !encryptionReady
  }
>
  {sending ? "Sending..." : "Send"}
</button>
      </form>
    </section>
  );
}



const styles = {
  page: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    minHeight: 0,
    boxSizing: "border-box",
    background: "#10101b",
    border: "1px solid rgba(255,255,255,0.09)",
    borderRadius: "16px",
    overflow: "hidden",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "14px",
    padding: "16px 20px",
    borderBottom: "1px solid rgba(255,255,255,0.09)",
  },
  backButton: {
    border: 0,
    background: "transparent",
    color: "#fff",
    fontSize: "22px",
    cursor: "pointer",
  },
  avatar: {
    width: "42px",
    height: "42px",
    borderRadius: "50%",
    background: "#6855d6",
    display: "grid",
    placeItems: "center",
    color: "#fff",
    fontWeight: "bold",
    fontSize: "18px",
  },
  notice: {
    padding: "8px 12px",
    background: "#252438",
    color: "#c7beff",
    textAlign: "center",
    fontSize: "11px",
  },
  messageArea: {
    flex: 1,
    overflowY: "auto",
    padding: "20px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  bubble: {
    maxWidth: "75%",
    padding: "11px 15px",
    borderRadius: "14px",
    color: "#f4f2ff",
    lineHeight: 1.5,
    overflowWrap: "anywhere",
  },
  messageStatus: {
    fontSize: "10px",
    marginTop: "6px",
    opacity: 0.7,
  },
  empty: {
    margin: "auto",
    textAlign: "center",
    color: "#aaa6bd",
  },
  info: {
    color: "#aaa6bd",
    textAlign: "center",
  },
  error: {
    color: "#ff8585",
    fontSize: "12px",
    padding: "0 15px",
  },
  composer: {
    display: "flex",
    gap: "10px",
    padding: "15px",
    borderTop: "1px solid rgba(255,255,255,0.09)",
  },
  input: {
    flex: 1,
    minWidth: 0,
    padding: "13px",
    borderRadius: "10px",
    border: "1px solid rgba(255,255,255,0.12)",
    background: "#1b1a29",
    color: "#fff",
    outline: "none",
  },
  button: {
    padding: "10px 16px",
    border: 0,
    borderRadius: "9px",
    background: "#6855d6",
    color: "#fff",
    cursor: "pointer",
  },

  messageTime: {
  fontSize: "10px",
  color: "#c7c2df",
  textAlign: "right",
  marginTop: "5px",
  opacity: 0.8,
},

dateSeparator: {
  display: "flex",
  justifyContent: "center",
  margin: "14px 0",
  color: "#aaa6bd",
  fontSize: "11px",
},

fingerprintButton: {
  marginLeft: "auto",
  padding: "9px 13px",
  border: "1px solid rgba(104,85,214,0.6)",
  borderRadius: "8px",
  background: "#252438",
  color: "#c7beff",
  cursor: "pointer",
  fontSize: "12px",
},

fingerprintPanel: {
  padding: "16px",
  background: "#191827",
  borderBottom: "1px solid rgba(255,255,255,0.1)",
},

fingerprintCard: {
  display: "flex",
  flexDirection: "column",
  gap: "10px",
  padding: "13px",
  marginBottom: "12px",
  background: "#252438",
  borderRadius: "10px",
  color: "#fff",
},

fingerprintValue: {
  color: "#b9adff",
  fontSize: "12px",
  lineHeight: 1.8,
  overflowWrap: "anywhere",
},

copyFingerprintButton: {
  padding: "8px",
  border: "none",
  borderRadius: "6px",
  background: "#6855d6",
  color: "#fff",
  cursor: "pointer",
},

fingerprintWarning: {
  color: "#ffc66d",
  fontSize: "11px",
  lineHeight: 1.6,
},
attachmentButton: {
  minWidth: "42px",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: "9px",
  background: "#252438",
  color: "#fff",
  cursor: "pointer",
  fontSize: "19px",
  display: "grid",
  placeItems: "center",
},

};


