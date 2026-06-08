import { muxToMp4 } from "../src/background/yt-muxer";

// ─── Helpers: Build minimal valid MP4 test data ──────────────────────────────

function writeAscii(buf: Uint8Array, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    buf[offset + i] = str.charCodeAt(i);
  }
}

function buildBox(type: string, payload: Uint8Array): Uint8Array {
  const size = 8 + payload.byteLength;
  const box = new Uint8Array(size);
  const view = new DataView(box.buffer);
  view.setUint32(0, size);
  writeAscii(box, 4, type);
  box.set(payload, 8);
  return box;
}

/**
 * Builds a minimal mvhd box (version 0, 108 bytes total).
 * next_track_id is the last 4 bytes.
 */
function buildMvhd(nextTrackId: number): Uint8Array {
  // mvhd v0: 8 header + 100 payload = 108 bytes
  const payload = new Uint8Array(100);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 0); // version 0, flags 0
  view.setUint32(12, 1000); // timescale
  view.setUint32(16, 5000); // duration
  view.setUint32(20, 0x00010000); // rate
  view.setUint16(24, 0x0100); // volume
  view.setUint32(96, nextTrackId); // next_track_id (last 4 bytes)
  return buildBox("mvhd", payload);
}

/**
 * Builds a minimal tkhd box (version 0).
 */
function buildTkhd(trackId: number): Uint8Array {
  const payload = new Uint8Array(84);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 0x00000001); // version 0, flags = track_enabled
  view.setUint32(12, trackId); // track_ID
  return buildBox("tkhd", payload);
}

function buildTrak(trackId: number): Uint8Array {
  const tkhd = buildTkhd(trackId);
  return buildBox("trak", tkhd);
}

function buildMoov(trackId: number): Uint8Array {
  const mvhd = buildMvhd(trackId + 1);
  const trak = buildTrak(trackId);
  const payload = new Uint8Array(mvhd.byteLength + trak.byteLength);
  payload.set(mvhd, 0);
  payload.set(trak, mvhd.byteLength);
  return buildBox("moov", payload);
}

function buildFtyp(): Uint8Array {
  const payload = new Uint8Array(8);
  writeAscii(payload, 0, "isom");
  return buildBox("ftyp", payload);
}

function buildMdat(content: Uint8Array): Uint8Array {
  return buildBox("mdat", content);
}

function buildMinimalMp4(trackId: number, mdatContent: Uint8Array): ArrayBuffer {
  const ftyp = buildFtyp();
  const moov = buildMoov(trackId);
  const mdat = buildMdat(mdatContent);

  const result = new Uint8Array(ftyp.byteLength + moov.byteLength + mdat.byteLength);
  result.set(ftyp, 0);
  result.set(moov, ftyp.byteLength);
  result.set(mdat, ftyp.byteLength + moov.byteLength);
  return result.buffer;
}

// Helper to parse top-level boxes from an ArrayBuffer
function parseBoxes(data: Uint8Array): Array<{ type: string; offset: number; size: number }> {
  const boxes: Array<{ type: string; offset: number; size: number }> = [];
  let offset = 0;
  while (offset < data.byteLength - 8) {
    const dv = new DataView(data.buffer, data.byteOffset + offset);
    const size = dv.getUint32(0);
    const type = String.fromCharCode(
      data[offset + 4], data[offset + 5], data[offset + 6], data[offset + 7],
    );
    if (size < 8) break;
    boxes.push({ type, offset, size });
    offset += size;
  }
  return boxes;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("yt-muxer", () => {
  describe("muxToMp4", () => {
    it("should produce valid MP4 output starting with ftyp box", async () => {
      const videoContent = new Uint8Array([0x00, 0x00, 0x00, 0x01, 0x65]);
      const audioContent = new Uint8Array([0xff, 0xf1, 0x50, 0x80]);

      const videoMp4 = buildMinimalMp4(1, videoContent);
      const audioMp4 = buildMinimalMp4(1, audioContent);

      const result = await muxToMp4(videoMp4, audioMp4);

      expect(result).toBeInstanceOf(ArrayBuffer);
      expect(result.byteLength).toBeGreaterThan(0);

      const view = new Uint8Array(result);
      const firstBoxType = String.fromCharCode(view[4], view[5], view[6], view[7]);
      expect(firstBoxType).toBe("ftyp");
    });

    it("should contain moov and mdat boxes in output", async () => {
      const videoContent = new Uint8Array([0x01, 0x02, 0x03]);
      const audioContent = new Uint8Array([0x04, 0x05, 0x06]);

      const videoMp4 = buildMinimalMp4(1, videoContent);
      const audioMp4 = buildMinimalMp4(1, audioContent);

      const result = await muxToMp4(videoMp4, audioMp4);
      const view = new Uint8Array(result);
      const boxes = parseBoxes(view);

      const boxTypes = boxes.map((b) => b.type);
      expect(boxTypes).toContain("moov");
      expect(boxTypes).toContain("mdat");
    });

    it("should combine video and audio payloads in mdat", async () => {
      const videoContent = new Uint8Array([0x01, 0x02, 0x03]);
      const audioContent = new Uint8Array([0x04, 0x05, 0x06]);

      const videoMp4 = buildMinimalMp4(1, videoContent);
      const audioMp4 = buildMinimalMp4(1, audioContent);

      const result = await muxToMp4(videoMp4, audioMp4);
      const view = new Uint8Array(result);
      const boxes = parseBoxes(view);

      const mdatBox = boxes.find((b) => b.type === "mdat")!;
      const mdatPayload = view.subarray(mdatBox.offset + 8, mdatBox.offset + mdatBox.size);
      expect(mdatPayload.byteLength).toBe(
        videoContent.byteLength + audioContent.byteLength,
      );
    });

    it("should throw if video has no moov box", async () => {
      const badVideo = buildMdat(new Uint8Array([0x01])).buffer as ArrayBuffer;
      const audioMp4 = buildMinimalMp4(1, new Uint8Array([0x02]));

      await expect(muxToMp4(badVideo, audioMp4)).rejects.toThrow(
        "video input has no moov box",
      );
    });

    it("should throw if audio has no moov box", async () => {
      const videoMp4 = buildMinimalMp4(1, new Uint8Array([0x01]));
      const badAudio = buildMdat(new Uint8Array([0x02])).buffer as ArrayBuffer;

      await expect(muxToMp4(videoMp4, badAudio)).rejects.toThrow(
        "audio input has no moov box",
      );
    });
  });
});
