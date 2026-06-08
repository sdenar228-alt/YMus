import { invoke } from "@tauri-apps/api/core";
import "./styles.css";

type BrowserInfo = {
  id: string;
  name: string;
  engine: string;
  path: string | null;
  installed: boolean;
  installMode: string;
  extensionsUrl: string;
};

type PreparedExtension = {
  path: string;
  version: string;
  extensionId: string;
  sha256: string;
  updateUrl: string;
  packageType: string;
};

type Notice = {
  tone: "info" | "success" | "error";
  text: string;
};

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("App root is missing");
const app: HTMLDivElement = appElement;

const isTauri = "__TAURI_INTERNALS__" in window;
const browserOrder = ["yandex", "chrome", "edge", "brave", "opera", "firefox"];
const state: {
  browsers: BrowserInfo[];
  selected: Set<string>;
  prepared: PreparedExtension | null;
  unpacked: PreparedExtension | null;
  loading: boolean;
  booting: boolean;
  notice: Notice;
} = {
  browsers: [],
  selected: new Set(),
  prepared: null,
  unpacked: null,
  loading: true,
  booting: true,
  notice: {
    tone: "info",
    text: "Ищем браузеры на этом компьютере",
  },
};

const demoBrowsers: BrowserInfo[] = [
  {
    id: "yandex",
    name: "Yandex Browser",
    engine: "Chromium",
    path: "C:\\Users\\User\\AppData\\Local\\Yandex\\YandexBrowser\\Application\\browser.exe",
    installed: true,
    installMode: "CRX установка",
    extensionsUrl: "chrome://extensions/",
  },
  {
    id: "chrome",
    name: "Google Chrome",
    engine: "Chromium",
    path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    installed: true,
    installMode: "CRX установка",
    extensionsUrl: "chrome://extensions/",
  },
  {
    id: "edge",
    name: "Microsoft Edge",
    engine: "Chromium",
    path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    installed: true,
    installMode: "CRX установка",
    extensionsUrl: "edge://extensions/",
  },
  {
    id: "firefox",
    name: "Mozilla Firefox",
    engine: "Firefox",
    path: null,
    installed: false,
    installMode: "Подписанный XPI",
    extensionsUrl: "about:addons",
  },
];

