# Написание адаптеров для обменников

## Workflow на VPS

### 1. Исследование сайта

```bash
npm run explore -- --domain=example-exchange.com
```

Результат сохраняется в `data/explore/example-exchange.com/`:
- `01_main.png` - скриншот главной страницы
- `page.html` - HTML страницы
- `result.json` - найденные формы, ссылки, селекторы

### 2. Создание JSON-адаптера

Создайте файл `adapters/example-exchange.json`:

```json
{
  "name": "Example Exchange",
  "domain": "example-exchange.com",
  "pairs": [
    { "from": "USDT", "to": "BTC", "network": "TRC20" }
  ],
  "steps": [
    {
      "action": "goto",
      "url": "https://example-exchange.com/exchange"
    },
    {
      "action": "click",
      "selector": "[data-currency='USDT']"
    },
    {
      "action": "fill",
      "selector": "input[name='amount']",
      "value": "100"
    },
    {
      "action": "click",
      "selector": "button[type='submit']"
    },
    {
      "action": "wait",
      "selector": ".deposit-address",
      "timeout": 15000
    }
  ],
  "addressSelector": ".deposit-address"
}
```

### 3. Тестирование

```bash
npm run collect -- --domain=example-exchange.com
```

## Доступные действия

| Action | Параметры | Описание |
|--------|-----------|----------|
| `goto` | `url` | Переход на URL |
| `click` | `selector` | Клик по элементу |
| `fill` | `selector`, `value` | Заполнение поля |
| `select` | `selector`, `value` | Выбор в dropdown |
| `wait` | `selector` или `timeout` | Ожидание |
| `screenshot` | - | Промежуточный скриншот |
| `extract` | `selector`, `variable` | Извлечь текст в переменную |

## Плейсхолдеры

В `value` и `url` можно использовать:

- `{pair.from}` - исходная валюта (USDT)
- `{pair.to}` - целевая валюта (BTC)
- `{pair.network}` - сеть (TRC20)
- `{var.name}` - переменная из `extract`

## Советы

- Файлы с `_` в начале (`_example.json`) игнорируются
- Используйте `explore` для поиска селекторов
- Добавляйте `description` для отладки
- Тестируйте на одном обменнике перед массовым запуском
