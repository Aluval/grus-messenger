import {
  MessageCircle,
  Search,
  Settings,
  LogOut,
  ShieldCheck,
  Plus,
  Users,
  Sparkles,
} from "lucide-react";
import "./Dashboard.css";

export default function Dashboard({
  user,
  onLogout,
  query,
  setQuery,
  onSearch,
  results,
  loading,
  error,
  onStartChat,
  children,
}) {
  return (
    <main className="grus-dashboard">
      <aside className="dashboard-rail">
        <a href="#" className="dashboard-logo" aria-label="GRUS home">
          G
        </a>

        <div className="rail-divider" />

        <button className="rail-icon active" title="Messages">
          <MessageCircle size={21} />
        </button>

        <button className="rail-icon" title="Find people">
          <Users size={21} />
        </button>

        <div className="rail-spacer" />

        <button className="rail-icon" title="Settings">
          <Settings size={20} />
        </button>

        <div className="rail-avatar">
          {(user?.username || "G").charAt(0).toUpperCase()}
        </div>
      </aside>

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
            {(user?.username || "G").charAt(0).toUpperCase()}
            <span className="profile-online" />
          </div>
          <div className="profile-details">
            <strong>{user?.username}</strong>
            <span>Available</span>
          </div>
          <ShieldCheck size={17} className="profile-shield" />
        </div>

        <div className="conversation-section-title">
          <span>MESSAGES</span>
          <span className="section-count">{results.length}</span>
        </div>

        <form className="dashboard-search" onSubmit={onSearch}>
          <Search size={17} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find people..."
            minLength={3}
            aria-label="Search users"
          />
          <button type="submit" disabled={loading} title="Search">
            <Plus size={17} />
          </button>
        </form>

        {error && <p className="dashboard-error">{error}</p>}

        <div className="conversation-list">
          {loading && (
            <p className="sidebar-hint">Searching...</p>
          )}

          {!loading && results.length === 0 && !error && (
            <div className="sidebar-empty">
              <div className="sidebar-empty-icon">
                <Users size={20} />
              </div>
              <strong>Find your people</strong>
              <p>Search by username to start a conversation.</p>
            </div>
          )}

          {results.map((recipient) => (
            <button
              className="person-result"
              key={recipient.id}
              onClick={() => onStartChat(recipient)}
              disabled={loading}
            >
              <div className="person-avatar">
                {recipient.username.charAt(0).toUpperCase()}
              </div>
              <div className="person-info">
                <strong>{recipient.username}</strong>
                <span>GRUS member</span>
              </div>
              <MessageCircle size={17} className="person-chat-icon" />
            </button>
          ))}
        </div>

        <footer className="sidebar-footer">
          <div className="privacy-status">
            <ShieldCheck size={15} />
            <span>Privacy is a priority</span>
          </div>
          <span className="sidebar-version">GRUS · Development</span>
        </footer>
      </aside>

      <section className="dashboard-main">
        {children || (
          <div className="dashboard-welcome">
            <div className="welcome-icon">
              <Sparkles size={28} />
            </div>
            <span className="welcome-eyebrow">WELCOME TO GRUS</span>
            <h1>Make space for<br /><span>real conversations.</span></h1>
            <p>
              Search for someone on GRUS and start a conversation.
              Your messaging space is ready.
            </p>
            <div className="welcome-tip">
              <Search size={17} />
              <span>Search for a username in the left panel to get started.</span>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
