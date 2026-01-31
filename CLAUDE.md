# START HERE

**[docs/index.md](docs/index.md)** - навигация по всей документации проекта

## Правила

1. **НЕ открывать сайты обменников на локальной машине!**
   - Только через VPS: `ssh root@93.114.128.73`
   - Путь на VPS: `/root/exchanger-wallet-collector`

2. **Команды запускать на VPS:**
   - `npm run collect -- --domain=example.com`
   - `npm run analyze -- --domain=example.com`
   - `npm run stats`

## Цель проекта

Автономный сбор блокчейн-адресов с криптообменников при создании заявок на обмен.

## Быстрые ссылки

- [docs/status.md](docs/status.md) - текущий статус и прогресс
- [docs/setup.md](docs/setup.md) - установка
- [docs/architecture.md](docs/architecture.md) - архитектура
- [docs/antidetect.md](docs/antidetect.md) - антидетект браузер
