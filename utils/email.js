// Email utility functions using Resend
import { Resend } from 'resend';

// Initialize Resend client
const resend = new Resend(process.env.RESEND_API_KEY);

// Get the from email address (defaults to noreply@yourdomain.com if not set)
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';

/**
 * Send an email using Resend
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML email body
 * @param {string} options.text - Plain text email body (optional)
 * @returns {Promise<void>}
 */
export async function sendEmail({ to, subject, html, text }) {
  // If no API key is set, log to console (for development)
  if (!process.env.RESEND_API_KEY) {
    console.log('📧 Email would be sent (RESEND_API_KEY not set):');
    console.log('To:', to);
    console.log('Subject:', subject);
    console.log('From:', FROM_EMAIL);
    console.log('---');
    if (text) {
      console.log('Text:', text);
    }
    return;
  }

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: to,
      subject: subject,
      html: html,
      text: text || html.replace(/<[^>]*>/g, ''), // Strip HTML tags for text version if not provided
    });

    if (error) {
      console.error('Error sending email:', error);
      throw error;
    }

    console.log('✅ Email sent successfully:', data);
    return data;
  } catch (error) {
    console.error('Failed to send email:', error);
    throw error;
  }
}

/**
 * Send email verification email
 * @param {string} email - User email
 * @param {string} name - User name
 * @param {string} token - Verification token
 * @param {string} baseUrl - Application base URL
 */
export async function sendVerificationEmail(email, name, token, baseUrl) {
  const verificationUrl = `${baseUrl}/verify-email?token=${token}`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Verify Your Email</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #4F46E5;">Verify Your Email Address</h1>
        <p>Hi ${name},</p>
        <p>Thank you for signing up! Please verify your email address by clicking the button below:</p>
        <p style="text-align: center; margin: 30px 0;">
          <a href="${verificationUrl}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">Verify Email</a>
        </p>
        <p>Or copy and paste this link into your browser:</p>
        <p style="word-break: break-all; color: #666;">${verificationUrl}</p>
        <p>This link will expire in 24 hours.</p>
        <p>If you didn't create an account, you can safely ignore this email.</p>
      </div>
    </body>
    </html>
  `;
  
  const text = `
    Hi ${name},
    
    Thank you for signing up! Please verify your email address by visiting:
    ${verificationUrl}
    
    This link will expire in 24 hours.
    
    If you didn't create an account, you can safely ignore this email.
  `;
  
  await sendEmail({
    to: email,
    subject: 'Verify Your Email Address',
    html,
    text
  });
}

/**
 * Send invitation email
 * @param {string} email - Invited user email
 * @param {string} inviterName - Name of person who sent invitation
 * @param {string} organizationName - Organization name
 * @param {string} role - Assigned role
 * @param {string} token - Invitation token
 * @param {string} baseUrl - Application base URL
 */
export async function sendInvitationEmail(email, inviterName, organizationName, role, token, baseUrl) {
  const invitationUrl = `${baseUrl}/invite/accept?token=${token}`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>You've Been Invited</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #4F46E5;">You've Been Invited!</h1>
        <p>Hi there,</p>
        <p><strong>${inviterName}</strong> has invited you to join <strong>${organizationName}</strong> on the Objectives Management Platform.</p>
        <p>You'll be joining as a <strong>${role}</strong>.</p>
        <p style="text-align: center; margin: 30px 0;">
          <a href="${invitationUrl}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">Accept Invitation</a>
        </p>
        <p>Or copy and paste this link into your browser:</p>
        <p style="word-break: break-all; color: #666;">${invitationUrl}</p>
        <p>This invitation will expire in 7 days.</p>
        <p>If you don't want to join, you can safely ignore this email.</p>
      </div>
    </body>
    </html>
  `;
  
  const text = `
    Hi there,
    
    ${inviterName} has invited you to join ${organizationName} on the Objectives Management Platform.
    You'll be joining as a ${role}.
    
    Accept the invitation by visiting:
    ${invitationUrl}
    
    This invitation will expire in 7 days.
    
    If you don't want to join, you can safely ignore this email.
  `;
  
  await sendEmail({
    to: email,
    subject: `You've been invited to join ${organizationName}`,
    html,
    text
  });
}

/**
 * Send invitation accepted confirmation email to inviter
 * @param {string} inviterEmail - Email of person who sent invitation
 * @param {string} inviterName - Name of person who sent invitation
 * @param {string} acceptedUserName - Name of person who accepted invitation
 * @param {string} acceptedUserEmail - Email of person who accepted invitation
 * @param {string} organizationName - Organization name
 * @param {string} baseUrl - Application base URL
 */
export async function sendInvitationAcceptedEmail(inviterEmail, inviterName, acceptedUserName, acceptedUserEmail, organizationName, baseUrl) {
  const userProfileUrl = `${baseUrl}/people`; // Link to people page where they can see the new user
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Invitation Accepted</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #10b981;">Invitation Accepted!</h1>
        <p>Hi ${inviterName},</p>
        <p><strong>${acceptedUserName}</strong> (${acceptedUserEmail}) has accepted your invitation to join <strong>${organizationName}</strong>.</p>
        <p>They can now access the platform and start collaborating with your team.</p>
        <p style="text-align: center; margin: 30px 0;">
          <a href="${userProfileUrl}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">View Team Members</a>
        </p>
        <p>If you have any questions, feel free to reach out.</p>
      </div>
    </body>
    </html>
  `;
  
  const text = `
    Hi ${inviterName},
    
    ${acceptedUserName} (${acceptedUserEmail}) has accepted your invitation to join ${organizationName}.
    
    They can now access the platform and start collaborating with your team.
    
    View your team members: ${userProfileUrl}
    
    If you have any questions, feel free to reach out.
  `;
  
  await sendEmail({
    to: inviterEmail,
    subject: `${acceptedUserName} has accepted your invitation`,
    html,
    text
  });
}

/**
 * Send password reset email
 * @param {string} email - User email
 * @param {string} name - User name
 * @param {string} token - Reset token
 * @param {string} baseUrl - Application base URL
 */
export async function sendPasswordResetEmail(email, name, token, baseUrl) {
  const resetUrl = `${baseUrl}/reset-password?token=${token}`;
  
  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Reset Your Password</title>
    </head>
    <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
      <div style="max-width: 600px; margin: 0 auto; padding: 20px;">
        <h1 style="color: #4F46E5;">Reset Your Password</h1>
        <p>Hi ${name},</p>
        <p>We received a request to reset your password. Click the button below to create a new password:</p>
        <p style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="background-color: #4F46E5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; display: inline-block;">Reset Password</a>
        </p>
        <p>Or copy and paste this link into your browser:</p>
        <p style="word-break: break-all; color: #666;">${resetUrl}</p>
        <p>This link will expire in 1 hour.</p>
        <p>If you didn't request a password reset, you can safely ignore this email.</p>
      </div>
    </body>
    </html>
  `;
  
  const text = `
    Hi ${name},
    
    We received a request to reset your password. Visit the link below to create a new password:
    ${resetUrl}
    
    This link will expire in 1 hour.
    
    If you didn't request a password reset, you can safely ignore this email.
  `;
  
  await sendEmail({
    to: email,
    subject: 'Reset Your Password',
    html,
    text
  });
}

