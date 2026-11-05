
import { useEffect, useRef, useState } from "react";
import { connectSocket } from "./services/socket";
import "./App.css";
import Landing from "./Landing";

const API_URL = "http://127.0.0.1:5000";

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

useEffect(() => {
  if (!user || !token) {
    setRecoveryCheckComplete(false);
    return;
  }

  checkIdentityRecovery(user, token);
}, [user, token]);

export default function App() {
  const [view, setView] = useState("landing");
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);

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
    setUser(null);
    setToken(null);
    setPassword("");
    setMessage("");
  }

  if (user && token) {
  return (
    <Conversations
      token={token}
      user={user}
      onLogout={signOut}
    />
  );
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
    <main className="auth-page">
      <section className="auth-card">
        <h1>GRUS</h1>
        <p>Private by design. Connected in real time.</p>
        <h2>{mode === "register" ? "Create your account" : "Welcome back"}</h2>

        <form onSubmit={handleSubmit}>
          {mode === "register" && (
            <input
              placeholder="Username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              minLength={3}
              maxLength={20}
              required
            />
          )}

          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />

          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={12}
            maxLength={72}
            required
          />

          <button type="submit" disabled={loading}>
            {loading
              ? "Please wait..."
              : mode === "register"
                ? "Create account"
                : "Sign in"}
          </button>
        </form>

        {message && <p className="auth-message">{message}</p>}

        <p>
          {mode === "register" ? "Already have an account?" : "New to GRUS?"}
          {" "}
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setMode(mode === "register" ? "login" : "register");
              setMessage("");
            }}
          >
            {mode === "register" ? "Sign in" : "Create account"}
          </button>
        </p>
      </section>
    </main>
  );
}
