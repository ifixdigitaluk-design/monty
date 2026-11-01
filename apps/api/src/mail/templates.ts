import type { MailMessage } from './transports';

/** Escapes user-controlled text (names, organisation names) before it goes into HTML email. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function layout(title: string, bodyHtml: string, cta: { label: string; url: string }, footer: string): string {
  const url = escapeHtml(cta.url);
  return `<!doctype html><html><body style="margin:0;background:#f6f6f4;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1d1d1b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border:1px solid #e6e5e1;border-radius:12px"><tr><td style="padding:28px">
<p style="margin:0 0 16px;font-weight:600;font-size:15px">Monty</p>
<h1 style="margin:0 0 12px;font-size:20px">${escapeHtml(title)}</h1>
${bodyHtml}
<p style="margin:24px 0"><a href="${url}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;display:inline-block;font-weight:600">${escapeHtml(cta.label)}</a></p>
<p style="margin:0;font-size:12px;color:#6b6a66">If the button doesn’t work, paste this link into your browser:<br><span style="word-break:break-all">${url}</span></p>
<p style="margin:20px 0 0;font-size:12px;color:#6b6a66">${escapeHtml(footer)}</p>
</td></tr></table></td></tr></table></body></html>`;
}

export function passwordResetEmail(to: string, name: string, url: string): MailMessage {
  const footer = 'If you didn’t ask to reset your password, you can ignore this email — your password won’t change.';
  return {
    kind: 'password_reset',
    to,
    subject: 'Reset your Monty password',
    text: `Hi ${name},\n\nUse this link to choose a new password. It expires in 1 hour and works once.\n\n${url}\n\n${footer}\n`,
    html: layout(
      'Reset your password',
      `<p style="margin:0">Hi ${escapeHtml(name)}, use the button below to choose a new password. The link expires in 1 hour and works once. Signing in with the new password signs you out everywhere else.</p>`,
      { label: 'Choose a new password', url },
      footer,
    ),
  };
}

export function verifyEmailEmail(to: string, name: string, url: string): MailMessage {
  const footer = 'If you didn’t create a Monty account, you can ignore this email.';
  return {
    kind: 'email_verification',
    to,
    subject: 'Confirm your email for Monty',
    text: `Hi ${name},\n\nConfirm your email address and sign in with this link (valid for 48 hours, works once):\n\n${url}\n\n${footer}\n`,
    html: layout(
      'Confirm your email',
      `<p style="margin:0">Hi ${escapeHtml(name)}, please confirm this is your email address. The link signs you in, is valid for 48 hours and works once.</p>`,
      { label: 'Confirm email', url },
      footer,
    ),
  };
}

export function invitationEmail(to: string, inviterName: string, organisationName: string, role: string, url: string): MailMessage {
  const footer = 'This invitation works once, only for this email address, and expires in 7 days.';
  return {
    kind: 'invitation',
    to,
    subject: `${inviterName} invited you to ${organisationName} on Monty`,
    text: `${inviterName} invited you to join ${organisationName} on Monty as ${role.toLowerCase()}.\n\nAccept: ${url}\n\n${footer}\n`,
    html: layout(
      `Join ${organisationName}`,
      `<p style="margin:0">${escapeHtml(inviterName)} invited you to join <strong>${escapeHtml(organisationName)}</strong> on Monty as ${escapeHtml(role.toLowerCase())}.</p>`,
      { label: 'Accept invitation', url },
      footer,
    ),
  };
}

export function accountDeletionEmail(to: string, name: string, url: string): MailMessage {
  const footer = 'If you didn’t ask to delete your account, ignore this email and change your password — nothing will be deleted.';
  return {
    kind: 'account_deletion',
    to,
    subject: 'Confirm deleting your Monty account',
    text: `Hi ${name},\n\nYou asked to delete your Monty account. This cannot be undone. To confirm, open this link while signed in (valid for 1 hour, works once):\n\n${url}\n\n${footer}\n`,
    html: layout(
      'Confirm account deletion',
      `<p style="margin:0">Hi ${escapeHtml(name)}, you asked to delete your Monty account. <strong>This cannot be undone.</strong> Open the link while signed in to confirm. It is valid for 1 hour and works once.</p>`,
      { label: 'Review and confirm deletion', url },
      footer,
    ),
  };
}

export function organisationDeletionEmail(to: string, organisationName: string, actorName: string, purgeDate: string, url: string): MailMessage {
  const footer = 'Owners can restore the organisation from Settings until the date above.';
  return {
    kind: 'organisation_deletion_scheduled',
    to,
    subject: `${organisationName} is scheduled for deletion`,
    text: `${actorName} scheduled the organisation ${organisationName} for deletion. It is no longer accessible, and everything in it will be permanently erased on ${purgeDate}.\n\n${url}\n\n${footer}\n`,
    html: layout(
      `${organisationName} is scheduled for deletion`,
      `<p style="margin:0">${escapeHtml(actorName)} scheduled <strong>${escapeHtml(organisationName)}</strong> for deletion. It is no longer accessible, and all its projects, tasks and documents will be permanently erased on <strong>${escapeHtml(purgeDate)}</strong>.</p>`,
      { label: 'Open Monty', url },
      footer,
    ),
  };
}

/** Sent instead of a second account when someone signs up with an email that already has one (no enumeration). */
export function accountExistsEmail(to: string, name: string, signInUrl: string, resetUrl: string): MailMessage {
  const footer = 'If this wasn’t you, you can ignore this email — nothing changed on your account.';
  return {
    kind: 'account_exists',
    to,
    subject: 'You already have a Monty account',
    text: `Hi ${name},\n\nSomeone (hopefully you) tried to create a Monty account with this email, but you already have one.\n\nSign in: ${signInUrl}\nForgot your password? ${resetUrl}\n\n${footer}\n`,
    html: layout(
      'You already have an account',
      `<p style="margin:0">Hi ${escapeHtml(name)}, someone (hopefully you) tried to create a Monty account with this email address, but it already has one. If you forgot your password, <a href="${escapeHtml(resetUrl)}">reset it here</a>.</p>`,
      { label: 'Sign in', url: signInUrl },
      footer,
    ),
  };
}

export function inviteOnlyEmail(to: string, url: string): MailMessage {
  const footer = 'If you didn’t try to sign up, you can ignore this email.';
  return {
    kind: 'signup_invite_only',
    to,
    subject: 'Monty is invite-only',
    text: `Someone tried to create a Monty account with this email. This Monty is invite-only: ask an administrator to invite this address, then use the link in the invitation.\n\n${url}\n\n${footer}\n`,
    html: layout(
      'An invitation is needed',
      `<p style="margin:0">Someone tried to create a Monty account with this email. This Monty is invite-only: ask an administrator to invite this address, then use the link in the invitation email.</p>`,
      { label: 'Open Monty', url },
      footer,
    ),
  };
}