const browserMark: Record<string, string> = {
  yandex: "Я",
  chrome: "C",
  edge: "E",
  firefox: "F",
  brave: "B",
  opera: "O",
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function installedChromiumBrowsers() {
  return state.browsers.filter((browser) => browser.installed && browser.engine === "Chromium");
}

function selectedBrowsers() {
  return state.browsers.filter((browser) => state.selected.has(browser.id));
}

function browserIcon(browser: BrowserInfo): string {
  const src = `/assets/browsers/${browser.id}.svg`;
  return `
    <span class="browser-icon browser-icon--${browser.id}" aria-hidden="true">
      <img src="${src}" alt="" onerror="this.remove()" />
      <span>${browserMark[browser.id] ?? browser.name.slice(0, 1)}</span>
    </span>
  `;
}

function renderBrowser(browser: BrowserInfo): string {
  const selectable = browser.installed && browser.engine === "Chromium";
  const selected = state.selected.has(browser.id);
  const status = browser.installed
    ? browser.engine === "Chromium"
      ? "Готов к CRX"
      : "Нужна Firefox-сборка"
    : "Не найден";

  return `
    <label class="browser-row ${selected ? "browser-row--selected" : ""} ${selectable ? "" : "browser-row--disabled"}">
      <input
        class="browser-checkbox"
        type="checkbox"
        data-browser-id="${browser.id}"
        ${selected ? "checked" : ""}
        ${selectable ? "" : "disabled"}
      />
      <span class="check-ui" aria-hidden="true"></span>
      ${browserIcon(browser)}
      <span class="browser-main">
        <strong>${escapeHtml(browser.name)}</strong>
        <span>${escapeHtml(browser.engine)} · ${escapeHtml(browser.installMode)}</span>
      </span>
      <span class="browser-status ${browser.installed ? "" : "browser-status--muted"}">${status}</span>
    </label>
  `;
}

function render() {
  const installed = state.browsers.filter((browser) => browser.installed).length;
  const selected = selectedBrowsers();
  const canPrepare = selected.length > 0 && !state.loading;
  const selectedFirst = selected[0];

  app.innerHTML = `
    <div class="app-shell">
      <div class="boot-screen ${state.booting ? "" : "boot-screen--hidden"}" aria-hidden="true">
        <div class="boot-mark">
          <img src="/assets/ymus.png" alt="" />
          <span></span>
        </div>
        <strong>YMus</strong>
        <small>подготавливаем установщик</small>
      </div>

      <header class="topbar">
        <div class="brand">
          <img src="/assets/ymus.png" alt="" />
          <span>YMus</span>
          <span class="brand-tag">${isTauri ? "Desktop" : "Preview"}</span>
        </div>
        <div class="topbar-actions">
          <span class="local-mode"><i></i>${isTauri ? "Локальный режим" : "Предпросмотр интерфейса"}</span>
          <button class="icon-button" data-action="refresh" title="Повторить поиск браузеров" aria-label="Повторить поиск браузеров">
            <span aria-hidden="true">↻</span>
          </button>
        </div>
      </header>

      <main>
        <section class="overview">
          <div>
            <span class="eyebrow">YMus Desktop</span>
            <h1>Подключение YMus к браузерам</h1>
            <p>Выбери браузер и проверь все доступные способы установки: CRX policy, запуск unpacked и ручной fallback.</p>
            <div class="hero-pills" aria-label="Возможности">
              <span>CRX hash check</span>
              <span>Unpacked launch</span>
              <span>UI wizard beta</span>
            </div>
          </div>
          <div class="overview-stat">
            <strong>${installed}</strong>
            <span>браузера готово</span>
          </div>
        </section>

        <div class="workspace">
          <section class="browser-panel">
            <div class="section-heading">
              <div>
                <span class="step-number">01</span>
                <h2>Браузеры</h2>
              </div>
              <span>${selected.length} выбрано</span>
            </div>
            <div class="browser-list">
              ${state.loading ? '<div class="loading-list"><i></i><span>Проверяем установленные браузеры</span></div>' : state.browsers.map(renderBrowser).join("")}
            </div>
          </section>

          <aside class="action-panel">
            <div class="section-heading">
              <div>
                <span class="step-number">02</span>
                <h2>Способы установки</h2>
              </div>
              <span>${state.prepared || state.unpacked ? "Пакет готов" : "CRX + unpacked"}</span>
            </div>

            <ol class="install-steps">
              <li><b>1</b><span><strong>Policy CRX</strong><small>Пробуем официальный Chromium policy-механизм для подписанного CRX.</small></span></li>
              <li><b>2</b><span><strong>Распакованный запуск</strong><small>Открываем браузер с YMus через <code>--load-extension</code>.</small></span></li>
              <li><b>3</b><span><strong>Fallback</strong><small>Готовим папку, копируем путь и открываем страницу расширений.</small></span></li>
            </ol>

            <div class="method-list">
              <button class="primary-button" data-action="install-all" ${canPrepare ? "" : "disabled"}>
                ${state.loading ? "Проверяем браузеры" : selected.length ? "Policy: установить CRX" : "Выберите браузер"}
                <span aria-hidden="true">→</span>
              </button>
              <button class="method-card" data-action="launch-unpacked" ${canPrepare ? "" : "disabled"}>
                <strong>Запустить в текущем профиле</strong>
                <small>Работает, если браузер не проигнорирует <code>--load-extension</code>.</small>
              </button>
              <button class="method-card" data-action="launch-isolated" ${canPrepare ? "" : "disabled"}>
                <strong>Запустить в отдельном профиле</strong>
                <small>Самый стабильный запуск unpacked, но логины будут отдельные.</small>
              </button>
              <button class="method-card" data-action="manual-unpacked" ${selectedFirst && !state.loading ? "" : "disabled"}>
                <strong>Ручной fallback</strong>
                <small>Откроем ${selectedFirst ? escapeHtml(selectedFirst.name) : "браузер"} и скопируем путь к папке.</small>
              </button>
              <button class="method-card method-card--warning" data-action="auto-wizard" ${selectedFirst && !state.loading ? "" : "disabled"}>
                <strong>Попробовать авто-мастер</strong>
                <small>Экспериментально: пытается нажать Developer mode и Load unpacked.</small>
              </button>
            </div>

            ${
              state.prepared
                ? `
                  <div class="path-box">
                    <span>Пакет CRX</span>
                    <code>${escapeHtml(state.prepared.path)}</code>
                    <span>Extension ID</span>
                    <code>${escapeHtml(state.prepared.extensionId)}</code>
                    <span>Update URL</span>
                    <code>${escapeHtml(state.prepared.updateUrl)}</code>
                    <span>SHA-256</span>
                    <code>${escapeHtml(state.prepared.sha256)}</code>
                    <div class="path-actions">
                      <button class="secondary-button" data-action="copy-crx-path">Копировать путь</button>
                      <button class="secondary-button" data-action="open-crx-folder">Показать файл</button>
                    </div>
                  </div>
                `
                : ""
            }

            ${
              state.unpacked
                ? `
                  <div class="path-box">
                    <span>Распакованная папка</span>
                    <code>${escapeHtml(state.unpacked.path)}</code>
                    <span>Версия</span>
                    <code>${escapeHtml(state.unpacked.version)}</code>
                    <div class="path-actions">
                      <button class="secondary-button" data-action="copy-unpacked-path">Копировать путь</button>
                      <button class="secondary-button" data-action="open-unpacked-folder">Показать папку</button>
                    </div>
                  </div>
                `
                : ""
            }

            <div class="test-panel">
              <div class="test-panel__head">
                <strong>Тестирование</strong>
                <span>быстрые проверки без лишних переходов</span>
              </div>
              <div class="test-grid">
                <button class="secondary-button" data-action="test-crx" ${selected.length && !state.loading ? "" : "disabled"}>Тест CRX</button>
                <button class="secondary-button" data-action="test-unpacked" ${selected.length && !state.loading ? "" : "disabled"}>Тест папки</button>
                <button class="secondary-button" data-action="test-open-page" ${selectedFirst && !state.loading ? "" : "disabled"}>Открыть extensions</button>
                <button class="secondary-button" data-action="test-copy-path" ${state.unpacked ? "" : "disabled"}>Копировать путь</button>
              </div>
            </div>

            <div class="notice notice--${state.notice.tone}">
              <i aria-hidden="true"></i>
              <span>${escapeHtml(state.notice.text)}</span>
            </div>
          </aside>
        </div>

        <footer>
          <span>YMus Desktop 0.1.0</span>
          <span>Файлы браузеров и профилей не изменяются скрытно</span>
        </footer>
      </main>
    </div>
  `;
}

async function detectBrowsers() {
  state.loading = true;
  state.notice = { tone: "info", text: "Ищем браузеры на этом компьютере" };
  render();

  try {
    const browsers = isTauri ? await invoke<BrowserInfo[]>("detect_browsers") : demoBrowsers;
    state.browsers = browsers.sort(
      (a, b) => browserOrder.indexOf(a.id) - browserOrder.indexOf(b.id),
    );
    state.selected = new Set(installedChromiumBrowsers().map((browser) => browser.id));
    const count = installedChromiumBrowsers().length;
    state.notice = {
      tone: count ? "success" : "error",
      text: count ? `Найдено совместимых браузеров: ${count}` : "Совместимые Chromium-браузеры не найдены",
    };
  } catch (error) {
    state.browsers = [];
    state.notice = { tone: "error", text: `Не удалось проверить браузеры: ${String(error)}` };
  } finally {
    state.loading = false;
    render();
  }
}

async function ensureCrxPackage() {
  if (state.prepared) return state.prepared;
  if (!state.selected.size) return;

  state.loading = true;
  state.notice = { tone: "info", text: "Проверяем и подготавливаем CRX-пакет" };
  render();

  try {
    if (!isTauri) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      throw new Error("Подготовка файлов доступна после запуска desktop-приложения");
    }

    state.prepared = await invoke<PreparedExtension>("prepare_crx_package");
    state.notice = {
      tone: "success",
      text: `YMus ${state.prepared.version} проверен. Теперь можно установить CRX в выбранные браузеры.`,
    };
    return state.prepared;
  } catch (error) {
    state.notice = { tone: "error", text: String(error) };
  } finally {
    state.loading = false;
    render();
  }
}

