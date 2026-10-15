import axios from "axios";

const metricsEnabled = import.meta.env.VITE_METRICS_ENABLED !== "false";
const metricsBaseUrl = import.meta.env.VITE_METRICS_URL || "/metrics";

const metricsClient = axios.create({
  baseURL: metricsBaseUrl,
  timeout: 2000,
});

export type MetricEvent =
  | {
      type: "api";
      method: string;
      route: string;
      status: number | string;
      durationMs: number;
    }
  | {
      type: "job";
      event: "throughput" | "queue_depth";
      route: string;
      status?: number | string;
      queueDepth?: number;
    };

export async function sendMetricEvent(event: MetricEvent): Promise<void> {
  if (!metricsEnabled) {
    return;
  }

  try {
    await metricsClient.post("/event", event);
  } catch (error) {
    // Keep metrics best-effort only.
    console.debug("Metrics event failed:", error);
  }
}
