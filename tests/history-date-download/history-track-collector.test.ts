/**
 * @jest-environment jsdom
 */

/**
 * Unit tests for history-track-collector module.
 * Validates: Requirements 3.1, 3.2, 3.3, 3.5
 */

import { collectTrackIds } from "../../src/content/history-track-collector";

function buildDOM(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("collectTrackIds", () => {
  it("collects track IDs from anchors between date headers", () => {
    const doc = buildDOM(`
      <div>
        <div class="d-history__date-header" id="h1">Today</div>
        <div class="track-row"><a href="/track/111">Track 1</a></div>
        <div class="track-row"><a href="/track/222">Track 2</a></div>
        <div class="d-history__date-header" id="h2">Yesterday</div>
        <div class="track-row"><a href="/track/333">Track 3</a></div>
      </div>
    `);

    const header = doc.querySelector("#h1")!;
    const ids = collectTrackIds(header);

    expect(ids).toEqual(["111", "222"]);
  });

  it("does not include IDs from next date header section", () => {
    const doc = buildDOM(`
      <div>
        <div class="d-history__date-header" id="h1">Today</div>
        <div><a href="/track/100">T</a></div>
        <div class="d-history__date-header" id="h2">Yesterday</div>
        <div><a href="/track/200">T</a></div>
      </div>
    `);

    const header = doc.querySelector("#h1")!;
    const ids = collectTrackIds(header);

    expect(ids).toEqual(["100"]);
    expect(ids).not.toContain("200");
  });

  it("deduplicates by first occurrence, preserving DOM order", () => {
    const doc = buildDOM(`
      <div>
        <div class="d-history__date-header" id="h1">Today</div>
        <div><a href="/track/10">T</a></div>
        <div><a href="/track/20">T</a></div>
        <div><a href="/track/10">T (dup)</a></div>
        <div><a href="/track/30">T</a></div>
      </div>
    `);

    const header = doc.querySelector("#h1")!;
    const ids = collectTrackIds(header);

    expect(ids).toEqual(["10", "20", "30"]);
  });

  it("ignores anchors with non-matching hrefs", () => {
    const doc = buildDOM(`
      <div>
        <div class="d-history__date-header" id="h1">Today</div>
        <div><a href="/album/55">Album</a></div>
        <div><a href="/track/42">Track</a></div>
        <div><a href="/artist/99">Artist</a></div>
        <div><a href="/track/42/lyrics">Lyrics</a></div>
      </div>
    `);

    const header = doc.querySelector("#h1")!;
    const ids = collectTrackIds(header);

    expect(ids).toEqual(["42"]);
  });

  it("returns empty array when no track links exist", () => {
    const doc = buildDOM(`
      <div>
        <div class="d-history__date-header" id="h1">Today</div>
        <div>No tracks here</div>
        <div class="d-history__date-header" id="h2">Yesterday</div>
      </div>
    `);

    const header = doc.querySelector("#h1")!;
    const ids = collectTrackIds(header);

    expect(ids).toEqual([]);
  });

  it("collects until end of container when no next date header exists", () => {
    const doc = buildDOM(`
      <div>
        <div class="d-history__date-header" id="h1">Today</div>
        <div><a href="/track/1">T1</a></div>
        <div><a href="/track/2">T2</a></div>
      </div>
    `);

    const header = doc.querySelector("#h1")!;
    const ids = collectTrackIds(header);

    expect(ids).toEqual(["1", "2"]);
  });

  it("handles nested anchors within containers", () => {
    const doc = buildDOM(`
      <div>
        <div class="d-history__date-header" id="h1">Today</div>
        <div class="track-list">
          <div class="track-row"><a href="/track/5">T</a></div>
          <div class="track-row"><a href="/track/6">T</a></div>
        </div>
      </div>
    `);

    const header = doc.querySelector("#h1")!;
    const ids = collectTrackIds(header);

    expect(ids).toEqual(["5", "6"]);
  });
});
