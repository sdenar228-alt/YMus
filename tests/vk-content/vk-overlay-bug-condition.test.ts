/**
 * @jest-environment jsdom
 */

/**
 * Bug Condition Exploration Test
 * 
 * Property 1: VKIT-элементы в overlay не обнаруживаются scanAndInject
 * 
 * **Validates: Requirements 1.1, 1.2, 2.1, 2.2**
 * 
 * This test is EXPECTED TO FAIL on unfixed code — failure confirms the bug exists.
 * DO NOT attempt to fix the test or code when it fails.
 */

import * as fc from "fast-check";
import { extractVkTrackMeta } from "../../src/vk-content/vk-track-meta";

// We need to import scanAndInject indirectly since it's not exported directly.
// Instead, we import startVkTrackInjector which calls scanAndInject internally.
// However, scanAndInject is a local function. We'll test the behavior by calling
// startVkTrackInjector and checking DOM results.

// We'll dynamically require the injector to work around module state
function loadInjector() {
  // Reset module state between tests
  jest.resetModules();
  return require("../../src/vk-content/vk-track-injector");
}

/**
 * Generator for valid ownerId values (negative for communities, positive for users)
 */
const ownerIdArb = fc.oneof(
  fc.integer({ min: -2100000000, max: -1 }),
  fc.integer({ min: 1, max: 2100000000 })
);

/**
 * Generator for valid audioId values (always positive)
 */
const audioIdArb = fc.integer({ min: 1, max: 999999999 });

/**
 * Generator for artist names (non-empty strings)
 */
const artistArb = fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0);

/**
 * Generator for title names (non-empty strings)
 */
const titleArb = fc.string({ minLength: 1, maxLength: 80 }).filter(s => s.trim().length > 0);

/**
 * Creates a VKIT audio row element as found in VK overlay queue.
 */
function createVkitAudioRow(opts: {
  ownerId: number;
  audioId: number;
  artist: string;
  title: string;
}): HTMLElement {
  const el = document.createElement("div");
  el.className = "vkitAudioRow__root";
  el.setAttribute("data-testentitytag", "audio");
  el.setAttribute("data-sortable-id", `${opts.ownerId}_${opts.audioId}`);

  // Add artist element (VKIT structure)
  const artistEl = document.createElement("span");
  artistEl.className = "vkitAudioRow__artist";
  artistEl.textContent = opts.artist;
  el.appendChild(artistEl);

  // Add title element (VKIT structure)
  const titleEl = document.createElement("span");
  titleEl.className = "vkitAudioRow__title";
  titleEl.textContent = opts.title;
  el.appendChild(titleEl);

  return el;
}

describe("Bug Condition Exploration: VKIT overlay elements not detected by scanAndInject", () => {
  beforeEach(() => {
    // Clean up DOM
    document.body.innerHTML = "";
    jest.resetModules();
  });

  /**
   * Property 1.1: scanAndInject SHALL detect VKIT audio elements and inject download button
   * 
   * **Validates: Requirements 1.1, 1.2**
   * 
   * On UNFIXED code this MUST FAIL — proving the bug exists.
   */
  it("property: scanAndInject detects VKIT audio elements and injects download button", () => {
    fc.assert(
      fc.property(
        ownerIdArb,
        audioIdArb,
        artistArb,
        titleArb,
        (ownerId, audioId, artist, title) => {
          // Setup: clean DOM and create VKIT element
          document.body.innerHTML = "";
          const vkitRow = createVkitAudioRow({ ownerId, audioId, artist, title });
          document.body.appendChild(vkitRow);

          // Act: load injector and start it (which calls scanAndInject)
          const { startVkTrackInjector } = loadInjector();
          const mockOnClick = jest.fn();
          startVkTrackInjector(mockOnClick);

          // Assert: button should be injected (expected behavior after fix)
          const btn = vkitRow.querySelector(".ymus-vk-dl-btn");
          expect(btn).not.toBeNull();

          // Assert: bound attribute should be set
          expect(vkitRow.getAttribute("data-ymus-vk-bound")).toBe("1");
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Property 1.2: extractVkTrackMeta SHALL return correct metadata for VKIT elements
   * 
   * **Validates: Requirements 2.1, 2.2**
   * 
   * On UNFIXED code this MUST FAIL — proving the bug exists.
   */
  it("property: extractVkTrackMeta returns correct ownerId and audioId for VKIT elements", () => {
    fc.assert(
      fc.property(
        ownerIdArb,
        audioIdArb,
        artistArb,
        titleArb,
        (ownerId, audioId, artist, title) => {
          // Setup: create VKIT element (no data-full-id, has data-sortable-id)
          const vkitRow = createVkitAudioRow({ ownerId, audioId, artist, title });

          // Act: extract metadata
          const meta = extractVkTrackMeta(vkitRow);

          // Assert: meta should not be null (expected behavior after fix)
          expect(meta).not.toBeNull();

          // Assert: ownerId and audioId should be correctly parsed
          expect(meta!.ownerId).toBe(String(ownerId));
          expect(meta!.audioId).toBe(String(audioId));
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * Specific counterexample: typical VKIT row from VK overlay
   * 
   * This is the exact DOM structure observed in production.
   */
  it("specific: VKIT row with data-sortable-id=-2001234567_456789 is detected", () => {
    const vkitRow = createVkitAudioRow({
      ownerId: -2001234567,
      audioId: 456789,
      artist: "Test Artist",
      title: "Test Title",
    });
    document.body.appendChild(vkitRow);

    const { startVkTrackInjector } = loadInjector();
    startVkTrackInjector(jest.fn());

    // Expected behavior after fix: button injected
    expect(vkitRow.querySelector(".ymus-vk-dl-btn")).not.toBeNull();
    expect(vkitRow.getAttribute("data-ymus-vk-bound")).toBe("1");

    // Expected behavior after fix: metadata extracted
    const meta = extractVkTrackMeta(vkitRow);
    expect(meta).not.toBeNull();
    expect(meta!.ownerId).toBe("-2001234567");
    expect(meta!.audioId).toBe("456789");
  });
});
