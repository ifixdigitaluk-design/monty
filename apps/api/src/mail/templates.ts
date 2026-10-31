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
    text: `Hi ${name},\n\nConfirm your email address with this link (valid for 7 days):\n\n${url}\n\n${footer}\n`,
    html: layout(
      'Confirm your email',
      `<p style="margin:0">Hi ${escapeHtml(name)}, please confirm this is your email address. The link is valid for 7 days.</p>`,
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
