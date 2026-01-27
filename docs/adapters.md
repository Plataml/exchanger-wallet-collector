# Написание адаптеров для обменников

## Базовый адаптер

Каждый обменник требует свой адаптер для навигации по сайту и извлечения адреса.

```typescript
interface ExchangerAdapter {
  name: string;
  domain: string;

  // Создать заявку и получить адрес
  collect(page: Page, pair: CryptoPair): Promise<CollectResult>;
}

interface CollectResult {
  address: string;
  network: string;
  screenshotPath: string;
}
```

## Создание нового адаптера

1. Создать файл `src/adapters/название-обменника.ts`
2. Реализовать интерфейс `ExchangerAdapter`
3. Зарегистрировать в `src/adapters/index.ts`

## Пример адаптера

```typescript
import { Page } from 'playwright';
import { ExchangerAdapter, CollectResult, CryptoPair } from '../types';

export const exampleAdapter: ExchangerAdapter = {
  name: 'Example Exchange',
  domain: 'example.com',

  async collect(page: Page, pair: CryptoPair): Promise<CollectResult> {
    // 1. Перейти на страницу обмена
    await page.goto(`https://${this.domain}/exchange`);

    // 2. Выбрать криптопару
    await page.selectOption('#from-currency', pair.from);
    await page.selectOption('#to-currency', pair.to);

    // 3. Заполнить форму
    await page.fill('#amount', '0.01');
    await page.fill('#wallet', 'destination-address');

    // 4. Отправить заявку
    await page.click('#submit-btn');

    // 5. Дождаться адреса
    await page.waitForSelector('.deposit-address');
    const address = await page.textContent('.deposit-address');

    // 6. Скриншот
    const screenshotPath = `data/screenshots/${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    return {
      address: address!,
      network: pair.network,
      screenshotPath
    };
  }
};
```

## Советы

- Используйте `page.waitForSelector()` для ожидания элементов
- Добавляйте случайные задержки между действиями
- Обрабатывайте капчу и блокировки
- Делайте скриншот сразу после появления адреса
