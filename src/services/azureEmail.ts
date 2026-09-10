/**
 * @fileoverview Azure Communication Services & Microsoft 365 Email Service.
 *
 * Dispatches transactional OTP emails using Microsoft Entra ID (Client Credentials)
 * via Microsoft Graph `sendMail` or Azure Communication Services.
 */

import { config } from '../config/env.js';

interface SendOtpEmailOptions {
  to: string;
  otp: string;
  subject?: string;
}

interface SendEmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

// In-memory token cache to avoid redundant OAuth calls
let cachedToken: string | null = null;
let tokenExpiresAt = 0;

/**
 * Checks whether Azure/M365 email sending is configured.
 */
export function isAzureEmailConfigured(): boolean {
  const tenant = config.ACTIVE_AZURE_TENANT_ID;
  const clientId = config.AZURE_CLIENT_ID;
  const clientSecret = config.AZURE_CLIENT_SECRET;
  const senderEmail = config.AZURE_SENDER_EMAIL;

  return Boolean(tenant && clientId && clientSecret && senderEmail);
}

/**
 * Retrieves a valid OAuth2 access token for Microsoft Graph from Microsoft Entra ID.
 */
async function getGraphAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const tenant = config.ACTIVE_AZURE_TENANT_ID;
  const clientId = config.AZURE_CLIENT_ID;
  const clientSecret = config.AZURE_CLIENT_SECRET;

  if (!tenant || !clientId || !clientSecret) {
    throw new Error('Missing Azure credentials (tenant ID, client ID, or client secret).');
  }

  const loginBase = (config.MS_LOGIN_BASE_URL || 'https://login.microsoftonline.com').replace(/\/+$/, '');
  const graphBase = (config.MS_GRAPH_BASE_URL || 'https://graph.microsoft.com').replace(/\/+$/, '');
  const tokenUrl = `${loginBase}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: 'client_credentials',
    scope: `${graphBase}/.default`,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const errorData = await res.text();
    throw new Error(`Failed to obtain Microsoft Graph access token: HTTP ${res.status} - ${errorData}`);
  }

  const data: any = await res.json();
  if (!data.access_token) {
    throw new Error('Token response missing access_token.');
  }

  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  return data.access_token as string;
}

/**
 * Generates branded HTML template for ApplyWizz OTP verification email.
 */
function generateOtpEmailHtml(otp: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ApplyWizz Verification Code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #FAF4EB; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1A1A2E;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #FAF4EB; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 520px; background-color: #FFFFFF; border: 2px solid #1A1A2E; border-radius: 16px; box-shadow: 6px 6px 0px #1A1A2E; padding: 36px 32px; text-align: left;">
          <tr>
            <td>
              <!-- Brand Header -->
              <div style="margin-bottom: 24px;">
                <span style="display: inline-block; background-color: #1A1A2E; color: #FFF5EB; font-weight: 900; font-size: 14px; padding: 6px 12px; border-radius: 8px; border: 1.5px solid #1A1A2E; letter-spacing: 1px;">
                  APPLYWIZZ
                </span>
              </div>

              <!-- Title & Greeting -->
              <h2 style="font-size: 22px; font-weight: 900; color: #1A1A2E; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: -0.5px;">
                Sign Up Verification Code
              </h2>
              <p style="font-size: 14px; color: #4B5563; line-height: 1.6; margin: 0 0 24px 0;">
                Use the following 6-digit one-time code to complete your operator account registration. This code will expire in <strong>10 minutes</strong>.
              </p>

              <!-- OTP Code Display -->
              <div style="background-color: #FAF4EB; border: 2px solid #1A1A2E; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px; box-shadow: 3px 3px 0px #1A1A2E;">
                <span style="font-family: 'Courier New', Courier, monospace; font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #1A1A2E; display: inline-block;">
                  ${otp}
                </span>
              </div>

              <!-- Security Notice -->
              <div style="background-color: #FEF3C7; border: 1.5px solid #D97706; border-radius: 8px; padding: 12px 16px; margin-bottom: 24px;">
                <p style="font-size: 12px; color: #92400E; margin: 0; line-height: 1.5;">
                  <strong>Security Note:</strong> Never share this verification code with anyone. ApplyWizz administrators will never ask for your code.
                </p>
              </div>

              <!-- Next Step Notice -->
              <p style="font-size: 12px; color: #6B7280; line-height: 1.5; margin: 0 0 20px 0;">
                After verifying this code, you will configure your <strong>Microsoft Authenticator</strong> app. Passwords are eliminated for high security.
              </p>

              <!-- Footer -->
              <hr style="border: none; border-top: 1px solid #E5E7EB; margin: 24px 0;" />
              <p style="font-size: 11px; color: #9CA3AF; margin: 0;">
                If you did not attempt to sign up for ApplyWizz, please safely ignore this message.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

export interface SendEmailOptions {
  to: string;
  subject: string;
  html?: string;
  text?: string;
}

/**
 * Sends a generic email using Microsoft Graph sendMail API.
 */
export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const { to, subject, html, text } = options;

  if (!isAzureEmailConfigured()) {
    throw new Error('Azure Communication Services / Microsoft 365 credentials are not configured on the server.');
  }

  const senderEmail = config.AZURE_SENDER_EMAIL!;
  const accessToken = await getGraphAccessToken();

  const mailPayload = {
    message: {
      subject,
      body: {
        contentType: html ? 'HTML' : 'Text',
        content: html || text || subject,
      },
      toRecipients: [
        {
          emailAddress: {
            address: to.trim().toLowerCase(),
          },
        },
      ],
    },
    saveToSentItems: false,
  };

  const graphBase = (config.MS_GRAPH_BASE_URL || 'https://graph.microsoft.com').replace(/\/+$/, '');
  const endpoint = `${graphBase}/v1.0/users/${encodeURIComponent(senderEmail)}/sendMail`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(mailPayload),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`[AzureEmail] Failed to send email to ${to}: HTTP ${res.status} - ${errText}`);
    return {
      success: false,
      error: `Failed to send email: HTTP ${res.status} - ${errText}`,
    };
  }

  console.log(`[AzureEmail] Successfully dispatched email to ${to} (Sender: ${senderEmail})`);
  return { success: true };
}

/**
 * Sends a 6-digit OTP email to the user using Microsoft Graph sendMail API.
 */
export async function sendOtpEmail(options: SendOtpEmailOptions): Promise<SendEmailResult> {
  const { to, otp, subject = `ApplyWizz Verification Code: ${otp}` } = options;
  return sendEmail({
    to,
    subject,
    html: generateOtpEmailHtml(otp),
    text: `Your ApplyWizz verification code is: ${otp}. It expires in 10 minutes.`,
  });
}

