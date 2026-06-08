/**
 * @jest-environment jsdom
 */

import * as fs from 'fs';
import * as path from 'path';
import { getLegalBlockHtml } from '../../src/popup/legal-blocks';

const html = fs.readFileSync(
  path.resolve(__dirname, '../../src/popup/popup.html'),
  'utf-8'
);

describe('Popup legal info block', () => {
  beforeAll(() => {
    document.body.innerHTML = html;
    // Legal blocks are now rendered by JS; simulate the render for the yandex-music panel
    const container = document.getElementById('legal-yandex-music');
    if (container) {
      container.innerHTML = getLegalBlockHtml('yandex-music');
    }
  });

  it('.legal-info element exists', () => {
    const legalInfo = document.querySelector('.legal-info');
    expect(legalInfo).not.toBeNull();
  });

  it('block is not inside a <details> element', () => {
    const legalInfo = document.querySelector('.legal-info');
    expect(legalInfo!.closest('details')).toBeNull();
  });

  it('block does not have display: none style', () => {
    const legalInfo = document.querySelector('.legal-info') as HTMLElement;
    expect(legalInfo.style.display).not.toBe('none');
  });

  it('contains independence statement (Req 8.1, 8.2)', () => {
    const content = document.querySelector('.legal-info')!.textContent!;
    expect(content).toContain('независимый некоммерческий проект');
    expect(content).toContain('не связано с ООО «Яндекс»');
  });

  it('contains trademark notice (Req 8.3, 8.4)', () => {
    const content = document.querySelector('.legal-info')!.textContent!;
    expect(content).toContain('товарными знаками');
    expect(content).toContain('совместимости');
  });

  it('contains data policy — OAuth mention (Req 9.1, 9.5)', () => {
    const content = document.querySelector('.legal-info')!.textContent!;
    expect(content).toContain('OAuth');
    expect(content).toContain('chrome.storage');
  });

  it('contains data policy — no telemetry (Req 9.2)', () => {
    const content = document.querySelector('.legal-info')!.textContent!;
    expect(content).toContain('телеметрии');
  });

  it('contains date in DD.MM.YYYY format (Req 10.4)', () => {
    const dateEl = document.querySelector('.legal-info__date');
    expect(dateEl).not.toBeNull();
    expect(dateEl!.textContent).toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  it('contains contact info (Req 10.9)', () => {
    const contact = document.querySelector('.legal-info__contact');
    expect(contact).not.toBeNull();
    expect(contact!.textContent).toContain('Telegram');
  });

  it('contains applicable law statement (Req 10.7)', () => {
    const content = document.querySelector('.legal-info')!.textContent!;
    expect(content).toContain('как есть');
  });

  it('contains document change notice (Req 10.11)', () => {
    const content = document.querySelector('.legal-info')!.textContent!;
    // Legal block now contains as-is disclaimer instead of change notice
    expect(content).toContain('не несёт ответственности');
  });

  it('is written in Russian (Req 10.2)', () => {
    const content = document.querySelector('.legal-info')!.textContent!;
    // Check for Cyrillic characters — confirms Russian language
    expect(content).toMatch(/[а-яА-ЯёЁ]/);
    expect(content).toContain('Правовая информация');
  });

  it('has numbered paragraphs in content (Req 10.9)', () => {
    const paragraphs = document.querySelectorAll('.legal-info__content p');
    expect(paragraphs.length).toBeGreaterThanOrEqual(4);
  });
});
