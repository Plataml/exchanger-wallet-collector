# Установка и запуск на VPS

## Требования

- Ubuntu 22.04+
- 2GB RAM минимум
- Docker и docker-compose

## Установка Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

## Деплой

```bash
git clone <repo-url> exchanger-wallet-collector
cd exchanger-wallet-collector

# Конфигурация
cp .env.example .env
nano .env  # настроить прокси

# Список обменников
nano exchangers.json

# Запуск
docker-compose up -d

# Логи
docker-compose logs -f
```

## Автозапуск через systemd

```bash
sudo cp deploy/exchanger-collector.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable exchanger-collector
sudo systemctl start exchanger-collector
```

## Управление

```bash
# Статус
sudo systemctl status exchanger-collector

# Логи
sudo journalctl -u exchanger-collector -f

# Перезапуск
sudo systemctl restart exchanger-collector
```
