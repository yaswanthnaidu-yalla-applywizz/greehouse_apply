import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger, shouldLogMessage } from '../src/utils/logger.js';

describe('Logger Level Filtering & Signal-to-Noise Control', () => {
  it('shouldLogMessage returns true for WARN, ERROR, and HALT regardless of level setting', () => {
    assert.strictEqual(shouldLogMessage('WARN', 'WARN'), true);
    assert.strictEqual(shouldLogMessage('ERROR', 'WARN'), true);
    assert.strictEqual(shouldLogMessage('HALT', 'WARN'), true);
    assert.strictEqual(shouldLogMessage('WARN', 'INFO'), true);
    assert.strictEqual(shouldLogMessage('ERROR', 'INFO'), true);
    assert.strictEqual(shouldLogMessage('HALT', 'INFO'), true);
  });

  it('shouldLogMessage filters DEBUG when configured level is INFO', () => {
    assert.strictEqual(shouldLogMessage('DEBUG', 'INFO'), false);
    assert.strictEqual(shouldLogMessage('INFO', 'INFO'), true);
  });

  it('shouldLogMessage filters INFO and DEBUG when configured level is WARN', () => {
    assert.strictEqual(shouldLogMessage('INFO', 'WARN'), false);
    assert.strictEqual(shouldLogMessage('DEBUG', 'WARN'), false);
    assert.strictEqual(shouldLogMessage('WARN', 'WARN'), true);
  });

  it('shouldLogMessage permits DEBUG when configured level is DEBUG', () => {
    assert.strictEqual(shouldLogMessage('DEBUG', 'DEBUG'), true);
    assert.strictEqual(shouldLogMessage('INFO', 'DEBUG'), true);
  });

  it('createLogger suppresses debug output when LOG_LEVEL is INFO', () => {
    const origEnv = process.env.LOG_LEVEL;
    const origDebug = console.debug;
    let debugCalled = false;
    try {
      process.env.LOG_LEVEL = 'INFO';
      console.debug = () => {
        debugCalled = true;
      };
      const logger = createLogger('TestModule');
      logger.debug('This is a low-signal chatter log');
      assert.strictEqual(debugCalled, false, 'console.debug should not be called when LOG_LEVEL=INFO');
    } finally {
      process.env.LOG_LEVEL = origEnv;
      console.debug = origDebug;
    }
  });

  it('createLogger outputs info, warn, and error when LOG_LEVEL is INFO', () => {
    const origEnv = process.env.LOG_LEVEL;
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    let logCalled = false;
    let warnCalled = false;
    let errorCalled = false;
    try {
      process.env.LOG_LEVEL = 'INFO';
      console.log = () => { logCalled = true; };
      console.warn = () => { warnCalled = true; };
      console.error = () => { errorCalled = true; };

      const logger = createLogger('TestModule');
      logger.info('Milestone stats');
      logger.warn('Warning notice');
      logger.error('Error notice');

      assert.strictEqual(logCalled, true);
      assert.strictEqual(warnCalled, true);
      assert.strictEqual(errorCalled, true);
    } finally {
      process.env.LOG_LEVEL = origEnv;
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }
  });
});
