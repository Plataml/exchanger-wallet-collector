/**
 * Gmail IMAP Email Service for verification codes
 * Uses real Gmail account to avoid temp-email blocks by exchangers
 */

import { ImapFlow } from 'imapflow';
import { logger } from './logger';

export interface TempMailbox {
  id: string;
  email: string;
  password: string;
  token: string;
  // Gmail specific
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

// Gmail IMAP config from environment
const GMAIL_CONFIG = {
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: {
    user: process.env.GMAIL_USER || '',
    pass: (process.env.GMAIL_APP_PASSWORD || '').replace(/\s/g, '') // Remove spaces from app password
  }
};

/**
 * Create IMAP client connection
 */
async function createImapClient(): Promise<ImapFlow> {
  const client = new ImapFlow({
    host: GMAIL_CONFIG.host,
    port: GMAIL_CONFIG.port,
    secure: GMAIL_CONFIG.secure,
    auth: GMAIL_CONFIG.auth,
    logger: false // Disable verbose logging
  });

  await client.connect();
  return client;
}

/**
 * Create a "virtual" mailbox using Gmail
 * Returns Gmail address - no actual mailbox creation needed
 */
export async function createTempMailbox(): Promise<TempMailbox> {
  const email = GMAIL_CONFIG.auth.user;

  if (!email) {
    throw new Error('GMAIL_USER not configured in .env');
  }

  logger.info(`Using Gmail mailbox: ${email}`);

  return {
    id: email,
    email,
    password: '',
    token: '',
    login: email.split('@')[0],
    domain: 'gmail.com'
  };
}

/**
 * Get recent messages from Gmail INBOX
 */
export async function getMessages(_mailbox: TempMailbox): Promise<EmailMessage[]> {
  let client: ImapFlow | null = null;

  try {
    client = await createImapClient();
    await client.mailboxOpen('INBOX');

    // Get messages from last 10 minutes (recent verification emails)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);

    const messages: EmailMessage[] = [];

    // Search for recent unseen messages
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
    logger.warn(`Failed to get Gmail messages: ${error}`);
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

    // Fetch message with body
    const msg = await client.fetchOne(messageId, {
      envelope: true,
      source: true
    }, { uid: true });

    if (!msg) {
      throw new Error(`Message ${messageId} not found`);
    }

    // Parse email source
    const source = msg.source?.toString() || '';

    // Extract text and HTML parts (simplified parsing)
    let textBody = '';
    let htmlBody = '';

    // Try to extract text content
    const textMatch = source.match(/Content-Type: text\/plain[\s\S]*?\r\n\r\n([\s\S]*?)(?=\r\n--|\r\n\r\n--|\Z)/i);
    if (textMatch) {
      textBody = textMatch[1].replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_match: string, hex: string) =>
        String.fromCharCode(parseInt(hex, 16))
      );
    }