async function ensureUnpackedPackage() {
  if (state.unpacked) return state.unpacked;
  if (!state.selected.size) return;

  state.loading = true;
  state.notice = { tone: "info", text: "Готовим распакованную папку YMus" };
  render();

  try {
    if (!isTauri) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      throw new Error("Подготовка папки доступна после запуска desktop-приложения");
    }

    state.unpacked = await invoke<PreparedExtension>("prepare_local_extension");
    state.notice = {
      tone: "success",
      text: `Распакованная папка YMus ${state.unpacked.version} готова.`,
    };
    return state.unpacked;
  } catch (error) {
    state.notice = { tone: "error", text: String(error) };
  } finally {
    state.loading = false;
    render();
  }
}

async function openBrowser(browserId: string) {
  try {
    await invoke("open_extensions_page", { browserId });
    state.notice = {
      tone: "info",
      text: "Включите режим разработчика, нажмите «Загрузить распакованное» и выберите папку YMus из буфера обмена.",
    };
  } catch (error) {
    state.notice = { tone: "error", text: `Не удалось открыть браузер: ${String(error)}` };
  }
  render();
}

async function installCrxToBrowser(browserId: string) {
  const prepared = await ensureCrxPackage();
  if (!prepared) return;

  try {
    if (!isTauri) {
      throw new Error("CRX-установка доступна после запуска desktop-приложения");
    }

    const message = await invoke<string>("install_crx_extension", {
      browserId,
      crxPath: prepared.path,
    });
    state.notice = {
      tone: "success",
      text: message,
    };
  } catch (error) {
    state.notice = { tone: "error", text: `Не удалось установить CRX: ${String(error)}` };
  }
  render();
}

