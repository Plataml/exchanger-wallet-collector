/**
 * Temporary Email Service using mail.tm API
 * Free API for disposable email addresses
 */

import { logger } from './logger';

const API_BASE = 'https://api.mail.tm';

export interface TempMailbox {
  id: string;
  email: string;
  password: string;
  token: string;
}

export interface EmailMessage {
  id: string;
  from: { address: string; name: string };
  to: { address: string; name: string }[];
  subject: string;
  intro: string;
  seen: boolean;
  createdAt: string;
}

export interface EmailContent {
  id: string;
  from: { address: string; name: string };
  subject: string;
  text: string;
  html: string[];
  createdAt: string;
}

/**
 * Get available domains
 */
async function getDomains(): Promise<string[]> {
  const response = await fetch(`${API_BASE}/domains`, {
    headers: { 'Accept': 'application/json' }
  });
  const data = await response.json() as { domain: string; isActive: boolean }[];
  return data.filter(d => d.isActive).map(d => d.domain);
}

/**
 * Generate random string for email/password
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
 * Create a new temporary email account
 */
export async function createTempMailbox(): Promise<TempMailbox> {
  // Get available domain
  const domains = await getDomains();
  if (domains.length === 0) {
    throw new Error('No available email domains');
  }
  const domain = domains[0];

  // Generate credentials
  const login = randomString(10);
  const email = `${login}@${domain}`;
  const password = randomString(12);

  // Create account
  const createResponse = await fetch(`${API_BASE}/accounts`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ address: email, password })
  });

  if (!createResponse.ok) {
    const error = await createResponse.text();
    throw new Error(`Failed to create mailbox: ${error}`);
  }

  const account = await createResponse.json() as { id: string };

  // Get auth token
  const tokenResponse = await fetch(`${API_BASE}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({ address: email, password })
  });

  if (!tokenResponse.ok) {
    throw new Error('Failed to get auth token');
  }

  const tokenData = await tokenResponse.json() as { token: string };

  logger.info(`Created temp mailbox: ${email}`);

  return {
    id: account.id,
    email,
    password,
    token: tokenData.token
  };
}

/**
 * Get list of messages in mailbox
 */
export async function getMessages(mailbox: TempMailbox): Promise<EmailMessage[]> {
  const response = await fetch(`${API_BASE}/messages`, {
    headers: {
      'Authorization': `Bearer ${mailbox.token}`,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    return [];
  }

  const data = await response.json() as { 'hydra:member': EmailMessage[] };
  return data['hydra:member'] || [];
}

/**
 * Read full email content
 */
export async function readMessage(mailbox: TempMailbox, messageId: string): Promise<EmailContent> {
  const response = await fetch(`${API_BASE}/messages/${messageId}`, {
    headers: {
      'Authorization': `Bearer ${mailbox.token}`,
      'Accept': 'application/json'
    }
  });

  return response.json() as Promise<EmailContent>;
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
        const content = await readMessage(mailbox, msg.id);
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
 * Delete mailbox (cleanup)
 */
export async function deleteTempMailbox(mailbox: TempMailbox): Promise<void> {
  try {
    await fetch(`${API_BASE}/accounts/${mailbox.id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${mailbox.token}`
      }
    });
    logger.info(`Deleted temp mailbox: ${mailbox.email}`);
  } catch {
    // Ignore deletion errors
  }
}
