# Статус проекта

**Последнее обновление:** 2026-01-31 (актуализировано)

## Главная цель

Собрать блокчейн-адреса с криптообменников при совершении обменов. Автоматизировать сбор с ~60% обменников, работающих на известных CMS платформах.

## Текущая статистика

### База данных
- **1426** обменников в базе
- **46** неудачных попыток
- **0** собранных кошельков (пока)

### Детекция CMS (802 просканировано)
| CMS | Количество | Статус движка |
|-----|------------|---------------|
| VueSpa | 333 | ✅ Готов (общий) |
| iEXExchanger | 74 | ✅ Готов |
| BoxExchanger | 27 | ✅ Готов |
| PremiumExchanger | 12 | ✅ Готов |
| Exchanger-CMS | 7 | ❌ Нужен |
| Cloudflare | 65 | ⚠️ Антидетект |
| Unknown | 279 | - |
| Multipage | 2 | ✅ Готов |
| Errors | 3 | — |

**Покрытие:** 448 сайтов с движками (56%), из них 65 за Cloudflare

## Реализованные движки

### 1. PremiumExchangerEngine (12 сайтов)
- Самый распространённый CMS (~30% обменников)
- Поддержка URL форматов: `exchange_` и `xchange_`
- Поддержка вариаций кодов валют (SBERRUB, SBPRUB, SBRFRUF)
- Email верификация через Gmail IMAP
- Обход капчи через 2captcha

### 2. IexExchangerEngine (74 сайта)
- Vue 3 SPA с Sanctum авторизацией
- API-based exchange flow
- Поддержка dropdown селекторов валют
- Email верификация (код или ссылка)

### 3. BoxExchangerEngine (27 сайтов)
- Nuxt.js SPA с exchange-calculator
- Поддержка кастомных dropdown компонентов
- Email верификация

### 4. VueSpaEngine
- Vue.js SPA обменники (общий)
- Динамическая загрузка форм

### 5. MultipageEngine
- Многостраничные обменники
- Пошаговые формы

## Интеграции

### Gmail IMAP (для email верификации)
```env
GMAIL_USER=carolynrogers1912@gmail.com
GMAIL_APP_PASSWORD=tvqn vrlq dcdn hyht
FORM_EMAIL=carolynrogers1912@gmail.com
```

**Статус:** ✅ Работает на VPS

**Зачем:** Многие обменники блокируют временные email (1secmail, mailinator). Gmail воспринимается как "реальный" email.

### 2captcha
```env
CAPTCHA_API_KEY=5ea0a7c62f6dfcfd5f8d55e4cb977f0c
```

### Telegram уведомления
```env
TELEGRAM_TOKEN=7963606215:AAHPVYaWSu7EBSdko-7vFVzCnZvBzkMqttQ
TELEGRAM_CHAT_ID=165150064
```

## VPS

```
IP: 93.114.128.73
User: root
Password: v9DUhZQFpyRAp
Путь: /root/exchanger-wallet-collector
```

**Подключение:**
```bash
ssh root@93.114.128.73
```

## Тестовые данные для форм

```env
FORM_EMAIL=carolynrogers1912@gmail.com
FORM_PHONE=9991234567
FORM_CARD=4276921306008364
FORM_FIO=Иванов Иван Иванович
FORM_BANK=Сбербанк
FORM_WALLET_BTC=bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh
FORM_WALLET_ETH=0x742d35Cc6634C0532925a3b844Bc9e7595f5bE12
FORM_WALLET_USDT=TN2DKuFEQz3mVsXVL4kAkGzFwfpVNvP8Ep
```

## Известные проблемы

### 1. SmartFormFiller не распознаёт некоторые формы
**Пример:** coins.black - поля `amount_from` и `wallet/card` не обнаружены.

**Решения:**
- Улучшить эвристику SmartFormFiller
- Создать JSON-адаптеры для конкретных обменников

### 2. URL формат отличается на разных CMS
**Решено:** Добавлена поддержка `exchange_` и `xchange_` префиксов.

### 3. Вариации кодов валют
**Решено:** `getCurrencyVariations()` генерирует все варианты (SBERRUB, SBPRUB, SBRFRUB и т.д.)

## Следующие шаги

См. **[plan-phase-1-2.md](plan-phase-1-2.md)** для детального плана.

### Фаза 1: Тестирование
1. Протестировать PremiumExchanger на 5 сайтах
2. Протестировать IexExchanger на 5 сайтах
3. Протестировать BoxExchanger на 5 сайтах
4. Исправить найденные баги

### Фаза 2: Расширение
1. Создать движок Exchanger-CMS (7 сайтов)
2. Протестировать VueSpa на 20 сайтах
3. Проанализировать Unknown (279 сайтов)
4. Запустить массовый сбор на 448 сайтах

## Полезные команды

```bash
# Анализ конкретного обменника
npm run analyze -- --domain=example.com

# Сбор с конкретного обменника
npm run collect -- --domain=example.com

# Статистика
npm run stats

# Тест Gmail подключения
npx ts-node test-gmail.ts
```

## Файлы конфигурации

- `.env` - переменные окружения (credentials, API keys)
- `data/database.sqlite` - SQLite база данных
- `data/cms-detection-v2.json` - результаты сканирования CMS
- `src/engines/` - движки для разных CMS
- `src/adapters/` - JSON-адаптеры для конкретных сайтов
