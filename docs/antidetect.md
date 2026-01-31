# Антидетект браузер для обхода защиты

Подключение антидетект браузера через CDP позволяет обходить:
- Капчи (reCAPTCHA, hCaptcha, Cloudflare)
- Fingerprint-детекторы
- Bot-защиту

## Преимущества перед обычным Playwright

| Параметр | Playwright | Антидетект |
|----------|------------|------------|
| Fingerprint | Обнаруживаемый | Уникальный/реальный |
| WebGL | Headless-сигнатура | Настоящая GPU |
| Canvas | Детектится | Рандомизирован |
| Cookies/Storage | Чистые | Прогретые профили |
| IP репутация | Зависит от прокси | Привязка к профилю |

## Поддерживаемые браузеры

### Multilogin
```env
ANTIDETECT_CDP_URL=http://localhost:35000
```

Запуск профиля через API:
```bash
curl -X POST "http://localhost:35000/api/v1/profile/start?profileId=xxx"
```

### GoLogin
```env
ANTIDETECT_CDP_URL=ws://127.0.0.1:{PORT}
```

Порт динамический, получать через GoLogin API.

### Dolphin Anty
```env
ANTIDETECT_API_URL=http://localhost:3001
ANTIDETECT_PROFILE_ID=xxx
```

### AdsPower
```env
ANTIDETECT_CDP_URL=http://localhost:50325
```

## Настройка профилей

Для сбора кошельков рекомендуется:

1. **Создать несколько профилей** - ротация между обменниками
2. **Прогреть профили** - посетить популярные сайты вручную
3. **Привязать резидентные прокси** - один IP на профиль
4. **Настроить timezone/language** - под страну прокси

## Интеграция с коллектором

В `src/browser.ts` можно добавить логику:

```typescript
async function launchBrowser(): Promise<Browser> {
  const cdpUrl = process.env.ANTIDETECT_CDP_URL;

  if (cdpUrl) {
    // Подключаемся к антидетект браузеру
    return chromium.connectOverCDP(cdpUrl);
  }

  // Fallback на обычный Playwright
  return chromium.launch({ headless: config.headless });
}
```

## Workflow на VPS

1. Установить антидетект браузер (Multilogin/GoLogin)
2. Создать и прогреть профили
3. Запустить профиль через API
4. Указать CDP URL в `.env`
5. Запустить коллектор

## Рекомендации

- **Один профиль = один обменник** - снижает риск бана
- **Ротация профилей** - не использовать один профиль постоянно
- **Интервалы между запросами** - 30-120 секунд рандом
- **Мониторинг блокировок** - алерты в Telegram
