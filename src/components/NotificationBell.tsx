import React, { useState } from "react";
import { useNotifications } from "../context/NotificationContext";
import "./NotificationBell.css";

export default function NotificationBell(): React.ReactElement {
  const { notifications, markRead } = useNotifications();
  const [open, setOpen] = useState(false);

  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="notif-bell">
      <button className="bell-btn" onClick={() => setOpen((s) => !s)} title="Notifications">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M15 17h5l-1.405-1.405A2.032 2.032 0 0 1 18 14.158V11a6 6 0 0 0-5-5.917V4a1 1 0 1 0-2 0v1.083A6 6 0 0 0 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h11z"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        {unread > 0 && <span className="bell-count">{unread}</span>}
      </button>

      {open && (
        <div className="bell-dropdown" role="menu">
          <div className="bell-header">Notifications</div>
          <div className="bell-list">
            {notifications.length === 0 && <div className="bell-empty">No notifications</div>}
            {notifications.map((n) => (
              <div key={n.id} className={`bell-item ${n.read ? "read" : "unread"}`} onClick={() => markRead(n.id)}>
                <div className="bell-item-title">{n.title}</div>
                {n.body && <div className="bell-item-body">{n.body}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
