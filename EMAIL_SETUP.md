# Email Setup with Resend

This application uses [Resend](https://resend.com) for sending emails (verification, invitations, password resets).

## Setup Instructions

### 1. Create a Resend Account

1. Go to [https://resend.com](https://resend.com)
2. Sign up for a free account
3. Verify your email address

### 2. Get Your API Key

1. Go to [API Keys](https://resend.com/api-keys) in your Resend dashboard
2. Click "Create API Key"
3. Give it a name (e.g., "Objectives App")
4. Copy the API key (starts with `re_`)

### 3. Verify Your Domain (Production)

For production, you'll need to verify your domain:

1. Go to [Domains](https://resend.com/domains) in your Resend dashboard
2. Click "Add Domain"
3. Follow the DNS configuration instructions
4. Once verified, you can use emails like `noreply@yourdomain.com`

### 4. Set Environment Variables

Add these to your `.env` file (local) or deployment platform (production):

```bash
# Resend API Key
RESEND_API_KEY=re_your_api_key_here

# From Email Address
# For testing: onboarding@resend.dev (works without domain verification)
# For production: noreply@yourdomain.com (requires domain verification)
FROM_EMAIL=onboarding@resend.dev
```

### 5. Testing Email (Local Development)

For local development, you can:

**Option A: Use Resend's test email**
- Set `FROM_EMAIL=onboarding@resend.dev` (this works without domain verification)
- Set your `RESEND_API_KEY`
- Emails will be sent to the recipient

**Option B: Console logging (no API key)**
- Don't set `RESEND_API_KEY`
- Emails will be logged to the console instead of being sent
- Useful for development when you don't want to send real emails

## Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `RESEND_API_KEY` | Yes (for sending) | Your Resend API key | `re_xxxxxxxxxxxxx` |
| `FROM_EMAIL` | No | Email address to send from | `onboarding@resend.dev` or `noreply@yourdomain.com` |

## Email Types

The application sends the following emails:

1. **Email Verification** - Sent when a user registers
2. **Password Reset** - Sent when a user requests a password reset
3. **Invitations** - Sent when an admin/manager invites a user to join

## Troubleshooting

### Emails not sending

1. Check that `RESEND_API_KEY` is set correctly
2. Verify the API key is active in your Resend dashboard
3. Check server logs for error messages
4. Ensure `FROM_EMAIL` is verified (or use `onboarding@resend.dev` for testing)

### "Domain not verified" error

- For production, you must verify your domain in Resend
- For testing, use `onboarding@resend.dev` as the `FROM_EMAIL`

### Rate Limits

Resend free tier includes:
- 3,000 emails/month
- 100 emails/day

Upgrade your plan if you need more.

## Production Setup

1. Verify your domain in Resend
2. Set `FROM_EMAIL` to an address on your verified domain (e.g., `noreply@yourdomain.com`)
3. Set `RESEND_API_KEY` in your deployment platform's environment variables
4. Set `FRONTEND_URL` to your production frontend URL

