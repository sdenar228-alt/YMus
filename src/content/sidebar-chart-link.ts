/**
 * Module: sidebar-chart-link
 *
 * Инжектит пункт "Чарт" в навигацию сайдбара Яндекс.Музыки.
 * Вставляется ВНУТРЬ ul навигации между "Коллекция" и "Ваш Плюс".
 * React удаляет чужие узлы при reconciliation, поэтому MutationObserver
 * постоянно пере-вставляет элемент при его исчезновении.
 */

const CHART_LINK_ATTR = "data-ymd-chart-nav";

const CHART_ICON = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17L9 11L13 15L21 7"/><path d="M15 7H21V13"/></svg>`;

/**
 * Вставляет элемент "Чарт" в навигацию.
 * Клонирует существующий li (для идеальных стилей) и подменяет содержимое.
 */
function injectChartLink(): boolean {
  // Уже есть?
  if (document.querySelector(`[${CHART_LINK_ATTR}]`)) return true;

  // Находим nav
  const nav = document.querySelector('nav[aria-label="Главное меню"]')
    || document.querySelector('[role="complementary"] nav')
    || document.querySelector('aside nav');
  if (!nav) return false;

  const list = nav.querySelector("ul, ol");
  if (!list) return false;

  const items = list.querySelectorAll(":scope > li");
  if (items.length < 2) return false;

  // Ищем "Ваш Плюс" — последний пункт. Вставим перед ним.
  // Ищем "Коллекция" по ссылке /collection — вставим после неё.
  let insertBeforeEl: Element | null = null;
  let templateLi: Element | null = null;

  for (let i = 0; i < items.length; i++) {
    const link = items[i].querySelector("a");
    if (!link) continue;
    const href = link.getAttribute("href") || "";
    if (href === "/collection" || href.startsWith("/collection")) {
      // Вставим после "Коллекция" = перед следующим
      templateLi = items[i];
      insertBeforeEl = items[i + 1] || null;
      break;
    }
  }

  // Fallback: вставляем перед последним
  if (!templateLi) {
    templateLi = items[items.length - 1];
    insertBeforeEl = items[items.length - 1];
  }

  // Клонируем li для идеальных стилей
  const newLi = templateLi.cloneNode(true) as HTMLElement;
  newLi.setAttribute(CHART_LINK_ATTR, "1");

  // Находим <a> внутри и подменяем
  const link = newLi.querySelector("a");
  if (!link) return false;

  link.setAttribute("href", "/chart");
  link.removeAttribute("aria-current");

  // Подменяем иконку (img или svg) — заменяем содержимое img на SVG,
  // но сохраняем родительский контейнер с его CSS-классами для корректного
  // поведения при свёрнутом сайдбаре.
  const icon = link.querySelector("img, svg");
  if (icon) {
    const svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svgEl.setAttribute("width", "24");
    svgEl.setAttribute("height", "24");
    svgEl.setAttribute("viewBox", "0 0 24 24");
    svgEl.setAttribute("fill", "none");
    svgEl.setAttribute("stroke", "currentColor");
    svgEl.setAttribute("stroke-width", "2");
    svgEl.setAttribute("stroke-linecap", "round");
    svgEl.setAttribute("stroke-linejoin", "round");
    svgEl.innerHTML = `<path d="M3 17L9 11L13 15L21 7"/><path d="M15 7H21V13"/>`;
    // Копируем className от img (может содержать size/display классы)
    if (icon.className && typeof icon.className === "string") {
      svgEl.setAttribute("class", icon.className);
    }
    icon.replaceWith(svgEl);
  }

  // Подменяем текст — ищем элемент с текстом пункта навигации (не контейнер иконки)
  // Важно: не менять структуру, только textContent, чтобы CSS классы
  // для скрытия текста при свёрнутом сайдбаре продолжали работать.
  const allEls = link.querySelectorAll("*");
  let textEl: Element | null = null;
  for (const el of allEls) {
    // Пропускаем контейнеры иконок
    if (el.querySelector("svg, img")) continue;
    if (el.closest("[style*='display:inline-flex']")) continue;
    const text = (el.textContent || "").trim();
    if (text.length > 0 && !el.children.length) {
      el.textContent = "Чарт";
      textEl = el;
      break;
    }
  }

  // Отслеживаем состояние свёрнутого сайдбара —
  // скрываем текст когда сайдбар узкий (< 100px)
  if (textEl) {
    const textElement = textEl as HTMLElement;
    const checkCollapsed = (): void => {
      const sidebar = newLi.closest('[role="complementary"]') 
        || newLi.closest("aside")
        || newLi.closest("nav")?.parentElement;
      if (sidebar) {
        const width = sidebar.getBoundingClientRect().width;
        textElement.style.display = width < 100 ? "none" : "";
      }
    };

    // Проверяем при каждой пере-вставке и по ResizeObserver
    checkCollapsed();

    // Используем ResizeObserver для отслеживания изменения ширины сайдбара
    try {
      const sidebar = document.querySelector('[role="complementary"]')
        || document.querySelector("aside");
      if (sidebar) {
        const ro = new ResizeObserver(checkCollapsed);
        ro.observe(sidebar);
      }
    } catch { /* ResizeObserver может быть недоступен */ }
  }

  // Клик — прямой переход
  link.addEventListener("click", (e) => {
    e.preventDefault();
    location.href = "/chart";
  });

  // Вставляем
  if (insertBeforeEl) {
    list.insertBefore(newLi, insertBeforeEl);
  } else {
    list.appendChild(newLi);
  }

  return true;
}

export function startSidebarChartLink(): void {
  injectChartLink();

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let injecting = false;

  const observer = new MutationObserver((mutations) => {
    if (injecting) return;

    // Реагируем только на мутации, связанные с навигацией
    let relevant = false;
    for (const m of mutations) {
      const t = m.target as HTMLElement;
      if (t.closest?.("nav") || t.tagName === "NAV") {
        relevant = true;
        break;
      }
      for (const node of m.removedNodes) {
        if (node instanceof HTMLElement && node.hasAttribute?.(CHART_LINK_ATTR)) {
          relevant = true;
          break;
        }
      }
      if (relevant) break;
    }

    if (!relevant && document.querySelector(`[${CHART_LINK_ATTR}]`)) return;

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (!document.querySelector(`[${CHART_LINK_ATTR}]`)) {
        injecting = true;
        injectChartLink();
        Promise.resolve().then(() => { injecting = false; });
      }
    }, 150);
  });

  observer.observe(document.body, { childList: true, subtree: true });
}
