import https from 'https';
import { config } from './config';
import { logger } from './logger';

interface TelegramMessage {
  chat_id: string;
  text: string;
  parse_mode?: 'HTML' | 'Markdown';
}

async function sendRequest(method: string, data: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(data);

    const options = {
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${config.telegramToken}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(body);
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

export async function sendTelegram(text: string): Promise<boolean> {
  if (!config.telegramToken || !config.telegramChatId) {
    return false;
  }

  try {
    const message: TelegramMessage = {
      chat_id: config.telegramChatId,
      text,
      parse_mode: 'HTML'
    };

    const result = await sendRequest('sendMessage', message);
    return result?.ok === true;
  } catch (error: any) {
    logger.error(`Telegram error: ${error.message}`);
    return false;
  }
}

export async function notifySuccess(exchanger: string, address: string, pair: string): Promise<void> {
  const text = `✅ <b>Адрес собран</b>\n\n` +
    `📍 ${exchanger}\n` +
    `💱 ${pair}\n` +
    `📬 <code>${address}</code>`;

  await sendTelegram(text);
}

export async function notifyError(exchanger: string, error: string): Promise<void> {
  const text = `❌ <b>Ошибка</b>\n\n` +
    `📍 ${exchanger}\n` +
    `⚠️ ${error}`;

  await sendTelegram(text);
}

export async function notifyStats(
  total: number,
  success: number,
  failed: number,
  newAddresses: number
): Promise<void> {
  const text = `📊 <b>Статистика сбора</b>\n\n` +
    `🔄 Обработано: ${total}\n` +
    `✅ Успешно: ${success}\n` +
    `❌ Ошибки: ${failed}\n` +
    `🆕 Новых адресов: ${newAddresses}`;

  await sendTelegram(text);
}

export async function notifyStart(): Promise<void> {
  await sendTelegram('🚀 <b>Коллектор запущен</b>');
}

export async function notifyStop(): Promise<void> {
  await sendTelegram('🛑 <b>Коллектор остановлен</b>');
}
