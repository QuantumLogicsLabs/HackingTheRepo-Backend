import React, { createContext, useContext, useState, useEffect, useRef } from "react";
import api from "../utils/api";
import type { Job } from "../types";

export type NotificationKind = "info" | "success" | "error" | "warning";

export interface Notification {
  id: string;
  title: string;
  body?: string;
  kind?: NotificationKind;
  read?: boolean;
  meta?: Record<string, unknown>;
}

interface NotificationContextValue {
  notifications: Notification[];
  addNotification: (n: Omit<Notification, "id" | "read">) => void;
  markRead: (id: string) => void;
  clear: () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

export function useNotifications(): NotificationContextValue {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationProvider");
  return ctx;
}

function uid(prefix = "n"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const jobsRef = useRef<Record<string, string>>({}); // jobId -> status

  const addNotification = (n: Omit<Notification, "id" | "read">) => {
    const note: Notification = { id: uid(), read: false, ...n };
    setNotifications((s) => [note, ...s].slice(0, 50));
  };

  const markRead = (id: string) => setNotifications((s) => s.map((n) => (n.id === id ? { ...n, read: true } : n)));
  const clear = () => setNotifications([]);

  // Poll jobs and detect status transitions
  useEffect(() => {
    let cancelled = false;

    const check = async () => {
      try {
        const { data } = await api.get("/jobs");
        const jobs = (data as Job[]) || [];

        // build map
        const nextMap: Record<string, string> = {};
        jobs.forEach((j) => (nextMap[j._id] = j.status));

        // compare with previous
        Object.entries(nextMap).forEach(([id, status]) => {
          const prev = jobsRef.current[id];
          if (!prev) {
            // new job, skip
            return;
          }
          if (prev !== status) {
            // transition detected
            if (status === "completed") {
              addNotification({ title: "Job completed", body: `Job ${id} completed successfully`, kind: "success", meta: { jobId: id } });
            } else if (status === "failed") {
              addNotification({ title: "Job failed", body: `Job ${id} failed — check the job details`, kind: "error", meta: { jobId: id } });
            } else if (status === "running" && (prev === "completed" || prev === "failed" || prev === "queued")) {
              addNotification({ title: "Job running", body: `Job ${id} is running (including refinements)`, kind: "info", meta: { jobId: id } });
            } else if (status === "refined") {
              addNotification({ title: "Review requested", body: `Job ${id} needs review or changes`, kind: "info", meta: { jobId: id } });
            }
          }
        });

        // store snapshot
        jobsRef.current = nextMap;
      } catch {
        // ignore polling errors
      }
    };

    // initial load to populate ref without notifications
    (async () => {
      try {
        const { data } = await api.get("/jobs");
        const jobs = (data as Job[]) || [];
        const map: Record<string, string> = {};
        jobs.forEach((j) => (map[j._id] = j.status));
        jobsRef.current = map;
      } catch {
        // ignore initial polling errors
      }
    })();

    const iv = setInterval(() => { if (!cancelled) check(); }, 8000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []);

  return (
    <NotificationContext.Provider value={{ notifications, addNotification, markRead, clear }}>
      {children}
    </NotificationContext.Provider>
  );
}

export default NotificationContext;
