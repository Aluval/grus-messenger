
import { useEffect, useState } from "react";
import { API_URL } from "./services/api";
import {
  MessageCircle,
  Search,
  Settings,
  LogOut,
  ShieldCheck,
  Users,
  UserPlus,
  ShieldBan,
  Sparkles,
  Menu,
  X,
} from "lucide-react";

import "./Dashboard.css";

const navigation = [
  { id: "discover", label: "Discover", icon: Search },
  { id: "requests", label: "Requests", icon: UserPlus },
  { id: "connections", label: "Connections", icon: Users },
  { id: "chats", label: "Chats", icon: MessageCircle },
  { id: "blocked", label: "Blocked Users", icon: ShieldBan },
  { id: "settings", label: "Settings", icon: Settings },
];

function ProfileAvatar({
  userId,
  username,
  token,
  className,
}) {
  const [imageUrl, setImageUrl] = useState("");

  useEffect(() => {
    let active = true;
    let objectUrl = "";

    async function loadPicture() {
      if (!userId || !token) {
        setImageUrl("");
        return;
      }

      try {
        const response = await fetch(
          `${API_URL}/api/users/profile-picture/${userId}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) {
          if (active) setImageUrl("");
          return;
        }

        const blob = await response.blob();

        if (!active) return;

        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      } catch (error) {
        console.error("Profile picture loading failed:", error);
      }
    }

    loadPicture();

    return () => {
      active = false;

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [userId, token]);

  return (
    <div className={className}>
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={`${username || "GRUS user"} profile`}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            borderRadius: "inherit",
            display: "block",
          }}
        />
      ) : (
        (username || "G").charAt(0).toUpperCase()
      )}
    </div>
  );
}

export default function Dashboard({
  user,
  token,
  profilePictureUrl,
  onLogout,
  activeSection,
  onSectionChange,
  query,
  setQuery,
  onSearch,
  results = [],
  loading = false,
  error = "",
  notice = "",
  onConnect,
  children,
}) {

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  
// Keep the dashboard synchronized with the visible mobile viewport.
useEffect(() => {
  const updateViewportHeight = () => {
    const height =
      window.visualViewport?.height || window.innerHeight;

    document.documentElement.style.setProperty(
      "--grus-viewport-height",
      `${height}px`
    );
  };

  let frameId = requestAnimationFrame(updateViewportHeight);

  const handleResize = () => {
    cancelAnimationFrame(frameId);
    frameId = requestAnimationFrame(updateViewportHeight);
  };

  updateViewportHeight();

  window.addEventListener("resize", handleResize);
  window.addEventListener("orientationchange", handleResize);

  window.visualViewport?.addEventListener("resize", handleResize);

  return () => {
    cancelAnimationFrame(frameId);
    window.removeEventListener("resize", handleResize);
    window.removeEventListener("orientationchange", handleResize);
    window.visualViewport?.removeEventListener("resize", handleResize);
  };
}, []);

  const currentSection =
    navigation.find((item) => item.id === activeSection) ||
    navigation[0];
  const CurrentSectionIcon = currentSection.icon;

  return (
    <main
  className={`grus-dashboard ${
    mobileMenuOpen ? "mobile-menu-open" : ""
  }`}
>

    {/* MOBILE MENU BUTTON */}
<button
  type="button"
  className="mobile-menu-toggle"
  onClick={() => setMobileMenuOpen((prev) => !prev)}
  aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
  aria-expanded={mobileMenuOpen}
>
  {mobileMenuOpen ? <X size={23} /> : <Menu size={23} />}
</button>

{/* MOBILE MENU BACKDROP */}
{mobileMenuOpen && (
  <button
    type="button"
    className="mobile-menu-backdrop"
    aria-label="Close navigation"
    onClick={() => setMobileMenuOpen(false)}
  />
)}
      {/* RESPONSIVE NAVIGATION DRAWER */}
<div className="dashboard-navigation">

  {/* LEFT NAVIGATION RAIL */}
  <aside className="dashboard-rail">
        <button
          className="dashboard-logo"
          aria-label="GRUS home"
          onClick={() => {
  onSectionChange("discover");
  setMobileMenuOpen(false);
}}
        >
          G
        </button>

        <div className="rail-divider" />

        {navigation.map((item) => {
          const Icon = item.icon;

          return (
            <button
              key={item.id}
              className={`rail-icon ${
                activeSection === item.id ? "active" : ""
              }`}
              title={item.label}
              aria-label={item.label}
              aria-current={
                activeSection === item.id ? "page" : undefined
              }
              onClick={() => {
  onSectionChange(item.id);
  setMobileMenuOpen(false);
}}
            >
              <Icon size={21} />
            </button>
          );
        })}

        <div className="rail-spacer" />

        <ProfileAvatar
  userId={user?.id}
  username={user?.username}
  token={token}
  className="rail-avatar"
/>
          </aside>

      {/* MIDDLE SIDEBAR */}
      <aside className="conversation-sidebar">
        <header className="sidebar-header">
          <div>
            <div className="sidebar-brand">
              GRUS<span>.</span>
            </div>
            <p>Your private space</p>
          </div>

          <button
            className="sidebar-logout"
            onClick={onLogout}
            title="Sign out"
          >
            <LogOut size={18} />
          </button>
        </header>

        <div className="profile-card">
          <div className="profile-avatar">
            {profilePictureUrl ? (
              <img
                src={profilePictureUrl}
                alt="Your profile"
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  borderRadius: "inherit",
                  display: "block",
                }}
              />
            ) : (
              (user?.username || "G").charAt(0).toUpperCase()
            )}

            <span className="profile-online" />
          </div>

          <div className="profile-details">
            <strong>{user?.username || "GRUS User"}</strong>
            <span>Account active</span>
          </div>

          <ShieldCheck size={17} className="profile-shield" />
        </div>

        <div className="conversation-section-title">
          <span>{currentSection.label.toUpperCase()}</span>
          <span className="section-count">{results.length}</span>
        </div>

        {/* DISCOVER SEARCH */}
        {activeSection === "discover" && (
          <>
            <form
              className="dashboard-search"
              onSubmit={onSearch}
            >
              <Search size={17} />

              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find people..."
                minLength={3}
                aria-label="Search users"
              />

              <button type="submit" disabled={loading} title="Search">
                <Search size={17} />
              </button>
            </form>

            {error && (
              <p className="dashboard-error">{error}</p>
            )}

            <div className="conversation-list">
              {loading && (
                <p className="sidebar-hint">Searching...</p>
              )}

              {!loading && results.length === 0 && (
                <div className="sidebar-empty">
                  <div className="sidebar-empty-icon">
                    <Users size={20} />
                  </div>
                  <strong>Find your people</strong>
                  <p>
                    Search by username to discover GRUS members.
                  </p>
                </div>
              )}

              {results.map((recipient) => (
                <div
                  className="person-result"
                  key={recipient.id}
                >
                  <ProfileAvatar
  userId={recipient.id}
  username={recipient.username}
  token={token}
  className="person-avatar"
/>

                  <div className="person-info">
                    <strong>{recipient.username}</strong>
                    <span>GRUS member</span>
                  </div>

                  <button
                    className="person-connect-button"
                    onClick={() => onConnect?.(recipient)}
                    disabled={loading}
                  >
                    Connect
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {/* NAVIGATION INFORMATION */}
        {activeSection !== "discover" && (
          <div className="conversation-list">
            <div className="sidebar-empty">
              <div className="sidebar-empty-icon">
                <CurrentSectionIcon size={20} />
              </div>
              <strong>{currentSection.label}</strong>
              <p>
                Select this section to manage your GRUS account.
              </p>
            </div>
          </div>
        )}

        <footer className="sidebar-footer">
          <div className="privacy-status">
            <ShieldCheck size={15} />
            <span>Privacy is a priority</span>
          </div>

          <span className="sidebar-version">
            GRUS · Beyond Messaging
          </span>
        </footer>
      </aside>

</div>

{/* MAIN CONTENT */}
<section className="dashboard-main">

  {/* MOBILE BRAND HEADER */}
  <header className="mobile-brand-header">
    <div className="mobile-brand-logo">G</div>
    <div className="mobile-brand-details">
      <strong>GRUS<span>.</span></strong>
      <small>PRIVATE MESSAGING</small>
    </div>
  </header>

  {/* MOBILE DISCOVER */}
  {activeSection === "discover" && (
    <div className="mobile-discover-panel">
      <div className="mobile-discover-heading">
        <span>DISCOVER GRUS</span>
        <h2>Find your people.</h2>
        <p>Connect with people and start meaningful conversations.</p>
      </div>

      <form className="mobile-discover-search" onSubmit={onSearch}>
        <Search size={19} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by username..."
          minLength={3}
          aria-label="Search users"
        />
        <button type="submit" disabled={loading}>
          <Search size={19} />
        </button>
      </form>

      {/* MOBILE DISCOVER NOTIFICATIONS */}
{(notice || error) && (
  <div
    className={`mobile-discover-notification ${
      error ? "is-error" : "is-success"
    }`}
    role="status"
    aria-live="polite"
  >
    {notice || error}
  </div>
)}

      <div className="mobile-discover-results">
        <div className="mobile-results-heading">
          <strong>People</strong>
          <span>{results.length} found</span>
        </div>

        {loading && <p className="sidebar-hint">Searching...</p>}

        {!loading && results.length === 0 && (
          <div className="mobile-discover-empty">
            <Users size={25} />
            <strong>Discover new connections</strong>
            <p>Enter a username above to find people on GRUS.</p>
          </div>
        )}

        {results.map((recipient) => (
          <div className="person-result" key={recipient.id}>
            <ProfileAvatar
              userId={recipient.id}
              username={recipient.username}
              token={token}
              className="person-avatar"
            />
            <div className="person-info">
              <strong>{recipient.username}</strong>
              <span>GRUS member</span>
            </div>
            <button
              type="button"
              className="person-connect-button"
              onClick={() => onConnect?.(recipient)}
              disabled={loading}
            >
              Connect
            </button>
          </div>
        ))}
      </div>
    </div>
  )}

  {/* DESKTOP CONTENT */}
  <div className={`dashboard-desktop-content ${
    activeSection === "discover" ? "discover-desktop-content" : ""
  }`}>
    {children || (
      <div className="dashboard-welcome">
        <div className="welcome-icon">
          <Sparkles size={28} />
        </div>
        <span className="welcome-eyebrow">WELCOME TO GRUS</span>
        <h1>
          Make space for
          <br />
          <span>real conversations.</span>
        </h1>
        <p>
          Discover people, build connections and enjoy
          private conversations.
        </p>
        <div className="welcome-tip">
          <ShieldCheck size={17} />
          <span>
            End-to-end encrypted messaging with identity verification.
          </span>
        </div>
      </div>
    )}
  </div>

</section>
    </main>
  );
}
