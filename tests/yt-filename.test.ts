import { buildYtFilename } from "../src/shared/yt-filename";

describe("buildYtFilename", () => {
  it("returns sanitized title for normal input", () => {
    expect(buildYtFilename("My Video Title")).toBe("My Video Title");
  });

  it("replaces forbidden characters with underscores", () => {
    expect(buildYtFilename('a\\b/c:d*e?f"g<h>i|j')).toBe(
      "a_b_c_d_e_f_g_h_i_j"
    );
  });

  it("truncates to 200 characters", () => {
    const longTitle = "A".repeat(250);
    const result = buildYtFilename(longTitle);
    expect(result.length).toBe(200);
  });

  it('returns "Unknown" for empty string', () => {
    expect(buildYtFilename("")).toBe("Unknown");
  });

  it('returns "Unknown" for whitespace-only string', () => {
    expect(buildYtFilename("   \t\n  ")).toBe("Unknown");
  });

  it("trims leading and trailing whitespace before sanitizing", () => {
    expect(buildYtFilename("  Hello World  ")).toBe("Hello World");
  });

  it("handles title with only forbidden characters", () => {
    const result = buildYtFilename(":::***???");
    expect(result).toBe("_________");
  });
});