async function installCrxToSelectedBrowsers() {
  const prepared = await ensureCrxPackage();
  if (!prepared) return;

  const selected = selectedBrowsers();
  let installed = 0;
  for (const browser of selected) {
    try {
      await invoke("install_crx_extension", {
        browserId: browser.id,
        crxPath: prepared.path,
      });
      installed += 1;
    } catch (error) {
      state.notice = {
        tone: "error",
        text: `Установлено ${installed} из ${selected.length}. Ошибка ${browser.name}: ${String(error)}`,
      };
      render();
      return;
    }
  }

  state.notice = {
    tone: "success",
    text: `CRX прописан в браузеры: ${installed}. Если расширение не появилось сразу, перезапустите браузер.`,
  };
  render();
}

async function launchUnpackedToSelected(isolated: boolean) {
  const unpacked = await ensureUnpackedPackage();
  if (!unpacked) return;

  const selected = selectedBrowsers();
  let launched = 0;
  for (const browser of selected) {
    try {
      await invoke(isolated ? "launch_isolated_with_extension" : "launch_with_extension", {
        browserId: browser.id,
        extensionPath: unpacked.path,
      });
      launched += 1;
    } catch (error) {
      state.notice = {
        tone: "error",
        text: `Запущено ${launched} из ${selected.length}. Ошибка ${browser.name}: ${String(error)}`,
      };
      render();
      return;
    }
  }

  state.notice = {
    tone: "success",
    text: isolated
      ? `YMus запущен в отдельных профилях: ${launched}.`
      : `YMus передан браузерам через --load-extension: ${launched}. Если браузер уже был открыт, он мог проигнорировать флаг.`,
  };
  render();
}

