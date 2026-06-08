import type { ServiceId } from "../shared/types";

export interface TabConfig {
  id: ServiceId;
  label: string;
  accent: string;
  accentHover: string;
}

export const SERVICE_TABS: readonly TabConfig[] = [
  { id: "yandex-music", label: "Яндекс", accent: "#FFDB4D", accentHover: "#FFE680" },
  { id: "vk",           label: "VK",      accent: "#0077FF", accentHover: "#3399FF" },
  { id: "youtube",      label: "YouTube",  accent: "#FF0000", accentHover: "#FF4444" },
  { id: "spotify",      label: "Spotify",  accent: "#1DB954", accentHover: "#1ED760" },
];

const STORAGE_KEY = "ymd_active_tab";
const DEFAULT_TAB: ServiceId = "yandex-music";

const VALID_IDS: readonly ServiceId[] = SERVICE_TABS.map((t) => t.id);

function isValidServiceId(value: unknown): value is ServiceId {
  return typeof value === "string" && (VALID_IDS as readonly string[]).includes(value);
}

/**
 * Retrieve the persisted active tab from chrome.storage.local.
 * Falls back to "yandex-music" if storage is unavailable or value is invalid.
 */
export async function getActiveTab(): Promise<ServiceId> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY];
    return isValidServiceId(stored) ? stored : DEFAULT_TAB;
  } catch {
    return DEFAULT_TAB;
  }
}

/**
 * Persist the active tab identifier to chrome.storage.local.
 */
export async function setActiveTab(id: ServiceId): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: id });
}

/**
 * Switch the visible tab panel and update accent CSS variables.
 * - Toggles `display: none / block` on `.tab-panel` elements based on `data-tab` attribute.
 * - Sets `--accent` and `--accent-hover` CSS variables on `:root`.
 */
export function switchTab(id: ServiceId): void {
  const panels = document.querySelectorAll<HTMLElement>(".tab-panel");
  panels.forEach((panel) => {
    panel.style.display = panel.dataset.tab === id ? "block" : "none";
  });

  const config = SERVICE_TABS.find((t) => t.id === id);
  if (config) {
    document.documentElement.style.setProperty("--accent", config.accent);
    document.documentElement.style.setProperty("--accent-hover", config.accentHover);
  }
}
