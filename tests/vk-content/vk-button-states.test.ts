/**
 * @jest-environment jsdom
 */

import {
  createVkButtonController,
  handleVkDownloadResponse,
  VkButtonState,
} from "../../src/vk-content/vk-button-states";

describe("createVkButtonController", () => {
  let button: HTMLButtonElement;

  beforeEach(() => {
    button = document.createElement("button");
    document.body.innerHTML = "";
    document.body.appendChild(button);
  });

  it("adds base class on creation", () => {
    createVkButtonController(button);
    expect(button.classList.contains("ymus-vk-btn")).toBe(true);
  });

  it("starts in idle state", () => {
    const ctrl = createVkButtonController(button);
    expect(ctrl.getState()).toBe("idle");
  });

  it("applies loading state class and disables button", () => {
    const ctrl = createVkButtonController(button);
    ctrl.setState("loading");
    expect(button.classList.contains("ymus-vk-btn--loading")).toBe(true);
    expect(button.disabled).toBe(true);
  });

  it("applies success state class", () => {
    const ctrl = createVkButtonController(button);
    ctrl.setState("success");
    expect(button.classList.contains("ymus-vk-btn--success")).toBe(true);
    expect(button.disabled).toBe(false);
  });

  it("applies error state class", () => {
    const ctrl = createVkButtonController(button);
    ctrl.setState("error");
    expect(button.classList.contains("ymus-vk-btn--error")).toBe(true);
    expect(button.disabled).toBe(false);
  });

  it("applies disabled state class and disables button", () => {
    const ctrl = createVkButtonController(button);
    ctrl.setState("disabled");
    expect(button.classList.contains("ymus-vk-btn--disabled")).toBe(true);
    expect(button.disabled).toBe(true);
  });

  it("removes previous state class on transition", () => {
    const ctrl = createVkButtonController(button);
    ctrl.setState("loading");
    ctrl.setState("success");
    expect(button.classList.contains("ymus-vk-btn--loading")).toBe(false);
    expect(button.classList.contains("ymus-vk-btn--success")).toBe(true);
  });

  it("showToast creates a toast element and removes it after duration", () => {
    jest.useFakeTimers();
    const ctrl = createVkButtonController(button);
    ctrl.showToast("Test message", 2000);

    const toast = document.querySelector(".ymus-vk-toast");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toBe("Test message");

    jest.advanceTimersByTime(2000);
    expect(document.querySelector(".ymus-vk-toast")).toBeNull();
    jest.useRealTimers();
  });
});

describe("handleVkDownloadResponse", () => {
  let button: HTMLButtonElement;

  beforeEach(() => {
    jest.useFakeTimers();
    button = document.createElement("button");
    document.body.innerHTML = "";
    document.body.appendChild(button);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("on success: sets success state, then idle after 1700ms", () => {
    const ctrl = createVkButtonController(button);
    ctrl.setState("loading");

    handleVkDownloadResponse(ctrl, { success: true });
    expect(ctrl.getState()).toBe("success");

    jest.advanceTimersByTime(1700);
    expect(ctrl.getState()).toBe("idle");
  });

  it("on error: sets error state, shows toast, then idle after 1500ms", () => {
    const ctrl = createVkButtonController(button);
    ctrl.setState("loading");

    handleVkDownloadResponse(ctrl, { success: false, reason: "Ошибка сети" });
    expect(ctrl.getState()).toBe("error");
    expect(document.querySelector(".ymus-vk-toast")!.textContent).toBe("Ошибка сети");

    jest.advanceTimersByTime(1500);
    expect(ctrl.getState()).toBe("idle");
  });

  it("on VK_TRACK_UNAVAILABLE: sets disabled state permanently", () => {
    const ctrl = createVkButtonController(button);
    ctrl.setState("loading");

    handleVkDownloadResponse(ctrl, {
      success: false,
      errorCode: "VK_TRACK_UNAVAILABLE",
      reason: "Трек недоступен",
    });
    expect(ctrl.getState()).toBe("disabled");

    // Does not transition back to idle
    jest.advanceTimersByTime(10000);
    expect(ctrl.getState()).toBe("disabled");
  });

  it("uses default error message when reason is not provided", () => {
    const ctrl = createVkButtonController(button);
    handleVkDownloadResponse(ctrl, { success: false });
    expect(document.querySelector(".ymus-vk-toast")!.textContent).toBe("Ошибка загрузки");
  });
});
