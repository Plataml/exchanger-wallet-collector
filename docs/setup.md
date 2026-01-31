# Установка и запуск на VPS

## Текущий VPS

```
IP: 93.114.128.73
User: root
Password: v9DUhZQFpyRAp
Путь: /root/exchanger-wallet-collector
```

```bash
ssh root@93.114.128.73
```

## Требования

- Ubuntu 22.04+
- 2GB RAM минимум (4GB для антидетект браузера)
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
nano .env  # настроить прокси и капчу

# Список обменников
nano exchangers.json

# Запуск
docker-compose up -d

# Логи
docker-compose logs -f
```

## Конфигурация .env

```env
# Прокси (ThorData или аналоги)
PROXY_HOST=p.webshare.io
PROXY_PORT=80
PROXY_USER=user
PROXY_PASS=pass

# Капча (2captcha.com)
CAPTCHA_API_KEY=your_2captcha_key

# Антидетект браузер (опционально)
ANTIDETECT_CDP_URL=http://localhost:35000

# Telegram уведомления
TELEGRAM_TOKEN=bot_token
TELEGRAM_CHAT_ID=chat_id

# Данные для форм
FORM_EMAIL=test@example.com
FORM_PHONE=9991234567
FORM_WALLET_BTC=bc1q...
FORM_WALLET_ETH=0x...
```

## Антидетект браузер

Для обхода капч и блокировок рекомендуется использовать антидетект браузер.

### Установка Multilogin

```bash
# Скачать с multilogin.com
chmod +x multilogin-installer.sh
./multilogin-installer.sh

# Запуск
./multilogin --headless
```

### Подключение к коллектору

1. Создать профиль в Multilogin
2. Запустить профиль через API
3. Указать CDP URL в `.env`:

```env
ANTIDETECT_CDP_URL=http://localhost:35000
```

См. [antidetect.md](antidetect.md) для подробностей.

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

# Статистика
npm run stats
```
