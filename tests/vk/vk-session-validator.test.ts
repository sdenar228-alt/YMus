import { validateVkSession } from "../../src/background/vk-session-validator";

// jest-webextension-mock does not provide chrome.cookies, so we set it up manually.
beforeAll(() => {
  (global as any).chrome = (global as any).chrome || {};
  (global as any).chrome.cookies = {
    get: jest.fn(),
  };
});

describe("validateVkSession", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it("returns valid:true when remixsid cookie is present", async () => {
    (chrome.cookies.get as jest.Mock).mockResolvedValue({
      name: "remixsid",
      value: "abc123",
      domain: ".vk.com",
    });

    const result = await validateVkSession();

    expect(result).toEqual({ valid: true });
    expect(chrome.cookies.get).toHaveBeenCalledWith({
      url: "https://vk.com",
      name: "remixsid",
    });
  });

  it("returns VK_NOT_LOGGED_IN when cookie is absent", async () => {
    (chrome.cookies.get as jest.Mock).mockResolvedValue(null);

    const result = await validateVkSession();

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("VK_NOT_LOGGED_IN");
    expect(result.errorMessage).toBe("Войдите в VK в браузере");
  });

  it("returns VK_NOT_LOGGED_IN when chrome.cookies.get throws", async () => {
    (chrome.cookies.get as jest.Mock).mockRejectedValue(
      new Error("Permission denied"),
    );

    const result = await validateVkSession();

    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("VK_NOT_LOGGED_IN");
    expect(result.errorMessage).toBe("Войдите в VK в браузере");
  });
});
