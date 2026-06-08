// Санитайзер старой плавающей кнопки "Скачать всё".
//
// Назначение: удалить из DOM элементы, ранее внедрявшиеся модулем
// `bulk-button.ts` (Bulk_Button_Legacy), и не позволить им появиться вновь
// в течение жизни страницы. Это нужно для пользователей, у которых кнопка
// уже была отрисована старой версией расширения до обновления, а также
// на случай повторной инъекции контент-скрипта при SPA-навигации.
//
// Контракт:
//   - removeLegacyBulkArtifacts() вызывается синхронно при инициализации.
//   - startLegacyBulkSanitizer() устанавливает MutationObserver, который
//     удаляет элементы #ymd-bulk-btn / #ymd-bulk-status в течение < 1000 мс
//     с момента их обнаружения.
//
// Соответствие требованиям: 2.1, 2.2, 2.4, 2.5, 2.6.

const LEGACY_BULK_BUTTON_ID = "ymd-bulk-btn";
const LEGACY_BULK_STATUS_ID = "ymd-bulk-status";

const LEGACY_IDS: readonly string[] = [
  LEGACY_BULK_BUTTON_ID,
  LEGACY_BULK_STATUS_ID,
];

/**
 * Безопасно удаляет узел из DOM. Если узел уже отсоединён
 * (`isConnected === false`), повторное удаление пропускается.
 */
function safeRemove(node: Element): void {
  if (!node.isConnected) return;
  node.remove();
}

/**
 * Синхронно удаляет существующие в DOM узлы Bulk_Button_Legacy
 * (`#ymd-bulk-btn`, `#ymd-bulk-status`).
 *
 * Вызывается при инициализации Content_Script до построения нового UI,
 * чтобы в одном тике рендера у пользователя не оказалось двух вариантов
 * кнопки одновременно.
 */
export function removeLegacyBulkArtifacts(): void {
  for (const id of LEGACY_IDS) {
    const el = document.getElementById(id);
    if (el !== null) {
      safeRemove(el);
    }
  }
}

/**
 * Возвращает true, если узел `node` является элементом с одним из целевых
 * legacy-ID или содержит такой элемент в своём поддереве.
 */
function findLegacyArtifactsIn(node: Node): Element[] {
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const el = node as Element;
  const found: Element[] = [];
  if (el.id === LEGACY_BULK_BUTTON_ID || el.id === LEGACY_BULK_STATUS_ID) {
    found.push(el);
  }
  // На случай, если legacy-узел добавлен внутри обёртки.
  for (const id of LEGACY_IDS) {
    const nested = el.querySelector(`#${id}`);
    if (nested !== null && !found.includes(nested)) {
      found.push(nested);
    }
  }
  return found;
}

/**
 * Запускает MutationObserver на `document.body`, удаляющий любые
 * добавляемые в DOM узлы с ID `#ymd-bulk-btn` или `#ymd-bulk-status`.
 *
 * Возвращает дескриптор с методом `stop()`, отключающим наблюдение
 * (например, при выгрузке вкладки или для тестов).
 */
export function startLegacyBulkSanitizer(): { stop: () => void } {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      // Нас интересуют только добавления в дерево — атрибуты не наблюдаем.
      if (record.type !== "childList") continue;
      record.addedNodes.forEach((added) => {
        const artifacts = findLegacyArtifactsIn(added);
        for (const artifact of artifacts) {
          safeRemove(artifact);
        }
      });
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  return {
    stop(): void {
      observer.disconnect();
    },
  };
}
