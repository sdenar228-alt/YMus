// Button state machine for VK download buttons.
//
// States: idle, loading, success, error, disabled
//
// Transitions:
//   idle → loading (on click, disable re-clicks)
//   loading → success (on downloadId received) — green checkmark 1700ms → idle
//   loading → error (on any error) — red bg 1500ms + toast 4000ms → idle
//   loading → disabled (on VK_TRACK_UNAVAILABLE) — permanently disabled
//   loading → error (on 30s timeout) — same as error above
//
// Requirements: 8.1, 8.2, 8.3, 8.7, 8.9

export type VkButtonState = "idle" | "loading" | "success" | "error" | "disabled";

export interface VkButtonController {
  setState(state: VkButtonState): void;
  getState(): VkButtonState;
  /** Show a toast notification near the button or in a fixed position */
  showToast(message: string, durationMs?: number): void;
}

const STATE_CLASSES: Record<VkButtonState, string> = {
  idle: "ymus-vk-btn",
  loading: "ymus-vk-btn--loading",
  success: "ymus-vk-btn--success",
  error: "ymus-vk-btn--error",
  disabled: "ymus-vk-btn--disabled",
};

/**
 * Create a button controller for a VK download button element.
 * Manages CSS classes and icons for state transitions.
 */
export function createVkButtonController(button: HTMLButtonElement): VkButtonController {
  let currentState: VkButtonState = "idle";

  // Ensure base class is always present
  if (!button.classList.contains("ymus-vk-btn")) {
    button.classList.add("ymus-vk-btn");
  }

  function applyState(state: VkButtonState): void {
    // Remove all state-specific classes
    for (const cls of Object.values(STATE_CLASSES)) {
      if (cls !== "ymus-vk-btn") {
        button.classList.remove(cls);
      }
    }

    // Add new state class (idle has no modifier, just the base class)
    if (state !== "idle") {
      button.classList.add(STATE_CLASSES[state]);
    }

    // Update disabled attribute
    button.disabled = state === "loading" || state === "disabled";
  }

  const controller: VkButtonController = {
    setState(state: VkButtonState): void {
      currentState = state;
      applyState(state);
    },

    getState(): VkButtonState {
      return currentState;
    },

    showToast(message: string, durationMs = 4000): void {
      const toast = document.createElement("div");
      toast.className = "ymus-vk-toast";
      toast.textContent = message;
      document.body.appendChild(toast);

      setTimeout(() => {
        toast.remove();
      }, durationMs);
    },
  };

  return controller;
}

/**
 * Handle the full download response flow:
 * - On success: setState("success"), wait 1700ms, setState("idle")
 * - On error: setState("error"), showToast(message, 4000), wait 1500ms, setState("idle")
 * - On VK_TRACK_UNAVAILABLE: setState("disabled")
 */
export function handleVkDownloadResponse(
  ctrl: VkButtonController,
  response: { success: boolean; errorCode?: string; reason?: string },
): void {
  if (response.success) {
    ctrl.setState("success");
    setTimeout(() => {
      ctrl.setState("idle");
    }, 1700);
    return;
  }

  // VK_TRACK_UNAVAILABLE — permanently disabled, no retry
  if (response.errorCode === "VK_TRACK_UNAVAILABLE") {
    ctrl.setState("disabled");
    ctrl.showToast(response.reason || "Трек недоступен для скачивания", 4000);
    return;
  }

  // All other errors — red bg for 1500ms, toast for 4000ms, then idle
  ctrl.setState("error");
  ctrl.showToast(response.reason || "Ошибка загрузки", 4000);
  setTimeout(() => {
    ctrl.setState("idle");
  }, 1500);
}
