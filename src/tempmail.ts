/**
 * Temporary Email Service using 1secmail API
 * Less likely to be blocked by exchangers than mail.tm
 */

import { logger } from './logger';

const SECMAIL_API = 'https://www.1secmail.com/api/v1';

// Available 1secmail domains (less known = less likely blocked)
const SECMAIL_DOMAINS = ['kzccv.com', 'qiott.com', 'wuuvo.com', 'icznn.com', 'vjuum.com'];

export interface TempMailbox {
  id: string;
  email: string;
  password: string;
  token: string;
  // 1secmail specific
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

/**
 * Generate random string for email login
 */
function randomString(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Create a new temporary email using 1secmail
 * No registration required - just generate random address
 */
export async function createTempMailbox(): Promise<TempMailbox> {
  // Use a random less-known domain
  const domain = SECMAIL_DOMAINS[Math.floor(Math.random() * SECMAIL_DOMAINS.length)];
  const login = randomString(10);
  const email = `${login}@${domain}`;

  logger.info(`Created temp mailbox: ${email}`);

  return {
    id: login,
    email,
    password: '', // Not needed for 1secmail
    token: '',    // Not needed for 1secmail
    login,
    domain
  };
}

/**
 * 1secmail message format
 */
interface SecMailMessage {
  id: number;
  from: string;
  subject: string;
  date: string;
}

interface SecMailMessageFull {
  id: number;
  from: string;
  subject: string;
  date: string;
  body: string;
  textBody: string;
  htmlBody: string;
}

/**
 * Get list of messages in mailbox using 1secmail API
 */
export async function getMessages(mailbox: TempMailbox): Promise<EmailMessage[]> {
  try {
    const url = `${SECMAIL_API}/?action=getMessages&login=${mailbox.login}&domain=${mailbox.domain}`;
    const response = await fetch(url);

    if (!response.ok) {
      return [];
    }

    const messages = await response.json() as SecMailMessage[];

    return messages.map(msg => ({
      id: String(msg.id),
      from: { address: msg.from, name: msg.from.split('@')[0] },
      to: [{ address: mailbox.email, name: mailbox.login }],
      subject: msg.subject,
      intro: msg.subject,
      seen: false,
      createdAt: msg.date
    }));
  } catch (error) {
    logger.warn(`Failed to get messages: ${error}`);
    return [];
  }
}

/**
 * Read full email content using 1secmail API
 */
export async function readMessage(mailbox: TempMailbox, messageId: string): Promise<EmailContent> {
  const url = `${SECMAIL_API}/?action=readMessage&login=${mailbox.login}&domain=${mailbox.domain}&id=${messageId}`;
  const response = await fetch(url);
  const msg = await response.json() as SecMailMessageFull;

  return {
    id: String(msg.id),
    from: { address: msg.from, name: msg.from.split('@')[0] },
    subject: msg.subject,
    text: msg.textBody || msg.body,
    html: msg.htmlBody ? [msg.htmlBody] : [],
    createdAt: msg.date
  };
}

/**
 * Wait for email with specific subject/sender pattern
 */
export async function waitForEmail(
  mailbox: TempMailbox,
  pattern: RegExp,
  timeoutMs: number = 90000,
  pollIntervalMs: number = 5000
): Promise<EmailContent | null> {
  const startTime = Date.now();

  logger.info(`Waiting for email matching /${pattern.source}/ to ${mailbox.email}...`);

  while (Date.now() - startTime < timeoutMs) {
    const messages = await getMessages(mailbox);

    for (const msg of messages) {
      if (pattern.test(msg.subject) || pattern.test(msg.from.address)) {
        const content = await readMessage(mailbox, String(msg.id));
        logger.info(`Found email: "${msg.subject}" from ${msg.from.address}`);
        return content;
      }
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

  // Pattern 7: Any standalone alphanumeric 5-8 chars that looks like a code
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
  logger.debug(`Email body: ${body.substring(0, 500)}...`);
  return null;
}

/**
 * Full flow: wait for verification email and extract code
 */
export async function getVerificationCode(
  mailbox: TempMailbox,
  senderPattern: RegExp = /./,
  timeoutMs: number = 90000
): Promise<string | null> {
  const email = await waitForEmail(mailbox, senderPattern, timeoutMs);

  if (!email) {
    return null;
  }

  return extractVerificationCode(email);
}

/**
 * Delete mailbox (cleanup) - not needed for 1secmail but kept for API compatibility
 */
export async function deleteTempMailbox(mailbox: TempMailbox): Promise<void> {
  // 1secmail doesn't require deletion - emails auto-expire
  logger.info(`Temp mailbox expired: ${mailbox.email}`);
}
