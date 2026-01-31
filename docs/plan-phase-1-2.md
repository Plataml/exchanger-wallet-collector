# План: Фазы 1-2

## Актуальная статистика (cms-detection-v2.json)

| CMS | Сайтов | Движок |
|-----|--------|--------|
| PremiumExchanger | 12 | ✅ Готов |
| iEXExchanger | 74 | ✅ Готов |
| BoxExchanger | 27 | ✅ Готов |
| VueSpa | 333 | ✅ Готов (общий) |
| Multipage | 2 | ✅ Готов |
| Exchanger-CMS | 7 | ❌ Нужен |
| Cloudflare | 65 | ⚠️ Требует антидетект |
| Unknown | 279 | — |

**Итого с движками:** 448 сайтов (56%)

---

## Фаза 1: Тестирование движков

### 1.1 PremiumExchanger (5 сайтов)

```bash
# На VPS:
npm run collect -- --domain=coins.black
npm run collect -- --domain=wmstream.pro
npm run collect -- --domain=altinbit.com
npm run collect -- --domain=belqi.net
npm run collect -- --domain=24wm.kz
```

**Чек-лист:**
- [ ] Открытие страницы обмена
- [ ] Выбор валют (BTC → SBERRUB)
- [ ] Заполнение суммы
- [ ] Заполнение реквизитов (карта/кошелёк)
- [ ] Решение капчи
- [ ] Email верификация
- [ ] Извлечение адреса

### 1.2 IexExchanger (5 сайтов)

```bash
npm run collect -- --domain=nixexchange.com
npm run collect -- --domain=crypto-store.cc
npm run collect -- --domain=paymarket.cc
npm run collect -- --domain=global-ex.cc
npm run collect -- --domain=freechange.cc
```

### 1.3 BoxExchanger (5 сайтов)

```bash
npm run collect -- --domain=exbox.app
npm run collect -- --domain=digichanger.pro
npm run collect -- --domain=obmen-box.net
npm run collect -- --domain=w-box.io
npm run collect -- --domain=zombie.cash
```

### 1.4 Результаты тестирования

| Движок | Тестов | Успешно | Проблемы |
|--------|--------|---------|----------|
| PremiumExchanger | 0/5 | — | — |
| IexExchanger | 0/5 | — | — |
| BoxExchanger | 0/5 | — | — |

---

## Фаза 2: Расширение охвата

### 2.1 Создать движок Exchanger-CMS (7 сайтов)

**Сайты для анализа:**
```bash
npm run analyze -- --domain=<exchanger-cms-site>
```

### 2.2 Анализ VueSpa сайтов (333 шт)

Многие VueSpa сайты могут работать с общим VueSpaEngine. Нужно:
1. Протестировать 10-20 случайных сайтов
2. Выявить подгруппы с общими паттернами
3. Создать специализированные движки если нужно

### 2.3 Анализ Unknown (279 сайтов)

```bash
npm run analyze-unknown
```

Задачи:
- Кластеризация по технологиям
- Выявление новых CMS-паттернов
- Ручные JSON-адаптеры для крупных сайтов

---

## Команды на VPS

```bash
# Подключение
ssh root@93.114.128.73
cd /root/exchanger-wallet-collector

# Синхронизация кода
git pull

# Тестирование одного сайта
npm run collect -- --domain=example.com

# Статистика
npm run stats

# Логи
tail -f logs/collector.log
```

---

## Критерии завершения

### Фаза 1 завершена когда:
- [ ] Протестировано 15 сайтов (по 5 на движок)
- [ ] Успешность ≥ 60% на каждом движке
- [ ] Критические баги исправлены

### Фаза 2 завершена когда:
- [ ] Движок Exchanger-CMS готов
- [ ] VueSpa протестирован на 20 сайтах
- [ ] Есть понимание структуры Unknown сайтов
