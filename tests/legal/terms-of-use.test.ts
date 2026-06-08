// Smoke tests for docs/terms-of-use.md
// Validates: Requirements 1.1–1.6, 2.1–2.5, 3.1–3.4, 4.1–4.6, 5.1–5.7, 6.1–6.4, 7.1–7.5, 10.1, 10.3, 10.5, 10.6, 10.8, 10.10

import * as fs from 'fs';
import * as path from 'path';

const filePath = path.resolve(__dirname, '../../docs/terms-of-use.md');

describe('Terms of Use document', () => {
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(filePath, 'utf-8');
  });

  it('file exists and is readable', () => {
    expect(fs.existsSync(filePath)).toBe(true);
    expect(content.length).toBeGreaterThan(0);
  });

  it('contains date in DD.MM.YYYY format', () => {
    expect(content).toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  it('contains all 11 required sections', () => {
    const requiredSections = [
      'Общие положения',
      'Допустимое использование',
      'Запрет коммерческого использования',
      'Ограничение ответственности',
      'Отказ от гарантий',
      'Распространение и запрет утечек',
      'Полузакрытый доступ',
      'Санкции за нарушение',
      'Применимое право',
      'Изменение правил',
      'Контактная информация',
    ];

    for (const section of requiredSections) {
      expect(content).toContain(section);
    }
  });

  it('contains key legal phrases', () => {
    expect(content).toContain('как есть');
    expect(content).toContain('ответственность');
    expect(content).toMatch(/Российск\S+ Федерац/);
  });

  it('contains contact information', () => {
    expect(content).toContain('Контактная информация');
    expect(content).toMatch(/@\w+/);
  });
});