    // Try to extract HTML content
    const htmlMatch = source.match(/Content-Type: text\/html[\s\S]*?\r\n\r\n([\s\S]*?)(?=\r\n--|\r\n\r\n--|\Z)/i);
    if (htmlMatch) {
      htmlBody = htmlMatch[1].replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_match: string, hex: string) =>
        String.fromCharCode(parseInt(hex, 16))
      );
    }

    // Fallback: use entire source if no parts found
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
    logger.error(`Failed to read Gmail message ${messageId}: ${error}`);
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

      logger.info(`Found ${messages.length} recent messages in Gmail`);

      for (const msg of messages) {
        // Check if message matches pattern (subject or sender)
        const matchesSubject = pattern.test(msg.subject);
        const matchesSender = pattern.test(msg.from.address);

        logger.info(`Checking email: "${msg.subject}" from ${msg.from.address} - matches: ${matchesSubject || matchesSender}`);

        if (matchesSubject || matchesSender) {
          const content = await readMessage(mailbox, String(msg.id));
          logger.info(`Found matching email: "${msg.subject}" from ${msg.from.address}`);
          return content;
        }
      }
    } catch (error) {
      logger.warn(`Error checking Gmail: ${error}`);
    }

    // Wait before next poll
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

  // Pattern 1: Code after keyword (код/code/pin/пин) - alphanumeric 4-10 chars
  const keywordCodeMatch = body.match(/(?:код|code|pin|пин|token|токен)[:\s]*([A-Z0-9]{4,10})\b/i);
  if (keywordCodeMatch) {
    logger.info(`Extracted code after keyword: ${keywordCodeMatch[1]}`);
    return keywordCodeMatch[1];
  }

  // Pattern 2: Code in brackets/quotes after keyword
  const bracketMatch = body.match(/(?:код|code|pin)[:\s]*[«"'\[]([A-Z0-9]{4,12})[»"'\]]/i);
  if (bracketMatch) {
    logger.info(`Extracted code in brackets: ${bracketMatch[1]}`);
    return bracketMatch[1];
  }

  // Pattern 3: Standalone bold/highlighted code (often in HTML)
  const boldMatch = body.match(/<(?:b|strong|code)>([A-Z0-9]{4,10})<\/(?:b|strong|code)>/i);
  if (boldMatch) {
    logger.info(`Extracted bold code: ${boldMatch[1]}`);
    return boldMatch[1];
  }

  // Pattern 4: Confirmation/verification link
  const linkMatch = body.match(/https?:\/\/[^\s<>"]+(?:confirm|verify|activate|code|token)[^\s<>"]*/i);
  if (linkMatch) {
    logger.info(`Found confirmation link: ${linkMatch[0]}`);
    return linkMatch[0];
  }

  // Pattern 5: "verification/confirmation code is/:" pattern
  const verifyCodeMatch = body.match(/(?:verification|confirmation|подтверждения|верификации)\s+(?:code|код)\s*(?:is|:)?\s*([A-Z0-9]{4,10})\b/i);
  if (verifyCodeMatch) {
    logger.info(`Extracted verification code: ${verifyCodeMatch[1]}`);
    return verifyCodeMatch[1];
  }

  // Pattern 6: Standalone 6-digit code (most common for 2FA)
  const sixDigitMatch = body.match(/\b(\d{6})\b/);
  if (sixDigitMatch) {
    logger.info(`Extracted 6-digit code: ${sixDigitMatch[1]}`);
    return sixDigitMatch[1];
  }

  // Pattern 7: 4-digit code
  const fourDigitMatch = body.match(/\b(\d{4})\b/);
  if (fourDigitMatch) {
    logger.info(`Extracted 4-digit code: ${fourDigitMatch[1]}`);
    return fourDigitMatch[1];
  }

  // Pattern 8: Any standalone alphanumeric 5-8 chars that looks like a code
  const standaloneMatch = body.match(/\b([A-Z0-9]{5,8})\b/g);
  if (standaloneMatch) {
    // Filter out common words and find most code-like match
    const codelike = standaloneMatch.find(m =>
      /\d/.test(m) && /[A-Z]/i.test(m) || // Has both letters and numbers
      /^\d{5,8}$/.test(m) // Or is 5-8 digits
    );
    if (codelike) {
      logger.info(`Extracted standalone code: ${codelike}`);
      return codelike;
    }
  }

  logger.warn('Could not extract verification code from email');
  logger.info(`Email body preview: ${body.substring(0, 500)}...`);
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
 * Delete mailbox (cleanup) - not needed for Gmail
 */
export async function deleteTempMailbox(mailbox: TempMailbox): Promise<void> {
  // Gmail doesn't need cleanup - just log
  logger.info(`Gmail session ended for: ${mailbox.email}`);
}

/**
 * Test Gmail connection
 */
export async function testGmailConnection(): Promise<boolean> {
  let client: ImapFlow | null = null;

  try {
    logger.info('Testing Gmail IMAP connection...');
    client = await createImapClient();
    await client.mailboxOpen('INBOX');

    // Get mailbox status
    const status = await client.status('INBOX', { messages: true, unseen: true });
    logger.info(`Gmail connected! Inbox has ${status.messages} messages, ${status.unseen} unseen`);

    return true;
  } catch (error) {
    logger.error(`Gmail connection failed: ${error}`);
    return false;
  } finally {
    if (client) {
      await client.logout().catch(() => {});
    }
  }
}
