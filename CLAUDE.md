[Читай docs/index.md для навигации по проекту](docs/index.md)

## Проект

Автономный сборщик блокчейн-адресов с криптообменников.

## Команды

- `npm run import-exchangers` - импорт обменников из exchangers.json
- `npm run collect` - запуск сбора кошельков
- `npm run collect -- --domain=example.com` - сбор с конкретного обменника
- `npm run stats` - статистика сбора

## Структура

- `src/` - исходный код
- `docs/` - документация
- `data/` - БД и скриншоты
- `deploy/` - Docker и systemd