async function manualUnpackedInstall() {
  const unpacked = await ensureUnpackedPackage();
  const browser = selectedBrowsers()[0];
  if (!unpacked || !browser) return;

  try {
    await navigator.clipboard.writeText(unpacked.path);
    await invoke("open_extensions_page", { browserId: browser.id });
    state.notice = {
      tone: "info",
      text: `Путь к папке скопирован. В ${browser.name}: Developer mode → Load unpacked → вставьте путь.`,
    };
  } catch (error) {
    state.notice = { tone: "error", text: `Не удалось открыть ручной режим: ${String(error)}` };
  }
  render();
}

async function autoWizard() {
  const unpacked = await ensureUnpackedPackage();
  const browser = selectedBrowsers()[0];
  if (!unpacked || !browser) return;

  try {
    const message = await invoke<string>("start_unpacked_auto_wizard", {
      browserId: browser.id,
      extensionPath: unpacked.path,
    });
    state.notice = { tone: "info", text: message };
  } catch (error) {
    state.notice = { tone: "error", text: `Автомастер не запустился: ${String(error)}` };
  }
  render();
}

async function testCrxPackage() {
  const prepared = await ensureCrxPackage();
  if (!prepared) return;
  state.notice = {
    tone: "success",
    text: `CRX тест пройден: v${prepared.version}, hash совпадает.`,
  };
  render();
}

async function testUnpackedPackage() {
  const unpacked = await ensureUnpackedPackage();
  if (!unpacked) return;
  state.notice = {
    tone: "success",
    text: `Папка тест пройдена: manifest.json найден, v${unpacked.version}.`,
  };
  render();
}

async function testOpenExtensionsPage() {
  const browser = selectedBrowsers()[0];
  if (!browser) return;
  await openBrowser(browser.id);
}

async function copyPath(path: string | undefined) {
  if (!path) return;
  try {
    await navigator.clipboard.writeText(path);
    state.notice = { tone: "success", text: "Путь скопирован" };
  } catch {
    state.notice = { tone: "error", text: "Не удалось скопировать путь" };
  }
  render();
}

async function openFolder(path: string | undefined) {
  if (!path) return;
  try {
    await invoke("open_folder", { path });
  } catch (error) {
    state.notice = { tone: "error", text: `Не удалось открыть папку: ${String(error)}` };
    render();
  }
}

app.addEventListener("change", (event) => {
  const input = (event.target as HTMLElement).closest<HTMLInputElement>("[data-browser-id]");
  if (!input || input.disabled) return;

  if (input.checked) state.selected.add(input.dataset.browserId!);
  else state.selected.delete(input.dataset.browserId!);
  state.notice = {
    tone: "info",
    text: state.selected.size ? "Можно подготовить установку" : "Выберите хотя бы один Chromium-браузер",
  };
  render();
});

app.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-action]");
  if (!button || button.disabled) return;

  const action = button.dataset.action;
  if (action === "refresh") void detectBrowsers();
  if (action === "install-all") void installCrxToSelectedBrowsers();
  if (action === "install-browser" && button.dataset.browserId) void installCrxToBrowser(button.dataset.browserId);
  if (action === "launch-unpacked") void launchUnpackedToSelected(false);
  if (action === "launch-isolated") void launchUnpackedToSelected(true);
  if (action === "manual-unpacked") void manualUnpackedInstall();
  if (action === "auto-wizard") void autoWizard();
  if (action === "test-crx") void testCrxPackage();
  if (action === "test-unpacked") void testUnpackedPackage();
  if (action === "test-open-page") void testOpenExtensionsPage();
  if (action === "test-copy-path") void copyPath(state.unpacked?.path);
  if (action === "copy-crx-path") void copyPath(state.prepared?.path);
  if (action === "copy-unpacked-path") void copyPath(state.unpacked?.path);
  if (action === "open-crx-folder") void openFolder(state.prepared?.path);
  if (action === "open-unpacked-folder") void openFolder(state.unpacked?.path);
  if (action === "open-browser" && button.dataset.browserId) void openBrowser(button.dataset.browserId);
});

render();
void detectBrowsers();
window.setTimeout(() => {
  state.booting = false;
  render();
}, 950);
