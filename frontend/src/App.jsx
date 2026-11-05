
import { useEffect, useRef, useState } from "react";
import { connectSocket } from "./services/socket";
import "./App.css";
import Auth from "./Auth";
import Landing from "./Landing";
import Dashboard from "./Dashboard";
import { apiRequest, API_URL } from "./services/api";
import ChatWindow from "./ChatWindow";
import PasswordRecovery from "./PasswordRecovery";
import RecoverySetup from "./RecoverySetup";
import IdentityRestore from "./IdentityRestore";
import { changeRecoveryPasswordBackup } from "./services/crypto";



async function getLocalIdentity(userId) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("grus_identity", 2);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("identities")) {
        db.createObjectStore("identities", {
          keyPath: "userId",
        });
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("identities")) {
        db.close();
        reject(new Error("GRUS identity storage is unavailable."));
        return;
      }

      const transaction = db.transaction("identities", "readonly");
      const store = transaction.objectStore("identities");
      const result = store.get(String(userId));

      result.onsuccess = () => {
        const identity = result.result || null;
        db.close();
        resolve(identity);
      };

      result.onerror = () => {
        const error = result.error;
        db.close();
        reject(error);
      };
    };

    request.onerror = () => reject(request.error);
  });
}

async function exportPublicKeyBase64(publicKey) {
  const exported = await crypto.subtle.exportKey("spki", publicKey);
  const bytes = new Uint8Array(exported);

  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function Chat({ token, user, conversation, onBack }) {
  const [socket, setSocket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("Connecting...");
  const [error, setError] = useState("");
  const bottomRef = useRef(null);
  

  useEffect(() => {
    let active = true;
    const connection = connectSocket(token);
    setSocket(connection);

    async function loadMessages() {
      try {
        const response = await fetch(
          `${API_URL}/api/messages/${conversation.id}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Unable to load messages");
        }

        if (active) setMessages(data.messages || []);
      } catch (err) {
        if (active) setError(err.message);
      }
    }

    connection.on("connect", async () => {
      if (!active) return;
      setStatus("Connected");
      await loadMessages();

      if (active) {
        connection.emit("join_conversation", {
          conversation_id: conversation.id,
        });
      }
    });

    connection.on("joined_conversation", () => {
      if (active) setStatus("Connected to conversation");
    });

    connection.on("new_message", (message) => {
      if (!active || message.conversation_id !== conversation.id) return;

      setMessages((previous) => {
        if (previous.some((item) => item.id === message.id)) return previous;
        return [...previous, message];
      });
    });

    connection.on("error_message", (data) => {
      if (active) setError(data.error);
    });

    connection.on("connect_error", (err) => {
      if (active) setStatus("Connection error: " + err.message);
    });

    connection.on("disconnect", () => {
      if (active) setStatus("Disconnected");
    });

    return () => {
      active = false;
      connection.disconnect();
    };
  }, [token, conversation.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function sendMessage(event) {
    event.preventDefault();
    const text = content.trim();

    if (!text || !socket?.connected) return;

    socket.emit("send_message", {
      conversation_id: conversation.id,
      content: text,
    });

    setContent("");
  }

  return (
    <main className="chat-page">
      <section className="chat-card">
        <header className="chat-header">
          <div>
            <h1>GRUS</h1>
            <p>Chat with {conversation.username}</p>
            <small>{status}</small>
          </div>
          <button onClick={onBack}>Back</button>
        </header>

        {error && <p className="auth-message">{error}</p>}

        <div className="chat-window">
          {messages.map((message, index) => {
            const own = String(message.sender_id) === String(user.id);

            return (
              <div
                key={message.id || index}
                className={`message ${own ? "own" : "received"}`}
              >
                {message.content}
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        <form className="message-form" onSubmit={sendMessage}>
          <input
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Write a message..."
            maxLength={5000}
          />
          <button type="submit" disabled={!socket?.connected}>
            Send
          </button>
        </form>
      </section>
    </main>
  );
}

function Conversations({ token, user, onLogout }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeConversation, setActiveConversation] = useState(null);

  async function searchUsers(event) {
    event.preventDefault();
    setError("");
    setResults([]);

    if (query.trim().length < 3) {
      setError("Enter at least 3 characters.");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch(
        `${API_URL}/api/users/search?q=${encodeURIComponent(query.trim())}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "User search failed");
      }

      setResults(data.users || []);

      if (!data.users?.length) {
        setError("No matching users found.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function startConversation(recipient) {
    setError("");
    setLoading(true);

    try {
      const response = await fetch(`${API_URL}/api/conversations/`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ recipient_id: recipient.id }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Could not create conversation");
      }

      setActiveConversation({
        id: data.conversation.id,
        username: recipient.username,
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (activeConversation) {
    return (
      <Chat
        token={token}
        user={user}
        conversation={activeConversation}
        onBack={() => setActiveConversation(null)}
      />
    );
  }

  

  return (
    <main className="auth-page">
      <section className="auth-card">
        <header className="chat-header">
          <div>
            <h1>GRUS</h1>
            <p>Private by design. Connected in real time.</p>
          </div>
          <button onClick={onLogout}>Sign out</button>
        </header>

        <h2>Welcome, {user.username}</h2>
        <p>Find people and start a private conversation.</p>

        <form onSubmit={searchUsers}>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search username..."
            minLength={3}
          />
          <button type="submit" disabled={loading}>
            {loading ? "Please wait..." : "Search users"}
          </button>
        </form>

        {error && <p className="auth-message">{error}</p>}

        <div className="user-results">
          {results.map((recipient) => (
            <div className="user-result" key={recipient.id}>
              <div>
                <strong>{recipient.username}</strong>
                <p>GRUS user</p>
              </div>
              <button
                onClick={() => startConversation(recipient)}
                disabled={loading}
              >
                Start chat
              </button>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
function GrusWorkspace({ user, token, onLogout, recoveryVerified }) {
  const [activeSection, setActiveSection] = useState(
  () => sessionStorage.getItem("grus_active_section") || "discover"
);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [incoming, setIncoming] = useState([]);
  const [outgoing, setOutgoing] = useState([]);
  const [connections, setConnections] = useState([]);
  const [blocked, setBlocked] = useState([]);
  const [presence, setPresence] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selectedConversation, setSelectedConversation] = useState(null);
  const [selectedPerson, setSelectedPerson] = useState(null);
  // Restore the last opened chat after browser refresh.
  const CHAT_SESSION_KEY = "grus_active_chat";
  const [showRecoveryPasswordForm, setShowRecoveryPasswordForm] = useState(false);
const [oldRecoveryPassword, setOldRecoveryPassword] = useState("");
const [newRecoveryPassword, setNewRecoveryPassword] = useState("");
const [confirmRecoveryPassword, setConfirmRecoveryPassword] = useState("");
const [recoveryPasswordBusy, setRecoveryPasswordBusy] = useState(false);
const [showOldRecoveryPassword, setShowOldRecoveryPassword] = useState(false);
const [showNewRecoveryPassword, setShowNewRecoveryPassword] = useState(false);
const [showConfirmRecoveryPassword, setShowConfirmRecoveryPassword] = useState(false);
// GRUS profile picture
const [profilePictureUrl, setProfilePictureUrl] = useState("");
const [showOwnProfilePicture, setShowOwnProfilePicture] = useState(false);
const [profilePictureVisibility, setProfilePictureVisibility] =
  useState("friends");
const [profilePictureStatus, setProfilePictureStatus] = useState("");
const [profilePictureBusy, setProfilePictureBusy] = useState(false);
const profilePictureInputRef = useRef(null);
  
  useEffect(() => {
  sessionStorage.setItem("grus_active_section", activeSection);
}, [activeSection]);

  async function refreshData() {
  try {
    const [requestData, connectionData, blockedData] =
      await Promise.all([
        apiRequest("/api/connections/requests", { token }),
        apiRequest("/api/connections/", { token }),
        apiRequest("/api/connections/blocked", { token }),
      ]);

    const loadedConnections = connectionData.connections || [];

    setIncoming(requestData.incoming || []);
    setOutgoing(requestData.outgoing || []);
    setConnections(loadedConnections);
    setBlocked(blockedData.blocked || []);

    return loadedConnections;
  } catch (err) {
    setError(err.message || "Could not load your GRUS data.");
    return [];
  }
}

  useEffect(() => {
  let cancelled = false;

  async function restoreLastChat() {
    const loadedConnections = await refreshData();

    if (cancelled) return;

    const savedSection = sessionStorage.getItem("grus_active_section");

    // Restore a conversation only if Chats was the last active page.
    if (savedSection !== "chats") return;

    const savedChat = sessionStorage.getItem(CHAT_SESSION_KEY);

    if (!savedChat) return;

    try {
      const saved = JSON.parse(savedChat);

      const connection = loadedConnections.find(
        (item) =>
          String(item.user?.id) === String(saved.personId)
      );

      if (!connection?.user) {
        sessionStorage.removeItem(CHAT_SESSION_KEY);
        return;
      }

      const person = connection.user;

      const data = await apiRequest("/api/conversations/", {
        method: "POST",
        token,
        body: { recipient_id: person.id },
      });

      if (cancelled) return;

      setSelectedConversation(data.conversation || null);
      setSelectedPerson(person);
      setActiveSection("chats");
    } catch (err) {
      if (!cancelled) {
        setError("Could not restore your previous chat: " + err.message);
      }
    }
  }

  restoreLastChat();

  return () => {
    cancelled = true;
  };
}, [token]);

  
async function loadProfilePicture() {
  try {
    const response = await fetch(
      `${API_URL}/api/users/profile-picture/${user.id}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (response.status === 404) {
      setProfilePictureUrl("");
      return;
    }

    if (!response.ok) {
      throw new Error("Could not load profile picture.");
    }

    const imageBlob = await response.blob();
    const imageUrl = URL.createObjectURL(imageBlob);

    setProfilePictureUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return imageUrl;
    });
  } catch (err) {
    console.error("GRUS profile picture:", err);
  }
}


async function handleProfilePictureUpload(event) {
  const file = event.target.files?.[0];

  if (!file) return;

  const MAX_PROFILE_PICTURE_SIZE = 5 * 1024 * 1024;

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp",
  ];

  // Validate image format
  if (!allowedTypes.includes(file.type)) {
    setProfilePictureStatus(
      "Invalid image format. Only JPEG, PNG and WebP are supported."
    );
    event.target.value = "";
    return;
  }

  // Validate image size before uploading
  if (file.size > MAX_PROFILE_PICTURE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);

    setProfilePictureStatus(
      `Image is ${sizeMB} MB. Maximum allowed size is 5 MB. Please choose a smaller image.`
    );

    event.target.value = "";
    return;
  }

  setProfilePictureStatus("");
  setProfilePictureBusy(true);

  try {
    const formData = new FormData();
    formData.append("image", file);

    const result = await apiRequest(
      "/api/users/profile-picture",
      {
        method: "POST",
        token,
        body: formData,
      }
    );

    await loadProfilePicture();

    setProfilePictureStatus(
      result.message || "Profile picture uploaded."
    );
  } catch (err) {
    setProfilePictureStatus(err.message);
  } finally {
    setProfilePictureBusy(false);
    event.target.value = "";
  }
}

useEffect(() => {
  loadProfilePicture();

  return () => {
    setProfilePictureUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return "";
    });
  };
}, [token, user.id]);

async function loadProfilePictureSettings() {
  try {
    const data = await apiRequest(
      "/api/users/profile-picture/settings",
      { token }
    );

    setProfilePictureVisibility(data.visibility || "friends");
  } catch (err) {
    console.error("Could not load profile settings:", err);
  }
}

async function handleProfilePictureVisibility(event) {
  const visibility = event.target.value;

  try {
    setProfilePictureVisibility(visibility);

    await apiRequest("/api/users/profile-picture/privacy", {
      method: "PATCH",
      token,
      body: { visibility },
    });

    setProfilePictureStatus("Profile picture privacy updated.");
  } catch (err) {
    setProfilePictureStatus(err.message);
    await loadProfilePictureSettings();
  }
}

async function handleRemoveProfilePicture() {
  if (!window.confirm("Remove your profile picture?")) return;

  setProfilePictureBusy(true);

  try {
    const data = await apiRequest("/api/users/profile-picture", {
      method: "DELETE",
      token,
    });

    setProfilePictureUrl("");
    setProfilePictureStatus(data.message || "Profile picture removed.");
  } catch (err) {
    setProfilePictureStatus(err.message);
  } finally {
    setProfilePictureBusy(false);
  }
}

useEffect(() => {
  loadProfilePicture();
  loadProfilePictureSettings();

  return () => {
    setProfilePictureUrl((previous) => {
      if (previous) URL.revokeObjectURL(previous);
      return "";
    });
  };
}, [token, user.id]);

// GRUS real-time presence and message delivery
useEffect(() => {
  const socket = connectSocket(token);

  async function acknowledgeDelivery(conversationId, messageId) {
    try {
      await apiRequest(
        `/api/messages/${conversationId}/${messageId}/delivered`,
        {
          method: "POST",
          token,
        }
      );
    } catch (err) {
      console.error("Message delivery acknowledgement failed:", err);
    }
  }

  socket.on("connect", async () => {
    socket.emit("get_presence");

    // Acknowledge messages that arrived while this user was offline.
    try {
      const data = await apiRequest("/api/messages/pending-delivery", {
        token,
      });

      for (const message of data.pending_messages || []) {
        await acknowledgeDelivery(
          message.conversation_id,
          message.message_id
        );
      }
    } catch (err) {
      console.error("Pending message sync failed:", err);
    }
  });

  // Receive messages even when their conversation is closed.
  socket.on("message_notification", (data) => {
    if (!data?.conversation_id || !data?.message_id) return;

    acknowledgeDelivery(
      data.conversation_id,
      data.message_id
    );
  });

  socket.on("presence_snapshot", (data) => {
    const updatedPresence = {};

    (data.users || []).forEach((item) => {
      updatedPresence[String(item.user_id)] = {
        is_online: item.is_online,
        last_seen: item.last_seen,
      };
    });

    setPresence(updatedPresence);
  });

  socket.on("presence_update", (data) => {
    setPresence((previous) => ({
      ...previous,
      [String(data.user_id)]: {
        is_online: data.is_online,
        last_seen: data.last_seen,
      },
    }));
  });

  return () => {
    socket.disconnect();
  };
}, [token]);



  async function handleSearch(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    setResults([]);

    if (query.trim().length < 3) {
      setError("Enter at least 3 characters to search.");
      return;
    }

    setLoading(true);

    try {
      const data = await apiRequest(
        `/api/users/search?q=${encodeURIComponent(query.trim())}`,
        { token }
      );
      setResults(data.users || []);

      if (!data.users?.length) {
        setNotice("No matching GRUS users found.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleConnect(recipient) {
    setError("");
    setNotice("");

    try {
      const data = await apiRequest(
        `/api/connections/requests/${recipient.id}`,
        { method: "POST", token }
      );

      setNotice(data.message || `Connection request sent to ${recipient.username}.`);
      await refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleAccept(requestId) {
    setError("");
    setNotice("");

    try {
      const data = await apiRequest(
        `/api/connections/requests/${requestId}/accept`,
        { method: "POST", token }
      );

      setNotice(data.message || "Connection request accepted.");
      await refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleDecline(requestId) {
    setError("");
    setNotice("");

    try {
      const data = await apiRequest(
        `/api/connections/requests/${requestId}/decline`,
        { method: "POST", token }
      );

      setNotice(data.message || "Connection request declined.");
      await refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleCancelRequest(requestId) {
  setError("");
  setNotice("");

  try {
    const data = await apiRequest(
      `/api/connections/requests/${requestId}/cancel`,
      { method: "DELETE", token }
    );

    setNotice(data.message || "Connection request cancelled.");
    await refreshData();
  } catch (err) {
    setError(err.message || "Could not cancel connection request.");
  }
}

  async function handleRemove(userId) {
    if (!window.confirm("Remove this connection?")) return;

    setError("");
    setNotice("");

    try {
      const data = await apiRequest(
        `/api/connections/${userId}`,
        { method: "DELETE", token }
      );

      setNotice(data.message || "Connection removed.");
      await refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleBlock(userId) {
    if (!window.confirm("Block this user?")) return;

    setError("");
    setNotice("");

    try {
      const data = await apiRequest(
        `/api/connections/blocked/${userId}`,
        { method: "POST", token }
      );

      setNotice(data.message || "User blocked.");
      await refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleUnblock(userId) {
    setError("");
    setNotice("");

    try {
      const data = await apiRequest(
        `/api/connections/blocked/${userId}`,
        { method: "DELETE", token }
      );

      setNotice(data.message || "User unblocked.");
      await refreshData();
    } catch (err) {
      setError(err.message);
    }
  }

  
async function handleOpenChat(person) {
  setError("");
  setNotice("");

  try {
    const data = await apiRequest("/api/conversations/", {
      method: "POST",
      token,
      body: { recipient_id: person.id },
    });

    const conversation = data.conversation || null;

    setSelectedConversation(conversation);
    setSelectedPerson(person);

    // Save the selected chat for browser refresh recovery.
    sessionStorage.setItem(
      "grus_active_chat",
      JSON.stringify({
        personId: String(person.id),
        username: person.username,
      })
    );

    setActiveSection("chats");
    setNotice("");
  } catch (err) {
    setError(err.message);
  }
}


  const panelStyle = {
    width: "100%",
    maxWidth: "760px",
    margin: "0 auto",
    padding: "32px",
    color: "#f4f2ff",
  };

  const rowStyle = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "14px",
    padding: "16px",
    marginTop: "10px",
    border: "1px solid rgba(255,255,255,0.09)",
    borderRadius: "12px",
    background: "rgba(255,255,255,0.025)",
  };

  const actionStyle = {
    padding: "8px 12px",
    border: "1px solid #6254c9",
    borderRadius: "8px",
    background: "rgba(112,94,232,0.15)",
    color: "#c7beff",
    cursor: "pointer",
  };

  function PersonRow({ person, actions }) {
  const userPresence = person?.id
    ? presence[String(person.id)]
    : null;

  const isOnline = userPresence?.is_online === true;

  const lastSeenText = userPresence?.last_seen
    ? new Intl.DateTimeFormat("en-IN", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      }).format(new Date(userPresence.last_seen))
    : null;

  return (
    <div style={rowStyle}>
      <div>
        <strong>{person?.username || "GRUS user"}</strong>

        <div
          style={{
            color: isOnline ? "#65d6a0" : "#9290a5",
            fontSize: "12px",
            marginTop: "4px",
            display: "flex",
            alignItems: "center",
            gap: "6px",
          }}
        >
          {userPresence ? (
            <>
              <span
                style={{
                  width: "7px",
                  height: "7px",
                  borderRadius: "50%",
                  background: isOnline ? "#65d6a0" : "#9290a5",
                  display: "inline-block",
                }}
              />
              {isOnline
                ? "Online"
                : lastSeenText
                  ? `Last seen at ${lastSeenText}`
                  : "Offline"}
            </>
          ) : (
            "GRUS member"
          )}
        </div>
      </div>

      <div
        style={{
          display: "flex",
          gap: "8px",
          flexWrap: "wrap",
        }}
      >
        {actions}
      </div>
    </div>
  );
}



async function handleChangeRecoveryPassword(event) {
  event.preventDefault();

  setError("");
  setNotice("");

  if (newRecoveryPassword !== confirmRecoveryPassword) {
    setError("The new recovery passwords do not match.");
    return;
  }

  if (newRecoveryPassword.length < 12) {
    setError("New recovery password must contain at least 12 characters.");
    return;
  }

  setRecoveryPasswordBusy(true);

  try {
    // Retrieve the current server backup.
    const current = await apiRequest("/api/auth/recovery", { token });

    if (
      !current?.recovery_backup ||
      !current?.public_key ||
      current.recovery_backup.publicKey !== current.public_key
    ) {
      throw new Error("The existing recovery backup is invalid.");
    }

    // Decrypt using the old password and re-encrypt the same identity.
    const newBackup = await changeRecoveryPasswordBackup(
      current.recovery_backup,
      oldRecoveryPassword,
      newRecoveryPassword
    );

    // Replace the server backup only after successful local verification.
    await apiRequest("/api/auth/recovery", {
      method: "PUT",
      token,
      body: {
        recovery_backup: newBackup,
        public_key: current.public_key,
        expected_backup: current.recovery_backup,
      },
    });

    setNotice(
      "Recovery password changed successfully. Your GRUS identity and public key remain unchanged."
    );

    setOldRecoveryPassword("");
    setNewRecoveryPassword("");
    setConfirmRecoveryPassword("");
    setShowRecoveryPasswordForm(false);
  } catch (err) {
    setError(err.message || "Could not change recovery password.");
  } finally {
    setRecoveryPasswordBusy(false);
  }
}


  function renderSection() {
    if (activeSection === "discover") {
      return (
        <>
          <h1>Discover</h1>
          <p>Find people and send connection requests.</p>
          <p style={{ color: "#a99eff" }}>
            Search for a username in the left panel.
          </p>
        </>
      );
    }

    if (activeSection === "requests") {
      return (
        <>
          <h1>Connection Requests</h1>
          <h3>Incoming · {incoming.length}</h3>

          {incoming.length === 0 && <p>No incoming requests.</p>}

          {incoming.map((request) => (
            <PersonRow
              key={request.request_id}
              person={request.user}
              actions={
                <>
                  <button
                    style={actionStyle}
                    onClick={() => handleAccept(request.request_id)}
                  >
                    Accept
                  </button>
                  <button
                    style={actionStyle}
                    onClick={() => handleDecline(request.request_id)}
                  >
                    Decline
                  </button>
                </>
              }
            />
          ))}

          <h3 style={{ marginTop: "28px" }}>
            Outgoing · {outgoing.length}
          </h3>

          {outgoing.length === 0 && <p>No outgoing requests.</p>}

          {outgoing.map((request) => (
            <PersonRow
              key={request.request_id}
              person={request.user}
              actions={
  <>
    <span style={{ color: "#a99eff" }}>Pending</span>
    <button
      style={actionStyle}
      onClick={() => handleCancelRequest(request.request_id)}
    >
      Cancel Request
    </button>
  </>
}
            />
          ))}
        </>
      );
    }

    if (activeSection === "connections") {
      return (
        <>
          <h1>My Connections</h1>
          <p>{connections.length} accepted connections</p>

          {connections.length === 0 && <p>No connections yet. Discover people to connect.</p>}

          {connections.map((connection) => (
            <PersonRow
              key={connection.connection_id || connection.user.id}
              person={connection.user}
              actions={
                <>
                  <button
                    style={actionStyle}
                    onClick={() => handleOpenChat(connection.user)}
                  >
                    Open chat
                  </button>
                  <button
                    style={actionStyle}
                    onClick={() => handleRemove(connection.user.id)}
                  >
                    Remove
                  </button>
                  <button
                    style={actionStyle}
                    onClick={() => handleBlock(connection.user.id)}
                  >
                    Block
                  </button>
                </>
              }
            />
          ))}
        </>
      );
    }

    
if (activeSection === "chats") {
  if (selectedConversation && selectedPerson) {
    return (
      <ChatWindow
        token={token}
        user={user}
        conversation={selectedConversation}
        person={selectedPerson}
        presence={presence[String(selectedPerson?.id)]}
        onBack={() => {
          setSelectedConversation(null);
          setSelectedPerson(null);
        }}
      />
    );
  }

  return (
    <>
      <h1>Chats</h1>
      <p>Select an accepted connection to open a conversation.</p>

      {connections.map((connection) => (
        <PersonRow
          key={connection.connection_id || connection.user.id}
          person={connection.user}
          actions={
            <button
              style={actionStyle}
              onClick={() => handleOpenChat(connection.user)}
            >
              Open chat
            </button>
          }
        />
      ))}

      {connections.length === 0 && (
        <p>You don't have any connections yet.</p>
      )}
    </>
  );
}


    if (activeSection === "blocked") {
      return (
        <>
          <h1>Blocked Users</h1>
          <p>{blocked.length} blocked users</p>

          {blocked.length === 0 && <p>You haven't blocked anyone.</p>}

          {blocked.map((item) => (
            <PersonRow
              key={item.user.id}
              person={item.user}
              actions={
                <button
                  style={actionStyle}
                  onClick={() => handleUnblock(item.user.id)}
                >
                  Unblock
                </button>
              }
            />
          ))}
        </>
      );
    }

    if (activeSection === "settings") {
  return (
    <>
      <h1>Settings</h1>
      <p>GRUS account</p>

      <div style={rowStyle}>
        <div>
          <strong>Username</strong>
          <p>{user?.username}</p>
        </div>
      </div>

      <div style={rowStyle}>
        <div>
          <strong>Email</strong>
          <p>{user?.email}</p>
        </div>
      </div>

      <div style={{ ...rowStyle, display: "block" }}>
  <h3>Profile Picture</h3>

  <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
    {profilePictureUrl ? (
  <button
    type="button"
    onClick={() => setShowOwnProfilePicture(true)}
    title="View profile picture"
    style={{
      padding: 0,
      border: "none",
      background: "transparent",
      borderRadius: "50%",
      cursor: "pointer",
    }}
  >
    <img
      src={profilePictureUrl}
      alt="Your GRUS profile"
      style={{
        width: "88px",
        height: "88px",
        borderRadius: "50%",
        objectFit: "cover",
        border: "2px solid #6254c9",
        display: "block",
      }}
    />
  </button>
) : (
      <div
        style={{
          width: "88px",
          height: "88px",
          borderRadius: "50%",
          display: "grid",
          placeItems: "center",
          background: "#292344",
          color: "#c7beff",
          fontSize: "30px",
        }}
      >
        {user?.username?.charAt(0)?.toUpperCase() || "G"}
      </div>

    )}

    <div>
      <p>Choose a profile picture for your GRUS account.</p>
      
<p
  style={{
    color: "#aaa5bd",
    fontSize: "12px",
    marginTop: "6px",
    marginBottom: "10px",
  }}
>
  Supported formats: JPEG, PNG, WebP
  <br />
  Maximum image size: <strong style={{ color: "#c7beff" }}>5 MB</strong>
</p>

      <input
        ref={profilePictureInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleProfilePictureUpload}
        style={{ display: "none" }}
      />

      <button
        type="button"
        style={actionStyle}
        disabled={profilePictureBusy}
        onClick={() => profilePictureInputRef.current?.click()}
      >
        {profilePictureBusy ? "Please wait..." : "Upload Picture"}
      </button>

      {profilePictureUrl && (
        <button
          type="button"
          style={{ ...actionStyle, marginLeft: "8px" }}
          disabled={profilePictureBusy}
          onClick={handleRemoveProfilePicture}
        >
          Remove
        </button>
      )}
    </div>
  </div>

  <label style={{ display: "block", marginTop: "20px" }}>
    Who can see your profile picture?
  </label>

  <select
    value={profilePictureVisibility}
    onChange={handleProfilePictureVisibility}
    style={{
      marginTop: "8px",
      padding: "10px",
      borderRadius: "8px",
      background: "#211d32",
      color: "#ffffff",
      border: "1px solid #6254c9",
      width: "100%",
      maxWidth: "280px",
    }}
  >
    <option value="everyone">Everyone</option>
    <option value="friends">Friends only</option>
    <option value="nobody">Nobody</option>
  </select>

  {profilePictureStatus && (
  <p
    role="alert"
    style={{
      color: profilePictureStatus.includes("successfully")
        ? "#65d6a0"
        : profilePictureStatus.includes("updated")
          ? "#65d6a0"
          : "#ff8585",
      background: profilePictureStatus.includes("successfully")
        ? "rgba(101,214,160,0.08)"
        : "rgba(255,100,100,0.08)",
      border: `1px solid ${
        profilePictureStatus.includes("successfully")
          ? "rgba(101,214,160,0.3)"
          : "rgba(255,100,100,0.3)"
      }`,
      padding: "10px 12px",
      borderRadius: "8px",
      fontSize: "13px",
      marginTop: "12px",
    }}
  >
    {profilePictureStatus}
  </p>
)}

  <p style={{ color: "#aaa5bd", fontSize: "12px" }}>
    Default visibility: Friends only.
  </p>
</div>

      <div style={{ ...rowStyle, flexWrap: "wrap" }}>
        <div>
          <strong>Chat Backup & Recovery</strong>
          <p>
            Encrypted identity backup and local identity verification.
          </p>
        </div>

        <span
          style={{
            color: recoveryVerified ? "#65d6a0" : "#e5c77b",
            fontWeight: 600,
          }}
        >
          {recoveryVerified ? "Verified" : "Not verified"}
        </span>
      </div>

      
<div style={{ ...rowStyle, flexWrap: "wrap" }}>
  <div>
    <strong>Change Recovery Password</strong>
    <p>
      Change the password protecting your encrypted identity backup.
    </p>
  </div>

  <button
    type="button"
    style={actionStyle}
    onClick={() => {
      setShowRecoveryPasswordForm((previous) => !previous);
      setError("");
      setNotice("");
    }}
  >
    {showRecoveryPasswordForm ? "Cancel" : "Change Password"}
  </button>
</div>

<div
  style={{
    ...rowStyle,
    display: "block",
    borderColor: "rgba(229, 199, 123, 0.35)",
  }}

  
>
  <strong style={{ color: "#e5c77b" }}>
    Important: Keep your Recovery Password safe
  </strong>
  <p>
    Your Recovery Password is required to restore your encrypted identity
    on a new device.
  </p>
  <p style={{ color: "#ff8585" }}>
    If you forget this password, you may be unable to restore your identity
    and access encrypted chat history on another device.
  </p>
  <p>
    Your original browser may retain access while its existing identity
    keys remain available. Do not clear its site data.
  </p>
  <p>
    Change this password if you suspect it has been exposed or compromised.
    You must know your current Recovery Password to change it.
  </p>
</div>

{showOwnProfilePicture && profilePictureUrl && (
  <div
    onClick={() => setShowOwnProfilePicture(false)}
    style={{
      position: "fixed",
      inset: 0,
      zIndex: 10000,
      background: "rgba(0,0,0,0.88)",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "20px",
    }}
  >
    <div
      onClick={(event) => event.stopPropagation()}
      style={{ position: "relative" }}
    >
      <button
        type="button"
        onClick={() => setShowOwnProfilePicture(false)}
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
        src={profilePictureUrl}
        alt="Your GRUS profile picture"
        style={{
          display: "block",
          maxWidth: "85vw",
          maxHeight: "80vh",
          objectFit: "contain",
          borderRadius: "14px",
        }}
      />

      <p style={{ color: "#fff", textAlign: "center" }}>
        Your GRUS Profile Picture
      </p>
    </div>
  </div>
)}


{showRecoveryPasswordForm && (
  <form
    onSubmit={handleChangeRecoveryPassword}
    style={{
      ...rowStyle,
      display: "block",
    }}
  >
    <h3>Update Recovery Password</h3>

    <label>Current Recovery Password</label>
    <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
      <input
        type={showOldRecoveryPassword ? "text" : "password"}
        value={oldRecoveryPassword}
        onChange={(event) => setOldRecoveryPassword(event.target.value)}
        autoComplete="current-password"
        placeholder="Enter current recovery password"
        required
        style={{ flex: 1, minWidth: 0 }}
      />
      <button
        type="button"
        style={actionStyle}
        onClick={() => setShowOldRecoveryPassword((value) => !value)}
      >
        {showOldRecoveryPassword ? "Hide" : "Show"}
      </button>
    </div>

    <label style={{ display: "block", marginTop: "16px" }}>
      New Recovery Password
    </label>
    <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
      <input
        type={showNewRecoveryPassword ? "text" : "password"}
        value={newRecoveryPassword}
        onChange={(event) => setNewRecoveryPassword(event.target.value)}
        autoComplete="new-password"
        placeholder="Enter new recovery password"
        minLength={12}
        required
        style={{ flex: 1, minWidth: 0 }}
      />
      <button
        type="button"
        style={actionStyle}
        onClick={() => setShowNewRecoveryPassword((value) => !value)}
      >
        {showNewRecoveryPassword ? "Hide" : "Show"}
      </button>
    </div>

    <label style={{ display: "block", marginTop: "16px" }}>
      Confirm New Recovery Password
    </label>
    <div style={{ display: "flex", gap: "8px", marginTop: "6px" }}>
      <input
        type={showConfirmRecoveryPassword ? "text" : "password"}
        value={confirmRecoveryPassword}
        onChange={(event) => setConfirmRecoveryPassword(event.target.value)}
        autoComplete="new-password"
        placeholder="Confirm new recovery password"
        minLength={12}
        required
        style={{ flex: 1, minWidth: 0 }}
      />
      <button
        type="button"
        style={actionStyle}
        onClick={() => setShowConfirmRecoveryPassword((value) => !value)}
      >
        {showConfirmRecoveryPassword ? "Hide" : "Show"}
      </button>
    </div>

    <p style={{ color: "#aaa5bd", fontSize: "13px" }}>
      Your new recovery password must contain at least 12 characters.
    </p>

    <button
      type="submit"
      style={{ ...actionStyle, marginTop: "12px" }}
      disabled={recoveryPasswordBusy}
    >
      {recoveryPasswordBusy ? "Updating..." : "Save New Recovery Password"}
    </button>
  </form>
)}


      <div style={rowStyle}>
        <div>
          <strong>End-to-end encryption</strong>
          <p>
            GRUS supports encrypted identity backups and encrypted message payloads. Full end-to-end encrypted messaging is still under development.
          </p>
        </div>

        <span style={{ color: "#e5c77b" }}>
          Partially implemented
        </span>
      </div>
    </>
  );
}

    return null;
  }

  return (
    <Dashboard
      user={user}
      token={token}
      profilePictureUrl={profilePictureUrl}
      onLogout={onLogout}
      activeSection={activeSection}
      onSectionChange={(section) => {
        setActiveSection(section);
        setError("");
        setNotice("");
        setResults([]);
      }}
      query={query}
      setQuery={setQuery}
      onSearch={handleSearch}
      results={results}
      loading={loading}
      error={error}
      onConnect={handleConnect}
    >
      <div style={panelStyle}>
        {notice && (
          <p style={{ color: "#a99eff", marginBottom: "16px" }}>
            {notice}
          </p>
        )}

        {error && (
          <p style={{ color: "#ff8585", marginBottom: "16px" }}>
            {error}
          </p>
        )}

        {renderSection()}
      </div>
    </Dashboard>
  );
}

export default function App() {

  const [view, setView] = useState("landing");
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [identityRestoreRequired, setIdentityRestoreRequired] = useState(false);
  const [recoveryChecking, setRecoveryChecking] = useState(false);
  const [recoveryCheckComplete, setRecoveryCheckComplete] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const recoveryCheckRef = useRef(false);
  const [user, setUser] = useState(() => {
  try {
    return JSON.parse(localStorage.getItem("grus_user")) || null;
  } catch {
    return null;
  }
});

const [token, setToken] = useState(
  () => localStorage.getItem("grus_token") || null
);  
  const [recoveryToken, setRecoveryToken] = useState(
  () => new URLSearchParams(window.location.search).get("token") || ""
);

  async function checkIdentityRecovery(currentUser, currentToken) {
  if (!currentUser?.id || !currentToken) return;

  if (recoveryCheckRef.current) return;

  recoveryCheckRef.current = true;
  setRecoveryChecking(true);
  setRecoveryCheckComplete(false);
  setRecoveryRequired(false);
  setIdentityRestoreRequired(false);
  setRecoveryError("");

  try {
    let serverBackup;

    try {
      serverBackup = await apiRequest(
        "/api/auth/recovery",
        { token: currentToken }
      );
    } catch (err) {
      if (err.status === 404) {
  const localIdentity = await getLocalIdentity(currentUser.id);

  if (localIdentity?.recoverySetupPending) {
    setRecoveryRequired(true);
    return;
  }

  if (localIdentity) {
    throw new Error(
      "A local identity exists, but its server backup is missing. Your identity has been preserved. Contact support before proceeding."
    );
  }

  setRecoveryRequired(true);
  return;
}

      throw err;
    }

    const localIdentity = await getLocalIdentity(currentUser.id);

    if (!localIdentity) {
      setIdentityRestoreRequired(true);
      return;
    }

    const localPublicKey = await exportPublicKeyBase64(
  localIdentity.publicKey
);

if (
  !serverBackup.recovery_backup ||
  serverBackup.recovery_backup.publicKey !== serverBackup.public_key ||
  localIdentity.recoveryBackup?.publicKey !== serverBackup.public_key ||
  localPublicKey !== serverBackup.public_key
) {
      throw new Error(
        "Your local identity does not match the server recovery record. Access has been paused to protect your identity."
      );
    }

    setRecoveryCheckComplete(true);
  } catch (err) {
    setRecoveryError(
      err.message || "Unable to verify your GRUS identity."
    );
  } finally {
    setRecoveryChecking(false);
    recoveryCheckRef.current = false;
  }
}

useEffect(() => {
  if (!user || !token) {
    setRecoveryCheckComplete(false);
    return;
  }

  checkIdentityRecovery(user, token);
}, [user, token]);




  async function handleSubmit(event) {
    event.preventDefault();
    setMessage("");
    setLoading(true);

    try {
      const endpoint =
        mode === "register" ? "/api/auth/register" : "/api/auth/login";

      const body =
        mode === "register"
          ? { username, email, password }
          : { email, password };

      const response = await fetch(API_URL + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Authentication failed");
      }

      if (mode === "register") {
        setMessage("Account created! Please sign in.");
        setMode("login");
        setPassword("");
      } else {
        localStorage.setItem("grus_user", JSON.stringify(data.user));
        localStorage.setItem("grus_token", data.token);
        setUser(data.user);
        setToken(data.token);
      }
    } catch (err) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  }

  function signOut() {
  localStorage.removeItem("grus_user");
  localStorage.removeItem("grus_token");

  setUser(null);
  setToken(null);
  setPassword("");
  setMessage("");
  setView("landing");
}

if (window.location.pathname === "/reset-password") {
  return (
    <PasswordRecovery
      initialToken={recoveryToken}
      onBack={() => {
        window.history.replaceState({}, "", "/");
        setRecoveryToken("");
        setMode("login");
        setMessage("");
        setView("auth");
      }}
    />
  );
}

if (view === "recovery") {
  return (
    <PasswordRecovery
      onBack={() => {
        setView("auth");
        setMessage("");
      }}
    />
  );
}

if (user && token) {
  if (recoveryChecking || !recoveryCheckComplete && !recoveryRequired && !identityRestoreRequired && !recoveryError) {
    return (
      <main className="auth-screen">
        <section className="auth-form-panel">
          <div className="auth-form-card">
            <h2>Verifying your GRUS identity</h2>
            <p>Please wait while we check your recovery backup.</p>
          </div>
        </section>
      </main>
    );
  }

  if (recoveryError) {
    return (
      <main className="auth-screen">
        <section className="auth-form-panel">
          <div className="auth-form-card">
            <h2>Identity verification failed</h2>
            <p>{recoveryError}</p>

            <button
              className="auth-submit"
              onClick={() => checkIdentityRecovery(user, token)}
            >
              Retry verification
            </button>

            <button onClick={signOut}>
              Sign out
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (recoveryRequired) {
    return (
      <RecoverySetup
        user={user}
        token={token}
        onComplete={() => {
          setRecoveryRequired(false);
          setRecoveryCheckComplete(true);
        }}
      />
    );
  }

  if (identityRestoreRequired) {
    return (
      <IdentityRestore
        user={user}
        token={token}
        onComplete={() => {
          setIdentityRestoreRequired(false);
          setRecoveryCheckComplete(true);
        }}
      />
    );
  }

  if (recoveryCheckComplete) {
    return (
      <GrusWorkspace
  user={user}
  token={token}
  onLogout={signOut}
  recoveryVerified={recoveryCheckComplete}
/>
    );
  }
}

if (view === "landing") {
  return (
    <Landing
      onSignIn={() => {
        setMode("login");
        setMessage("");
        setView("auth");
      }}
      onSignUp={() => {
        setMode("register");
        setMessage("");
        setView("auth");
      }}
    />
  );
}

  return (
  <Auth
    mode={mode}
    setMode={setMode}
    username={username}
    setUsername={setUsername}
    email={email}
    setEmail={setEmail}
    password={password}
    setPassword={setPassword}
    message={message}
    loading={loading}
    onSubmit={handleSubmit}
    onForgotPassword={() => {
      setMessage("");
      setView("recovery");
    }}
    onBack={() => {
      setView("landing");
      setMessage("");
    }}
  />
);
}

