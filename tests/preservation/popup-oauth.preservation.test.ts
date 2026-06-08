/**
 * Preservation Property Test — Popup OAuth round-trip
 *
 * **Validates: Requirements 3.5, 3.9**
 *
 * Property 2 (Preservation): The popup OAuth flow (`OAUTH_LOGIN`,
 * `OAUTH_TOKEN_RECEIVED`, `AUTH_STATUS`, `AUTH_LOGOUT`) is in the
 * non-bug-condition domain. The cobalt revert MUST NOT change the wire
 * shape, the `chrome.storage.local` key the token persists under
 * (`ymd_oauth_token`), or the response envelope.
 *
 * NOTE: The unfixed `message-router.ts` has pre-existing TS compile errors
 * in unrelated handlers (see lines 1135/1145/1148/1167) that prevent
 * ts-jest from importing the module. We pin the OAuth contract via the
 * shared `auth.ts` helpers (which DO compile cleanly) plus structural
 * source assertions on the router, so the property is observable on the
 * unfixed build.
 *
 * The contract this test pins:
 *   1. `getStoredToken` / `setStoredToken` / `clearStoredToken` from
 *      `src/shared/auth.ts` use the canonical key `ymd_oauth_token`.
 *   2. The token persists at `chrome.storage.local["ymd_oauth_token"]`
 *      across `setStoredToken` → `getStoredToken` → `clearStoredToken`.
 *   3. The router source contains the four OAuth case branches
 *      (`OAUTH_LOGIN`, `OAUTH_TOKEN_RECEIVED`, `AUTH_STATUS`,
 *      `AUTH_LOGOUT`) and references the auth helpers.
 *   4. No popup file references any cobalt host.
 *
 * EXPECTED OUTCOME: Test PASSES on the unfixed build.
 */

import * as fs from "fs";
import * as path from "path";
import * as fc from "fast-check";

import {
  getStoredToken,
  setStoredToken,
  clearStoredToken,
} from "../../src/shared/auth";

const STORAGE_KEY = "ymd_oauth_token" as const;

const ROUTER_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../src/background/message-router.ts"),
  "utf-8",
);
const POPUP_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../src/popup/popup.ts"),
  "utf-8",
);
const AUTH_SRC = fs.readFileSync(
  path.resolve(__dirname, "../../src/shared/auth.ts"),
  "utf-8",
);

const COBALT_HOSTS = [
  "cobalt-api.ayo.tf",
  "cobalt-api.luver.pw",
  "cobapi.elrant.team",
  "ymuslink.duckdns.org",
] as const;

describe("Preservation: Popup OAuth round-trip — unchanged after cobalt revert", () => {
  beforeEach(async () => {
    await chrome.storage.local.clear();
  });

  /**
   * **Validates: Requirements 3.5**
   *
   * Property: For any random token value, the
   * `setStoredToken → getStoredToken → clearStoredToken` round-trip
   * preserves the documented `chrome.storage.local["ymd_oauth_token"]`
   * key contract.
   */
  it("auth helpers persist + retrieve + clear at chrome.storage.local['ymd_oauth_token']", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 32, maxLength: 256 }).filter(
          (s) => s.trim().length >= 32,
        ),
        async (token) => {
          await chrome.storage.local.clear();

          // 1) Initial state: no token.
          expect(await getStoredToken()).toBeNull();

          // 2) Persist via the public API.
          await setStoredToken(token);

          // 3) Retrieve via the public API — round-trip preserves the value.
          expect(await getStoredToken()).toBe(token);

          // 4) The exact storage key is `ymd_oauth_token`.
          const raw = (await chrome.storage.local.get(STORAGE_KEY)) as Record<
            string,
            unknown
          >;
          expect(raw[STORAGE_KEY]).toBe(token);

          // 5) Clearing removes the key.
          await clearStoredToken();
          expect(await getStoredToken()).toBeNull();
          const after = (await chrome.storage.local.get(STORAGE_KEY)) as Record<
            string,
            unknown
          >;
          expect(after[STORAGE_KEY]).toBeUndefined();
        },
      ),
      { numRuns: 6 },
    );
  });

  /**
   * **Validates: Requirements 3.5, 3.9**
   *
   * Property: The OAuth message types are present in the router source
   * with the documented case names. The wire shape is preserved.
   */
  it("router source contains all four OAuth case branches", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "OAUTH_LOGIN",
          "OAUTH_TOKEN_RECEIVED",
          "AUTH_STATUS",
          "AUTH_LOGOUT",
        ),
        (caseName) => {
          const re = new RegExp(`case\\s+"${caseName}"\\s*:`);
          expect(ROUTER_SRC).toMatch(re);
        },
      ),
      { numRuns: 4 },
    );
  });

  /**
   * **Validates: Requirements 3.5**
   *
   * Property: The router consumes the canonical auth helpers
   * (`getStoredToken`, `setStoredToken`, `clearStoredToken`) and the
   * `authorizeAndSave` helper from `oauth-flow.ts`.
   */
  it("router imports canonical auth helpers", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "getStoredToken",
          "setStoredToken",
          "clearStoredToken",
          "authorizeAndSave",
        ),
        (sym) => {
          expect(ROUTER_SRC).toContain(sym);
        },
      ),
      { numRuns: 4 },
    );
  });

  /**
   * **Validates: Requirements 3.5, 3.9**
   *
   * Property: The OAuth storage key is exactly `ymd_oauth_token` in
   * `src/shared/auth.ts`.
   */
  it("auth.ts uses the canonical storage key 'ymd_oauth_token'", () => {
    expect(AUTH_SRC).toMatch(/STORAGE_KEY\s*=\s*"ymd_oauth_token"/);
  });

  /**
   * **Validates: Requirements 3.9**
   *
   * Property: The popup source does not reference any cobalt host. The
   * popup OAuth surface is in the non-bug-condition domain — it must stay
   * cobalt-free both before and after the revert.
   */
  it("popup source contains no cobalt host references", () => {
    fc.assert(
      fc.property(fc.constantFrom(...COBALT_HOSTS), (host) => {
        expect(POPUP_SRC).not.toContain(host);
      }),
      { numRuns: COBALT_HOSTS.length },
    );
  });
});
