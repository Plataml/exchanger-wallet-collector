/**
 * Generic IMAP Email Service for verification codes
 * Works with any IMAP provider: Gmail, Yandex, Mail.ru, custom SMTP, etc.
 * Config via env: IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASS
 * Falls back to GMAIL_USER/GMAIL_APP_PASSWORD for backward compatibility
 */

import { ImapFlow } from 'imapflow';
import { logger } from './logger';

export interface TempMailbox {
  id: string;
  email: string;
  password: string;
  token: string;
  login: string;
  domain: string;
}

export interface EmailMessage {
  id: string | number;
  from: { address: string; name: string };
  to: { address: string; name: string }[];
  subject: string;
  intro: string;
  seen: boolean;
  createdAt: string;
}

export interface EmailContent {
  id: string | number;
  from: { address: string; name: string };
  subject: string;
  text: string;
  html: string[];
  createdAt: string;
}

// Generic IMAP config — works with any provider
const IMAP_CONFIG = {
  host: process.env.IMAP_HOST || 'imap.gmail.com',
  port: parseInt(process.env.IMAP_PORT || '993', 10),
  secure: process.env.IMAP_SECURE !== 'false',
  auth: {
    user: process.env.IMAP_USER || process.env.GMAIL_USER || '',
    pass: (process.env.IMAP_PASS || process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '')
  }
};

/**
 * Check if IMAP email is configured
 */
export function isEmailConfigured(): boolean {
  return !!(IMAP_CONFIG.auth.user && IMAP_CONFIG.auth.pass);
}

/**
 * Create IMAP client connection
 */
async function createImapClient(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: IMAP_CONFIG.host,
    port: IMAP_CONFIG.port,
    secure: IMAP_CONFIG.secure,
    auth: IMAP_CONFIG.auth,
    logger: false
  });

  await client.connect();
  return client;
}

/**
 * Create a mailbox reference using configured IMAP email
 */
export async function createTempMailbox(): Promise<TempMailbox> {
  const email = IMAP_CONFIG.auth.user;

  if (!email) {
    throw new Error('IMAP email not configured. Set IMAP_USER+IMAP_PASS (or GMAIL_USER+GMAIL_APP_PASSWORD) in .env');
  }

  const [login, domain] = email.split('@');
  logger.info(`Using IMAP mailbox: ${email} (${IMAP_CONFIG.host})`);

  return {
    id: email,
    email,
    password: '',
    token: '',
    login: login || email,
    domain: domain || 'unknown'
  };
}

/**
 * Get recent messages from INBOX
 */
export async function getMessages(_mailbox: TempMailbox): Promise<EmailMessage[]> {
  let client: ImapFlow | null = null;

  try {
    client = await createImapClient();
    await client.mailboxOpen('INBOX');

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const messages: EmailMessage[] = [];

    for await (const msg of client.fetch(
      { seen: false, since: tenMinutesAgo },
      { envelope: true, uid: true }
    )) {
      const envelope = msg.envelope;
      if (!envelope) continue;

      messages.push({
        id: String(msg.uid),
        from: {
          address: envelope.from?.[0]?.address || '',
          name: envelope.from?.[0]?.name || ''
        },
        to: envelope.to?.map(t => ({
          address: t.address || '',
          name: t.name || ''
        })) || [],
        subject: envelope.subject || '',
        intro: envelope.subject || '',
        seen: false,
        createdAt: envelope.date?.toISOString() || new Date().toISOString()
      });
    }

    return messages;
  } catch (error) {
    logger.warn(`Failed to get IMAP messages: ${error}`);
    return [];
  } finally {
    if (client) {
      await client.logout().catch(() => {});
    }
  }
}

/**
 * Read full email content by UID
 */
export async function readMessage(_mailbox: TempMailbox, messageId: string): Promise<EmailContent> {
  let client: ImapFlow | null = null;

  try {
    client = await createImapClient();
    await client.mailboxOpen('INBOX');

    const msg = await client.fetchOne(messageId, {
      envelope: true,
      source: true
    }, { uid: true });

    if (!msg) {
      throw new Error(`Message ${messageId} not found`);
    }

    const source = msg.source?.toString() || '';

    let textBody = '';
    let htmlBody = '';

    const textMatch = source.match(/Content-Type: text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)(?=\r\n--|\r\n\r\n--|\Z)/i);
    if (textMatch) {
      textBody = textMatch[1].replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_match: string, hex: string) =>
        String.fromCharCode(parseInt(hex, 16))
      );
    }

    const htmlMatch = source.match(/Content-Type: text\/html[\s\S]*?\r\n\r\n([\s\S]*?)(?=\r\n--|\r\n\r\n--|\Z)/i);
    if (htmlMatch) {
      htmlBody = htmlMatch[1].replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_match: string, hex: string) =>
        String.fromCharCode(parseInt(hex, 16))
      );
    }

    if (!textBody && !htmlBody) {
      textBody = source;
    }

    const envelope = msg.envelope;

    return {
      id: messageId,
      from: {
        address: envelope?.from?.[0]?.address || '',
        name: envelope?.from?.[0]?.name || ''
      },
      subject: envelope?.subject || '',
      text: textBody,
      html: htmlBody ? [htmlBody] : [],
      createdAt: envelope?.date?.toISOString() || new Date().toISOString()
    };
  } catch (error) {
    logger.error(`Failed to read IMAP message ${messageId}: ${error}`);
    throw error;
  } finally {
    if (client) {
      await client.logout().catch(() => {});
    }
  }
}

