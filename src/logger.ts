import fs from 'fs';
import path from 'path';
import { config } from './config';

const logFile = path.join(config.dataPath, 'collector.log');

function timestamp(): string {
  return new Date().toISOString();
}

function writeLog(level: string, message: string): void {
  const line = `[${timestamp()}] [${level}] ${message}\n`;

  // Console output
  process.stdout.write(line);

  // File output
  try {
    fs.appendFileSync(logFile, line);
  } catch {
    // Ignore file write errors
  }
}

export const logger = {
  info(message: string): void {
    writeLog('INFO', message);
  },

  error(message: string): void {
    writeLog('ERROR', message);
  },

  warn(message: string): void {
    writeLog('WARN', message);
  },

  debug(message: string): void {
    if (process.env.DEBUG) {
      writeLog('DEBUG', message);
    }
  }
};
