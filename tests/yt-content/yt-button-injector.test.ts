/**
 * @jest-environment jsdom
 */

import type { YtDownloadButton } from "../../src/yt-content/yt-button-injector";

describe("yt-button-injector", () => {
  let injectDownloadButton: typeof import("../../src/yt-content/yt-button-injector").injectDownloadButton;

  beforeEach(() => {
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    jest.resetModules();
    // Re-import to reset module-level state (injectedButtons map, stylesInjected)
    const mod = require("../../src/yt-content/yt-button-injector");
    injectDownloadButton = mod.injectDownloadButton;
  });

  describe("injectDownloadButton — regular video", () => {
    beforeEach(() => {
      // Simulate YouTube action bar (ytd-menu-renderer with flexible-item-buttons)
      const menuRenderer = document.createElement("ytd-menu-renderer");
      menuRenderer.className = "ytd-watch-metadata";
      const flexItems = document.createElement("div");
      flexItems.id = "flexible-item-buttons";
      menuRenderer.appendChild(flexItems);
      document.body.appendChild(menuRenderer);
    });

    it("injects a button into the action bar", () => {
      const handle = injectDownloadButton("abc123", "regular", () => {});
      expect(handle).not.toBeNull();

      const btn = document.querySelector("[data-ymus-yt-dl='abc123']");
      expect(btn).not.toBeNull();
      expect(btn!.textContent).toBe("⬇ Скачать");
    });

    it("returns null if action bar container is missing", () => {
      document.body.innerHTML = "";
      const handle = injectDownloadButton("xyz", "regular", () => {});
      expect(handle).toBeNull();
    });

    it("prevents duplicate injection for the same videoId", () => {
      const h1 = injectDownloadButton("dup1", "regular", () => {});
      const h2 = injectDownloadButton("dup1", "regular", () => {});
      expect(h1).not.toBeNull();
      expect(h2).toBeNull();

      const buttons = document.querySelectorAll("[data-ymus-yt-dl='dup1']");
      expect(buttons.length).toBe(1);
    });

    it("calls onClick when button is clicked in idle state", () => {
      const onClick = jest.fn();
      injectDownloadButton("click1", "regular", onClick);

      const btn = document.querySelector("[data-ymus-yt-dl='click1']") as HTMLElement;
      btn.click();
      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it("does not call onClick when button is disabled", () => {
      const onClick = jest.fn();
      const handle = injectDownloadButton("dis1", "regular", onClick)!;
      handle.setState("disabled");

      const btn = document.querySelector("[data-ymus-yt-dl='dis1']") as HTMLElement;
      btn.click();
      expect(onClick).not.toHaveBeenCalled();
    });

    it("does not call onClick when button is loading", () => {
      const onClick = jest.fn();
      const handle = injectDownloadButton("load1", "regular", onClick)!;
      handle.setState("loading");

      const btn = document.querySelector("[data-ymus-yt-dl='load1']") as HTMLElement;
      btn.click();
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe("injectDownloadButton — shorts", () => {
    beforeEach(() => {
      const actions = document.createElement("div");
      actions.id = "actions";
      document.body.appendChild(actions);
    });

    it("injects a button into the actions sidebar", () => {
      const handle = injectDownloadButton("short1", "shorts", () => {});
      expect(handle).not.toBeNull();

      const btn = document.querySelector("[data-ymus-yt-dl='short1']");
      expect(btn).not.toBeNull();
      expect(btn!.classList.contains("ymus-yt-dl-btn-shorts")).toBe(true);
    });

    it("returns null if actions container is missing", () => {
      document.body.innerHTML = "";
      const handle = injectDownloadButton("short2", "shorts", () => {});
      expect(handle).toBeNull();
    });
  });

  describe("YtDownloadButton methods", () => {
    let handle: YtDownloadButton;
    let btn: HTMLElement;

    beforeEach(() => {
      const menuRenderer = document.createElement("ytd-menu-renderer");
      menuRenderer.className = "ytd-watch-metadata";
      const flexItems = document.createElement("div");
      flexItems.id = "flexible-item-buttons";
      menuRenderer.appendChild(flexItems);
      document.body.appendChild(menuRenderer);

      handle = injectDownloadButton("methods1", "regular", () => {})!;
      btn = document.querySelector("[data-ymus-yt-dl='methods1']") as HTMLElement;
    });

    it("setProgress updates button text with clamped percent", () => {
      handle.setProgress(55);
      expect(btn.textContent).toBe("55%");

      handle.setProgress(-10);
      expect(btn.textContent).toBe("0%");

      handle.setProgress(150);
      expect(btn.textContent).toBe("100%");
    });

    it("setState updates data-state and label", () => {
      handle.setState("error");
      expect(btn.getAttribute("data-state")).toBe("error");
      expect(btn.textContent).toBe("Ошибка");

      handle.setState("disabled");
      expect(btn.getAttribute("data-state")).toBe("disabled");
      expect(btn.textContent).toBe("Недоступно");

      handle.setState("success");
      expect(btn.getAttribute("data-state")).toBe("success");
      expect(btn.textContent).toBe("✓");

      handle.setState("idle");
      expect(btn.getAttribute("data-state")).toBe("idle");
      expect(btn.textContent).toBe("⬇ Скачать");
    });

    it("setTooltip truncates text to 200 characters", () => {
      const longText = "a".repeat(300);
      handle.setTooltip(longText);
      expect(btn.title.length).toBe(200);

      const shortText = "Short tooltip";
      handle.setTooltip(shortText);
      expect(btn.title).toBe(shortText);
    });

    it("setLabel updates button text", () => {
      handle.setLabel("Custom");
      expect(btn.textContent).toBe("Custom");
    });

    it("remove() removes button from DOM and allows re-injection", () => {
      handle.remove();
      expect(document.querySelector("[data-ymus-yt-dl='methods1']")).toBeNull();

      // After removal, a new button can be injected for the same videoId
      const menuRenderer = document.createElement("ytd-menu-renderer");
      menuRenderer.className = "ytd-watch-metadata";
      const flexItems = document.createElement("div");
      flexItems.id = "flexible-item-buttons";
      menuRenderer.appendChild(flexItems);
      document.body.appendChild(menuRenderer);
      const handle2 = injectDownloadButton("methods1", "regular", () => {});
      expect(handle2).not.toBeNull();
    });
  });
});
