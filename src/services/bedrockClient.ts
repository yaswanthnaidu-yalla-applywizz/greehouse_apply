/**
 * @fileoverview Centralized AWS Bedrock Runtime Client Provider.
 * Supports both Bedrock API Key (Bearer Token) and AWS SigV4 IAM credentials.
 */

import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Bedrock Client');

let clientInstance: BedrockRuntimeClient | null = null;

/**
 * Checks if AWS Bedrock credentials (API Key or IAM) are configured.
 */
export function isBedrockConfigured(): boolean {
  const apiKey = (
    config.BEDROCK_API_KEY ||
    config.AWS_BEARER_TOKEN_BEDROCK ||
    process.env.BEDROCK_API_KEY ||
    process.env.AWS_BEARER_TOKEN_BEDROCK ||
    ''
  ).trim();

  if (apiKey.length > 0) return true;

  const hasIam = Boolean(
    (config.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID) &&
    (config.AWS_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY)
  );

  return hasIam;
}

/**
 * Returns a singleton instance of BedrockRuntimeClient.
 */
export function getBedrockClient(): BedrockRuntimeClient {
  if (clientInstance) return clientInstance;

  const region = config.AWS_REGION || process.env.AWS_REGION || 'us-east-1';
  const apiKey = (
    config.BEDROCK_API_KEY ||
    config.AWS_BEARER_TOKEN_BEDROCK ||
    process.env.BEDROCK_API_KEY ||
    process.env.AWS_BEARER_TOKEN_BEDROCK ||
    ''
  ).trim();

  const clientConfig: any = { region };

  if (apiKey) {
    process.env.AWS_BEARER_TOKEN_BEDROCK = apiKey;
    clientConfig.token = { token: apiKey };
    log.debug(`[Bedrock Client] Initialized with Bedrock API Key (region=${region})`);
  } else if (config.AWS_ACCESS_KEY_ID && config.AWS_SECRET_ACCESS_KEY) {
    clientConfig.credentials = {
      accessKeyId: config.AWS_ACCESS_KEY_ID,
      secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
      ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
    };
    log.debug(`[Bedrock Client] Initialized with IAM credentials (region=${region})`);
  } else {
    log.debug(`[Bedrock Client] Initialized with default AWS credential chain (region=${region})`);
  }

  clientInstance = new BedrockRuntimeClient(clientConfig);
  return clientInstance;
}

/**
 * Resets the client instance (useful for testing or config reloads).
 */
export function resetBedrockClient(): void {
  clientInstance = null;
}
