export interface SessionValidationResult {
  valid: boolean;
  errorCode?: "VK_NOT_LOGGED_IN" | "VK_SESSION_EXPIRED";
  errorMessage?: string;
}

/**
 * Check if user is logged into VK by verifying presence of
 * "remixsid" cookie for domain ".vk.com" via chrome.cookies.get().
 * Returns valid:true if cookie exists, VK_NOT_LOGGED_IN if absent.
 */
export async function validateVkSession(): Promise<SessionValidationResult> {
  try {
    const cookie = await chrome.cookies.get({
      url: "https://vk.com",
      name: "remixsid",
    });

    if (cookie) {
      return { valid: true };
    }

    return {
      valid: false,
      errorCode: "VK_NOT_LOGGED_IN",
      errorMessage: "Войдите в VK в браузере",
    };
  } catch {
    return {
      valid: false,
      errorCode: "VK_NOT_LOGGED_IN",
      errorMessage: "Войдите в VK в браузере",
    };
  }
}