/**
 * Wait for email with specific subject/sender pattern
 */
export async function waitForEmail(
  mailbox: TempMailbox,
  pattern: RegExp,
  timeoutMs: number = 120000,
  pollIntervalMs: number = 5000
): Promise<EmailContent | null> {
  const startTime = Date.now();

  logger.info(`Waiting for email matching /${pattern.source}/ to ${mailbox.email}...`);

  while (Date.now() - startTime < timeoutMs) {
    try {
      const messages = await getMessages(mailbox);

      logger.debug(`Found ${messages.length} recent messages`);

      for (const msg of messages) {
        const matchesSubject = pattern.test(msg.subject);
        const matchesSender = pattern.test(msg.from.address);

        logger.debug(`Checking: "${msg.subject}" from ${msg.from.address} - match: ${matchesSubject || matchesSender}`);

        if (matchesSubject || matchesSender) {
          const content = await readMessage(mailbox, String(msg.id));
          logger.info(`Found matching email: "${msg.subject}" from ${msg.from.address}`);
          return content;
        }
      }
    } catch (error) {
      logger.warn(`Error checking IMAP: ${error}`);
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  logger.warn(`Timeout waiting for email matching /${pattern.source}/`);
  return null;
}

/**
 * Extract verification code from email body
 */
export function extractVerificationCode(email: EmailContent): string | null {
  const body = email.text || (email.html ? email.html.join(' ') : '');

  const keywordCodeMatch = body.match(/(?:код|code|pin|пин|token|токен)[:\s]*([A-Z0-9]{4,10})\b/i);
  if (keywordCodeMatch) {
    logger.info(`Extracted code after keyword: ${keywordCodeMatch[1]}`);
    return keywordCodeMatch[1];
  }

  const bracketMatch = body.match(/(?:код|code|pin)[:\s]*[«"'\[]([A-Z0-9]{4,12})[»"'\]]/i);
  if (bracketMatch) {
    logger.info(`Extracted code in brackets: ${bracketMatch[1]}`);
    return bracketMatch[1];
  }

  const boldMatch = body.match(/<(?:b|strong|code)>([A-Z0-9]{4,10})<\/(?:b|strong|code)>/i);
  if (boldMatch) {
    logger.info(`Extracted bold code: ${boldMatch[1]}`);
    return boldMatch[1];
  }

  const linkMatch = body.match(/https?:\/\/[^\s<>"]+(?:confirm|verify|activate|code|token)[^\s<>"]*/i);
  if (linkMatch) {
    logger.info(`Found confirmation link: ${linkMatch[0]}`);
    return linkMatch[0];
  }

  const verifyCodeMatch = body.match(/(?:verification|confirmation|подтверждения|верификации)\s+(?:code|код)\s*(?:is|:)?\s*([A-Z0-9]{4,10})\b/i);
  if (verifyCodeMatch) {
    logger.info(`Extracted verification code: ${verifyCodeMatch[1]}`);
    return verifyCodeMatch[1];
  }

  const sixDigitMatch = body.match(/\b(\d{6})\b/);
  if (sixDigitMatch) {
    logger.info(`Extracted 6-digit code: ${sixDigitMatch[1]}`);
    return sixDigitMatch[1];
  }

  const fourDigitMatch = body.match(/\b(\d{4})\b/);
  if (fourDigitMatch) {
    logger.info(`Extracted 4-digit code: ${fourDigitMatch[1]}`);
    return fourDigitMatch[1];
  }

  const standaloneMatch = body.match(/\b([A-Z0-9]{5,8})\b/g);
  if (standaloneMatch) {
    const codelike = standaloneMatch.find(m =>
      /\d/.test(m) && /[A-Z]/i.test(m) ||
      /^\d{5,8}$/.test(m)
    );
    if (codelike) {
      logger.info(`Extracted standalone code: ${codelike}`);
      return codelike;
    }
  }

  logger.warn('Could not extract verification code from email');
  logger.debug(`Email body preview: ${body.substring(0, 500)}...`);
  return null;
}

/**
 * Full flow: wait for verification email and extract code
 */
export async function getVerificationCode(
  mailbox: TempMailbox,
  senderPattern: RegExp = /./,
  timeoutMs: number = 120000
): Promise<string | null> {
  const email = await waitForEmail(mailbox, senderPattern, timeoutMs);

  if (!email) {
    return null;
  }

  return extractVerificationCode(email);
}

/**
 * Delete mailbox (cleanup) - IMAP doesn't need cleanup
 */
export async function deleteTempMailbox(mailbox: TempMailbox): Promise<void> {
  logger.debug(`IMAP session ended for: ${mailbox.email}`);
}

/**
 * Test IMAP connection
 */
export async function testImapConnection(): Promise<boolean> {
  let client: ImapFlow | null = null;

  try {
    logger.info(`Testing IMAP connection to ${IMAP_CONFIG.host}...`);
    client = await createImapClient();
    await client.mailboxOpen('INBOX');

    const status = await client.status('INBOX', { messages: true, unseen: true });
    logger.info(`IMAP connected! Inbox: ${status.messages} messages, ${status.unseen} unseen`);

    return true;
  } catch (error) {
    logger.error(`IMAP connection failed: ${error}`);
    return false;
  } finally {
    if (client) {
      await client.logout().catch(() => {});
    }
  }
}
